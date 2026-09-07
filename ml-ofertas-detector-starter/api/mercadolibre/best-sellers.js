import { getValidAccessToken } from "../../lib/meli.js";

export default async function handler(req, res) {
  try {
    const categoryId = String(req.query.category_id || "").trim();

    if (!categoryId) {
      return res.status(400).json({
        ok: false,
        error: "missing_category_id",
        message: "Usá ?category_id=MLA..."
      });
    }

    const token = await getValidAccessToken();

    const response = await fetch(
      `https://api.mercadolibre.com/highlights/MLA/category/${encodeURIComponent(categoryId)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json"
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: "highlights_failed",
        details: data
      });
    }

    return res.status(200).json({
      ok: true,
      category_id: categoryId,
      count: Array.isArray(data.content) ? data.content.length : 0,
      content: data.content || []
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      message: err?.message || "Error inesperado."
    });
  }
}
