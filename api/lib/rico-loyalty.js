// api/lib/rico-loyalty.js — Rico Cash two-bucket engine (loyalty build,
// 2026-10-30). Spec: RICO-CASH-TWO-BUCKET-SPEC.md (+ §8b rulings) and
// CUSTOMER-SYSTEM-SPEC.md §7 (deals engine types 1–3).
//
// THE MODEL
//   💵 "Tu dinero"  = customers.rico_balance — the customer's own topped-up
//                     money (plus every pre-existing balance, grandfathered).
//                     Spends on ANYTHING. NEVER expires.
//   🎁 "Regalo de la casa" = house money, tracked as LOTS in balance_history:
//                     one 'bonus_grant' row per gift (its own lot_id and
//                     expires_at), one 'bonus_spend' row per draw against a
//                     lot, one 'bonus_expire' row when the sweep zeroes it.
//                     A lot's remaining = SUM(amount) over its rows. Lots are
//                     spent soonest-expiry first and spend ONLY on house-made
//                     items (server-enforced in settleWalletForOrder).
//   customers.rico_bonus_balance is a CACHE of the live-lot sum, recomputed
//   on every grant/spend/expire so the number never lies.
//   The word "bucket" never reaches a customer surface — UI says
//   "Tu dinero" / "Regalo de la casa".
//
// ANTI-LOOP DOCTRINE (house rule): gift money never spawns rewards —
// earn is computed on the real-money portion of an order only, missions
// read items[].rico_bonus_used / orders.rico_bonus_used (populated by
// the spend path here), and campaign gift drops have per-customer caps.
//
// FAILURE DOCTRINE (the missions/notify pattern): post-payment hooks
// (processPaidOrder, sweeps, notifications) NEVER throw into an order
// flow. The spend path itself (settleWalletForOrder) DOES throw on a
// real insufficiency, exactly like the legacy one-pot debit did —
// a register must never believe a wallet paid when it did not.
//
// Every function takes the supabase client as its first argument (the
// house pattern in api/lib/*) so harnesses can inject a fake.

const { supabase: defaultSupabase } = require('./supabase');

function round2(n) {
    return parseFloat((parseFloat(n) || 0).toFixed(2));
}

const DEFAULT_LOYALTY_SETTINGS = {
    earn_rate: 0.10,                 // 10% back on every paid order
    launch_week: false,              // semana de apertura: earn × launch_multiplier
    launch_multiplier: 2,
    ladder: [                        // recarga bonus tiers (highest met tier wins)
        { min: 100, bonus: 10 },
        { min: 200, bonus: 25 },
        { min: 500, bonus: 75 }
    ],
    gift_expiry_days: 60,            // flat expiry on ALL gift lots
    manual_grant_cap: 100,           // POS "Dar regalo" above this needs a manager PIN
    monthly_promo_cap: 3000,         // deals cost-panel budget verdict (EL NÚMERO discipline)
    bogo_item_ids: null,             // null = the 7 bottled-coffee items below
    // Racha del Capitán (owner, 2026-10-30): % off the house-made portion
    // by streak week; the last entry is the cap (week 5+).
    streak_enabled: true,
    streak_ladder: [2, 4, 6, 8, 10],
    // Difusión del Capitán (owner, 2026-10-30): broadcast ceiling per
    // calendar month; template sends cost an ESTIMATE in lempiras per
    // message (Meta bills the WABA — the owner adjusts this when Meta's
    // real rate is known; free-form messages inside a 24h window cost 0).
    broadcast_monthly_cap: 4,
    broadcast_template_name: '',
    broadcast_template_approved: false,
    broadcast_template_cost: 1.25,
    // Especial del Día (owner, 2026-10-30): VIP push hour
    // (America/Tegucigalpa, 'HH:MM') and its template (falls back to the
    // broadcast template when empty).
    especial_push_time: '09:30',
    especial_template_name: ''
};

// The bottled-coffee items (menu-items-load.sql ids) — the BOGO door of
// the Creadores program applies to a customer's first bottle purchase.
const DEFAULT_BOGO_ITEM_IDS = [
    'botella-americano', 'botella-caramel', 'botella-de-temporada',
    'botella-dirty-chai', 'botella-dulce-de-leche', 'botella-french-vanilla',
    'botella-mocha'
];

async function getLoyaltySettings(supabase = defaultSupabase, restaurantId = 'rich-aroma') {
    let stored = {};
    try {
        const { data } = await supabase.from('restaurants')
            .select('settings').eq('id', restaurantId || 'rich-aroma').maybeSingle();
        stored = (data && data.settings && data.settings.loyalty) || {};
    } catch (e) { /* defaults stand */ }
    const merged = { ...DEFAULT_LOYALTY_SETTINGS, ...stored };
    if (!Array.isArray(merged.ladder) || merged.ladder.length === 0) merged.ladder = DEFAULT_LOYALTY_SETTINGS.ladder;
    if (!Array.isArray(merged.streak_ladder) || merged.streak_ladder.length === 0) merged.streak_ladder = DEFAULT_LOYALTY_SETTINGS.streak_ladder;
    return merged;
}

// ---------------------------------------------------------------------
// Lots
// ---------------------------------------------------------------------

async function fetchLotRows(supabase, customerId) {
    const { data } = await supabase.from('balance_history')
        .select('*')
        .eq('customer_id', customerId)
        .not('lot_id', 'is', null)
        .order('created_at', { ascending: true });
    return data || [];
}

/** Live lots for a customer, soonest-expiry first. */
async function getLiveLots(supabase = defaultSupabase, customerId) {
    if (!customerId) return [];
    const rows = await fetchLotRows(supabase, customerId);
    const now = Date.now();
    const byLot = {};
    for (const r of rows) {
        const lot = byLot[r.lot_id] || (byLot[r.lot_id] = {
            lot_id: r.lot_id, source: null, campaign_id: null,
            granted_at: null, expires_at: null, granted: 0, remaining: 0
        });
        lot.remaining = round2(lot.remaining + (parseFloat(r.amount) || 0));
        if (r.type === 'bonus_grant') {
            lot.source = r.source || 'promo';
            lot.campaign_id = r.campaign_id || null;
            lot.granted_at = r.created_at;
            lot.expires_at = r.expires_at || null;
            lot.granted = parseFloat(r.amount) || 0;
        }
    }
    return Object.values(byLot)
        .filter(l => l.granted > 0 && l.remaining > 0.004 &&
            (!l.expires_at || new Date(l.expires_at).getTime() > now))
        .sort((a, b) => {
            const ea = a.expires_at ? new Date(a.expires_at).getTime() : Infinity;
            const eb = b.expires_at ? new Date(b.expires_at).getTime() : Infinity;
            return ea - eb;
        });
}

async function getBonusBalance(supabase = defaultSupabase, customerId) {
    const lots = await getLiveLots(supabase, customerId);
    return round2(lots.reduce((s, l) => s + l.remaining, 0));
}

/** Rewrite customers.rico_bonus_balance from the live lots. Returns it. */
async function recomputeBonusBalance(supabase = defaultSupabase, customerId) {
    const total = await getBonusBalance(supabase, customerId);
    try {
        await supabase.from('customers').update({ rico_bonus_balance: total }).eq('id', customerId);
    } catch (e) { console.error('[Rico] recompute bonus balance failed:', e.message); }
    return total;
}

// ---------------------------------------------------------------------
// Bot notifications (grant alerts + expiry heads-up) — OS SIGNALS, the
// bot delivers. Same doctrine as notifyBotOrderStatus in store.js:
// inert + LOUD when BOT_NOTIFY_URL / WHATSAPP_SIGNUP_SECRET are unset,
// failure-silent always. The /loyalty-notify URL derives from
// BOT_NOTIFY_URL exactly the way account.js derives /account-link.
// ---------------------------------------------------------------------

function botLoyaltyUrl() {
    const notify = (process.env.BOT_NOTIFY_URL || '').trim();
    if (!notify) return '';
    if (/\/order-notify\/?$/.test(notify)) return notify.replace(/\/order-notify\/?$/, '/loyalty-notify');
    return '';
}

