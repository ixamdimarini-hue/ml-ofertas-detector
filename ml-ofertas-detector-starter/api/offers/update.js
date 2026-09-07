import { ensureOffersSchema } from "../../lib/offers.js";

const ALLOWED_STATUS = new Set([
  "DETECTADA",
  "ESPERANDO_LINK",
  "LISTA_PARA_PUBLICAR",
  "PUBLICADA",
  "DESCARTADA"
]);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  try {
    const body = req.body || {};
    const id = Number(body.id);

    if (!id) {
      return res.status(400).json({
        ok: false,
        error: "missing_id",
        message: "id es obligatorio."
      });
    }

    if (body.status && !ALLOWED_STATUS.has(body.status)) {
      return res.status(400).json({
        ok: false,
        error: "invalid_status"
      });
    }

    const sql = await ensureOffersSchema();

    const currentRows = await sql`
      SELECT * FROM offers_queue WHERE id = ${id} LIMIT 1
    `;

    if (!currentRows.length) {
      return res.status(404).json({ ok: false, error: "offer_not_found" });
    }

    const current = currentRows[0];
    const nextStatus = body.status || current.status;
    const nextAffiliate = body.affiliate_url !== undefined
      ? body.affiliate_url
      : current.affiliate_url;

    const publishedAt = nextStatus === "PUBLICADA"
      ? (current.published_at || new Date().toISOString())
      : current.published_at;

    const rows = await sql`
      UPDATE offers_queue
      SET
        affiliate_url = ${nextAffiliate || null},
        status = ${nextStatus},
        published_at = ${publishedAt},
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;

    return res.status(200).json({ ok: true, offer: rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      message: err?.message || "Error inesperado."
    });
  }
}
