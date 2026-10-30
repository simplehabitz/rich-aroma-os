// api/lib/inventory-engine.js
// ---------------------------------------------------------------------------
// INVENTORY CORE (2026-10-30, Oct 30–Nov 2 build) — the engine behind
// RECIPE-INVENTORY-DESIGN.md §1–§3, §7b/§7f–§7k:
//
//   * Stock is a LEDGER (stock_movements), never a field someone edits.
//     inventory.current_stock is the ledger's cache, updated in the same
//     breath as every movement insert.
//   * Three events move stock (§2): purchase (intake), batch production
//     (Producción), sale (one level deep, at PAID). Plus the honest
//     corrections: transfer between storage states, waste (merma), and
//     the weekly count_adjust.
//   * Lots (§7b/§7f): receipts and batches create lots; out-movements
//     draw FEFO (first-expiry-first-out), never from an expired lot.
//     A transfer splits a lot and re-clocks the destination expiry from
//     the item's per-state shelf life.
//   * Costs (§3/§7j): intake's price PAID rewrites cost_per_unit —
//     receiving IS the price update. Prep costs re-derive from their
//     lines; menu food costs mirror the /admin margin chip exactly
//     (one level, stored prep costs), so the drift flag and the admin
//     readout can never disagree. Past 35% COGS (30 target + 5 drift)
//     the item flags AND the owner hears about it on WhatsApp at the
//     moment the intake posts. The system NEVER reprices by itself.
//   * Every movement carries a name (§7h): by_employee / by_name are
//     the actor's PIN identity. Attribution is recognition, not
//     surveillance — it proves who did the work.
//   * Failure doctrine (same as rico-loyalty): the sale hook is
//     failure-silent (a bookkeeping gap never blocks a customer) and
//     idempotent per order via the ledger's unique key; intake and
//     production REFUSE loudly on guardrail violations instead.
//
// Callers: api/admin.js (the ops actions), api/lib/order-service.js
// (born-paid orders), api/store.js (orders that turn paid later, and
// store-born paid orders). No new top-level api/*.js files — this is a
// lib, per the 12-endpoint cap (FUNCTIONS-12).
// ---------------------------------------------------------------------------

const { supabase: defaultSupabase } = require('./supabase');

const DRIFT_LIMIT_PCT = 35;      // §7j: 30% target + 5 pts of drift
const TARGET_COGS = 0.30;        // §3b: sugerido = costo ÷ 30%, nearest L.5
const RESTAURANT = 'rich-aroma'; // the engine serves the shop tenant

function round4(n) { return Math.round((parseFloat(n) || 0) * 10000) / 10000; }
function round2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }
function num(n, dflt = 0) { const v = parseFloat(n); return Number.isFinite(v) ? v : dflt; }
function money(n) {
    const v = parseFloat(n) || 0;
    return 'L.' + (Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(2));
}

// ---------------------------------------------------------------------------
// Owner notifications — OS SIGNALS, the bot delivers (same doctrine as
// rico-loyalty's notifyLoyalty): the URL derives from BOT_NOTIFY_URL by
// swapping /order-notify → /owner-notify; inert + LOUD when the env is
// missing; failure-silent always. Kinds: 'drift' (§7j report),
// 'staff_alert' (§7i), 'sin_factura' (§7k.2 discipline report).
// ---------------------------------------------------------------------------

function botOwnerUrl() {
    const notify = (process.env.BOT_NOTIFY_URL || '').trim();
    if (!notify) return '';
    if (/\/order-notify\/?$/.test(notify)) return notify.replace(/\/order-notify\/?$/, '/owner-notify');
    return '';
}

async function notifyOwner(payload) {
    try {
        const url = botOwnerUrl();
        const secret = (process.env.WHATSAPP_SIGNUP_SECRET || '').trim();
        if (!url || !secret) {
            console.error(`[InvNotify] SKIPPED ${payload && payload.kind}: ${!url ? 'BOT_NOTIFY_URL (or its /order-notify shape)' : 'WHATSAPP_SIGNUP_SECRET'} not configured in this deployment's env`);
            return false;
        }
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + secret },
            body: JSON.stringify(payload)
        });
        if (!resp || !resp.ok) {
            console.error(`[InvNotify] bot rejected ${payload.kind}: HTTP ${resp && resp.status}`);
            return false;
        }
        return true;
    } catch (e) {
        console.error('[InvNotify] send failed (operation unaffected):', e && e.message);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Ledger primitives
// ---------------------------------------------------------------------------

async function getItem(supabase, inventoryItemId) {
    const { data } = await supabase.from('inventory').select('*')
        .eq('id', inventoryItemId).maybeSingle();
    return data || null;
}

async function applyStockCache(supabase, inventoryItemId, delta) {
    const item = await getItem(supabase, inventoryItemId);
    if (!item) return null;
    const next = round4(num(item.current_stock) + delta);
    await supabase.from('inventory').update({ current_stock: next }).eq('id', inventoryItemId);
    return next;
}

// FEFO draw (§7b): open lots, unexpired, earliest expiry first (lots
// without an expiry draw last, then oldest first). Expired lots are
// never consumed by a sale or a batch — the count walk forces the
// waste decision on them. Returns { drawn: [{lot, qty}], shortfall }.
async function drawLotsFEFO(supabase, inventoryItemId, qty, atIso) {
    const drawn = [];
    let remaining = round4(qty);
    if (remaining <= 0) return { drawn, shortfall: 0 };
    const { data: lots } = await supabase.from('stock_lots').select('*')
        .eq('inventory_item_id', inventoryItemId).gt('qty_left', 0);
    const now = atIso || new Date().toISOString();
    const usable = (lots || [])
        .filter(l => !l.expires_at || String(l.expires_at) > now)
        .sort((a, b) => {
            const ea = a.expires_at ? String(a.expires_at) : '9999';
            const eb = b.expires_at ? String(b.expires_at) : '9999';
            if (ea !== eb) return ea < eb ? -1 : 1;
            return String(a.created_at) < String(b.created_at) ? -1 : 1;
        });
    for (const lot of usable) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, num(lot.qty_left));
        if (take <= 0) continue;
        await supabase.from('stock_lots')
            .update({ qty_left: round4(num(lot.qty_left) - take) }).eq('id', lot.id);
        drawn.push({ lot, qty: take });
        remaining = round4(remaining - take);
    }
    return { drawn, shortfall: remaining };
}