async function notifyLoyalty(supabase, customerId, payload) {
    try {
        if (!customerId) return false;
        const url = botLoyaltyUrl();
        const secret = (process.env.WHATSAPP_SIGNUP_SECRET || '').trim();
        if (!url || !secret) {
            console.error(`[RicoNotify] SKIPPED ${payload && payload.kind} for customer ${customerId}: ${!url ? 'BOT_NOTIFY_URL (or its /order-notify shape)' : 'WHATSAPP_SIGNUP_SECRET'} not configured in this deployment's env`);
            return false;
        }
        const { data: cust } = await supabase.from('customers')
            .select('phone, name').eq('id', customerId).maybeSingle();
        const phone = (cust && cust.phone) || '';
        if (!phone) {
            console.error(`[RicoNotify] SKIPPED ${payload.kind} for customer ${customerId}: no phone on file`);
            return false;
        }
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + secret },
            body: JSON.stringify({ ...payload, phone, first_name: ((cust.name || '').trim().split(/\s+/)[0] || '') })
        });
        if (!resp || !resp.ok) {
            console.error(`[RicoNotify] bot rejected ${payload.kind} for customer ${customerId}: HTTP ${resp && resp.status}`);
            return false;
        }
        return true;
    } catch (e) {
        console.error('[RicoNotify] send failed (customer unaffected):', e && e.message);
        return false;
    }
}

// ---------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------

/**
 * Mint one gift lot. Writes the 'bonus_grant' ledger row, recomputes the
 * cached bonus balance, and (unless opts.notify === false) sends the
 * WhatsApp grant alert through the bot. Returns { lot_id, expires_at }.
 */
async function mintBonusLot(supabase = defaultSupabase, opts = {}) {
    const { customerId, source = 'promo', orderId = null, campaignId = null, notes = null } = opts;
    const amount = round2(opts.amount);
    if (!customerId || !(amount > 0)) return null;
    const settings = opts.settings || await getLoyaltySettings(supabase, opts.restaurantId);
    const days = opts.expiresDays != null ? opts.expiresDays : settings.gift_expiry_days;
    const expiresAt = opts.expiresAt || new Date(Date.now() + (parseInt(days) || 60) * 24 * 3600 * 1000).toISOString();
    const lotId = 'lot_' + Date.now() + Math.floor(Math.random() * 100000);
    const { error } = await supabase.from('balance_history').insert({
        customer_id: customerId,
        type: 'bonus_grant',
        bucket: 'bonus',
        amount,
        source,
        expires_at: expiresAt,
        lot_id: lotId,
        order_id: orderId,
        campaign_id: campaignId,
        notes
    });
    if (error) throw error;
    await recomputeBonusBalance(supabase, customerId);
    if (opts.notify !== false) {
        await notifyLoyalty(supabase, customerId, {
            kind: 'grant', amount, expires_at: expiresAt, source,
            ...(opts.notifyExtra || {})
        });
    }
    return { lot_id: lotId, expires_at: expiresAt };
}

/** Recarga ladder: the highest tier the top-up amount reaches wins. */
function ladderBonusFor(settings, amount) {
    let best = 0;
    for (const tier of (settings && settings.ladder) || []) {
        if ((parseFloat(amount) || 0) >= (parseFloat(tier.min) || 0)) {
            best = Math.max(best, parseFloat(tier.bonus) || 0);
        }
    }
    return round2(best);
}

/** Credit the recarga ladder bonus for a paid-bucket top-up. */
async function grantRecargaBonus(supabase = defaultSupabase, { customerId, amount, restaurantId } = {}) {
    const settings = await getLoyaltySettings(supabase, restaurantId);
    const bonus = ladderBonusFor(settings, amount);
    if (!(bonus > 0) || !customerId) return 0;
    await mintBonusLot(supabase, {
        customerId, amount: bonus, source: 'recarga_bonus', settings,
        notes: `Bono por recarga de L.${round2(amount)}`
    });
    return bonus;
}

// ---------------------------------------------------------------------
// Spending
// ---------------------------------------------------------------------

function lineTotal(item) {
    if (item && item.finalPrice !== undefined && item.finalPrice !== null) return parseFloat(item.finalPrice) || 0;
    return (parseFloat(item && item.price) || 0) * (parseInt(item && item.qty) || 1);
}

/** House-made figures for an order's priced items (post-discount net). */
function computeHouseNet(items, discount) {
    const houseSubtotal = round2((items || []).reduce((s, i) => s + (i && i.is_house_made ? lineTotal(i) : 0), 0));
    const discountOnHouse = Math.min(round2(discount) || 0, houseSubtotal);
    return { houseSubtotal, discountOnHouse, houseNet: round2(houseSubtotal - discountOnHouse) };
}

/**
 * Stamp items[].rico_bonus_used: the bonus draw distributed across the
 * HOUSE-MADE lines only, proportional to each line's net (post-discount)
 * value. Non-house lines get an explicit 0 so readers (missions) always
 * find the field. Mutates and returns the items array.
 */
function allocateBonusToItems(items, discount, bonusUsed) {
    const list = Array.isArray(items) ? items : [];
    list.forEach(i => { if (i && typeof i === 'object') i.rico_bonus_used = 0; });
    if (!(bonusUsed > 0)) return list;
    const { houseSubtotal, discountOnHouse } = computeHouseNet(list, discount);
    if (!(houseSubtotal > 0)) return list;
    const houseLines = list.filter(i => i && i.is_house_made);
    let assigned = 0;
    houseLines.forEach((line, idx) => {
        const net = Math.max(0, lineTotal(line) - (discountOnHouse * (lineTotal(line) / houseSubtotal)));
        let share;
        if (idx === houseLines.length - 1) share = round2(bonusUsed - assigned);
        else { share = round2(bonusUsed * (net / Math.max(0.0001, houseSubtotal - discountOnHouse))); assigned = round2(assigned + share); }
        line.rico_bonus_used = Math.max(0, share);
    });
    return list;
}

/** Draw gift lots, soonest-expiry first. Writes 'bonus_spend' rows. */
async function spendBonus(supabase = defaultSupabase, { customerId, maxAmount, orderId = null } = {}) {
    let want = round2(maxAmount);
    if (!customerId || !(want > 0)) return { used: 0, lots: [] };
    const lots = await getLiveLots(supabase, customerId);
    const draws = [];
    for (const lot of lots) {
        if (want <= 0.004) break;
        const take = round2(Math.min(lot.remaining, want));
        if (!(take > 0)) continue;
        const { error } = await supabase.from('balance_history').insert({
            customer_id: customerId,
            type: 'bonus_spend',
            bucket: 'bonus',
            amount: -take,
            source: 'spend',
            expires_at: lot.expires_at,
            lot_id: lot.lot_id,
            order_id: orderId,
            campaign_id: lot.campaign_id || null
        });
        if (error) throw error;
        draws.push({ lot_id: lot.lot_id, amount: take });
        want = round2(want - take);
    }
    const used = round2(draws.reduce((s, d) => s + d.amount, 0));
    if (used > 0) await recomputeBonusBalance(supabase, customerId);
    return { used, lots: draws };
}

/**
 * THE SPEND ENGINE. Settles a wallet charge against a priced order:
 * gift money first, capped at the house-made net portion; then the
 * customer's own money. Writes every ledger row and both balance
 * updates, stamps items[].rico_bonus_used, and returns the split.
 * order: { id?, order_number?, customer_id, total, discount, items }.
 * opts.walletTarget: how much of the total the wallet should cover
 * (POS sends ricoAmount; default = the whole total).
 */
