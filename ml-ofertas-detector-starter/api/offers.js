import { createHash } from "node:crypto";
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
const MAX_SELECTED_PER_IMPORT = 1;
const SIMILAR_BATCH_WINDOW_MINUTES = 15;
const SIMILAR_BATCH_OVERLAP_THRESHOLD = 0.70;

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

  const installments = price?.installments || null;
  const installmentsText = installments?.text || null;
  const noInterest = typeof installments?.no_interest === "boolean"
    ? installments.no_interest
    : null;

  let installmentsCount = null;
  if (installmentsText) {
    const countMatch = installmentsText.match(/(\d+)\s+cuotas?/i);
    if (countMatch) installmentsCount = Number(countMatch[1]);
  }

  let installmentAmount = null;
  const installmentValues = Array.isArray(installments?.values) ? installments.values : [];
  for (const value of installmentValues) {
    const amount = value?.price?.value;
    if (amount !== undefined && amount !== null && Number.isFinite(Number(amount))) {
      installmentAmount = Number(amount);
      break;
    }
  }

  return {
    current,
    previous,
    discountPct,
    installmentsText,
    installmentsCount,
    installmentAmount,
    noInterest
  };
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

function familyTokens(title) {
  const words = cleanTitleWords(title);
  const aliases = [];
  const joined = ` ${words.join(" ")} `;

  // Familias muy comunes: normaliza formas distintas de nombrar el mismo producto.
  if (/\b(playstation|ps)\s*5\b|\bps5\b/.test(joined)) return ["playstation", "5"];
  if (/\b(playstation|ps)\s*4\b|\bps4\b/.test(joined)) return ["playstation", "4"];
  if (/\bxbox\b/.test(joined) && /\bseries\b/.test(joined)) {
    if (/\bseries\s*x\b/.test(joined)) return ["xbox", "series", "x"];
    if (/\bseries\s*s\b/.test(joined)) return ["xbox", "series", "s"];
  }

  const iphone = joined.match(/\biphone\s*(\d{1,2})\b/);
  if (iphone) return ["iphone", iphone[1]];

  // Conserva términos de modelo fuertes (letras+números) y las primeras palabras útiles.
  const modelLike = words.filter(w => /[a-z]/.test(w) && /\d/.test(w));
  for (const w of modelLike) if (!aliases.includes(w)) aliases.push(w);
  for (const w of words) {
    if (aliases.length >= 5) break;
    if (!aliases.includes(w)) aliases.push(w);
  }
  return aliases;
}

function familyKey(title) {
  const tokens = familyTokens(title);
  return tokens.length ? tokens.slice(0, 5).join("-") : "sin-familia";
}

function sameFamilyTitle(aTitle, bTitle) {
  const a = familyTokens(aTitle);
  const b = familyTokens(bTitle);
  if (!a.length || !b.length) return false;

  // Si ambos caen en una firma canónica corta (ej. playstation-5), se consideran iguales.
  const aKey = a.slice(0, 3).join("-");
  const bKey = b.slice(0, 3).join("-");
  if (aKey === bKey) return true;

  const A = new Set(a);
  const B = new Set(b);
  let intersection = 0;
  for (const x of A) if (B.has(x)) intersection++;
  const union = new Set([...A, ...B]).size || 1;
  const jaccard = intersection / union;

  // Dos términos compartidos + similitud razonable alcanzan para tratarlos como la misma familia.
  return intersection >= 2 && jaccard >= 0.4;
}


function financingScore({ installments_count, no_interest, installments_text }) {
  const count = Number(installments_count || 0);
  const text = String(installments_text || "").toLowerCase();
  const interestFree = no_interest === true || text.includes("mismo precio") || text.includes("sin interés") || text.includes("sin interes");

  if (!count) return 0;

  if (interestFree) {
    if (count >= 12) return 10;
    if (count >= 9) return 8;
    if (count >= 6) return 6;
    if (count >= 3) return 3;
    return 2;
  }

  // Cuotas con interés: sirven como facilidad de pago, pero casi no pesan.
  if (count >= 12) return 1.5;
  if (count >= 6) return 1;
  if (count >= 3) return 0.5;
  return 0;
}

function calcOfferScoreWithFinancing(data) {
  const base = Number(calcOfferScore(data) || 0);
  const financing = financingScore(data);
  return Number(Math.min(100, base + financing).toFixed(1));
}