async function createLot(supabase, lot) {
    const { data, error } = await supabase.from('stock_lots').insert({
        restaurant_id: lot.restaurantId || RESTAURANT,
        inventory_item_id: lot.inventoryItemId,
        qty_in: round4(lot.qty),
        qty_left: round4(lot.qty),
        unit_cost: lot.unitCost != null ? num(lot.unitCost) : null,
        state: lot.state || 'ambiente',
        source: lot.source || 'purchase',
        ref_id: lot.refId || null,
        expires_at: lot.expiresAt || null
    }).select().single();
    if (error) throw new Error('No se pudo crear el lote: ' + error.message);
    return data;
}

// One ledger row + the cache update, as one act. When refId is given,
// the (reason, ref_id, item) unique key makes the post idempotent: a
// retry finds the existing row and changes nothing.
async function postMovement(supabase, mv) {
    if (mv.refId) {
        const { data: existing } = await supabase.from('stock_movements').select('id')
            .eq('reason', mv.reason).eq('ref_id', mv.refId)
            .eq('inventory_item_id', mv.inventoryItemId).maybeSingle();
        if (existing) return { skipped: true, movement: existing };
    }
    const { data, error } = await supabase.from('stock_movements').insert({
        restaurant_id: mv.restaurantId || RESTAURANT,
        inventory_item_id: mv.inventoryItemId,
        delta: round4(mv.delta),
        reason: mv.reason,
        ref_type: mv.refType || null,
        ref_id: mv.refId || null,
        lot_id: mv.lotId || null,
        by_employee: mv.actor ? (mv.actor.id || null) : null,
        by_name: mv.actor ? (mv.actor.name || null) : null,
        note: mv.note || null
    }).select().single();
    if (error) {
        // Lost a race against the unique key — that IS the idempotent win.
        if (mv.refId && /23505|duplicate/i.test(error.code + ' ' + error.message)) {
            return { skipped: true, movement: null };
        }
        throw new Error('No se pudo registrar el movimiento: ' + error.message);
    }
    await applyStockCache(supabase, mv.inventoryItemId, mv.delta);
    return { skipped: false, movement: data };
}

// ---------------------------------------------------------------------------
// Costing (§3) — prep costs roll up from their lines; menu food costs
// mirror the /admin margin chip (one level, stored costs).
// ---------------------------------------------------------------------------

async function recomputePrepCosts(supabase, restaurantId) {
    const [{ data: recipes }, { data: lines }, { data: inv }] = await Promise.all([
        supabase.from('prep_recipes').select('*'),
        supabase.from('prep_recipe_lines').select('*'),
        supabase.from('inventory').select('id, slug, cost_per_unit, category')
    ]);
    const costBySlug = {};
    (inv || []).forEach(r => { if (r.slug) costBySlug[r.slug] = r.cost_per_unit == null ? null : num(r.cost_per_unit); });
    const byPrep = {};
    (lines || []).forEach(l => { (byPrep[l.prep_slug] = byPrep[l.prep_slug] || []).push(l); });
    const changed = {};
    // Prep recipes can chain (a prep consuming a prep) — iterate to a
    // fixpoint; depth in this catalog is 2–3.
    for (let pass = 0; pass < 6; pass++) {
        let dirty = false;
        for (const r of (recipes || [])) {
            const yieldQty = num(r.yield_qty);
            if (!(yieldQty > 0)) continue;
            let sum = 0, complete = true;
            for (const l of (byPrep[r.prep_slug] || [])) {
                const c = costBySlug[l.ingredient_slug];
                if (c === null || c === undefined) { complete = false; break; }
                sum += num(l.quantity) * c;
            }
            if (!complete) continue;
            const newCost = sum / yieldQty; // full precision; the column carries 8 decimals
            const prev = costBySlug[r.prep_slug];
            if (prev === null || prev === undefined || Math.abs(prev - newCost) > 0.000001) {
                costBySlug[r.prep_slug] = newCost;
                dirty = true;
            }
        }
        if (!dirty) break;
    }
    const invBySlug = {};
    (inv || []).forEach(r => { if (r.slug) invBySlug[r.slug] = r; });
    for (const r of (recipes || [])) {
        const row = invBySlug[r.prep_slug];
        const c = costBySlug[r.prep_slug];
        if (!row || c === null || c === undefined) continue;
        if (row.cost_per_unit == null || Math.abs(num(row.cost_per_unit) - c) > 0.000001) {
            await supabase.from('inventory').update({ cost_per_unit: c }).eq('id', row.id);
            changed[row.slug] = { old: row.cost_per_unit, new: c };
        }
    }
    return changed;
}