async function settleWalletForOrder(supabase = defaultSupabase, order, opts = {}) {
    const total = round2(order && order.total);
    const out = { bonusUsed: 0, paidUsed: 0, items: (order && order.items) || [] };
    if (!order || !order.customer_id || !(total > 0)) return out;
    const target = Math.min(opts.walletTarget != null ? round2(opts.walletTarget) : total, total);
    if (!(target > 0)) return out;

    const { data: cust } = await supabase.from('customers')
        .select('id, rico_balance').eq('id', order.customer_id).maybeSingle();
    if (!cust) return out;

    const { houseNet } = computeHouseNet(order.items, order.discount);
    const bonusAvail = await getBonusBalance(supabase, order.customer_id);
    const bonusWanted = Math.min(bonusAvail, houseNet, target);
    if (bonusWanted > 0) {
        const drawn = await spendBonus(supabase, {
            customerId: order.customer_id, maxAmount: bonusWanted, orderId: order.id || null
        });
        out.bonusUsed = drawn.used;
    }

    const paidAvail = parseFloat(cust.rico_balance) || 0;
    out.paidUsed = round2(Math.min(paidAvail, target - out.bonusUsed));
    if (out.paidUsed > 0) {
        const { error: upErr } = await supabase.from('customers')
            .update({ rico_balance: round2(paidAvail - out.paidUsed) }).eq('id', order.customer_id);
        if (upErr) throw upErr;
        let led = await supabase.from('balance_history').insert({
            customer_id: order.customer_id,
            type: 'payment',
            bucket: 'paid',
            amount: -out.paidUsed,
            source: 'spend',
            order_id: order.id || null,
            notes: `Pedido #${order.order_number || ''}`.trim()
        });
        if (led.error && /bucket|source|campaign_id/.test(led.error.message || '')) {
            // Pre-migration DB (the loyalty migration has not run yet):
            // fall back to the legacy ledger shape so a paid-bucket
            // debit never fails over the new columns alone.
            led = await supabase.from('balance_history').insert({
                customer_id: order.customer_id,
                type: 'payment',
                amount: -out.paidUsed,
                order_id: order.id || null,
                notes: `Pedido #${order.order_number || ''}`.trim()
            });
        }
        if (led.error) throw led.error;
    }

    out.items = allocateBonusToItems(out.items, order.discount, out.bonusUsed);
    return out;
}

// ---------------------------------------------------------------------
// Campaigns (deals engine types 1–3) + BOGO
// ---------------------------------------------------------------------

function tguDayHour(now = new Date()) {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Tegucigalpa', weekday: 'short', hour: 'numeric', hourCycle: 'h23'
        }).formatToParts(now);
        const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.find(p => p.type === 'weekday').value];
        const hour = parseInt(parts.find(p => p.type === 'hour').value, 10) || 0;
        return { day: wd, hour };
    } catch (e) {
        return { day: now.getDay(), hour: now.getHours() };
    }
}

function campaignInWindow(campaign, now = new Date()) {
    if (!campaign || campaign.active === false) return false;
    if (campaign.starts_at && new Date(campaign.starts_at).getTime() > now.getTime()) return false;
    if (campaign.ends_at && new Date(campaign.ends_at).getTime() < now.getTime()) return false;
    const cfg = campaign.config || {};
    if (Array.isArray(cfg.days) && cfg.days.length > 0) {
        if (!cfg.days.includes(tguDayHour(now).day)) return false;
    }
    if (cfg.hours && (cfg.hours.from != null || cfg.hours.to != null)) {
        const h = tguDayHour(now).hour;
        if (cfg.hours.from != null && h < cfg.hours.from) return false;
        if (cfg.hours.to != null && h >= cfg.hours.to) return false;
    }
    return true;
}

async function activeCampaigns(supabase, restaurantId, type) {
    const { data } = await supabase.from('loyalty_campaigns')
        .select('*')
        .eq('restaurant_id', restaurantId || 'rich-aroma')
        .eq('type', type)
        .eq('active', true)
        .order('created_at', { ascending: true });
    return (data || []).filter(c => campaignInWindow(c));
}

/** Type 1 — Multiplicador: the best matching earn multiplier (never stacked). */
async function campaignMultiplier(supabase = defaultSupabase, order) {
    let mult = 1;
    try {
        const campaigns = await activeCampaigns(supabase, order.restaurant_id, 'multiplicador');
        for (const c of campaigns) {
            const cfg = c.config || {};
            const scope = cfg.scope || 'all';
            let matches = scope === 'all';
            if (!matches && scope === 'item' && cfg.item_id) {
                matches = (order.items || []).some(i => i && i.id === cfg.item_id);
            }
            if (!matches && scope === 'category' && cfg.category) {
                matches = (order.items || []).some(i => i && i.category === cfg.category);
            }
            if (matches) mult = Math.max(mult, parseFloat(cfg.multiplier) || 1);
        }
    } catch (e) { console.error('[Rico] campaign multiplier failed:', e.message); }
    return mult;
}

/**
 * Type 2 — Compra X, llevá Y: discount computed at pricing time. The Y
 * line must already be in the order (the register adds it); Y must be
 * house-made. First matching campaign only — deals never stack.
 */
/** Per-campaign Compra X, llevá Y math (pure — also used by the
 *  Especial del Día, where a claimed campaign applies even when the
 *  campaign itself is not switched on). */
function buyGetForCampaign(campaign, items) {
    const cfg = (campaign && campaign.config) || {};
    if (!cfg.buy_item_id || !cfg.get_item_id) return { discount: 0, campaign: null };
    const buyQty = (items || []).filter(i => i && i.id === cfg.buy_item_id)
        .reduce((s, i) => s + (parseInt(i.qty) || 1), 0);
    const sets = Math.floor(buyQty / Math.max(1, parseInt(cfg.buy_qty) || 1));
    if (sets <= 0) return { discount: 0, campaign: null };
    const getLine = (items || []).find(i => i && i.id === cfg.get_item_id && i.is_house_made);
    if (!getLine) return { discount: 0, campaign: null };
    const freeUnits = Math.min(parseInt(getLine.qty) || 1, sets * Math.max(1, parseInt(cfg.get_qty) || 1));
    const unit = lineTotal(getLine) / Math.max(1, parseInt(getLine.qty) || 1);
    const pct = Math.min(100, Math.max(0, parseFloat(cfg.get_discount_pct != null ? cfg.get_discount_pct : 100) || 0));
    const discount = round2(unit * freeUnits * (pct / 100));
    return discount > 0 ? { discount, campaign } : { discount: 0, campaign: null };
}

async function buyGetDiscount(supabase = defaultSupabase, { restaurantId, items } = {}) {
    try {
        const campaigns = await activeCampaigns(supabase, restaurantId, 'compra_x_lleva');
        for (const c of campaigns) {
            const r = buyGetForCampaign(c, items);
            if (r.discount > 0) return r;
        }
    } catch (e) { console.error('[Rico] buy-get evaluation failed:', e.message); }
    return { discount: 0, campaign: null };
}

/** Type 3 — Regalo de la casa: gift drop on a paid order, capped per customer. */
async function regaloGrantsForOrder(supabase = defaultSupabase, order, settings, campaignsOverride = null) {
    const granted = [];
    try {
        const campaigns = campaignsOverride || await activeCampaigns(supabase, order.restaurant_id, 'regalo');
        for (const c of campaigns) {
            const cfg = c.config || {};
            const amount = round2(cfg.gift_amount);
            if (!(amount > 0)) continue;
            let triggered = false;
            if (cfg.trigger === 'item' && cfg.trigger_item_id) {
                triggered = (order.items || []).some(i => i && i.id === cfg.trigger_item_id);
            } else if (cfg.trigger === 'total' && cfg.trigger_min_total != null) {
                triggered = (parseFloat(order.total) || 0) >= (parseFloat(cfg.trigger_min_total) || 0);
            }
            if (!triggered) continue;
            const cap = Math.max(1, parseInt(cfg.per_customer_cap) || 1);
            const { data: prior } = await supabase.from('balance_history')
                .select('id').eq('customer_id', order.customer_id)
                .eq('campaign_id', c.id).eq('type', 'bonus_grant');
            if ((prior || []).length >= cap) continue;
            const lot = await mintBonusLot(supabase, {
                customerId: order.customer_id,
                amount,
                source: 'campaign',
                campaignId: c.id,
                orderId: order.id || null,
                expiresDays: cfg.gift_expiry_days != null ? cfg.gift_expiry_days : settings.gift_expiry_days,
                settings,
                notes: c.name || 'Regalo de la casa'
            });
            if (lot) granted.push({ campaign_id: c.id, amount, lot_id: lot.lot_id });
        }
    } catch (e) { console.error('[Rico] regalo campaign failed:', e.message); }
    return granted;
}

/** Creadores BOGO door: first bottle purchase of a word-attributed
 *  customer (within 30 days of attribution) — one bottle free. */
