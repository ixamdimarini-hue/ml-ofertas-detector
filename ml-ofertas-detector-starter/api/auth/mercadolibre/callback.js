function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const cookies = header.split(";").map(v => v.trim());
  const found = cookies.find(v => v.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.split("=").slice(1).join("=")) : null;
}

export default async function handler(req, res) {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.status(400).json({
      ok: false,
      error,
      error_description: error_description || null
    });
  }

  if (!code) {
    return res.status(200).json({
      ok: true,
      message: "Callback de Mercado Libre activo. Todavía no se recibió un código OAuth."
    });
  }

  const expectedState = getCookie(req, "meli_oauth_state");
  if (!state || !expectedState || state !== expectedState) {
    return res.status(400).json({
      ok: false,
      error: "invalid_state",
      message: "La validación de seguridad OAuth (state) falló. Volvé a iniciar el login."
    });
  }

  const clientId = process.env.MELI_CLIENT_ID;
  const clientSecret = process.env.MELI_CLIENT_SECRET;
  const redirectUri = process.env.MELI_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return res.status(500).json({
      ok: false,
      error: "missing_environment_variables",
      message: "Faltan variables MELI_* en Vercel."
    });
  }

  const tokenResponse = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri
    })
  });

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok) {
    return res.status(tokenResponse.status).json({
      ok: false,
      error: "token_exchange_failed",
      details: tokenData
    });
  }

  // Verificamos que el access token realmente funciona sin exponerlo al navegador.
  const meResponse = await fetch("https://api.mercadolibre.com/users/me", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`
    }
  });

  const me = await meResponse.json();

  if (!meResponse.ok) {
    return res.status(meResponse.status).json({
      ok: false,
      error: "user_verification_failed",
      details: me
    });
  }

  // En esta prueba NO devolvemos access_token ni refresh_token.
  // En el siguiente paso los guardaremos en almacenamiento persistente seguro.
  res.setHeader(
    "Set-Cookie",
    "meli_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  );

  return res.status(200).json({
    ok: true,
    message: "Mercado Libre conectado correctamente.",
    user: {
      id: me.id,
      nickname: me.nickname,
      site_id: me.site_id
    },
    token_info: {
      expires_in: tokenData.expires_in,
      token_type: tokenData.token_type
    },
    next: "Guardar tokens de forma persistente y comenzar las consultas del detector."
  });
}
