import { getSql } from "./db.js";

export async function ensureDetectorSchema() {
  const sql = getSql();

  await sql`
    CREATE TABLE IF NOT EXISTS tracked_items (
      item_id TEXT PRIMARY KEY,
      catalog_product_id TEXT,
      title TEXT,
      category_id TEXT,
      seller_id BIGINT,
      currency_id TEXT,
      permalink TEXT,
      condition TEXT,
      listing_type_id TEXT,
      free_shipping BOOLEAN,
      status TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS price_observations (
      id BIGSERIAL PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES tracked_items(item_id) ON DELETE CASCADE,
      price NUMERIC,
      original_price NUMERIC,
      available_quantity INTEGER,
      sold_quantity INTEGER,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_price_observations_item_time
    ON price_observations(item_id, observed_at DESC)
  `;

  return sql;
}

export async function saveItemObservation(item, catalogProductId = null) {
  const sql = await ensureDetectorSchema();

  await sql`
    INSERT INTO tracked_items (
      item_id,
      catalog_product_id,
      title,
      category_id,
      seller_id,
      currency_id,
      permalink,
      condition,
      listing_type_id,
      free_shipping,
      status,
      last_seen_at
    )
    VALUES (
      ${item.id},
      ${catalogProductId},
      ${item.title || null},
      ${item.category_id || null},
      ${item.seller_id || null},
      ${item.currency_id || null},
      ${item.permalink || null},
      ${item.condition || null},
      ${item.listing_type_id || null},
      ${Boolean(item.shipping?.free_shipping)},
      ${item.status || null},
      NOW()
    )
    ON CONFLICT (item_id)
    DO UPDATE SET
      catalog_product_id = COALESCE(EXCLUDED.catalog_product_id, tracked_items.catalog_product_id),
      title = EXCLUDED.title,
      category_id = EXCLUDED.category_id,
      seller_id = EXCLUDED.seller_id,
      currency_id = EXCLUDED.currency_id,
      permalink = EXCLUDED.permalink,
      condition = EXCLUDED.condition,
      listing_type_id = EXCLUDED.listing_type_id,
      free_shipping = EXCLUDED.free_shipping,
      status = EXCLUDED.status,
      last_seen_at = NOW()
  `;

  await sql`
    INSERT INTO price_observations (
      item_id,
      price,
      original_price,
      available_quantity,
      sold_quantity
    )
    VALUES (
      ${item.id},
      ${item.price ?? null},
      ${item.original_price ?? null},
      ${item.available_quantity ?? null},
      ${item.sold_quantity ?? null}
    )
  `;
}