async function bogoDiscount(supabase = defaultSupabase, { customerId, items, restaurantId } = {}) {
    try {
        if (!customerId) return { discount: 0 };
        const settings = await getLoyaltySettings(supabase, restaurantId);
        const bottleIds = Array.isArray(settings.bogo_item_ids) && settings.bogo_item_ids.length
            ? settings.bogo_item_ids : DEFAULT_BOGO_ITEM_IDS;
        const lines = (items || []).filter(i => i && bottleIds.includes(i.id));
        const units = lines.reduce((s, i) => s + (parseInt(i.qty) || 1), 0);
        if (units < 2) return { discount: 0 };
        const { data: att } = await supabase.from('customer_attribution')
            .select('*').eq('customer_id', customerId).maybeSingle();
        if (!att || att.bogo_redeemed_at) return { discount: 0 };
        const ageMs = Date.now() - new Date(att.attributed_at || att.created_at).getTime();
        if (!(ageMs >= 0 && ageMs <= 30 * 24 * 3600 * 1000)) return { discount: 0 };
        const cheapest = Math.min(...lines.map(l => lineTotal(l) / Math.max(1, parseInt(l.qty) || 1)));
        return { discount: round2(cheapest), attribution: att };
    } catch (e) { console.error('[Rico] BOGO evaluation failed:', e.message); return { discount: 0 }; }
}

async function markBogoRedeemed(supabase = defaultSupabase, customerId) {
    try {
        await supabase.from('customer_attribution')
            .update({ bogo_redeemed_at: new Date().toISOString() })
            .eq('customer_id', customerId).is('bogo_redeemed_at', null);
    } catch (e) { console.error('[Rico] BOGO redemption mark failed:', e.message); }
}

// ---------------------------------------------------------------------
// Earn + the paid-order hook
// ---------------------------------------------------------------------

/**
 * 10% earn on a PAID order, on the real-money portion only (total minus
 * gift money spent — gift never spawns gift). Idempotent per order:
 * an order that already has its earn lot never earns twice, no matter
 * how many paths report it paid.
 */
async function earnForPaidOrder(supabase = defaultSupabase, order, settings, extra = {}) {
    try {
        if (!order || !order.customer_id) return null;
        const { data: prior } = await supabase.from('balance_history')
            .select('id').eq('order_id', order.id).eq('type', 'bonus_grant').eq('source', 'earn_10pct')
            .limit(1);
        if (prior && prior.length > 0) return null;
        const realBase = round2(Math.max(0, (parseFloat(order.total) || 0) - (parseFloat(order.rico_bonus_used) || 0)));
        if (!(realBase > 0)) return null;
        let rate = parseFloat(settings.earn_rate) || 0;
        if (settings.launch_week) rate *= (parseFloat(settings.launch_multiplier) || 1);
        if (extra.multiplierOverride != null) rate *= (parseFloat(extra.multiplierOverride) || 1);
        else rate *= await campaignMultiplier(supabase, order);
        const amount = round2(realBase * rate);
        if (!(amount > 0)) return null;
        return await mintBonusLot(supabase, {
            customerId: order.customer_id,
            amount,
            source: 'earn_10pct',
            orderId: order.id,
            settings,
            notes: 'Regalo por tu compra 🎁',
            notifyExtra: extra.notifyExtra || null
        });
    } catch (e) {
        console.error('[Rico] earn failed (order unaffected):', e && e.message);
        return null;
    }
}

/**
 * THE PAID-ORDER HOOK — call from every path that lands an order in
 * 'paid' (order-service createOrder when born paid, store.js
 * order_update on the transition into paid, store.js orders POST when
 * born paid). Earn + type-3 campaign drops. Idempotent. NEVER throws.
 */
async function processPaidOrder(supabase = defaultSupabase, order) {
    try {
        if (!order || order.status !== 'paid' || !order.customer_id) return { skipped: true };
        if ((order.restaurant_id || 'rich-aroma') !== 'rich-aroma') return { skipped: true };
        const settings = await getLoyaltySettings(supabase, order.restaurant_id);
        // Racha first: the earn WhatsApp can carry the streak line when
        // this order counts a NEW week (one message, not two).
        const streak = settings.streak_enabled === false
            ? null : await applyStreakAtPaid(supabase, order, settings);
        // Especial del Día: a claimed campaign-of-the-day drives the earn
        // multiplier / gift drop for THIS order instead of the regular
        // campaign scan (the special IS the deal today, for claimants).
        const especial = await getClaimedSpecial(supabase, {
            customerId: order.customer_id, restaurantId: order.restaurant_id
        });
        const espCampaign = especial && especial.campaign ? especial.campaign : null;
        const earnExtra = {};
        if (espCampaign && espCampaign.type === 'multiplicador') {
            earnExtra.multiplierOverride = parseFloat((espCampaign.config || {}).multiplier) || 1;
        }
        if (streak && streak.counted) {
            earnExtra.notifyExtra = { streak_weeks: streak.weeks, streak_pct: streak.pct };
        }
        const earn = await earnForPaidOrder(supabase, order, settings, earnExtra);
        if (!earn && streak && streak.counted) {
            await notifyLoyalty(supabase, order.customer_id, {
                kind: 'streak', streak_weeks: streak.weeks, streak_pct: streak.pct
            });
        }
        const gifts = (espCampaign && espCampaign.type === 'regalo')
            ? await regaloGrantsForOrder(supabase, order, settings, [espCampaign])
            : await regaloGrantsForOrder(supabase, order, settings);
        // Mark the especial redeemed when it actually touched this order:
        // a price-side type (item / compra) shows its [ESPECIAL] tag in
        // the notes; earn/gift types just applied above.
        if (especial) {
            const priceSide = !espCampaign || espCampaign.type === 'compra_x_lleva';
            const applied = priceSide
                ? String(order.notes || '').includes('[ESPECIAL')
                : (earnExtra.multiplierOverride != null || gifts.length > 0);
            if (applied) {
                await markEspecialRedeemed(supabase, especial, order);
            }
        }
        return { earn, gifts, streak, especial: especial ? especial.special.id : null };
    } catch (e) {
        console.error('[Rico] processPaidOrder failed (order unaffected):', e && e.message);
        return { error: e && e.message };
    }
}

// ---------------------------------------------------------------------
// Mission grants minting (reward_grants, grant_type LIKE 'mission%')
// ---------------------------------------------------------------------

/**
 * Mint PENDING mission reward_grants rows into gift lots. Both shapes
 * the live UNIQUE constraint produces are mission grants: 'mission'
 * and 'mission:<slug>'. Welcome-gift rows are NOT touched — their fate
 * is a separate owner decision. Called from admin_mission_decide (mint
 * immediately on approval) and from the daily sweep (backstop).
 */
async function mintPendingMissionGrants(supabase = defaultSupabase, opts = {}) {
    let minted = 0;
    try {
        let query = supabase.from('reward_grants').select('*')
            .eq('status', 'pending').like('grant_type', 'mission%');
        if (opts.customerId) query = query.eq('customer_id', opts.customerId);
        const { data: grants } = await query;
        for (const g of grants || []) {
            const amount = round2(g.amount);
            if (!(amount > 0) || !g.customer_id) continue;
            const lot = await mintBonusLot(supabase, {
                customerId: g.customer_id,
                amount,
                source: 'mission',
                notes: `Misión cumplida 🎁 (${g.grant_type})`
            });
            if (lot) {
                // reward_grants was designed for this moment: status
                // flips to 'minted' and the row records WHICH lot it
                // became (lot_id / expires_at columns were reserved
                // for the loyalty build by the intro-grants schema).
                await supabase.from('reward_grants')
                    .update({ status: 'minted', lot_id: lot.lot_id, expires_at: lot.expires_at })
                    .eq('id', g.id).eq('status', 'pending');
                minted++;
            }
        }
    } catch (e) { console.error('[Rico] mission grant minting failed:', e && e.message); }
    return minted;
}

// ---------------------------------------------------------------------
// The daily sweep (09:00 America/Tegucigalpa): expire lots, mint
// pending mission grants, and send ~3-day expiry heads-ups (one per
// lot) carrying the reworded personal suggestion (§8b.3).
// ---------------------------------------------------------------------

async function mostRecentHouseMadeItemName(supabase, customerId) {
    try {
        const { data: orders } = await supabase.from('orders')
            .select('items, created_at').eq('customer_id', customerId)
            .order('created_at', { ascending: false }).limit(5);
        for (const o of orders || []) {
            const line = (Array.isArray(o.items) ? o.items : []).find(i => i && i.is_house_made && i.name);
            if (line) return line.name;
        }
    } catch (e) { /* suggestion is optional */ }
    return null;
}

