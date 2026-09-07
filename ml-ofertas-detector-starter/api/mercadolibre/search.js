import { getValidAccessToken } from "../../lib/meli.js";

async function apiGet(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  let data;
  try {
    data = await response.json();
  } catch {
    data = await response.text();
  }

  return { ok: response.ok, status: response.status, data };
}

function buildProductUrl(product) {
  if (product?.permalink) return product.permalink;
  if (product?.id) {
    return `https://www.mercadolibre.com.ar/p/${encodeURIComponent(product.id)}`;
  }
  return null;
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function tokenScore(query, name) {
  const qTokens = normalize(query)
    .split(/\s+/)
    .filter(t => t.length >= 2);

  const n = normalize(name);

  if (!qTokens.length) return 0;

  let matched = 0;
  for (const t of qTokens) {
    if (n.includes(t)) matched++;
  }

  return matched / qTokens.length;
}

export default async function handler(req, res) {
  try {
    const q = String(req.query.q || "notebook").trim();
    const requestedLimit = Number(req.query.limit || 20);
    const limit = Math.min(Math.max(requestedLimit, 1), 30);

    if (!q) {
      return res.status(400).json({
        ok: false,
        error: "missing_query",
        message: "Usá ?q=producto para buscar."
      });
    }

    const accessToken = await getValidAccessToken();

    // 1) Predecir dominio/categoría a partir de la intención de búsqueda.
    const predictorUrl = new URL(
      "https://api.mercadolibre.com/sites/MLA/domain_discovery/search"
    );
    predictorUrl.searchParams.set("q", q);
    predictorUrl.searchParams.set("limit", "1");
    predictorUrl.searchParams.set("target", "core");

    const predictionResp = await apiGet(predictorUrl.toString(), accessToken);
    const prediction = predictionResp.ok && Array.isArray(predictionResp.data)
      ? predictionResp.data[0] || null
      : null;

    // 2) Buscar productos restringiendo al dominio predicho.
    const searchUrl = new URL("https://api.mercadolibre.com/products/search");
    searchUrl.searchParams.set("site_id", "MLA");
    searchUrl.searchParams.set("status", "active");
    searchUrl.searchParams.set("q", q);
    searchUrl.searchParams.set("limit", String(limit));

    if (prediction?.domain_id) {
      searchUrl.searchParams.set("domain_id", prediction.domain_id);
    }

    const searchResp = await apiGet(searchUrl.toString(), accessToken);

    if (!searchResp.ok) {
      return res.status(searchResp.status).json({
        ok: false,
        error: "meli_products_search_failed",
        details: searchResp.data,
        prediction
      });
    }

    // 3) Obtener top 20 de más vendidos de la categoría predicha.
    let bestSellerMap = new Map();
    let bestSellersStatus = null;

    if (prediction?.category_id) {
      const highlightsUrl =
        `https://api.mercadolibre.com/highlights/MLA/category/` +
        encodeURIComponent(prediction.category_id);

      const highlightsResp = await apiGet(highlightsUrl, accessToken);
      bestSellersStatus = highlightsResp.status;

      if (highlightsResp.ok && Array.isArray(highlightsResp.data?.content)) {
        bestSellerMap = new Map(
          highlightsResp.data.content.map(row => [
            row.id,
            {
              position: row.position,
              type: row.type
            }
          ])
        );
      }
    }

    // 4) Armar resultados y priorizar coincidencia textual + best sellers.
    const results = (searchResp.data?.results || []).map(product => {
      const winner = product.buy_box_winner || null;
      const best = bestSellerMap.get(product.id) || null;
      const relevance = tokenScore(q, product.name);

      return {
        product_id: product.id,
        name: product.name,
        status: product.status,
        domain_id: product.domain_id ?? null,
        permalink: product.permalink ?? null,
        product_url: buildProductUrl(product),
        family_name: product.family_name ?? null,
        relevance_score: Number(relevance.toFixed(3)),
        best_seller_position: best?.position ?? null,
        best_seller_type: best?.type ?? null,
        buy_box_winner: winner ? {
          item_id: winner.item_id ?? null,
          seller_id: winner.seller_id ?? null,
          price: winner.price ?? null,
          original_price: winner.original_price ?? null,
          currency_id: winner.currency_id ?? null,
          free_shipping: Boolean(winner.shipping?.free_shipping),
          listing_type_id: winner.listing_type_id ?? null,
          official_store_id: winner.official_store_id ?? null
        } : null
      };
    });

    results.sort((a, b) => {
      if (a.best_seller_position && !b.best_seller_position) return -1;
      if (!a.best_seller_position && b.best_seller_position) return 1;

      if (a.best_seller_position && b.best_seller_position) {
        return a.best_seller_position - b.best_seller_position;
      }

      return b.relevance_score - a.relevance_score;
    });

    return res.status(200).json({
      ok: true,
      query: q,
      search_strategy: prediction?.domain_id
        ? "domain_filtered"
        : "keyword_only",
      prediction: prediction ? {
        domain_id: prediction.domain_id ?? null,
        domain_name: prediction.domain_name ?? null,
        category_id: prediction.category_id ?? null,
        category_name: prediction.category_name ?? null,
        attributes: prediction.attributes ?? []
      } : null,
      best_sellers_status: bestSellersStatus,
      paging: searchResp.data?.paging || null,
      count: results.length,
      results
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      message: err?.message || "Error inesperado."
    });
  }
}
