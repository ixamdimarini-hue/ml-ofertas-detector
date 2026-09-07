import { getValidAccessToken } from "../../lib/meli.js";

async function call(url, accessToken, extraHeaders = {}) {
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...extraHeaders
      }
    });

    let data;
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
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error?.message || String(error)
    };
  }
}

export default async function handler(req, res) {
  try {
    const itemId = String(req.query.item_id || "").trim();

    if (!itemId) {
      return res.status(400).json({
        ok: false,
        error: "missing_item_id",
        message: "Usá ?item_id=MLA..."
      });
    }

    const accessToken = await getValidAccessToken();

    const base = "https://api.mercadolibre.com";
    const results = {};

    results.sale_price = await call(
      `${base}/items/${encodeURIComponent(itemId)}/sale_price?context=channel_marketplace`,
      accessToken
    );

    results.prices = await call(
      `${base}/items/${encodeURIComponent(itemId)}/prices`,
      accessToken,
      { "show-all-prices": "true" }
    );

    results.item = await call(
      `${base}/items/${encodeURIComponent(itemId)}`,
      accessToken
    );

    return res.status(200).json({
      ok: true,
      item_id: itemId,
      diagnosis: {
        sale_price_accessible: results.sale_price.ok,
        prices_accessible: results.prices.ok,
        item_accessible: results.item.ok
      },
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