async function runSweep(supabase = defaultSupabase, opts = {}) {
    const summary = { minted_mission_grants: 0, expired_lots: 0, expired_amount: 0, heads_up_sent: 0 };
    summary.minted_mission_grants = await mintPendingMissionGrants(supabase);

    const now = Date.now();
    // 1) Expiry — every grant row past its expiry whose lot still holds money.
    const { data: grantRows } = await supabase.from('balance_history')
        .select('customer_id, lot_id, expires_at')
        .eq('type', 'bonus_grant')
        .lt('expires_at', new Date(now).toISOString());
    const lotKeys = [...new Map((grantRows || []).map(r => [r.lot_id, r])).values()];
    const touchedCustomers = new Set();
    for (const g of lotKeys) {
        try {
            const { data: rows } = await supabase.from('balance_history')
                .select('amount').eq('lot_id', g.lot_id);
            const remaining = round2((rows || []).reduce((s, r) => s + (parseFloat(r.amount) || 0), 0));
            if (!(remaining > 0.004)) continue;
            const { error } = await supabase.from('balance_history').insert({
                customer_id: g.customer_id,
                type: 'bonus_expire',
                bucket: 'bonus',
                amount: -remaining,
                source: 'expire',
                expires_at: g.expires_at,
                lot_id: g.lot_id,
                notes: 'Regalo vencido'
            });
            if (error) throw error;
            summary.expired_lots++;
            summary.expired_amount = round2(summary.expired_amount + remaining);
            touchedCustomers.add(g.customer_id);
        } catch (e) { console.error('[Rico] sweep expire failed for lot', g.lot_id, e.message); }
    }
    for (const cid of touchedCustomers) await recomputeBonusBalance(supabase, cid);

    // 2) Heads-up — live lots expiring within ~3 days, once per lot.
    const horizon = new Date(now + 3 * 24 * 3600 * 1000).toISOString();
    const { data: soonRows } = await supabase.from('balance_history')
        .select('customer_id, lot_id, expires_at')
        .eq('type', 'bonus_grant')
        .gt('expires_at', new Date(now).toISOString())
        .lte('expires_at', horizon);
    for (const g of [...new Map((soonRows || []).map(r => [r.lot_id, r])).values()]) {
        try {
            const { data: warned } = await supabase.from('balance_history')
                .select('id').eq('lot_id', g.lot_id).eq('type', 'bonus_warn').limit(1);
            if (warned && warned.length > 0) continue;
            const { data: rows } = await supabase.from('balance_history')
                .select('amount').eq('lot_id', g.lot_id);
            const remaining = round2((rows || []).reduce((s, r) => s + (parseFloat(r.amount) || 0), 0));
            if (!(remaining > 0.004)) continue;
            const daysLeft = Math.max(1, Math.ceil((new Date(g.expires_at).getTime() - now) / (24 * 3600 * 1000)));
            const itemName = await mostRecentHouseMadeItemName(supabase, g.customer_id);
            const sent = await notifyLoyalty(supabase, g.customer_id, {
                kind: 'expire_warn', amount: remaining, expires_at: g.expires_at,
                days_left: daysLeft, item_name: itemName
            });
            // Mark warned either way: one warning per lot (§8b.3) — a
            // failed route must not re-spam the customer daily.
            await supabase.from('balance_history').insert({
                customer_id: g.customer_id,
                type: 'bonus_warn',
                bucket: 'bonus',
                amount: 0,
                source: 'expire_warn',
                expires_at: g.expires_at,
                lot_id: g.lot_id,
                notes: sent ? 'Aviso de vencimiento enviado' : 'Aviso de vencimiento intentado (ruta no disponible)'
            });
            if (sent) summary.heads_up_sent++;
        } catch (e) { console.error('[Rico] sweep heads-up failed for lot', g.lot_id, e.message); }
    }
    return summary;
}

// ---------------------------------------------------------------------
// Calendar math (America/Tegucigalpa) — Racha weeks, broadcast months,
// Especial days all read the shop's clock, never the server's.
// ---------------------------------------------------------------------

function tguParts(now = new Date()) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Tegucigalpa', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });
    const parts = {};
    for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
    return {
        y: parseInt(parts.year), m: parseInt(parts.month), d: parseInt(parts.day),
        hh: parseInt(parts.hour) % 24, mm: parseInt(parts.minute)
    };
}

