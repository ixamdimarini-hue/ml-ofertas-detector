import { getValidAccessToken } from "../../lib/meli.js";
import { saveItemObservation } from "../../lib/detector.js";

export default async function handler(req, res) {
  try {
    const q = String(req.query.q || "celular").trim();
    const requestedLimit = Number(req.query.limit || 20);
    const limit = Math.min(Math.max(requestedLimit, 1), 50);

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
    productUrl.searchParams.set("limit", String(limit));

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

    // 2) Tomar las publicaciones ganadoras (buy box) disponibles.
    const winnerMap = new Map();

    for (const product of productData.results || []) {
      const winner = product.buy_box_winner;
      if (winner?.item_id) {
        winnerMap.set(winner.item_id, product.id);
      }
    }

    const itemIds = [...winnerMap.keys()];

    if (!itemIds.length) {
      return res.status(200).json({
        ok: true,
        query: q,
        products_found: (productData.results || []).length,
        items_saved: 0,
        message: "La búsqueda devolvió productos, pero ninguno tenía buy_box_winner. Probá con una búsqueda más comercial, por ejemplo celular, smart tv, auriculares o taladro."
      });
    }

    // 3) Enriquecer hasta 20 publicaciones por llamada usando el endpoint bulk.
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
          await saveItemObservation(body, winnerMap.get(body.id) || body.catalog_product_id || null);

          saved.push({
            item_id: body.id,
            catalog_product_id: winnerMap.get(body.id) || body.catalog_product_id || null,
            title: body.title,
            price: body.price,
            original_price: body.original_price ?? null,
            currency_id: body.currency_id,
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
      products_found: (productData.results || []).length,
      buy_box_items_found: itemIds.length,
      items_saved: saved.length,
      saved,
      failures_count: failures.length
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
