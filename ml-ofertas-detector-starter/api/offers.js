
import { ensureOffersSchema, calcOfferScore } from "../lib/offers.js";

const ALLOWED_STATUS = new Set([
  "DETECTADA",
  "ESPERANDO_LINK",
  "NOTIFICADA",
  "LISTA_PARA_PUBLICAR",
  "PUBLICADA",
  "DESCARTADA"
]);

function component(card, type) {
  return (card?.components || []).find(c => c?.type === type) || null;
}

function parseCommission(card) {
  const chip = component(card, "chip");
  const text = chip?.chip?.pill?.text || "";
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*%/);
  return match ? Number(match[1].replace(",", ".")) : null;
}

function parseRatingAndSold(card) {
  const review = component(card, "review_compacted");
  const values = review?.review_compacted?.values || [];
  let rating = null;
  let soldText = null;

  for (const v of values) {
    const text = v?.label?.text;
    if (!text) continue;

    if (rating === null && /^\d+(?:[.,]\d+)?$/.test(text.trim())) {
      rating = Number(text.replace(",", "."));
    }

    if (text.toLowerCase().includes("vendid")) {
      soldText = text.replace(/^\|\s*/, "").trim();
    }
  }

  if (!soldText) {
    const alt = review?.review_compacted?.alt_text || "";
    const m = alt.match(/Más de ([^.]+) productos vendidos/i);
    if (m) soldText = `+${m[1].trim()} vendidos`;
  }

  return { rating, soldText };
}

function parseHighlight(card) {
  return component(card, "highlight")?.highlight?.text || null;
}

function parseTitle(card) {
  return component(card, "title")?.title?.text || null;
}

function parsePrice(card) {
  const price = component(card, "price")?.price || {};
  const current = price?.current_price?.value ?? null;
  const previous = price?.previous_price?.value ?? null;
  const discountText = price?.discount_label?.text || "";

  let discountPct = null;
  const m = discountText.match(/(\d+(?:[.,]\d+)?)\s*%/);

  if (m) {
    discountPct = Number(m[1].replace(",", "."));
  } else if (current !== null && previous) {
    discountPct = Number((((previous - current) / previous) * 100).toFixed(2));
  }

  return { current, previous, discountPct };
}

function buildProductUrl(card) {
  const meta = card?.metadata || {};
  if (!meta.url) return null;

  let url = meta.url.startsWith("http") ? meta.url : `https://${meta.url}`;
  if (meta.url_params) url += meta.url_params;
  return url;
}

function normalizeAffiliateCard(card) {
  const meta = card?.metadata || {};
  const title = parseTitle(card);
  const { current, previous, discountPct } = parsePrice(card);
  const commissionPct = parseCommission(card);
  const { rating, soldText } = parseRatingAndSold(card);
  const highlight = parseHighlight(card);

  if (!title || !meta.product_id) return null;

  return {
    external_product_id: meta.product_id || null,
    item_id: meta.id || null,
    title,
    product_url: buildProductUrl(card),
    current_price: current,
    previous_price: previous,
    discount_pct: discountPct,
    commission_pct: commissionPct,
    sold_text: soldText,
    rating,
    highlight,
    offer_score: calcOfferScore({
      discount_pct: discountPct || 0,
      commission_pct: commissionPct || 0,
      rating: rating || 0,
      highlight: highlight || "",
      sold_text: soldText || ""
    }),
    status: "ESPERANDO_LINK",
    source: "affiliate_portal_json"
  };
}

export default async function handler(req, res) {
  try {
    const sql = await ensureOffersSchema();

    if (req.method === "GET") {
      const rows = await sql`
        SELECT * FROM offers_queue
        ORDER BY
          CASE status
            WHEN 'ESPERANDO_LINK' THEN 1
            WHEN 'NOTIFICADA' THEN 2
            WHEN 'LISTA_PARA_PUBLICAR' THEN 3
            WHEN 'DETECTADA' THEN 4
            WHEN 'PUBLICADA' THEN 5
            ELSE 6
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
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ ok: false, error: "method_not_allowed" });
    }

    const body = req.body || {};
    const action = body.action || "create";

    if (action === "import_affiliates") {
      const payload = body.payload;
      const cards = payload?.polycard_client_model?.polycards;

      if (!Array.isArray(cards)) {
        return res.status(400).json({
          ok: false,
          error: "missing_polycards",
          message: "No encontré polycard_client_model.polycards en el JSON."
        });
      }

      const normalized = cards.map(normalizeAffiliateCard).filter(Boolean);

      const existingRows = await sql`
        SELECT id, external_product_id, status, affiliate_url, published_at
        FROM offers_queue
        WHERE external_product_id IS NOT NULL
      `;

      const existingMap = new Map(
        existingRows.map(row => [String(row.external_product_id), row])
      );

      let inserted = 0;
      let updated = 0;

      for (const o of normalized) {
        const existing = existingMap.get(String(o.external_product_id));

        if (existing) {
          await sql`
            UPDATE offers_queue
            SET
              item_id = ${o.item_id},
              title = ${o.title},
              product_url = ${o.product_url},
              current_price = ${o.current_price},
              previous_price = ${o.previous_price},
              discount_pct = ${o.discount_pct},
              commission_pct = ${o.commission_pct},
              sold_text = ${o.sold_text},
              rating = ${o.rating},
              highlight = ${o.highlight},
              offer_score = ${o.offer_score},
              source = ${o.source},
              updated_at = NOW()
            WHERE id = ${existing.id}
          `;
          updated++;
        } else {
          const rows = await sql`
            INSERT INTO offers_queue (
              external_product_id, item_id, title, product_url,
              current_price, previous_price, discount_pct, commission_pct,
              sold_text, rating, highlight, offer_score, status, source
            )
            VALUES (
              ${o.external_product_id}, ${o.item_id}, ${o.title}, ${o.product_url},
              ${o.current_price}, ${o.previous_price}, ${o.discount_pct}, ${o.commission_pct},
              ${o.sold_text}, ${o.rating}, ${o.highlight}, ${o.offer_score},
              ${o.status}, ${o.source}
            )
            RETURNING id
          `;
          existingMap.set(String(o.external_product_id), {
            id: rows[0].id,
            external_product_id: o.external_product_id
          });
          inserted++;
        }
      }

      return res.status(200).json({
        ok: true,
        found: cards.length,
        normalized: normalized.length,
        inserted,
        updated
      });
    }

    if (action === "update") {
      const id = Number(body.id);
      if (!id) return res.status(400).json({ ok: false, error: "missing_id" });

      if (body.status && !ALLOWED_STATUS.has(body.status)) {
        return res.status(400).json({ ok: false, error: "invalid_status" });
      }

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
    }

    if (action === "delete") {
      const id = Number(body.id);
      if (!id) return res.status(400).json({ ok: false, error: "missing_id" });

      await sql`DELETE FROM offers_queue WHERE id = ${id}`;
      return res.status(200).json({ ok: true, deleted_id: id });
    }

    if (action === "delete_test_offers") {
      const rows = await sql`
        DELETE FROM offers_queue
        WHERE source = 'manual_test'
        RETURNING id
      `;

      return res.status(200).json({
        ok: true,
        deleted: rows.length
      });
    }

    return res.status(400).json({ ok: false, error: "invalid_action" });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      message: err?.message || "Error inesperado."
    });
  }
}
