import { neon } from "@neondatabase/serverless";

export function getSql() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Falta DATABASE_URL en las variables de entorno.");
  }
  return neon(process.env.DATABASE_URL);
}

export async function ensureSchema() {
  const sql = getSql();

  await sql`
    CREATE TABLE IF NOT EXISTS meli_credentials (
      user_id BIGINT PRIMARY KEY,
      nickname TEXT,
      site_id TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      token_type TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      scope TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  return sql;
}
