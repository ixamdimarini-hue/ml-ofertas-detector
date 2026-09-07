import { ensureOffersSchema, calcOfferScore } from "../../lib/offers.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  try {
    const body = req.body || {};

    if (!body.title) {
      return res.status(400).json({
        ok: false,
        error: "missing_title",
        message: "title es obligatorio."
      });
    }

    const sql = await ensureOffersSchema();

    const score = body.offer_score ?? calcOfferScore({
      discount_pct: body.discount_pct,
      commission_pct: body.commission_pct,
      rating: body.rating,
      highlight: body.highlight,
      sold_text: body.sold_text
    });

    const rows = await sql`
      INSERT INTO offers_queue (
        external_product_id,
        item_id,
        title,
        product_url,
        current_price,
        previous_price,
        discount_pct,
        commission_pct,
        sold_text,
        rating,
        highlight,
        offer_score,
        affiliate_url,
        status,
        source
      )
      VALUES (
        ${body.external_product_id || null},
        ${body.item_id || null},
        ${body.title},
        ${body.product_url || null},
        ${body.current_price ?? null},
        ${body.previous_price ?? null},
        ${body.discount_pct ?? null},
        ${body.commission_pct ?? null},
        ${body.sold_text || null},
        ${body.rating ?? null},
        ${body.highlight || null},
        ${score},
        ${body.affiliate_url || null},
        ${body.status || "DETECTADA"},
        ${body.source || "manual"}
      )
      RETURNING *
    `;

    return res.status(201).json({ ok: true, offer: rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      ok: false,
      error: "internal_error",
      message: err?.message || "Error inesperado."
    });
  }
}