async function menuFoodCosts(supabase, restaurantId) {
    const [{ data: items }, { data: lines }, { data: inv }] = await Promise.all([
        supabase.from('menu_items').select('id, name, price').eq('restaurant_id', restaurantId || RESTAURANT),
        supabase.from('menu_item_ingredients').select('menu_item_id, inventory_item_id, quantity'),
        supabase.from('inventory').select('id, cost_per_unit')
    ]);
    const costOf = {};
    (inv || []).forEach(r => { costOf[r.id] = r.cost_per_unit == null ? null : num(r.cost_per_unit); });
    const byItem = {};
    (lines || []).forEach(l => { (byItem[l.menu_item_id] = byItem[l.menu_item_id] || []).push(l); });
    const out = new Map();
    (items || []).forEach(it => {
        const ls = byItem[it.id] || [];
        let sum = 0, priced = 0, unpriced = 0;
        ls.forEach(l => {
            const c = costOf[l.inventory_item_id];
            if (c === null || c === undefined) unpriced++;
            else { sum += num(l.quantity) * c; priced++; }
        });
        const price = num(it.price);
        const foodCost = priced > 0 ? round2(sum) : null;
        out.set(it.id, {
            id: it.id, name: it.name, price,
            has_recipe: ls.length > 0,
            food_cost: foodCost,
            partial: unpriced > 0,
            cogs_pct: (foodCost !== null && price > 0) ? round2(foodCost / price * 100) : null,
            suggested: foodCost !== null ? Math.round((foodCost / TARGET_COGS) / 5) * 5 : null
        });
    });
    return out;
}

// §7j step 3: compare before/after around a re-cost. Only a CROSSING
// (was ≤ 35, now > 35) flags + reports — an item already red stays in
// the Sunday review instead of re-shouting at every purchase.
async function checkDrift(supabase, opts) {
    const { restaurantId = RESTAURANT, before, cause, refId, actor } = opts || {};
    const after = await menuFoodCosts(supabase, restaurantId);
    const events = [];
    for (const [itemId, a] of after.entries()) {
        if (a.cogs_pct === null || a.partial) continue;
        const b = before ? before.get(itemId) : null;
        const wasPct = b ? b.cogs_pct : null;
        if (a.cogs_pct > DRIFT_LIMIT_PCT && (wasPct === null || wasPct <= DRIFT_LIMIT_PCT)) {
            events.push({
                menu_item_id: itemId, item_name: a.name,
                old_cogs_pct: wasPct, new_cogs_pct: a.cogs_pct,
                suggested_price: a.suggested, price: a.price, food_cost: a.food_cost
            });
        }
    }
    for (const ev of events) {
        await supabase.from('inventory_drift_flags').insert({
            restaurant_id: restaurantId,
            menu_item_id: ev.menu_item_id, item_name: ev.item_name,
            old_cogs_pct: ev.old_cogs_pct, new_cogs_pct: ev.new_cogs_pct,
            suggested_price: ev.suggested_price,
            cause: cause || 'intake', ref_id: refId || null,
            status: 'open'
        });
    }
    if (events.length > 0) {
        await notifyOwner({
            kind: 'drift', cause: cause || 'intake',
            by_name: actor ? actor.name : null,
            items: events.map(e => ({
                name: e.item_name,
                old_pct: e.old_cogs_pct, new_pct: e.new_cogs_pct,
                price: e.price, food_cost: e.food_cost, suggested: e.suggested_price
            }))
        });
    }
    return events;
}

// ---------------------------------------------------------------------------
// INTAKE (§7k) — receiving IS the price update.
// ---------------------------------------------------------------------------

function intakeError(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
}

