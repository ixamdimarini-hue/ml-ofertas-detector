import crypto from "crypto";

export default async function handler(req, res) {
  const clientId = process.env.MELI_CLIENT_ID;
  const redirectUri = process.env.MELI_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(500).json({
      ok: false,
      error: "Faltan MELI_CLIENT_ID o MELI_REDIRECT_URI en Vercel."
    });
  }

  const state = crypto.randomBytes(24).toString("hex");

  res.setHeader(
    "Set-Cookie",
    `meli_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state
  });

  return res.redirect(
    302,
    `https://auth.mercadolibre.com.ar/authorization?${params.toString()}`
  );
}
