import { ensureOffersSchema, calcOfferScore } from "../lib/offers.js";

const ALLOWED_STATUS = new Set([
  "DETECTADA",
  "ESPERANDO_LINK",
  "NOTIFICADA",
  "LISTA_PARA_PUBLICAR",
  "PUBLICADA",
  "DESCARTADA"
]);

const SMART_COOLDOWN_HOURS = 24;
const BREAK_COOLDOWN_SCORE_GAIN = 12;
const BREAK_COOLDOWN_PRICE_DROP_PCT = 15;

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
    if (rating === null && /^\d+(?:[.,]\d+)?$/.test(text.trim())) rating = Number(text.replace(",", "."));
    if (text.toLowerCase().includes("vendid")) soldText = text.replace(/^\|\s*/, "").trim();
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
  if (m) discountPct = Number(m[1].replace(",", "."));
  else if (current !== null && previous) discountPct = Number((((previous - current) / previous) * 100).toFixed(2));
  return { current, previous, discountPct };
}

function buildProductUrl(card) {
  const meta = card?.metadata || {};
  if (!meta.url) return null;
  let url = meta.url.startsWith("http") ? meta.url : `https://${meta.url}`;
  if (meta.url_params) url += meta.url_params;
  return url;
}

function cleanTitleWords(title) {
  const stop = new Set([
    "color","negro","negra","blanco","blanca","azul","rojo","roja","gris","verde","rosa",
    "nuevo","nueva","original","oficial","con","sin","para","de","del","la","el","los","las","y","en",
    "unidad","unidades","pack","combo","kit","incluye","edition","edicion","versión","version"
  ]);

  return String(title || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 1 && !stop.has(w));
}

function familyKey(title) {
  const words = cleanTitleWords(title);
  if (!words.length) return "sin-familia";

  // Conserva marca/modelo y evita que color, accesorios o copy comercial creen familias distintas.
  const modelLike = words.filter(w => /[a-z]/.test(w) && /\d/.test(w));
  const base = [];
  if (words[0]) base.push(words[0]);
  for (const w of modelLike) if (!base.includes(w)) base.push(w);
  for (const w of words) {
    if (base.length >= 4) break;
    if (!base.includes(w)) base.push(w);
  }
  return base.slice(0, 4).join("-");
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
    family_key: familyKey(title),
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
    source: "affiliate_portal_json"
  };
}

function betterOffer(a, b) {
  const score = Number(b.offer_score || 0) - Number(a.offer_score || 0);
  if (score !== 0) return score;
  const discount = Number(b.discount_pct || 0) - Number(a.discount_pct || 0);
  if (discount !== 0) return discount;
  const commission = Number(b.commission_pct || 0) - Number(a.commission_pct || 0);
  if (commission !== 0) return commission;
  const rating = Number(b.rating || 0) - Number(a.rating || 0);
  if (rating !== 0) return rating;
  return Number(a.current_price || Infinity) - Number(b.current_price || Infinity);
}

function canBreakCooldown(candidate, recent) {
  if (!recent) return false;
  const scoreGain = Number(candidate.offer_score || 0) - Number(recent.offer_score || 0);
  const oldPrice = Number(recent.current_price || 0);
  const newPrice = Number(candidate.current_price || 0);
  const priceDropPct = oldPrice > 0 && newPrice > 0 ? ((oldPrice - newPrice) / oldPrice) * 100 : 0;
  return scoreGain >= BREAK_COOLDOWN_SCORE_GAIN || priceDropPct >= BREAK_COOLDOWN_PRICE_DROP_PCT;
}

async function ensureSmartColumns(sql) {
  await sql`ALTER TABLE offers_queue ADD COLUMN IF NOT EXISTS family_key TEXT`;
  await sql`ALTER TABLE offers_queue ADD COLUMN IF NOT EXISTS selection_reason TEXT`;
  await sql`ALTER TABLE offers_queue ADD COLUMN IF NOT EXISTS selected_at TIMESTAMPTZ`;
}