function normalizeAffiliateCard(card) {
  const meta = card?.metadata || {};
  const title = parseTitle(card);
  const { current, previous, discountPct, installmentsText, installmentsCount, installmentAmount, noInterest } = parsePrice(card);
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
    installments_text: installmentsText,
    installments_count: installmentsCount,
    installment_amount: installmentAmount,
    no_interest: noInterest,
    commission_pct: commissionPct,
    sold_text: soldText,
    rating,
    highlight,
    offer_score: calcOfferScoreWithFinancing({
      discount_pct: discountPct || 0,
      commission_pct: commissionPct || 0,
      rating: rating || 0,
      highlight: highlight || "",
      sold_text: soldText || "",
      installments_count: installmentsCount || 0,
      installments_text: installmentsText || "",
      no_interest: noInterest
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


function parseSoldApprox(text) {
  const s = String(text || "").toLowerCase().replace(/\./g, "").replace(/,/g, ".");
  const m = s.match(/([0-9]+(?:\.[0-9]+)?)(?:\s*)(mil|k)?/);
  if (!m) return 0;
  let n = Number(m[1]) || 0;
  if (m[2] === "mil" || m[2] === "k") n *= 1000;
  return n;
}

function scoreBreakdown(o) {
  const discount = Math.min(45, Math.max(0, Number(o.discount_pct || 0) * 1.5));
  const commission = Math.min(20, Math.max(0, Number(o.commission_pct || 0) * 2));
  const rating = Math.min(12, Math.max(0, (Number(o.rating || 0) / 5) * 12));
  const h = String(o.highlight || "").toUpperCase();
  const highlight = h.includes("MÁS VENDIDO") || h.includes("MAS VENDIDO") ? 10 : (h.includes("MÁS BUSCADO") || h.includes("MAS BUSCADO") ? 7 : 0);
  const sold = parseSoldApprox(o.sold_text);
  const sales = sold >= 10000 ? 8 : sold >= 5000 ? 7 : sold >= 1000 ? 6 : sold >= 500 ? 5 : sold >= 100 ? 4 : sold > 0 ? 2 : 0;
  const financing = financingScore(o);
  const baseTotal = Number((discount + commission + rating + highlight + sales).toFixed(1));
  return {
    discount: Number(discount.toFixed(1)),
    commission: Number(commission.toFixed(1)),
    rating: Number(rating.toFixed(1)),
    highlight,
    sales,
    financing: Number(financing.toFixed(1)),
    base_total: baseTotal,
    total: Number(o.offer_score || 0),
    financing_label: o.installments_count
      ? `${o.installments_count} cuotas${o.no_interest === true ? " sin interés" : ""}`
      : null
  };
}

function makeBatchId(normalized) {
  // Mismo conjunto de resultados = misma tanda lógica. Evita que una segunda
  // importación automática de la misma búsqueda elija "la siguiente mejor".
  const signature = [...normalized]
    .map(o => `${o.external_product_id}:${o.item_id || ""}`)
    .sort()
    .join("|");
  const hash = createHash("sha1").update(signature).digest("hex").slice(0, 16);
  return `batch_${hash}`;
}


function overlapRatio(currentIds, previousIds) {
  const A = new Set((currentIds || []).map(String));
  const B = new Set((previousIds || []).map(String));
  if (!A.size || !B.size) return 0;
  let intersection = 0;
  for (const id of A) if (B.has(id)) intersection++;
  return intersection / Math.min(A.size, B.size);
}

function findRecentSimilarBatch(normalized, existingRows) {
  const now = Date.now();
  const cutoff = now - SIMILAR_BATCH_WINDOW_MINUTES * 60 * 1000;
  const currentIds = normalized.map(o => String(o.external_product_id)).filter(Boolean);

  const groups = new Map();
  for (const row of existingRows) {
    if (!row.import_batch_id || !row.external_product_id) continue;
    const t = new Date(row.updated_at || 0).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    if (!groups.has(row.import_batch_id)) groups.set(row.import_batch_id, []);
    groups.get(row.import_batch_id).push(String(row.external_product_id));
  }

  let best = null;
  for (const [batchId, ids] of groups.entries()) {
    const overlap = overlapRatio(currentIds, ids);
    if (!best || overlap > best.overlap) best = { batchId, overlap };
  }

  return best && best.overlap >= SIMILAR_BATCH_OVERLAP_THRESHOLD ? best : null;
}

async function ensureSmartColumns(sql) {
  await sql`ALTER TABLE offers_queue ADD COLUMN IF NOT EXISTS family_key TEXT`;
  await sql`ALTER TABLE offers_queue ADD COLUMN IF NOT EXISTS selection_reason TEXT`;
  await sql`ALTER TABLE offers_queue ADD COLUMN IF NOT EXISTS selected_at TIMESTAMPTZ`;
  await sql`ALTER TABLE offers_queue ADD COLUMN IF NOT EXISTS import_batch_id TEXT`;
  await sql`ALTER TABLE offers_queue ADD COLUMN IF NOT EXISTS selection_rank INTEGER`;
  await sql`ALTER TABLE offers_queue ADD COLUMN IF NOT EXISTS selection_details JSONB`;
  await sql`ALTER TABLE offers_queue ADD COLUMN IF NOT EXISTS installments_text TEXT`;
  await sql`ALTER TABLE offers_queue ADD COLUMN IF NOT EXISTS installments_count INTEGER`;
  await sql`ALTER TABLE offers_queue ADD COLUMN IF NOT EXISTS installment_amount NUMERIC`;
  await sql`ALTER TABLE offers_queue ADD COLUMN IF NOT EXISTS no_interest BOOLEAN`;
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
      const importBatchId = makeBatchId(normalized);

      const existingRows = await sql`
        SELECT id, external_product_id, status, affiliate_url, published_at,
               title, family_key, offer_score, current_price, selected_at, updated_at, import_batch_id
        FROM offers_queue
        WHERE external_product_id IS NOT NULL
      `;
      const existingMap = new Map(existingRows.map(row => [String(row.external_product_id), row]));

      for (const row of existingRows) if (!row.family_key) row.family_key = familyKey(row.title);

      const recentCutoff = Date.now() - SMART_COOLDOWN_HOURS * 60 * 60 * 1000;
      const recentRows = existingRows.filter(row =>
        ["NOTIFICADA","LISTA_PARA_PUBLICAR","PUBLICADA"].includes(row.status) &&
        new Date(row.selected_at || row.updated_at || 0).getTime() >= recentCutoff
      );

      // V3: cada búsqueda/importación funciona como una tanda.
      // Elegimos como máximo UNA oferta para notificar: la mejor candidata elegible de toda la tanda.
      // El resto queda guardado en DETECTADA para estudio, evitando cataratas de productos similares.
      const ranked = [...normalized].sort(betterOffer);
      const rankMap = new Map(ranked.map((o, i) => [String(o.external_product_id), i + 1]));
      const selectedIds = new Set();

      // Anti-repetición de tanda: algunas páginas del portal disparan la misma
      // búsqueda más de una vez. Si esta tanda ya tuvo una oferta avanzada en
      // las últimas 24h, no seleccionamos una segunda candidata del mismo lote.
      const exactRepeatedBatch = existingRows.some(row =>
        row.import_batch_id === importBatchId &&
        ["NOTIFICADA","LISTA_PARA_PUBLICAR","PUBLICADA"].includes(row.status) &&
        new Date(row.selected_at || row.updated_at || 0).getTime() >= recentCutoff
      );

      // Mercado Libre puede volver a disparar casi la misma búsqueda con uno o dos
      // resultados rotados. El hash exacto cambia, pero para nosotros sigue siendo
      // la misma tanda. Si comparte >=70% de productos con una tanda de los últimos
      // 15 minutos, no elegimos una nueva ganadora.
      const similarBatch = findRecentSimilarBatch(normalized, existingRows);
      const repeatedBatch = exactRepeatedBatch || Boolean(similarBatch);

      if (!repeatedBatch && ranked.length) {
        // Regla estricta: SOLO puede avanzar el puesto #1 de la tanda.
        // Antes, si el #1 estaba bloqueado por cooldown o ya había avanzado,
        // el sistema saltaba al #2, #3, etc. Eso podía generar alertas extra.
        // Ahora, si el #1 no es elegible, esta tanda no publica ninguna alternativa.
        const candidate = ranked[0];
        const existing = existingMap.get(String(candidate.external_product_id));

        const protectedStatus = existing &&
          ["NOTIFICADA","LISTA_PARA_PUBLICAR","PUBLICADA","DESCARTADA"].includes(existing.status);

        if (!protectedStatus) {
          const recent = recentRows.find(row => sameFamilyTitle(row.title, candidate.title)) || null;
          if (!recent || canBreakCooldown(candidate, recent)) {
            selectedIds.add(String(candidate.external_product_id));
          }
        }
      }

      let inserted = 0;
      let updated = 0;
      let selected = 0;
      let held = 0;
      let cooldownHeld = 0;

      for (const o of normalized) {
        const shouldSelect = selectedIds.has(String(o.external_product_id));
        const recent = recentRows.find(row => sameFamilyTitle(row.title, o.title)) || null;
        const breakCooldown = shouldSelect && recent && canBreakCooldown(o, recent);
        const selectionRank = rankMap.get(String(o.external_product_id)) || null;

        let targetStatus = shouldSelect ? "ESPERANDO_LINK" : "DETECTADA";
        let reason = shouldSelect
          ? (breakCooldown ? "Mejoró claramente una oferta reciente" : "Mejor oferta de toda la búsqueda")
          : (repeatedBatch
              ? `En espera: esta misma tanda ya tuvo una oferta seleccionada en las últimas ${SMART_COOLDOWN_HOURS}h`
              : (recent
                ? `En espera: familia publicada/notificada en las últimas ${SMART_COOLDOWN_HOURS}h`
                : (selectionRank === 1
                    ? "En espera: el puesto #1 no era elegible para publicar"
                    : "En estudio: solo avanza el puesto #1 de esta búsqueda")));

        const existing = existingMap.get(String(o.external_product_id));
        const selectionDetails = {
          batch_id: importBatchId,
          rank: selectionRank,
          total_candidates: ranked.length,
          selected: shouldSelect,
          score_breakdown: scoreBreakdown(o),
          cooldown_blocked: Boolean(recent && !breakCooldown && !shouldSelect),
          cooldown_hours: SMART_COOLDOWN_HOURS,
          repeated_batch: repeatedBatch,
          repeated_batch_reason: exactRepeatedBatch ? "exact" : (similarBatch ? "similar" : null),
          similar_batch_id: similarBatch?.batchId || null,
          similar_batch_overlap: similarBatch ? Number(similarBatch.overlap.toFixed(3)) : null
        };
        if (existing) {
          // No retrocedemos estados ya avanzados por el usuario/n8n.
          const protectedStatus = ["NOTIFICADA","LISTA_PARA_PUBLICAR","PUBLICADA","DESCARTADA"].includes(existing.status);
          if (protectedStatus) targetStatus = existing.status;

          await sql`
            UPDATE offers_queue
            SET item_id=${o.item_id}, title=${o.title}, family_key=${o.family_key}, product_url=${o.product_url},
                current_price=${o.current_price}, previous_price=${o.previous_price}, discount_pct=${o.discount_pct},
                installments_text=${o.installments_text}, installments_count=${o.installments_count},
                installment_amount=${o.installment_amount}, no_interest=${o.no_interest},
                commission_pct=${o.commission_pct}, sold_text=${o.sold_text}, rating=${o.rating}, highlight=${o.highlight},
                offer_score=${o.offer_score}, source=${o.source}, status=${targetStatus}, selection_reason=${reason},
                selected_at=${shouldSelect && !protectedStatus ? new Date().toISOString() : (existing.selected_at || null)},
                import_batch_id=${importBatchId}, selection_rank=${selectionRank}, selection_details=${JSON.stringify(selectionDetails)}::jsonb,
                updated_at=NOW()
            WHERE id=${existing.id}
          `;
          updated++;
        } else {
          const rows = await sql`
            INSERT INTO offers_queue (
              external_product_id,item_id,title,family_key,product_url,current_price,previous_price,
              discount_pct,installments_text,installments_count,installment_amount,no_interest,
              commission_pct,sold_text,rating,highlight,offer_score,status,source,selection_reason,selected_at,
              import_batch_id,selection_rank,selection_details
            ) VALUES (
              ${o.external_product_id},${o.item_id},${o.title},${o.family_key},${o.product_url},${o.current_price},${o.previous_price},
              ${o.discount_pct},${o.installments_text},${o.installments_count},${o.installment_amount},${o.no_interest},
              ${o.commission_pct},${o.sold_text},${o.rating},${o.highlight},${o.offer_score},${targetStatus},${o.source},${reason},
              ${shouldSelect ? new Date().toISOString() : null},${importBatchId},${selectionRank},${JSON.stringify(selectionDetails)}::jsonb
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
        selected_limit_per_import: MAX_SELECTED_PER_IMPORT,
        import_batch_id: importBatchId,
        repeated_batch: repeatedBatch,
        repeated_batch_reason: exactRepeatedBatch ? "exact" : (similarBatch ? "similar" : null),
        similar_batch_id: similarBatch?.batchId || null,
        similar_batch_overlap: similarBatch ? Number(similarBatch.overlap.toFixed(3)) : null,
        smart_selection: {
          cooldown_hours: SMART_COOLDOWN_HOURS,
          break_score_gain: BREAK_COOLDOWN_SCORE_GAIN,
          break_price_drop_pct: BREAK_COOLDOWN_PRICE_DROP_PCT,
          max_selected_per_import: MAX_SELECTED_PER_IMPORT,
          similar_batch_window_minutes: SIMILAR_BATCH_WINDOW_MINUTES,
          similar_batch_overlap_threshold: SIMILAR_BATCH_OVERLAP_THRESHOLD
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
