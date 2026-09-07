function normalizeItem(row) {
  return {
    item_id: row.id ?? null,
    title: row.title ?? null,
    price: row.price ?? null,
    original_price: row.original_price ?? null,
    currency_id: row.currency_id ?? "ARS",
    condition: row.condition ?? null,
    permalink: row.permalink ?? null,
    thumbnail: row.thumbnail ?? null,
    seller_id: row.seller?.id ?? null,
    seller_nickname: row.seller?.nickname ?? null,
    free_shipping: Boolean(row.shipping?.free_shipping),
    shipping_mode: row.shipping?.mode ?? null,
    available_quantity: row.available_quantity ?? null,
    sold_quantity: row.sold_quantity ?? null,
    category_id: row.category_id ?? null,
    catalog_product_id: row.catalog_product_id ?? null,
    listing_type_id: row.listing_type_id ?? null,
    official_store_id: row.official_store_id ?? null
  };
}

export default async function handler(req, res) {
  try {
    const q = String(req.query.q || "").trim();
    const requestedLimit = Number(req.query.limit || 20);
    const limit = Math.min(Math.max(requestedLimit, 1), 50);
    const offset = Math.max(Number(req.query.offset || 0), 0);

    if (!q) {
      return res.status(400).json({
        ok: false,
        error: "missing_query",
        message: "Usá ?q=producto para buscar publicaciones activas."
      });
    }

    const url = new URL("https://api.mercadolibre.com/sites/MLA/search");
    url.searchParams.set("q", q);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    // Este recurso está documentado como búsqueda pública.
    // No enviamos el token de vendedor para evitar mezclar permisos de ownership.
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "ML-Ofertas-Detector/1.0"
      }
    });

    let data;
    try {
      data = await response.json();
    } catch {
      data = await response.text();
    }

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: "meli_listings_search_failed",
        upstream_status: response.status,
        details: data
      });
    }

    const results = Array.isArray(data?.results)
      ? data.results.map(normalizeItem).filter(x => x.item_id && x.permalink)
      : [];

    return res.status(200).json({
      ok: true,
      source: "sites/MLA/search",
      query: q,
      paging: data?.paging ?? null,
      count: results.length,
      results,
      filters: data?.filters ?? [],
      available_filters: data?.available_filters ?? []
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
