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

    const url = new URL("https://api.mercadolibre.com/sites/MLA/search");
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
        error: "meli_search_failed",
        details: data
      });
    }

    const results = (data.results || []).map(item => ({
      id: item.id,
      title: item.title,
      price: item.price,
      original_price: item.original_price ?? null,
      currency_id: item.currency_id,
      permalink: item.permalink,
      condition: item.condition,
      sold_quantity: item.sold_quantity ?? null,
      free_shipping: Boolean(item.shipping?.free_shipping),
      seller_id: item.seller?.id ?? null,
      thumbnail: item.thumbnail ?? null
    }));

    return res.status(200).json({
      ok: true,
      query: q,
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