// Validates the guardrails WITHOUT writing — powers the "Revisar"
// step of the Recibir flow (papel vs físico cross-check included).
async function previewIntake(supabase, input) {
    const lines = [];
    for (const raw of (input.lines || [])) {
        const pres = raw.presentacionId
            ? (await supabase.from('presentaciones').select('*').eq('id', raw.presentacionId).maybeSingle()).data
            : null;
        const insumoId = (pres && pres.inventory_item_id) || raw.inventoryItemId || null;
        if (!insumoId) throw intakeError('LINEA_SIN_INSUMO', 'Una tarjeta no tiene insumo. Elegí el insumo de cada tarjeta antes de confirmar.');
        const item = await getItem(supabase, insumoId);
        if (!item) throw intakeError('INSUMO_NO_EXISTE', 'Una tarjeta apunta a un insumo que ya no está en el catálogo.');
        const packs = num(raw.packs);
        const pricePerPack = num(raw.pricePerPack);
        if (!(packs > 0)) throw intakeError('CANTIDAD_INVALIDA', `La tarjeta de ${item.name} no tiene cantidad.`);
        if (!(pricePerPack > 0)) throw intakeError('PRECIO_INVALIDO', `La tarjeta de ${item.name} no tiene precio. El precio pagado es lo que actualiza el costo.`);
        const perPackContent = pres ? num(pres.contenido_total) : num(raw.contenidoTotal);
        if (!(perPackContent > 0)) throw intakeError('PAQUETE_SIN_CONTENIDO', `La presentación de ${item.name} no dice cuánto trae. Completala en Presentaciones.`);
        const qtyIn = round4(packs * perPackContent);
        lines.push({
            presentacionId: pres ? pres.id : null,
            presentacion: pres ? pres.descripcion : (raw.descripcion || 'Presentación nueva'),
            inventoryItemId: insumoId, insumoName: item.name, unit: item.unit,
            packs, pricePerPack,
            lineTotal: round2(packs * pricePerPack),
            qtyIn, unitCost: qtyIn > 0 ? (packs * pricePerPack) / qtyIn : 0,
            expiresAt: raw.expiresAt || null,
            papelQty: raw.papelQty != null ? num(raw.papelQty) : null
        });
    }
    // Papel contra físico (§7k.1): when the factura lines were entered
    // (by hand today; by the vision read when it lands), every mismatch
    // between what the paper says and what was scanned flags BEFORE
    // anything posts.
    const crosscheck = lines
        .filter(l => l.papelQty !== null)
        .map(l => ({
            insumo: l.insumoName, papel: l.papelQty, fisico: l.packs,
            ok: Math.abs(l.papelQty - l.packs) < 0.0001
        }));
    return {
        lines,
        crosscheck,
        total: round2(lines.reduce((s, l) => s + l.lineTotal, 0))
    };
}

async function postIntake(supabase, input) {
    const { restaurantId = RESTAURANT, actor } = input;
    // FACTURA GATE (§7k.1/§7k.2): the factura photo closes the purchase.
    // Sin factura, ONLY an Encargado-level override (tap + reason) on
    // this very call closes it — attributed and owner-reported.
    if (input.conFactura) {
        if (!input.facturaPhotoUrl) {
            throw intakeError('FACTURA_SIN_FOTO', 'Falta la foto de la factura. La factura es la constancia de la compra: sacale la foto para confirmar.');
        }
    } else {
        const ov = input.override || {};
        if (!ov.by || !String(ov.reason || '').trim()) {
            throw intakeError('SIN_FACTURA_SIN_OVERRIDE', 'Compra sin factura: solo se cierra con el toque del encargado y el motivo (ej: compra en el mercado).');
        }
    }
    const preview = await previewIntake(supabase, input);
    if (preview.lines.length === 0) {
        throw intakeError('SIN_LINEAS', 'La recepción no tiene tarjetas. Agregá al menos una.');
    }
    // §7j: snapshot the menu math BEFORE this purchase moves any cost.
    const before = await menuFoodCosts(supabase, restaurantId);

    const { data: batch, error: bErr } = await supabase.from('intake_batches').insert({
        restaurant_id: restaurantId,
        supplier: input.supplier || null,
        con_factura: !!input.conFactura,
        factura_photo_url: input.conFactura ? input.facturaPhotoUrl : null,
        override_by: !input.conFactura ? input.override.by : null,
        override_by_name: !input.conFactura ? (input.override.byName || null) : null,
        override_reason: !input.conFactura ? String(input.override.reason).trim() : null,
        by_employee: actor ? actor.id : null,
        by_name: actor ? actor.name : null,
        total: preview.total
    }).select().single();
    if (bErr) throw new Error('No se pudo guardar la recepción: ' + bErr.message);

    const posted = [];
    for (const l of preview.lines) {
        const lot = await createLot(supabase, {
            restaurantId, inventoryItemId: l.inventoryItemId, qty: l.qtyIn,
            unitCost: l.unitCost, state: 'ambiente', source: 'purchase',
            refId: batch.id, expiresAt: l.expiresAt ? new Date(l.expiresAt).toISOString() : null
        });
        const { data: lineRow } = await supabase.from('intake_lines').insert({
            batch_id: batch.id,
            presentacion_id: l.presentacionId,
            inventory_item_id: l.inventoryItemId,
            packs: l.packs, price_per_pack: l.pricePerPack,
            qty_in: l.qtyIn, unit_cost: l.unitCost,
            expires_at: l.expiresAt || null, lot_id: lot.id
        }).select().single();
        await postMovement(supabase, {
            restaurantId, inventoryItemId: l.inventoryItemId, delta: l.qtyIn,
            reason: 'purchase', refType: 'intake', refId: lineRow ? lineRow.id : batch.id,
            lotId: lot.id, actor,
            note: `${l.presentacion} × ${l.packs} — ${money(l.pricePerPack)} c/u`
        });
        // §7j step 1: the price PAID rewrites the insumo's unit cost.
        await supabase.from('inventory').update({
            cost_per_unit: l.unitCost, last_restock: new Date().toISOString(),
            supplier: input.supplier || undefined
        }).eq('id', l.inventoryItemId);
        if (l.presentacionId) {
            await supabase.from('presentaciones').update({
                last_price: l.pricePerPack, last_intake_at: new Date().toISOString()
            }).eq('id', l.presentacionId);
        }
        posted.push(l);
    }
    // §7j step 2: re-cost is immediate and total (preps roll up first).
    await recomputePrepCosts(supabase, restaurantId);
    const drift = await checkDrift(supabase, {
        restaurantId, before, cause: 'intake', refId: batch.id, actor
    });
    if (!input.conFactura) {
        await notifyOwner({
            kind: 'sin_factura',
            supplier: input.supplier || null,
            by_name: actor ? actor.name : null,
            override_by_name: input.override.byName || null,
            reason: String(input.override.reason).trim(),
            total: preview.total
        });
    }
    const summary = 'Recibido: ' + posted.map(l =>
        `${l.packs} × ${l.presentacion} de ${l.insumoName} (costo nuevo ${money(l.unitCost)} por ${l.unit})`
    ).join(' · ');
    return { batchId: batch.id, lines: posted, crosscheck: preview.crosscheck, drift, total: preview.total, summary };
}

