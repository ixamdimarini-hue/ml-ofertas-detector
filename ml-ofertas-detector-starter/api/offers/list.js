import { ensureOffersSchema } from "../../lib/offers.js";

export default async function handler(req, res) {
  try {
    const sql = await ensureOffersSchema();
    const status = String(req.query.status || "").trim();

    const rows = status
      ? await sql`
          SELECT * FROM offers_queue
          WHERE status = ${status}
          ORDER BY offer_score DESC NULLS LAST, updated_at DESC
          LIMIT 200
        `
      : await sql`
          SELECT * FROM offers_queue
          ORDER BY
            CASE status
              WHEN 'ESPERANDO_LINK' THEN 1
              WHEN 'LISTA_PARA_PUBLICAR' THEN 2
              WHEN 'DETECTADA' THEN 3
              WHEN 'PUBLICADA' THEN 4
              ELSE 5
            END,
            offer_score DESC NULLS LAST,
            updated_at DESC
          LIMIT 200
        `;

    return res.status(200).json({
      ok: true,
      count: rows.length,
      offers: rows
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