/** ISO week key ('2026-W44') of the Tegucigalpa calendar date, shifted. */
function isoWeekKey(now = new Date(), shiftDays = 0) {
    const p = tguParts(now);
    const base = new Date(Date.UTC(p.y, p.m - 1, p.d + shiftDays));
    const date = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function quarterKey(now = new Date()) {
    const p = tguParts(now);
    return `${p.y}-Q${Math.ceil(p.m / 3)}`;
}

function tguDateKey(now = new Date()) {
    const p = tguParts(now);
    return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

function tguMinutes(now = new Date()) {
    const p = tguParts(now);
    return p.hh * 60 + p.mm;
}

function parseHHMM(s, fallbackMinutes) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    if (!m) return fallbackMinutes;
    return parseInt(m[1]) * 60 + parseInt(m[2]);
}

// ---------------------------------------------------------------------
// Racha del Capitán (owner, 2026-10-30)
// One PAID order per calendar week keeps the streak. "Paid" means real
// money: only the non-gift portion counts (order.total − rico_bonus_used
// > 0), so a fully gift-funded order can never farm the streak. The
// discount is computed at pricing time (order-service) and the week is
// counted at paid time (processPaidOrder → applyStreakAtPaid). One
// automatic freeze per quarter covers a single missed week.
// ---------------------------------------------------------------------

function streakPctForLevel(settings, level) {
    const ladder = (settings && Array.isArray(settings.streak_ladder) && settings.streak_ladder.length)
        ? settings.streak_ladder : DEFAULT_LOYALTY_SETTINGS.streak_ladder;
    const idx = Math.max(0, Math.min(parseInt(level) || 1, ladder.length) - 1);
    return (parseFloat(ladder[idx]) || 0) / 100;
}

/** Pure read of a customer's streak position (cuenta + pricing). */
function streakStatus(customer, settings, now = new Date()) {
    if (!settings || settings.streak_enabled === false) return { enabled: false };
    const weeks = parseInt(customer && customer.streak_weeks) || 0;
    const last = (customer && customer.streak_last_week) || null;
    const freezeAvailable = !customer || customer.streak_freeze_quarter !== quarterKey(now);
    let alive = false, countedThisWeek = false, levelNext = 1;
    if (last && last === isoWeekKey(now)) {
        alive = weeks > 0; countedThisWeek = true; levelNext = Math.max(1, weeks);
    } else if (last && last === isoWeekKey(now, -7)) {
        alive = weeks > 0; levelNext = weeks + 1;
    } else if (last && last === isoWeekKey(now, -14) && weeks > 0 && freezeAvailable) {
        alive = true; levelNext = weeks + 1; // the freeze would cover the gap
    }
    return {
        enabled: true, weeks, alive, countedThisWeek, freezeAvailable,
        levelNext, pctNext: Math.round(streakPctForLevel(settings, levelNext) * 100)
    };
}

/** Pricing-time Racha discount: % of the house-made net portion only. */
async function streakDiscountForOrder(supabase = defaultSupabase, { customer, items, discount = 0, restaurantId, now = new Date() } = {}) {
    try {
        if (!customer) return { discount: 0 };
        const settings = await getLoyaltySettings(supabase, restaurantId);
        const st = streakStatus(customer, settings, now);
        if (!st.enabled || !(st.pctNext > 0)) return { discount: 0 };
        const { houseNet } = computeHouseNet(items, discount);
        const amount = round2(houseNet * streakPctForLevel(settings, st.levelNext));
        return amount > 0
            ? { discount: amount, pct: st.pctNext, level: st.levelNext }
            : { discount: 0 };
    } catch (e) {
        console.error('[Rico] streak discount failed (order unaffected):', e && e.message);
        return { discount: 0 };
    }
}

/** Paid-time week counting. Returns { counted, weeks, pct, freezeUsed }. */
async function applyStreakAtPaid(supabase = defaultSupabase, order, settings, now = new Date()) {
    try {
        if (!order || !order.customer_id) return null;
        const realMoney = round2((parseFloat(order.total) || 0) - (parseFloat(order.rico_bonus_used) || 0));
        if (!(realMoney > 0)) return null; // gift-only orders never count
        const { data: customer } = await supabase.from('customers')
            .select('id, streak_weeks, streak_last_week, streak_freeze_quarter')
            .eq('id', order.customer_id).maybeSingle();
        if (!customer) return null;
        const thisKey = isoWeekKey(now);
        if (customer.streak_last_week === thisKey) {
            return { counted: false, weeks: parseInt(customer.streak_weeks) || 0 };
        }
        const qKey = quarterKey(now);
        let weeks, freezeQuarter = customer.streak_freeze_quarter || null, freezeUsed = false;
        if (customer.streak_last_week === isoWeekKey(now, -7)) {
            weeks = (parseInt(customer.streak_weeks) || 0) + 1;
        } else if (customer.streak_last_week === isoWeekKey(now, -14)
            && (parseInt(customer.streak_weeks) || 0) > 0
            && customer.streak_freeze_quarter !== qKey) {
            weeks = (parseInt(customer.streak_weeks) || 0) + 1;
            freezeQuarter = qKey; freezeUsed = true; // the quarterly freeze covers the missed week
        } else {
            weeks = 1;
        }
        await supabase.from('customers').update({
            streak_weeks: weeks, streak_last_week: thisKey, streak_freeze_quarter: freezeQuarter
        }).eq('id', customer.id);
        return { counted: true, weeks, pct: Math.round(streakPctForLevel(settings, weeks) * 100), freezeUsed };
    } catch (e) {
        console.error('[Rico] streak count failed (order unaffected):', e && e.message);
        return null;
    }
}

// ---------------------------------------------------------------------
// Difusión del Capitán (owner, 2026-10-30)
// Audience is mechanical: a customer is reachable when they have a
// phone, they have actually conversed with the shop on WhatsApp
// (wa_last_inbound_at set — that conversation IS the opt-in), and they
// have not opted out (wa_opt_out — ALTO/STOP, honored absolutely).
// Inside a 24h window → free-form text (no Meta cost). Outside → only
// an approved marketing template can reach them.
// ---------------------------------------------------------------------

async function broadcastAudience(supabase = defaultSupabase, now = new Date()) {
    const { data } = await supabase.from('customers')
        .select('id, phone, name, wa_opt_out, wa_last_inbound_at')
        .not('phone', 'is', null)
        .not('wa_last_inbound_at', 'is', null);
    const cutoff = now.getTime() - 24 * 3600 * 1000;
    const windowSeg = [], templateSeg = [];
    for (const c of (data || [])) {
        if (!c.phone || c.wa_opt_out) continue;
        const last = c.wa_last_inbound_at ? new Date(c.wa_last_inbound_at).getTime() : 0;
        (last > cutoff ? windowSeg : templateSeg).push(c);
    }
    return { window: windowSeg, template: templateSeg, total: windowSeg.length + templateSeg.length };
}

async function broadcastsThisMonth(supabase = defaultSupabase, restaurantId = 'rich-aroma', now = new Date()) {
    const p = tguParts(now);
    const monthStart = new Date(Date.UTC(p.y, p.m - 1, 1, 6, 0, 0)).toISOString(); // 00:00 TGU = 06:00 UTC
    const { data } = await supabase.from('broadcasts')
        .select('id, status').eq('restaurant_id', restaurantId || 'rich-aroma')
        .gte('created_at', monthStart);
    // A failed send never reached anyone — it does not consume the ceiling.
    return (data || []).filter(r => r.status !== 'failed').length;
}

const GIFT_BREAKAGE = 0.875; // ~12.5% of gift money is never spent

/** Expected cost of attaching a deal to a broadcast (the gate's math). */
function broadcastDealEstimate(campaign, { recipients = 0, blendedCogs = 0.30, avgTicket = 0, earnRate = 0.10, expectedUses = null, getItem = null } = {}) {
    if (!campaign) return null;
    const cfg = campaign.config || {};
    let face = 0, cost = 0, basis = '';
    if (campaign.type === 'regalo') {
        face = round2((parseFloat(cfg.gift_amount) || 0) * recipients);
        cost = round2(face * GIFT_BREAKAGE * blendedCogs);
        basis = `${recipients} clientes × L.${round2(cfg.gift_amount)} de regalo`;
    } else if (campaign.type === 'multiplicador') {
        face = round2(recipients * avgTicket * earnRate * Math.max(0, (parseFloat(cfg.multiplier) || 1) - 1));
        cost = round2(face * GIFT_BREAKAGE * blendedCogs);
        basis = `${recipients} clientes × ticket promedio L.${round2(avgTicket)} × regalo extra`;
    } else if (campaign.type === 'compra_x_lleva') {
        const uses = expectedUses != null ? expectedUses : Math.ceil(recipients * 0.2);
        const qty = Math.max(1, parseInt(cfg.get_qty) || 1);
        const pct = Math.min(100, Math.max(0, parseFloat(cfg.get_discount_pct != null ? cfg.get_discount_pct : 100) || 0)) / 100;
        const unitPrice = getItem ? (parseFloat(getItem.price) || 0) : 0;
        const unitCost = getItem && getItem.food_cost != null ? getItem.food_cost : unitPrice * blendedCogs;
        face = round2(unitPrice * qty * pct * uses);
        cost = round2(unitCost * qty * pct * uses);
        basis = `${uses} canjes esperados × ${qty} unidad(es)`;
    }
    return { face, cost, basis };
}

/** The broadcast cost panel, computed server-side so the UI never lies. */
async function broadcastPreview(supabase = defaultSupabase, { restaurantId = 'rich-aroma', campaign = null, getItem = null, blendedCogs = 0.30, avgTicket = 0, expectedUses = null, now = new Date() } = {}) {
    const settings = await getLoyaltySettings(supabase, restaurantId);
    const aud = await broadcastAudience(supabase, now);
    const used = await broadcastsThisMonth(supabase, restaurantId, now);
    const templateUnitCost = parseFloat(settings.broadcast_template_cost) || 0;
    const templateCost = round2(aud.template.length * templateUnitCost);
    const deal = broadcastDealEstimate(campaign, {
        recipients: aud.total, blendedCogs, avgTicket,
        earnRate: settings.earn_rate, expectedUses, getItem
    });
    return {
        window_count: aud.window.length,
        template_count: aud.template.length,
        total: aud.total,
        template_unit_cost: templateUnitCost,
        template_cost: templateCost,
        deal,
        total_cost: round2(templateCost + (deal ? deal.cost : 0)),
        month_used: used,
        month_cap: parseInt(settings.broadcast_monthly_cap) || 4,
        template_state: aud.template.length === 0 ? 'not_needed'
            : (settings.broadcast_template_approved && settings.broadcast_template_name ? 'approved' : 'pending'),
        template_name: settings.broadcast_template_name || ''
    };
}

function botBroadcastUrl() {
    const notify = (process.env.BOT_NOTIFY_URL || '').trim();
    if (!notify) return '';
    if (/\/order-notify\/?$/.test(notify)) return notify.replace(/\/order-notify\/?$/, '/broadcast-send');
    return '';
}

/** POST one broadcast job to the bot. Returns its counts, or null. */
async function sendViaBotBroadcast({ windowPhones = [], templatePhones = [], message = '', templateName = '' } = {}) {
    try {
        const url = botBroadcastUrl();
        const secret = (process.env.WHATSAPP_SIGNUP_SECRET || '').trim();
        if (!url || !secret) {
            console.error('[Broadcast] SKIPPED: BOT_NOTIFY_URL (or its /order-notify shape) or WHATSAPP_SIGNUP_SECRET not configured');
            return null;
        }
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + secret },
            body: JSON.stringify({
                window_phones: windowPhones, template_phones: templatePhones,
                message, template_name: templateName
            })
        });
        if (!resp || !resp.ok) {
            console.error(`[Broadcast] bot rejected the job: HTTP ${resp && resp.status}`);
            return null;
        }
        return await resp.json();
    } catch (e) {
        console.error('[Broadcast] bot call failed:', e && e.message);
        return null;
    }
}

// ---------------------------------------------------------------------
// Especial del Día (owner, 2026-10-30)
// One special per day (daily_specials). Customers PULL it by texting
// ESPECIAL — claiming marks them for the day and the special then
// applies on its own at pricing/paid time until the redemption cap
// ("hasta agotar") is hit; the cap counts CLAIMS so a claim is a
// reservation. VIPs are pushed (and pre-claimed) once a day at the
// owner-set hour through the broadcast machinery.
// ---------------------------------------------------------------------