// ---------------------------------------------------------------------------
// PRODUCCIÓN (§7g/§7f) — produce, move, waste.
// ---------------------------------------------------------------------------

async function produceBatch(supabase, input) {
    const { restaurantId = RESTAURANT, actor, prepSlug } = input;
    const batches = Math.max(1, Math.min(4, parseInt(input.batches) || 1)); // §7i ×1–×4
    const { data: recipe } = await supabase.from('prep_recipes').select('*')
        .eq('prep_slug', prepSlug).maybeSingle();
    if (!recipe) throw intakeError('RECETA_NO_EXISTE', 'Ese preparado no tiene receta cargada.');
    const { data: rLines } = await supabase.from('prep_recipe_lines').select('*')
        .eq('prep_slug', prepSlug);
    if (!rLines || rLines.length === 0) throw intakeError('RECETA_VACIA', 'La receta de ese preparado no tiene insumos.');
    const { data: prepRow } = await supabase.from('inventory').select('*')
        .eq('slug', prepSlug).maybeSingle();
    if (!prepRow) throw intakeError('PREP_NO_EXISTE', 'Ese preparado no está en el catálogo.');
    const actualYield = num(input.actualYieldQty);
    if (!(actualYield > 0)) throw intakeError('RENDIMIENTO_INVALIDO', 'Contanos cuántas salieron: el rendimiento real es lo que hace honesto el costo.');

    const runId = 'run_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const state = input.state || 'refrigerado';
    const shelfDays = state === 'congelado' ? prepRow.shelf_life_frozen_days : prepRow.shelf_life_fresh_days;
    const expiresAt = shelfDays ? new Date(Date.now() + shelfDays * 86400000).toISOString() : null;

    const before = await menuFoodCosts(supabase, restaurantId);
    const consumed = [];
    let inputCost = 0;
    for (const l of rLines) {
        const { data: ing } = await supabase.from('inventory').select('*')
            .eq('slug', l.ingredient_slug).maybeSingle();
        if (!ing) continue;
        const qty = round4(num(l.quantity) * batches);
        inputCost += qty * num(ing.cost_per_unit);
        await drawLotsFEFO(supabase, ing.id, qty);
        await postMovement(supabase, {
            restaurantId, inventoryItemId: ing.id, delta: -qty,
            reason: 'batch_out', refType: 'produce', refId: runId + ':' + ing.id,
            actor, note: `Producción de ${prepRow.name} ×${batches}`
        });
        consumed.push({ name: ing.name, qty, unit: ing.unit });
    }
    // Prep cost = Σ inputs ÷ ACTUAL yield (§3/§7f) — trim and cleaning
    // loss land in the true cost, not in a fantasy standard.
    const unitCost = actualYield > 0 ? inputCost / actualYield : 0;
    const lot = await createLot(supabase, {
        restaurantId, inventoryItemId: prepRow.id, qty: actualYield,
        unitCost, state, source: 'batch', refId: runId, expiresAt
    });
    await postMovement(supabase, {
        restaurantId, inventoryItemId: prepRow.id, delta: actualYield,
        reason: 'batch_in', refType: 'produce', refId: runId, lotId: lot.id,
        actor, note: `Producción ×${batches} — salieron ${actualYield} ${prepRow.unit}`
    });
    await supabase.from('inventory').update({ cost_per_unit: unitCost }).eq('id', prepRow.id);
    // §7i: a production posting against a flagged prep CLEARS its flags.
    await supabase.from('prep_flags').update({
        status: 'cleared', cleared_at: new Date().toISOString(),
        cleared_by: actor ? actor.id : null, cleared_by_name: actor ? actor.name : null
    }).eq('prep_slug', prepSlug).eq('status', 'open');
    await recomputePrepCosts(supabase, restaurantId);
    const drift = await checkDrift(supabase, {
        restaurantId, before, cause: 'produce', refId: runId, actor
    });
    return {
        runId, prepName: prepRow.name, batches, producedQty: actualYield,
        unit: prepRow.unit, unitCost: round4(unitCost), consumed, drift,
        summary: `Producido: ${actualYield} ${prepRow.unit} de ${prepRow.name} (costo ${money(unitCost)} por ${prepRow.unit})`
    };
}

