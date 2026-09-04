import { ensureSchema } from "../../../lib/db.js";

function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const cookies = header.split(";").map(v => v.trim());
  const found = cookies.find(v => v.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.split("=").slice(1).join("=")) : null;
}

export default async function handler(req, res) {
  try {
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
        message: "La validación OAuth falló. Volvé a iniciar el login."
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

    const sql = await ensureSchema();
    const expiresAt = new Date(Date.now() + Number(tokenData.expires_in || 21600) * 1000);

    await sql`
      INSERT INTO meli_credentials (
        user_id, nickname, site_id, access_token, refresh_token,
        token_type, expires_at, scope, updated_at
      )
      VALUES (
        ${me.id}, ${me.nickname || null}, ${me.site_id || null},
        ${tokenData.access_token}, ${tokenData.refresh_token},
        ${tokenData.token_type || "bearer"}, ${expiresAt.toISOString()},
        ${tokenData.scope || null}, NOW()
      )
      ON CONFLICT (user_id)
      DO UPDATE SET
        nickname = EXCLUDED.nickname,
        site_id = EXCLUDED.site_id,
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        token_type = EXCLUDED.token_type,
        expires_at = EXCLUDED.expires_at,
        scope = EXCLUDED.scope,
        updated_at = NOW()
    `;

    res.setHeader(
      "Set-Cookie",
      "meli_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    );

    return res.status(200).json({
      ok: true,
      message: "Mercado Libre conectado y credenciales guardadas en Neon.",
      user: {
        id: me.id,
        nickname: me.nickname,
        site_id: me.site_id
      },
      token_info: {
        expires_in: tokenData.expires_in,
        expires_at: expiresAt.toISOString()
      },
      next: "Implementar renovación automática y primera consulta del detector."
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
