import { ensureSchema } from "./db.js";

async function refreshAccessToken(sql, row) {
  const clientId = process.env.MELI_CLIENT_ID;
  const clientSecret = process.env.MELI_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Faltan MELI_CLIENT_ID o MELI_CLIENT_SECRET.");
  }

  const response = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: row.refresh_token
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`No se pudo renovar el token: ${JSON.stringify(data)}`);
  }

  const expiresAt = new Date(
    Date.now() + Number(data.expires_in || 21600) * 1000
  );

  await sql`
    UPDATE meli_credentials
    SET
      access_token = ${data.access_token},
      refresh_token = ${data.refresh_token || row.refresh_token},
      token_type = ${data.token_type || "bearer"},
      expires_at = ${expiresAt.toISOString()},
      scope = ${data.scope || row.scope || null},
      updated_at = NOW()
    WHERE user_id = ${row.user_id}
  `;

  return data.access_token;
}

export async function getValidAccessToken() {
  const sql = await ensureSchema();

  const rows = await sql`
    SELECT
      user_id,
      access_token,
      refresh_token,
      expires_at,
      scope
    FROM meli_credentials
    ORDER BY updated_at DESC
    LIMIT 1
  `;

  if (!rows.length) {
    throw new Error(
      "No hay una cuenta de Mercado Libre conectada. Volvé a realizar OAuth."
    );
  }

  const row = rows[0];
  const expiresAt = new Date(row.expires_at).getTime();
  const fiveMinutes = 5 * 60 * 1000;

  if (expiresAt - Date.now() > fiveMinutes) {
    return row.access_token;
  }

  return refreshAccessToken(sql, row);
}