// Transfer between storage states (§7f): splits lots FEFO and RE-CLOCKS
// the destination expiry (frozen weeks ≠ fridge hours — food safety,
// not bookkeeping). Total stock does not change; the ledger records
// the move with delta 0 against the new lot.
async function moveStock(supabase, input) {
    const { restaurantId = RESTAURANT, actor, inventoryItemId } = input;
    const qty = num(input.qty);
    const toState = input.toState;
    if (!(qty > 0)) throw intakeError('CANTIDAD_INVALIDA', 'Decinos cuántas pasás.');
    if (!['congelado', 'refrigerado', 'ambiente', 'linea'].includes(toState)) {
        throw intakeError('ESTADO_INVALIDO', 'Elegí el estado destino: congelado, refrigerado, ambiente o línea.');
    }
    const item = await getItem(supabase, inventoryItemId);
    if (!item) throw intakeError('INSUMO_NO_EXISTE', 'Ese insumo ya no está en el catálogo.');
    const { data: lots } = await supabase.from('stock_lots').select('*')
        .eq('inventory_item_id', inventoryItemId).gt('qty_left', 0).neq('state', toState);
    const shelfDays = toState === 'congelado' ? item.shelf_life_frozen_days
        : (toState === 'refrigerado' || toState === 'linea') ? item.shelf_life_fresh_days : null;
    let remaining = qty;
    const moved = [];
    const sorted = (lots || []).sort((a, b) => String(a.created_at) < String(b.created_at) ? -1 : 1);
    for (const lot of sorted) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, num(lot.qty_left));
        if (take <= 0) continue;
        await supabase.from('stock_lots')
            .update({ qty_left: round4(num(lot.qty_left) - take) }).eq('id', lot.id);
        const newLot = await createLot(supabase, {
            restaurantId, inventoryItemId, qty: take, unitCost: lot.unit_cost,
            state: toState, source: lot.source, refId: lot.ref_id,
            expiresAt: shelfDays ? new Date(Date.now() + shelfDays * 86400000).toISOString() : lot.expires_at
        });
        await postMovement(supabase, {
            restaurantId, inventoryItemId, delta: 0,
            reason: 'transfer', refType: 'move', refId: newLot.id, lotId: newLot.id,
            actor, note: `${lot.state} → ${toState} · ${take} ${item.unit}`
        });
        moved.push({ qty: take, from: lot.state });
        remaining = round4(remaining - take);
    }
    if (moved.length === 0) {
        throw intakeError('SIN_STOCK_MOVIBLE', `No hay ${item.name} fuera de ${toState} para mover.`);
    }
    return {
        moved, shortfall: remaining,
        summary: `Movido: ${round4(qty - remaining)} ${item.unit} de ${item.name} → ${toState}`
    };
}

async function wasteStock(supabase, input) {
    const { restaurantId = RESTAURANT, actor, inventoryItemId } = input;
    const qty = num(input.qty);
    if (!(qty > 0)) throw intakeError('CANTIDAD_INVALIDA', 'Decinos cuánta merma es.');
    const item = await getItem(supabase, inventoryItemId);
    if (!item) throw intakeError('INSUMO_NO_EXISTE', 'Ese insumo ya no está en el catálogo.');
    await drawLotsFEFO(supabase, inventoryItemId, qty);
    await postMovement(supabase, {
        restaurantId, inventoryItemId, delta: -qty,
        reason: 'waste', refType: 'manual', refId: 'waste_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        actor, note: input.note ? String(input.note) : 'Merma registrada'
    });
    return { summary: `Merma: ${qty} ${item.unit} de ${item.name}` };
}

// ---------------------------------------------------------------------------
// COUNT WALK (§7c) — the Sunday backstop. One count_adjust per variance;
// expired lots get a forced waste decision (pullExpired).
// ---------------------------------------------------------------------------

