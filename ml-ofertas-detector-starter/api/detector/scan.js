import { getValidAccessToken } from "../../lib/meli.js";
import { saveItemObservation } from "../../lib/detector.js";

export default async function handler(req, res) {
  try {
    const q = String(req.query.q || "celular").trim();
    const requestedProducts = Number(req.query.limit || 10);
    const productLimit = Math.min(Math.max(requestedProducts, 1), 20);

    if (!q) {
      return res.status(400).json({
        ok: false,
        error: "missing_query",
        message: "Usá ?q=producto para escanear."
      });
    }

    const accessToken = await getValidAccessToken();

    // 1) Buscar productos de catálogo.
    const productUrl = new URL("https://api.mercadolibre.com/products/search");
    productUrl.searchParams.set("site_id", "MLA");
    productUrl.searchParams.set("status", "active");
    productUrl.searchParams.set("q", q);
    productUrl.searchParams.set("limit", String(productLimit));

    const productResponse = await fetch(productUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    });

    const productData = await productResponse.json();

    if (!productResponse.ok) {
      return res.status(productResponse.status).json({
        ok: false,
        error: "product_search_failed",
        details: productData
      });
    }

    // 2) Para cada producto, pedir las publicaciones que compiten en esa PDP.
    // Endpoint oficial: /products/{PRODUCT_ID}/items
    const productResults = productData.results || [];
    const candidateMap = new Map();
    const productFailures = [];

    for (const product of productResults) {
      const itemsUrl = new URL(
        `https://api.mercadolibre.com/products/${encodeURIComponent(product.id)}/items`
      );
      itemsUrl.searchParams.set("limit", "20");

      const itemsResponse = await fetch(itemsUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json"
        }
      });

      const itemsData = await itemsResponse.json();

      if (!itemsResponse.ok) {
        productFailures.push({
          product_id: product.id,
          status: itemsResponse.status,
          details: itemsData
        });
        continue;
      }

      for (const row of itemsData.results || []) {
        const itemId = row.item_id || row.id;
        if (!itemId) continue;

        if (!candidateMap.has(itemId)) {
          candidateMap.set(itemId, {
            catalog_product_id: product.id,
            listing_snapshot: row
          });
        }
      }
    }

    const itemIds = [...candidateMap.keys()];

    if (!itemIds.length) {
      return res.status(200).json({
        ok: true,
        query: q,
        products_found: productResults.length,
        item_candidates_found: 0,
        items_saved: 0,
        product_failures: productFailures.length,
        message: "Se encontraron productos de catálogo, pero no publicaciones asociadas accesibles."
      });
    }

    // 3) Enriquecer publicaciones reales con /items/bulk.
    const saved = [];
    const failures = [];

    for (let i = 0; i < itemIds.length; i += 20) {
      const chunk = itemIds.slice(i, i + 20);

      const bulkUrl = new URL("https://api.mercadolibre.com/items/bulk");
      bulkUrl.searchParams.set("ids", chunk.join(","));

      const bulkResponse = await fetch(bulkUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json"
        }
      });

      const bulkData = await bulkResponse.json();

      if (!bulkResponse.ok) {
        failures.push({
          ids: chunk,
          status: bulkResponse.status,
          details: bulkData
        });
        continue;
      }

      for (const entry of bulkData || []) {
        const body = entry?.body;

        if (entry?.code === 200 && body?.id) {
          const meta = candidateMap.get(body.id);
          await saveItemObservation(
            body,
            meta?.catalog_product_id || body.catalog_product_id || null
          );

          saved.push({
            item_id: body.id,
            catalog_product_id:
              meta?.catalog_product_id || body.catalog_product_id || null,
            title: body.title,
            price: body.price,
            original_price: body.original_price ?? null,
            currency_id: body.currency_id,
            seller_id: body.seller_id ?? null,
            sold_quantity: body.sold_quantity ?? null,
            free_shipping: Boolean(body.shipping?.free_shipping),
            permalink: body.permalink
          });
        } else {
          failures.push(entry);
        }
      }
    }

    return res.status(200).json({
      ok: true,
      query: q,
      products_found: productResults.length,
      item_candidates_found: itemIds.length,
      items_saved: saved.length,
      saved,
      product_failures_count: productFailures.length,
      item_failures_count: failures.length
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
