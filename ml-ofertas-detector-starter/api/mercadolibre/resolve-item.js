import { getValidAccessToken } from "../../lib/meli.js";

async function apiGet(pathOrUrl, token) {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `https://api.mercadolibre.com${pathOrUrl}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = await response.text();
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

async function validateItem(itemId, token) {
  const item = await apiGet(`/items/${encodeURIComponent(itemId)}`, token);
  const salePrice = await apiGet(
    `/items/${encodeURIComponent(itemId)}/sale_price?context=channel_marketplace`,
    token
  );

  return {
    item_id: itemId,
    valid_item: item.ok,
    sale_price_accessible: salePrice.ok,
    item_status: item.status,
    sale_price_status: salePrice.status,
    item: item.ok ? {
      id: item.data?.id ?? itemId,
      title: item.data?.title ?? null,
      seller_id: item.data?.seller_id ?? null,
      category_id: item.data?.category_id ?? null,
      catalog_product_id: item.data?.catalog_product_id ?? null,
      permalink: item.data?.permalink ?? null,
      status: item.data?.status ?? null
    } : null,
    sale_price: salePrice.ok ? {
      amount: salePrice.data?.amount ?? null,
      regular_amount: salePrice.data?.regular_amount ?? null,
      currency_id: salePrice.data?.currency_id ?? null,
      price_id: salePrice.data?.price_id ?? null,
      type: salePrice.data?.type ?? null
    } : null,
    raw_errors: {
      item: item.ok ? null : item.data,
      sale_price: salePrice.ok ? null : salePrice.data
    }
  };
}

async function resolveFromProduct(productId, token) {
  const productDetail = await apiGet(
    `/products/${encodeURIComponent(productId)}`,
    token
  );

  if (!productDetail.ok) {
    return {
      product_id: productId,
      product_ok: false,
      product_status: productDetail.status,
      product_error: productDetail.data,
      candidates: []
    };
  }

  const candidateIds = [];
  const seen = new Set();

  const winnerId = productDetail.data?.buy_box_winner?.item_id;
  if (winnerId && !seen.has(winnerId)) {
    seen.add(winnerId);
    candidateIds.push({
      item_id: winnerId,
      source: "product.buy_box_winner"
    });
  }

  // Fallback diagnóstico. Este recurso puede estar limitado/deprecado según el flujo,
  // por eso nunca confiamos en él sin validar cada ITEM_ID.
  const competition = await apiGet(
    `/products/${encodeURIComponent(productId)}/items?limit=20`,
    token
  );

  if (competition.ok) {
    for (const row of competition.data?.results || []) {
      const itemId = row?.item_id || row?.id;
      if (itemId && !seen.has(itemId)) {
        seen.add(itemId);
        candidateIds.push({
          item_id: itemId,
          source: "product.items"
        });
      }
    }
  }

  const validations = [];
  for (const candidate of candidateIds.slice(0, 20)) {
    const result = await validateItem(candidate.item_id, token);
    validations.push({
      source: candidate.source,
      ...result
    });

    if (result.valid_item || result.sale_price_accessible) {
      break;
    }
  }

  const resolved = validations.find(
    row => row.valid_item || row.sale_price_accessible
  ) || null;

  return {
    product_id: productId,
    product_ok: true,
    product: {
      id: productDetail.data?.id ?? productId,
      name: productDetail.data?.name ?? null,
      status: productDetail.data?.status ?? null,
      permalink: productDetail.data?.permalink ?? null,
      domain_id: productDetail.data?.domain_id ?? null,
      sold_quantity: productDetail.data?.sold_quantity ?? null
    },
    buy_box_winner_present: Boolean(winnerId),
    competition_endpoint_status: competition.status,
    candidates_found: candidateIds.length,
    resolved,
    validations
  };
}

export default async function handler(req, res) {
  try {
    const productId = String(req.query.product_id || "").trim();
    const q = String(req.query.q || "").trim();
    const maxProducts = Math.min(
      Math.max(Number(req.query.max_products || 5), 1),
      10
    );

    if (!productId && !q) {
      return res.status(400).json({
        ok: false,
        error: "missing_input",
        message:
          "Usá ?product_id=MLA... o ?q=celular para resolver automáticamente un ITEM_ID activo."
      });
    }

    const token = await getValidAccessToken();

    let productIds = [];

    if (productId) {
      productIds = [productId];
    } else {
      const searchUrl = new URL("https://api.mercadolibre.com/products/search");
      searchUrl.searchParams.set("status", "active");
      searchUrl.searchParams.set("site_id", "MLA");
      searchUrl.searchParams.set("q", q);
      searchUrl.searchParams.set("limit", String(maxProducts));

      const search = await apiGet(searchUrl.toString(), token);

      if (!search.ok) {
        return res.status(search.status).json({
          ok: false,
          error: "product_search_failed",
          details: search.data
        });
      }

      productIds = (search.data?.results || [])
        .map(p => p?.id)
        .filter(Boolean)
        .slice(0, maxProducts);
    }

    const attempts = [];

    for (const id of productIds) {
      const result = await resolveFromProduct(id, token);
      attempts.push(result);

      if (result.resolved) {
        return res.status(200).json({
          ok: true,
          input: productId ? { product_id: productId } : { q },
          resolved: true,
          result,
          attempts_count: attempts.length
        });
      }
    }

    return res.status(200).json({
      ok: true,
      input: productId ? { product_id: productId } : { q },
      resolved: false,
      attempts_count: attempts.length,
      attempts,
      message:
        "No se pudo resolver un ITEM_ID actualmente consultable. Revisá los estados de cada intento para saber si el bloqueo está en buy_box, competencia, /items o /sale_price."
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