async function countWalk(supabase, input) {
    const { restaurantId = RESTAURANT, actor } = input;
    const walkId = 'walk_' + Date.now();
    const report = [];
    for (const c of (input.counts || [])) {
        const item = await getItem(supabase, c.inventoryItemId);
        if (!item) continue;
        const book = num(item.current_stock);
        const counted = num(c.countedQty);
        const delta = round4(counted - book);
        let wastedExpired = 0;
        if (c.pullExpired) {
            const nowIso = new Date().toISOString();
            const { data: lots } = await supabase.from('stock_lots').select('*')
                .eq('inventory_item_id', item.id).gt('qty_left', 0);
            for (const lot of (lots || [])) {
                if (lot.expires_at && String(lot.expires_at) <= nowIso) {
                    wastedExpired = round4(wastedExpired + num(lot.qty_left));
                    await supabase.from('stock_lots').update({ qty_left: 0 }).eq('id', lot.id);
                }
            }
            if (wastedExpired > 0) {
                // The expired pull is a REAL waste movement (it moves
                // the cache) — never a silent cache edit, so the
                // ledger always sums to the physical truth.
                await postMovement(supabase, {
                    restaurantId, inventoryItemId: item.id, delta: -wastedExpired,
                    reason: 'waste', refType: 'count', refId: walkId + ':exp:' + item.id,
                    actor, note: `Vencido retirado en conteo: ${wastedExpired} ${item.unit}`
                });
            }
        }
        // What remains to explain is counted vs (book − already-wasted).
        const effectiveDelta = round4(counted - (book - wastedExpired));
        if (Math.abs(effectiveDelta) > 0.0001) {
            await postMovement(supabase, {
                restaurantId, inventoryItemId: item.id, delta: effectiveDelta,
                reason: 'count_adjust', refType: 'count', refId: walkId + ':' + item.id,
                actor, note: `Conteo: había ${book} ${item.unit}, contaron ${counted}`
            });
        }
        report.push({
            name: item.name, unit: item.unit, book, counted,
            delta: effectiveDelta, wastedExpired,
            value: round2(Math.abs(effectiveDelta) * num(item.cost_per_unit))
        });
    }
    return { walkId, report, summary: `Conteo guardado: ${report.length} insumos revisados` };
}

// ---------------------------------------------------------------------------
// SALE (§2 event 3 + §6) — one level deep, at PAID, exactly once.
// Menu lines deduct their insumo; prep lines deduct the PREP's stock
// (its ingredients already moved at batch time — exploding through
// would double-count). Modifier rows are DELTAS (the delta editor's
// contract): a chosen option adds/removes its rows, item-specific
// rows winning over the option-wide ones. Stock may go negative —
// never block a customer for a bookkeeping gap — but it flags.
// ---------------------------------------------------------------------------

async function deductForOrder(supabase, order) {
    try {
        if (!order || order.status !== 'paid') return { skipped: 'not_paid' };
        if (order.restaurant_id && order.restaurant_id !== RESTAURANT) return { skipped: 'other_tenant' };
        if (!order.id || !Array.isArray(order.items) || order.items.length === 0) return { skipped: 'no_items' };
        const { data: prior } = await supabase.from('stock_movements').select('id')
            .eq('reason', 'sale').eq('ref_id', order.id).limit(1);
        if (prior && prior.length > 0) return { skipped: 'already_deducted' };

        const items = order.items;
        const itemIds = [...new Set(items.map(i => i.id).filter(Boolean))];
        if (itemIds.length === 0) return { skipped: 'no_items' };
        const { data: menuLines } = await supabase.from('menu_item_ingredients')
            .select('menu_item_id, inventory_item_id, quantity').in('menu_item_id', itemIds);

        // Resolve chosen options exactly the way order-service prices
        // them: pool = options of the groups linked to the item; match
        // by id when the snapshot carries one, else by name.
        const { data: links } = await supabase.from('item_modifier_groups')
            .select('item_id, group_id').in('item_id', itemIds);
        const groupIds = [...new Set((links || []).map(l => l.group_id).filter(Boolean))];
        let optionsByItem = {};
        if (groupIds.length > 0) {
            const { data: opts } = await supabase.from('modifier_options')
                .select('id, group_id, name').in('group_id', groupIds);
            const byGroup = {};
            (opts || []).forEach(o => { (byGroup[o.group_id] = byGroup[o.group_id] || []).push(o); });
            (links || []).forEach(l => { (optionsByItem[l.item_id] = optionsByItem[l.item_id] || []).push(...(byGroup[l.group_id] || [])); });
        }
        const modQty = (mod) => { const q = parseInt(mod && mod.qty); return Number.isInteger(q) && q > 0 ? Math.min(q, 8) : 1; };
        const matchOption = (itemId, mod) => {
            const pool = optionsByItem[itemId] || [];
            if (!pool.length || mod === null || mod === undefined) return null;
            const modId = (typeof mod === 'object') ? (mod.id || mod.option_id || mod.optionId) : null;
            if (modId) { const byId = pool.find(o => o.id === modId); if (byId) return byId; }
            const modName = String(typeof mod === 'object' ? (mod.name || '') : mod).trim().toLowerCase();
            if (!modName) return null;
            return pool.find(o => String(o.name || '').trim().toLowerCase() === modName) || null;
        };
        const matchedOptionIds = new Set();
        const perItemOptions = items.map(item => {
            const mods = Array.isArray(item.mods) ? item.mods : (Array.isArray(item.modifiers) ? item.modifiers : []);
            return mods.map(mod => ({ mod, opt: matchOption(item.id, mod) }))
                .filter(x => x.opt)
                .map(x => { matchedOptionIds.add(x.opt.id); return x; });
        });
        let deltaRows = [];
        if (matchedOptionIds.size > 0) {
            const { data } = await supabase.from('modifier_ingredients')
                .select('modifier_option_id, item_id, inventory_item_id, quantity')
                .in('modifier_option_id', [...matchedOptionIds]);
            deltaRows = data || [];
        }

        const totals = new Map(); // inventory_item_id -> signed qty to deduct (positive = out)
        const addTo = (invId, qty) => { if (invId && qty) totals.set(invId, round4((totals.get(invId) || 0) + qty)); };
        items.forEach((item, idx) => {
            const qty = parseInt(item.qty) || 1;
            (menuLines || []).filter(l => l.menu_item_id === item.id)
                .forEach(l => addTo(l.inventory_item_id, num(l.quantity) * qty));
            (perItemOptions[idx] || []).forEach(({ mod, opt }) => {
                const rows = deltaRows.filter(r => r.modifier_option_id === opt.id);
                const specific = rows.filter(r => r.item_id === item.id);
                const use = specific.length > 0 ? specific : rows.filter(r => !r.item_id);
                use.forEach(r => addTo(r.inventory_item_id, num(r.quantity) * modQty(mod) * qty));
            });
        });

        const low = [];
        let movements = 0;
        for (const [invId, qty] of totals.entries()) {
            if (!(qty > 0)) continue; // a net-negative modifier mix never ADDS stock on a sale
            await drawLotsFEFO(supabase, invId, qty);
            const res = await postMovement(supabase, {
                restaurantId: order.restaurant_id || RESTAURANT,
                inventoryItemId: invId, delta: -qty,
                reason: 'sale', refType: 'order', refId: order.id,
                actor: null, note: `Venta · pedido ${order.order_number || order.id}`
            });
            if (!res.skipped) movements++;
            const item = await getItem(supabase, invId);
            if (item && (num(item.current_stock) < 0 || (num(item.min_stock) > 0 && num(item.current_stock) <= num(item.min_stock)))) {
                low.push({ name: item.name, stock: num(item.current_stock), unit: item.unit });
            }
        }
        return { deducted: movements, low };
    } catch (e) {
        // §6 doctrine: a bookkeeping gap NEVER blocks a customer.
        console.error('[Inventory] sale deduction failed (order unaffected):', e && e.message);
        return { error: e && e.message };
    }
}

