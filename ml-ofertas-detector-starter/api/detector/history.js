import { ensureDetectorSchema } from "../../lib/detector.js";

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

    const sql = await ensureDetectorSchema();

    const itemRows = await sql`
      SELECT *
      FROM tracked_items
      WHERE item_id = ${itemId}
      LIMIT 1
    `;

    if (!itemRows.length) {
      return res.status(404).json({
        ok: false,
        error: "item_not_found",
        message: "Ese item todavía no fue guardado por el detector."
      });
    }

    const observations = await sql`
      SELECT
        price,
        original_price,
        available_quantity,
        sold_quantity,
        observed_at
      FROM price_observations
      WHERE item_id = ${itemId}
      ORDER BY observed_at DESC
      LIMIT 100
    `;

    return res.status(200).json({
      ok: true,
      item: itemRows[0],
      observations
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
