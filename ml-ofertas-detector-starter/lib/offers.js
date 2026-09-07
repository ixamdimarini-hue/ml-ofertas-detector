import { getSql } from "./db.js";

export async function ensureOffersSchema() {
  const sql = getSql();

  await sql`
    CREATE TABLE IF NOT EXISTS offers_queue (
      id BIGSERIAL PRIMARY KEY,
      external_product_id TEXT,
      item_id TEXT,
      title TEXT NOT NULL,
      product_url TEXT,
      current_price NUMERIC,
      previous_price NUMERIC,
      discount_pct NUMERIC,
      commission_pct NUMERIC,
      sold_text TEXT,
      rating NUMERIC,
      highlight TEXT,
      offer_score NUMERIC,
      affiliate_url TEXT,
      status TEXT NOT NULL DEFAULT 'DETECTADA',
      source TEXT NOT NULL DEFAULT 'manual',
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_offers_queue_status_updated
    ON offers_queue(status, updated_at DESC)
  `;

  return sql;
}

export function calcOfferScore({
  discount_pct = 0,
  commission_pct = 0,
  rating = 0,
  highlight = "",
  sold_text = ""
}) {
  let score = 0;

  const discount = Number(discount_pct || 0);
  const commission = Number(commission_pct || 0);
  const r = Number(rating || 0);
  const h = String(highlight || "").toUpperCase();
  const sold = String(sold_text || "").toLowerCase();

  score += Math.min(discount * 1.5, 45);
  score += Math.min(commission * 2, 20);

  if (r >= 4.8) score += 12;
  else if (r >= 4.5) score += 8;
  else if (r >= 4.0) score += 4;

  if (h.includes("MÁS VENDIDO") || h.includes("MAS VENDIDO")) score += 10;
  if (h.includes("MÁS BUSCADO") || h.includes("MAS BUSCADO")) score += 7;

  if (sold.includes("10mil") || sold.includes("10 mil")) score += 8;
  else if (sold.includes("5mil") || sold.includes("5 mil")) score += 6;
  else if (sold.includes("1000") || sold.includes("1mil")) score += 4;

  return Math.max(0, Math.min(Math.round(score), 100));
}
