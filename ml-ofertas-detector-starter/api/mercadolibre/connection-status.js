import { ensureSchema } from "../../lib/db.js";

export default async function handler(req, res) {
  try {
    const sql = await ensureSchema();
    const rows = await sql`
      SELECT user_id, nickname, site_id, expires_at, updated_at
      FROM meli_credentials
      ORDER BY updated_at DESC
      LIMIT 1
    `;

    if (!rows.length) {
      return res.status(200).json({
        ok: true,
        connected: false,
        message: "Base lista, pero todavía no hay credenciales guardadas."
      });
    }

    return res.status(200).json({
      ok: true,
      connected: true,
      account: rows[0]
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || "Error verificando la base."
    });
  }
}
