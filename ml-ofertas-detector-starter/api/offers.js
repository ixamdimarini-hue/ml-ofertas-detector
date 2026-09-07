import { ensureOffersSchema, calcOfferScore } from "../lib/offers.js";

const ALLOWED_STATUS = new Set([
  "DETECTADA",
  "ESPERANDO_LINK",
  "LISTA_PARA_PUBLICAR",
  "PUBLICADA",
  "DESCARTADA"
]);

export default async function handler(req, res) {
  try {
    const sql = await ensureOffersSchema();

    if (req.method === "GET") {
      const status = String(req.query.status || "").trim();

      const rows = status
        ? await sql`
            SELECT * FROM offers_queue
            WHERE status = ${status}
            ORDER BY offer_score DESC NULLS LAST, updated_at DESC
            LIMIT 200
          `
        : await sql`
            SELECT * FROM offers_queue
            ORDER BY
              CASE status
                WHEN 'ESPERANDO_LINK' THEN 1
                WHEN 'LISTA_PARA_PUBLICAR' THEN 2
                WHEN 'DETECTADA' THEN 3
                WHEN 'PUBLICADA' THEN 4
                ELSE 5
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

    if (req.method === "POST") {
      const body = req.body || {};
      const action = body.action || "create";

      if (action === "create") {
        if (!body.title) {
          return res.status(400).json({
            ok: false,
            error: "missing_title",
            message: "title es obligatorio."
          });
        }

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
      }

      if (action === "update") {
        const id = Number(body.id);

        if (!id) {
          return res.status(400).json({
            ok: false,
            error: "missing_id",
            message: "id es obligatorio."
          });
        }

        if (body.status && !ALLOWED_STATUS.has(body.status)) {
          return res.status(400).json({
            ok: false,
            error: "invalid_status"
          });
        }

        const currentRows = await sql`
          SELECT * FROM offers_queue WHERE id = ${id} LIMIT 1
        `;

        if (!currentRows.length) {
          return res.status(404).json({
            ok: false,
            error: "offer_not_found"
          });
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

      return res.status(400).json({
        ok: false,
        error: "invalid_action"
      });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({
      ok: false,
      error: "method_not_allowed"
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