/** Food cost of one menu item from its recipe lines (margin chip math). */
async function itemFoodCost(supabase = defaultSupabase, itemId) {
    try {
        const { data: lines } = await supabase.from('menu_item_ingredients')
            .select('inventory_item_id, quantity').eq('menu_item_id', itemId);
        if (!lines || !lines.length) return null;
        let total = 0, partial = false;
        for (const line of lines) {
            const { data: inv } = await supabase.from('inventory')
                .select('cost_per_unit').eq('id', line.inventory_item_id).maybeSingle();
            const cpu = inv ? parseFloat(inv.cost_per_unit) : NaN;
            if (isNaN(cpu)) { partial = true; continue; }
            total += cpu * (parseFloat(line.quantity) || 0);
        }
        return { cost: round2(total), partial };
    } catch (e) { return null; }
}

async function getSpecialState(supabase = defaultSupabase, { restaurantId = 'rich-aroma', now = new Date() } = {}) {
    const { data: special } = await supabase.from('daily_specials')
        .select('*').eq('restaurant_id', restaurantId || 'rich-aroma')
        .eq('special_date', tguDateKey(now)).eq('active', true).maybeSingle();
    if (!special) return { special: null, phase: 'none', claims: 0, redeemed: 0, exhausted: false };
    const mins = tguMinutes(now);
    const from = parseHHMM(special.starts_time, 0);
    const to = parseHHMM(special.ends_time, 24 * 60);
    const phase = mins < from ? 'before' : (mins >= to ? 'after' : 'active');
    const { data: claimRows } = await supabase.from('special_claims')
        .select('id, redeemed_at').eq('special_id', special.id);
    const claims = (claimRows || []).length;
    const redeemed = (claimRows || []).filter(r => r.redeemed_at).length;
    return {
        special, phase, claims, redeemed,
        exhausted: claims >= Math.max(1, parseInt(special.cap) || 1)
    };
}

/** Claim today's special for a customer (pull or VIP pre-mark). */
async function claimSpecial(supabase = defaultSupabase, { customerId, restaurantId = 'rich-aroma', source = 'pull', now = new Date() } = {}) {
    const st = await getSpecialState(supabase, { restaurantId, now });
    if (!st.special) return { ok: false, state: 'none', ...st };
    if (st.phase !== 'active') return { ok: false, state: st.phase, ...st };
    const { data: existing } = await supabase.from('special_claims')
        .select('*').eq('special_id', st.special.id).eq('customer_id', customerId).maybeSingle();
    if (existing) return { ok: true, state: 'already', claim: existing, ...st };
    if (st.exhausted) return { ok: false, state: 'exhausted', ...st };
    const row = {
        id: 'spc_' + Date.now() + Math.floor(Math.random() * 100000),
        restaurant_id: restaurantId || 'rich-aroma',
        special_id: st.special.id,
        customer_id: customerId,
        source
    };
    const { error } = await supabase.from('special_claims').insert(row);
    if (error) {
        // Unique violation = a parallel claim won; that IS claimed.
        if (error.code === '23505') return { ok: true, state: 'already', ...st };
        throw error;
    }
    return { ok: true, state: 'claimed', claim: row, ...st, claims: st.claims + 1 };
}

/** The customer's live claim for today (pricing + paid-time hooks). */
async function getClaimedSpecial(supabase = defaultSupabase, { customerId, restaurantId = 'rich-aroma', now = new Date() } = {}) {
    try {
        const st = await getSpecialState(supabase, { restaurantId, now });
        if (!st.special || st.phase !== 'active') return null;
        const { data: claim } = await supabase.from('special_claims')
            .select('*').eq('special_id', st.special.id).eq('customer_id', customerId).maybeSingle();
        if (!claim || claim.redeemed_at) return null;
        let campaign = null;
        if (st.special.campaign_id) {
            const { data: c } = await supabase.from('loyalty_campaigns')
                .select('*').eq('id', st.special.campaign_id).maybeSingle();
            campaign = c || null;
        }
        return { special: st.special, claim, campaign };
    } catch (e) {
        console.error('[Especial] claimed lookup failed:', e && e.message);
        return null;
    }
}

/** Pricing-time effect of a claimed special for this cart. */
async function especialDiscountForOrder(supabase = defaultSupabase, { customer, items, restaurantId, now = new Date() } = {}) {
    try {
        if (!customer) return { discount: 0 };
        const claimed = await getClaimedSpecial(supabase, { customerId: customer.id, restaurantId, now });
        if (!claimed) return { discount: 0 };
        if (claimed.campaign) {
            if (claimed.campaign.type !== 'compra_x_lleva') return { discount: 0 };
            const r = buyGetForCampaign(claimed.campaign, items);
            return r.discount > 0 ? { discount: r.discount, kind: 'deal' } : { discount: 0 };
        }
        if (claimed.special.item_id) {
            const line = (items || []).find(i => i && i.id === claimed.special.item_id);
            if (!line) return { discount: 0 };
            const unit = lineTotal(line) / Math.max(1, parseInt(line.qty) || 1);
            return { discount: round2(unit), kind: 'item' }; // ONE unit on the house
        }
        return { discount: 0 };
    } catch (e) {
        console.error('[Especial] discount failed (order unaffected):', e && e.message);
        return { discount: 0 };
    }
}

async function markEspecialRedeemed(supabase = defaultSupabase, claimed, order) {
    try {
        await supabase.from('special_claims').update({
            redeemed_order_id: order && order.id ? order.id : null,
            redeemed_at: new Date().toISOString()
        }).eq('id', claimed.claim.id).is('redeemed_at', null);
    } catch (e) { console.error('[Especial] redeem mark failed:', e && e.message); }
}

/** Margin cost of ONE redemption of a special (the cost panel's unit). */
async function especialPerUseCost(supabase = defaultSupabase, special, { blendedCogs = 0.30, avgTicket = 0, earnRate = 0.10 } = {}) {
    try {
        if (!special) return { perUse: 0, basis: '' };
        if (special.item_id) {
            const fc = await itemFoodCost(supabase, special.item_id);
            if (fc) return { perUse: fc.cost, basis: fc.partial ? 'costo de la receta (parcial: faltan precios de insumos)' : 'costo de la receta' };
            const { data: item } = await supabase.from('menu_items')
                .select('price').eq('id', special.item_id).maybeSingle();
            return { perUse: round2((parseFloat(item && item.price) || 0) * blendedCogs), basis: 'estimado: el artículo aún no tiene receta costeada' };
        }
        if (special.campaign_id) {
            const { data: c } = await supabase.from('loyalty_campaigns')
                .select('*').eq('id', special.campaign_id).maybeSingle();
            if (!c) return { perUse: 0, basis: '' };
            const cfg = c.config || {};
            if (c.type === 'regalo') {
                return { perUse: round2((parseFloat(cfg.gift_amount) || 0) * GIFT_BREAKAGE * blendedCogs), basis: 'regalo × lo que realmente cuesta cuando se gasta' };
            }
            if (c.type === 'multiplicador') {
                return { perUse: round2(avgTicket * earnRate * Math.max(0, (parseFloat(cfg.multiplier) || 1) - 1) * GIFT_BREAKAGE * blendedCogs), basis: 'ticket promedio × regalo extra' };
            }
            if (c.type === 'compra_x_lleva') {
                const fc = await itemFoodCost(supabase, cfg.get_item_id);
                const qty = Math.max(1, parseInt(cfg.get_qty) || 1);
                const pct = Math.min(100, Math.max(0, parseFloat(cfg.get_discount_pct != null ? cfg.get_discount_pct : 100) || 0)) / 100;
                if (fc) return { perUse: round2(fc.cost * qty * pct), basis: 'costo del artículo que se lleva' };
                const { data: item } = await supabase.from('menu_items')
                    .select('price').eq('id', cfg.get_item_id).maybeSingle();
                return { perUse: round2((parseFloat(item && item.price) || 0) * blendedCogs * qty * pct), basis: 'estimado: el artículo que se lleva no tiene receta costeada' };
            }
        }
        return { perUse: 0, basis: '' };
    } catch (e) { return { perUse: 0, basis: '' }; }
}