// ---------------------------------------------------------------------------
// Prep Check flags + Tidy + staff alert (§7i)
// ---------------------------------------------------------------------------

async function setPrepFlag(supabase, input) {
    const { restaurantId = RESTAURANT, actor, prepSlug, flag } = input;
    if (!['bajo', 'hacer_ahora'].includes(flag)) {
        throw intakeError('BANDERA_INVALIDA', 'La bandera es "bajo" o "hacer ahora".');
    }
    const { data: prepRow } = await supabase.from('inventory').select('id, name')
        .eq('slug', prepSlug).maybeSingle();
    const { data, error } = await supabase.from('prep_flags').insert({
        restaurant_id: restaurantId, prep_slug: prepSlug,
        inventory_item_id: prepRow ? prepRow.id : null,
        flag, status: 'open',
        by_employee: actor ? actor.id : null, by_name: actor ? actor.name : null,
        note: input.note || null
    }).select().single();
    if (error) throw new Error('No se pudo poner la bandera: ' + error.message);
    return { flag: data, prepName: prepRow ? prepRow.name : prepSlug };
}

async function clearPrepFlag(supabase, input) {
    const { actor, flagId } = input;
    const { data, error } = await supabase.from('prep_flags').update({
        status: 'cleared', cleared_at: new Date().toISOString(),
        cleared_by: actor ? actor.id : null, cleared_by_name: actor ? actor.name : null
    }).eq('id', flagId).eq('status', 'open').select().single();
    if (error) throw new Error('No se pudo quitar la bandera: ' + error.message);
    return { flag: data };
}

async function logEvent(supabase, input) {
    const { data, error } = await supabase.from('inv_events').insert({
        restaurant_id: input.restaurantId || RESTAURANT,
        kind: input.kind, alert_kind: input.alertKind || null,
        inventory_item_id: input.inventoryItemId || null,
        by_employee: input.actor ? input.actor.id : null,
        by_name: input.actor ? input.actor.name : null,
        note: input.note || null, delivered: input.delivered != null ? input.delivered : null
    }).select().single();
    if (error) throw new Error('No se pudo guardar el evento: ' + error.message);
    return data;
}

// Staff alert (§7i): one tap to the owner on WhatsApp via the bot
// notify route. The inv_events row is the durable record — if the
// notify path is down the alert survives as the Producción banner for
// Owner/Admin sessions instead of vanishing. Never silently lost.
async function staffAlert(supabase, input) {
    const delivered = await notifyOwner({
        kind: 'staff_alert',
        alert_kind: input.alertKind,
        by_name: input.actor ? input.actor.name : null,
        note: input.note || null,
        item_name: input.itemName || null
    });
    const event = await logEvent(supabase, {
        restaurantId: input.restaurantId, kind: 'alert',
        alertKind: input.alertKind, inventoryItemId: input.inventoryItemId,
        actor: input.actor, note: input.note, delivered
    });
    return { delivered, event };
}

module.exports = {
    DRIFT_LIMIT_PCT, TARGET_COGS,
    notifyOwner,
    postMovement, drawLotsFEFO, createLot,
    recomputePrepCosts, menuFoodCosts, checkDrift,
    previewIntake, postIntake,
    produceBatch, moveStock, wasteStock, countWalk,
    deductForOrder,
    setPrepFlag, clearPrepFlag, logEvent, staffAlert,
    _intakeError: intakeError
};