export default async function handler(req, res) {
  try {
    const sql = await ensureOffersSchema();
    await ensureSmartColumns(sql);

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
        LIMIT 300
      `;
      return res.status(200).json({ ok: true, count: rows.length, offers: rows });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ ok: false, error: "method_not_allowed" });
    }

    const body = req.body || {};
    const action = body.action || "create";

    if (action === "import_affiliates") {
      const cards = body.payload?.polycard_client_model?.polycards;
      if (!Array.isArray(cards)) {
        return res.status(400).json({ ok: false, error: "missing_polycards", message: "No encontré polycard_client_model.polycards en el JSON." });
      }

      const normalized = cards.map(normalizeAffiliateCard).filter(Boolean);
      const groups = new Map();
      for (const o of normalized) {
        if (!groups.has(o.family_key)) groups.set(o.family_key, []);
        groups.get(o.family_key).push(o);
      }

      const batchWinners = new Map();
      for (const [key, list] of groups) batchWinners.set(key, [...list].sort(betterOffer)[0]);

      const existingRows = await sql`
        SELECT id, external_product_id, status, affiliate_url, published_at,
               title, family_key, offer_score, current_price, selected_at, updated_at
        FROM offers_queue
        WHERE external_product_id IS NOT NULL
      `;
      const existingMap = new Map(existingRows.map(row => [String(row.external_product_id), row]));

      // Para filas antiguas creadas antes de esta versión, inferimos la familia en memoria.
      for (const row of existingRows) if (!row.family_key) row.family_key = familyKey(row.title);

      const recentCutoff = Date.now() - SMART_COOLDOWN_HOURS * 60 * 60 * 1000;
      const recentByFamily = new Map();
      for (const row of existingRows) {
        if (!["NOTIFICADA","LISTA_PARA_PUBLICAR","PUBLICADA"].includes(row.status)) continue;
        const when = new Date(row.selected_at || row.updated_at || 0).getTime();
        if (!Number.isFinite(when) || when < recentCutoff) continue;
        const prev = recentByFamily.get(row.family_key);
        if (!prev || new Date(prev.selected_at || prev.updated_at || 0) < new Date(row.selected_at || row.updated_at || 0)) {
          recentByFamily.set(row.family_key, row);
        }
      }

      let inserted = 0;
      let updated = 0;
      let selected = 0;
      let held = 0;
      let cooldownHeld = 0;

      for (const o of normalized) {
        const winner = batchWinners.get(o.family_key);
        const isBatchWinner = winner?.external_product_id === o.external_product_id;
        const recent = recentByFamily.get(o.family_key);
        const breakCooldown = isBatchWinner && recent && canBreakCooldown(o, recent);
        const shouldSelect = isBatchWinner && (!recent || breakCooldown);

        let targetStatus = shouldSelect ? "ESPERANDO_LINK" : "DETECTADA";
        let reason = shouldSelect
          ? (breakCooldown ? "Mejoró claramente una oferta reciente" : "Mejor oferta de su grupo")
          : (recent ? `En espera: familia publicada/notificada en las últimas ${SMART_COOLDOWN_HOURS}h` : "En espera: hay una oferta mejor del mismo grupo");

        const existing = existingMap.get(String(o.external_product_id));
        if (existing) {
          // No retrocedemos estados ya avanzados por el usuario/n8n.
          const protectedStatus = ["NOTIFICADA","LISTA_PARA_PUBLICAR","PUBLICADA","DESCARTADA"].includes(existing.status);
          if (protectedStatus) targetStatus = existing.status;

          await sql`
            UPDATE offers_queue
            SET item_id=${o.item_id}, title=${o.title}, family_key=${o.family_key}, product_url=${o.product_url},
                current_price=${o.current_price}, previous_price=${o.previous_price}, discount_pct=${o.discount_pct},
                commission_pct=${o.commission_pct}, sold_text=${o.sold_text}, rating=${o.rating}, highlight=${o.highlight},
                offer_score=${o.offer_score}, source=${o.source}, status=${targetStatus}, selection_reason=${reason},
                selected_at=${shouldSelect && !protectedStatus ? new Date().toISOString() : (existing.selected_at || null)},
                updated_at=NOW()
            WHERE id=${existing.id}
          `;
          updated++;
        } else {
          const rows = await sql`
            INSERT INTO offers_queue (
              external_product_id,item_id,title,family_key,product_url,current_price,previous_price,
              discount_pct,commission_pct,sold_text,rating,highlight,offer_score,status,source,selection_reason,selected_at
            ) VALUES (
              ${o.external_product_id},${o.item_id},${o.title},${o.family_key},${o.product_url},${o.current_price},${o.previous_price},
              ${o.discount_pct},${o.commission_pct},${o.sold_text},${o.rating},${o.highlight},${o.offer_score},${targetStatus},${o.source},${reason},
              ${shouldSelect ? new Date().toISOString() : null}
            ) RETURNING id
          `;
          existingMap.set(String(o.external_product_id), { id: rows[0].id, status: targetStatus, family_key: o.family_key });
          inserted++;
        }

        if (shouldSelect) selected++;
        else {
          held++;
          if (recent) cooldownHeld++;
        }
      }

      return res.status(200).json({
        ok: true,
        found: cards.length,
        normalized: normalized.length,
        inserted,
        updated,
        selected,
        held,
        cooldown_held: cooldownHeld,
        groups: groups.size,
        smart_selection: {
          cooldown_hours: SMART_COOLDOWN_HOURS,
          break_score_gain: BREAK_COOLDOWN_SCORE_GAIN,
          break_price_drop_pct: BREAK_COOLDOWN_PRICE_DROP_PCT
        }
      });
    }

    if (action === "update") {
      const id = Number(body.id);
      if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
      if (body.status && !ALLOWED_STATUS.has(body.status)) return res.status(400).json({ ok: false, error: "invalid_status" });

      const currentRows = await sql`SELECT * FROM offers_queue WHERE id=${id} LIMIT 1`;
      if (!currentRows.length) return res.status(404).json({ ok: false, error: "offer_not_found" });
      const current = currentRows[0];
      const nextStatus = body.status || current.status;
      const nextAffiliate = body.affiliate_url !== undefined ? body.affiliate_url : current.affiliate_url;
      const publishedAt = nextStatus === "PUBLICADA" ? (current.published_at || new Date().toISOString()) : current.published_at;

      const rows = await sql`
        UPDATE offers_queue
        SET affiliate_url=${nextAffiliate || null}, status=${nextStatus}, published_at=${publishedAt}, updated_at=NOW()
        WHERE id=${id}
        RETURNING *
      `;
      return res.status(200).json({ ok: true, offer: rows[0] });
    }

    if (action === "delete") {
      const id = Number(body.id);
      if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
      await sql`DELETE FROM offers_queue WHERE id=${id}`;
      return res.status(200).json({ ok: true, deleted_id: id });
    }

    if (action === "delete_test_offers") {
      const rows = await sql`DELETE FROM offers_queue WHERE source='manual_test' RETURNING id`;
      return res.status(200).json({ ok: true, deleted: rows.length });
    }

    return res.status(400).json({ ok: false, error: "invalid_action" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "internal_error", message: err?.message || "Error inesperado." });
  }
}