/** Spanish reveal copy for the pull door (composed by the OS, once). */
async function especialReveal(supabase = defaultSupabase, { customerId, restaurantId = 'rich-aroma', now = new Date() } = {}) {
    const res = await claimSpecial(supabase, { customerId, restaurantId, source: 'pull', now });
    const s = res.special;
    if (!s || res.state === 'none') {
        return { state: 'none', text: 'Hoy el Capitán no escondió ningún especial 😄 Pero la casa está abierta y el menú completo te espera — escribí "menú" y te lo muestro.' };
    }
    if (res.state === 'before') {
        return { state: 'before', text: `El especial de hoy se revela de ${s.starts_time} a ${s.ends_time} ⏰ Volvé en ese horario y escribí ESPECIAL.` };
    }
    if (res.state === 'after') {
        return { state: 'after', text: 'El especial de hoy ya cerró por hoy 😴 Mañana el Capitán esconde otro — escribí ESPECIAL y te lo cuento.' };
    }
    if (res.state === 'exhausted') {
        return { state: 'exhausted', text: '¡Voló! 🎈 El especial de hoy se agotó. Mañana hay otro — escribí ESPECIAL temprano y te lo guardo.' };
    }
    // claimed / already — reveal it
    let what = '';
    if (s.item_id) {
        const { data: item } = await supabase.from('menu_items')
            .select('name').eq('id', s.item_id).maybeSingle();
        what = `hoy tu ${item && item.name ? item.name : 'artículo especial'} va GRATIS (uno) con tu pedido 🎁`;
    } else if (res && s.campaign_id) {
        const { data: c } = await supabase.from('loyalty_campaigns')
            .select('*').eq('id', s.campaign_id).maybeSingle();
        const cfg = (c && c.config) || {};
        if (c && c.type === 'multiplicador') {
            what = `hoy el regalo por tu compra se multiplica ×${cfg.multiplier || 2} 🎁`;
        } else if (c && c.type === 'regalo') {
            what = `hoy, con tu compra, te regalamos L.${round2(cfg.gift_amount)} de Rico Cash 🎁`;
        } else if (c && c.type === 'compra_x_lleva') {
            const names = {};
            for (const key of ['buy_item_id', 'get_item_id']) {
                const { data: it } = await supabase.from('menu_items')
                    .select('name').eq('id', cfg[key]).maybeSingle();
                names[key] = it && it.name ? it.name : 'tu favorito';
            }
            what = `hoy comprás ${names.buy_item_id} y te llevás ${names.get_item_id} ${(parseFloat(cfg.get_discount_pct != null ? cfg.get_discount_pct : 100) >= 100) ? 'GRATIS' : 'con descuento'} 🎁`;
        }
    }
    if (!what) what = 'hoy tenés un especial guardado 🎁';
    return {
        state: res.state,
        text: `🎁 ¡ESPECIAL DEL DÍA! ${what} Ya quedó guardado a tu nombre: pedí normal y se aplica solo. Solo hoy, hasta agotar.`
    };
}

/** VIP audience: VIP tag/flag OR Gold (1,500+ legacy points), minus
 *  every opt-out. The especial push has its OWN opt-in (especial_opt_out)
 *  on top of the global one — ALTO sets both. */
async function especialVipAudience(supabase = defaultSupabase, now = new Date()) {
    const { data } = await supabase.from('customers')
        .select('id, phone, name, is_vip, tags, points, wa_opt_out, especial_opt_out, wa_last_inbound_at')
        .not('phone', 'is', null);
    const cutoff = now.getTime() - 24 * 3600 * 1000;
    const windowSeg = [], templateSeg = [];
    for (const c of (data || [])) {
        if (!c.phone || c.wa_opt_out || c.especial_opt_out) continue;
        const tags = Array.isArray(c.tags) ? c.tags : [];
        const isVip = c.is_vip === true || tags.includes('VIP') || (parseInt(c.points) || 0) >= 1500;
        if (!isVip) continue;
        const last = c.wa_last_inbound_at ? new Date(c.wa_last_inbound_at).getTime() : 0;
        (last > cutoff ? windowSeg : templateSeg).push(c);
    }
    return { window: windowSeg, template: templateSeg, total: windowSeg.length + templateSeg.length };
}

/**
 * The VIP push runner: fires at most once per day, never before the
 * owner-set hour, never on a day with no special. Pre-marks claims for
 * everyone it actually sends to (cap-respecting), then sends through
 * the broadcast machinery: window segment free-form, the rest via the
 * approved template; if the template is not approved yet, that segment
 * is reported as pending_template — a state, never an error.
 */
async function runEspecialPush(supabase = defaultSupabase, { restaurantId = 'rich-aroma', now = new Date() } = {}) {
    try {
        const settings = await getLoyaltySettings(supabase, restaurantId);
        const st = await getSpecialState(supabase, { restaurantId, now });
        if (!st.special) return { sent: 0, reason: 'no_special' };
        if (st.special.push_sent_at) return { sent: 0, reason: 'already_sent' };
        if (tguMinutes(now) < parseHHMM(settings.especial_push_time, 570)) {
            return { sent: 0, reason: 'too_early' };
        }
        const aud = await especialVipAudience(supabase, now);
        const templateName = settings.especial_template_name || settings.broadcast_template_name || '';
        const templateOk = !!(settings.broadcast_template_approved && templateName);
        let slots = Math.max(0, (parseInt(st.special.cap) || 0) - st.claims);
        const pick = [];
        for (const c of [...aud.window, ...(templateOk ? aud.template : [])]) {
            if (slots <= 0) break;
            pick.push(c); slots--;
        }
        const pendingTemplate = templateOk ? 0 : aud.template.length;
        if (pick.length === 0) {
            return { sent: 0, reason: templateOk ? 'no_audience' : 'template_pending', pending_template: pendingTemplate };
        }
        // Pre-mark claims (the push IS their claim for the day).
        let claimed = 0;
        for (const c of pick) {
            const { error } = await supabase.from('special_claims').insert({
                id: 'spc_' + Date.now() + Math.floor(Math.random() * 100000) + claimed,
                restaurant_id: restaurantId || 'rich-aroma',
                special_id: st.special.id, customer_id: c.id, source: 'vip_push'
            });
            if (!error) claimed++;
        }
        const inWindow = new Set(aud.window.map(c => c.id));
        const result = await sendViaBotBroadcast({
            windowPhones: pick.filter(c => inWindow.has(c.id)).map(c => c.phone),
            templatePhones: pick.filter(c => !inWindow.has(c.id)).map(c => c.phone),
            message: '🔥 Capitán Rico: hoy hay un ESPECIAL DEL DÍA en Rich Aroma y ya quedó guardado a tu nombre. Escribí ESPECIAL y te lo cuento 🎁',
            templateName
        });
        if (!result) return { sent: 0, reason: 'bot_unreachable', claims: claimed };
        const sent = (result.sent_window || 0) + (result.sent_template || 0);
        await supabase.from('daily_specials').update({
            push_sent_at: now.toISOString(),
            push_result: { ...result, pending_template: pendingTemplate, claims: claimed }
        }).eq('id', st.special.id);
        return { sent, claims: claimed, pending_template: pendingTemplate, result };
    } catch (e) {
        console.error('[Especial] push failed:', e && e.message);
        return { sent: 0, reason: 'error', error: e && e.message };
    }
}

module.exports = {
    round2,
    DEFAULT_LOYALTY_SETTINGS,
    DEFAULT_BOGO_ITEM_IDS,
    getLoyaltySettings,
    getLiveLots,
    getBonusBalance,
    recomputeBonusBalance,
    mintBonusLot,
    ladderBonusFor,
    grantRecargaBonus,
    computeHouseNet,
    allocateBonusToItems,
    spendBonus,
    settleWalletForOrder,
    campaignInWindow,
    campaignMultiplier,
    buyGetDiscount,
    buyGetForCampaign,
    regaloGrantsForOrder,
    bogoDiscount,
    markBogoRedeemed,
    earnForPaidOrder,
    processPaidOrder,
    mintPendingMissionGrants,
    runSweep,
    notifyLoyalty,
    tguParts,
    isoWeekKey,
    quarterKey,
    tguDateKey,
    tguMinutes,
    streakPctForLevel,
    streakStatus,
    streakDiscountForOrder,
    applyStreakAtPaid,
    broadcastAudience,
    broadcastsThisMonth,
    broadcastDealEstimate,
    broadcastPreview,
    sendViaBotBroadcast,
    itemFoodCost,
    getSpecialState,
    claimSpecial,
    getClaimedSpecial,
    especialDiscountForOrder,
    markEspecialRedeemed,
    especialPerUseCost,
    especialReveal,
    especialVipAudience,
    runEspecialPush
};
