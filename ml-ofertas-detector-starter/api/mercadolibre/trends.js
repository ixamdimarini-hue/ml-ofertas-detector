import { getValidAccessToken } from "../../lib/meli.js";

export default async function handler(req, res) {
  try {
    const categoryId = String(req.query.category_id || "").trim();
    const accessToken = await getValidAccessToken();

    const base = "https://api.mercadolibre.com/trends/MLA";
    const url = categoryId
      ? `${base}/${encodeURIComponent(categoryId)}`
      : base;

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
        error: "meli_trends_failed",
        details: data
      });
    }

    const trends = (Array.isArray(data) ? data : []).map((row, index) => ({
      rank: index + 1,
      keyword: row.keyword || null,
      url: row.url || null
    }));

    return res.status(200).json({
      ok: true,
      site_id: "MLA",
      category_id: categoryId || null,
      count: trends.length,
      trends
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
