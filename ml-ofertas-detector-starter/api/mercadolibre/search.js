import { getValidAccessToken } from "../../lib/meli.js";

export default async function handler(req, res) {
  try {
    const q = String(req.query.q || "notebook").trim();
    const requestedLimit = Number(req.query.limit || 10);
    const limit = Math.min(Math.max(requestedLimit, 1), 20);

    if (!q) {
      return res.status(400).json({
        ok: false,
        error: "missing_query",
        message: "Usá ?q=producto para buscar."
      });
    }

    const accessToken = await getValidAccessToken();

    const url = new URL("https://api.mercadolibre.com/products/search");
    url.searchParams.set("site_id", "MLA");
    url.searchParams.set("status", "active");
    url.searchParams.set("q", q);
    url.searchParams.set("limit", String(limit));

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: "meli_products_search_failed",
        details: data
      });
    }

    const results = (data.results || []).map(product => {
      const winner = product.buy_box_winner || null;

      return {
        product_id: product.id,
        name: product.name,
        status: product.status,
        domain_id: product.domain_id ?? null,
        permalink: product.permalink ?? null,
        family_name: product.family_name ?? null,

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

    return res.status(200).json({
      ok: true,
      query: q,
      paging: data.paging || null,
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
