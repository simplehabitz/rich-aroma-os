const crypto = require('crypto');
const { supabase } = require('./lib/supabase');
const { isMasterPin, isAdminCredential } = require('./lib/auth');
const { pinThrottleCheck, pinThrottleFail, pinThrottleSuccess } = require('./lib/rate-limit');
const { awardPoints, syncMembershipState } = require('./lib/loyalty');
const ricoLoyalty = require('./lib/rico-loyalty');
const { describeMenuItemPhoto } = require('./lib/ai-service');

// ---------------------------------------------------------------------------
// SEC-FIX 2b (audit F4, second half): server-side pricing helpers for the
// orders POST below — the /api/orders path (vercel.json rewrites POST
// /api/orders to this handler). The logic is identical to SEC-FIX 2's
// order-service pricing, so both checkout paths charge exactly what the
// menu displays: unit prices are recomputed from menu_items
// (displayPriceFor mirrors handler-v2-menu: batch-expiry discount first,
// then the rich-aroma transform round(price * 1.15 / 5) * 5) plus each
// modifier option's price_adjustment from modifier_options, matched by id
// when present, else by name, within the groups linked to the item via
// item_modifier_groups.
// ---------------------------------------------------------------------------

function round2(n) {
    return parseFloat((parseFloat(n) || 0).toFixed(2));
}

/** Selling price of a menu_items row, mirroring handler-v2-menu exactly. */
function displayPriceFor(menuRow, settings, restaurantId) {
    let p = parseFloat(menuRow.price) || 0;
    let finalPrice = p;
    const productInventory = (settings && settings.product_inventory) || {};
    const batches = (settings && settings.batches) || [];
    const cfg = productInventory[menuRow.id] || { is_unlimited: true };
    if (cfg.is_unlimited === false) {
        const now = new Date();
        const valid = batches.filter(b => b.menu_item_id === menuRow.id && new Date(b.expires_at) > now && (parseFloat(b.quantity) || 0) > 0);
        if (valid.length > 0) {
            const sorted = [...valid].sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at));
            const expiresInHours = (new Date(sorted[0].expires_at) - now) / (1000 * 60 * 60);
            if (expiresInHours <= 12) finalPrice = p * 0.50;
            else if (expiresInHours <= 24) finalPrice = p * 0.80;
        }
    }
    if (restaurantId === 'rich-aroma') {
        finalPrice = Math.round((finalPrice * 1.15) / 5) * 5;
    }
    return finalPrice;
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    if (req.method === 'OPTIONS') return res.status(200).end();

    // 1. EXTRACT ACTION & ID (Support both /api/store?action=X and /api/orders/:id)
    let action = req.query.action;
    let id = req.query.id;
    
    const urlParts = req.url.split('?')[0].split('/');
    if (!action) {
        if (urlParts.includes('status')) action = 'store_status';
        else if (urlParts.includes('orders')) {
            action = 'orders';
            const ordIdx = urlParts.indexOf('orders');
            if (urlParts[ordIdx + 1]) id = urlParts[ordIdx + 1];
        }
    }

    // Auto-fix for common shift typos
    if (action === 'close-sft') action = 'close-shift';

    // --- Consolidated handlers (2026-10-21): former standalone functions,
    // code unchanged in api/lib/handler-*.js; public URLs kept via vercel.json.
    if (action === 'create_order') return require('./lib/handler-orders-v2')(req, res);
    if (action === 'upload_receipt') return require('./lib/handler-receipt')(req, res);
    if (action === 'topup') return require('./lib/handler-topup')(req, res);
    if (action === 'auth_login' || action === 'auth_register') {
        req.query.action = action === 'auth_login' ? 'login' : 'register';
        return require('./lib/handler-auth')(req, res);
    }
    if (action === 'auth_passthrough') return require('./lib/handler-auth')(req, res);

    const { restaurantId, resId, query: queryParam } = req.query;
    let finalResId = restaurantId || resId || 'rich-aroma';

    // Auto-map names to IDs for partners
    if (finalResId && typeof finalResId === 'string') {
        const lowerId = finalResId.toLowerCase();
        if (lowerId.includes('fradas')) finalResId = 'fradas-bar--grill-445';
        else if (lowerId.includes('tony') || lowerId.includes('cerca')) finalResId = 'tonys-pizza';
        else if (lowerId.includes('meson')) finalResId = 'el-meson';
    }

    // --- SEC-FIX 1 (2026-10-24): staff credential gate ---
    // The clients already hold a credential: POS/KDS/members send the staff
    // PIN as "Authorization: Bearer <PIN>", partner pages send the
    // restaurant's settings PIN the same way. Accept exactly what
    // verify-pin accepts: the env master PIN, an active employee's PIN,
    // or the settings PIN of the restaurant being acted on.
    function bearerCred() {
        const h = req.headers.authorization || req.headers.Authorization || '';
        return String(h).replace(/^Bearer\s+/i, '').trim();
    }
    async function staffActor() {
        const cred = bearerCred();
        if (!cred) return null;
        if (isMasterPin(cred)) return { id: 'master', name: 'Admin', role: 'admin' };
        const { data: emp } = await supabase.from('employees').select('id, name, role').eq('pin', cred).eq('active', true).maybeSingle();
        if (emp) return emp;
        const targets = [finalResId, req.body?.restaurantId, req.body?.restaurant_id].filter(Boolean);
        for (const t of [...new Set(targets)]) {
            const { data: rest } = await supabase.from('restaurants').select('settings').eq('id', t).maybeSingle();
            if (rest && rest.settings && rest.settings.pin && String(rest.settings.pin) === cred) return { id: 'master', name: 'Admin', role: 'admin' };
        }
        return null;
    }
    async function requireStaff() {
        const actor = await staffActor();
        if (!actor) { res.status(401).json({ error: 'Se requiere credencial de personal' }); return null; }
        return actor;
    }
    async function customerPinMatches(customerId, pin) {
        if (!customerId || !pin) return false;
        const { data: c } = await supabase.from('customers').select('pin').eq('id', customerId).maybeSingle();
        return !!c && !!c.pin && String(c.pin) === String(pin);
    }
    // Customer rows must never leave the API with credential fields on them.
    function sanitizeCustomer(row) {
        if (!row || typeof row !== 'object') return row;
        const copy = { ...row };
        delete copy.pin;
        delete copy.password;
        return copy;
    }
    // --- WhatsApp intro bot gate (server-to-server) ---
    // The Honduras intro bot (whatsapp-front-desk) creates accounts
    // through the whatsapp_* actions below. (It used to also record
    // pending welcome gifts — retired 2026-10-26, see the gate at
    // whatsapp_signup.) It authenticates with a shared secret the owner sets as
    // WHATSAPP_SIGNUP_SECRET in BOTH Vercel (here) and Render (the bot).
    // Not a staff PIN and NOT public: fail closed when the env var is
    // unset, and compare in constant time.
    function botSecretOk() {
        const expected = process.env.WHATSAPP_SIGNUP_SECRET || '';
        if (!expected) return false;
        const cred = bearerCred();
        if (!cred) return false;
        const a = Buffer.from(cred);
        const b = Buffer.from(expected);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    // Phone normalization shared by the whatsapp_* actions — mirrors
    // customer_by_phone / customer_create: digits only, 8-digit local
    // numbers gain the 504 country code.
    function normalizePhone(raw) {
        const clean = String(raw || '').replace(/\D/g, '');
        if (!clean) return '';
        return clean.length === 8 ? `504${clean}` : clean;
    }
    async function findCustomerByPhone(phoneToStore) {
        if (!phoneToStore) return null;
        const variants = [...new Set([phoneToStore, phoneToStore.replace(/^504/, '')])];
        const { data } = await supabase.from('customers').select('*')
            .in('phone', variants).limit(1);
        return (data && data[0]) || null;
    }

    // --- CREADORES: signup-word attribution (first-touch) ---
    // Every creator in the Creadores program gets a signup WORD. A
    // customer who arrives carrying it is attributed to that creator
    // (creators earn a share of attributed customers' sales — the
    // earnings math itself is the month-2 build; this build only
    // CAPTURES, because a month of unattributed signups is data lost
    // forever). Attribution is FIRST-TOUCH and permanent:
    // customer_attribution is insert-once — its customer_id PRIMARY
    // KEY is the rule — and this helper NEVER updates it; a later
    // word is answered, not written.
    // One word never binds at all: the creator's OWN. When the
    // code's creator_customer_id IS the customer being attributed,
    // the attempt is a non-bind (reason 'self_word') — a creator
    // must never harvest their own purchases (CREADORES-PROGRAM.md;
    // the block was owner-approved 2026-10-26).
    // Normalization is one function used in BOTH directions (staff
    // creating a code, customers sending a word): trim, single token,
    // UPPERCASE, diacritics stripped (NFD + combining-mark removal
    // turns Á→A and Ñ→N). "Capitán", "capitan" and "CAPITÁN" are one
    // word. Surrounding punctuation and a leading @/# are dropped so
    // a word copied off a flyer still matches; anything with inner
    // whitespace or nothing left after cleanup is not a word ('').
    function normalizeWord(raw) {
        if (raw == null) return '';
        let w = String(raw).trim();
        if (!w || /\s/.test(w)) return '';
        w = w.replace(/^[@#]+/, '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        w = w.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
        if (!w || /\s/.test(w) || !/^[\p{L}\p{N}]+$/u.test(w)) return '';
        return w;
    }
    async function attributeCustomer(customerId, wordRaw, channel) {
        const word = normalizeWord(wordRaw);
        if (!customerId) return { attributed: false, reason: 'unknown_word' };
        // First touch wins over everything: an existing row answers
        // for ANY later word (valid, invalid, unparseable or retired).
        const { data: existing } = await supabase.from('customer_attribution')
            .select('*').eq('customer_id', customerId).maybeSingle();
        if (existing) {
            let existingName = existing.creator_code;
            const { data: ec } = await supabase.from('creator_codes')
                .select('creator_name').eq('code', existing.creator_code).maybeSingle();
            if (ec && ec.creator_name) existingName = ec.creator_name;
            return { attributed: false, reason: 'already_attributed', creator_name: existingName };
        }
        if (!word) return { attributed: false, reason: 'unknown_word' };
        const { data: codeRow } = await supabase.from('creator_codes')
            .select('*').eq('code', word).maybeSingle();
        if (!codeRow) return { attributed: false, reason: 'unknown_word' };
        if (!codeRow.is_active) return { attributed: false, reason: 'inactive_code', creator_name: codeRow.creator_name };
        // SELF-BLOCK: the word is real and active, but it belongs to
        // THIS customer — binding it would attribute the creator's
        // own account (and, later, their own purchases) to
        // themselves. Answer as a plain non-bind and write nothing:
        // signup surfaces it as attribution null ("silently null"),
        // whatsapp_attribute as ok:false — the bot renders the
        // 'self_word' reason through its unknown-word fall-through
        // (silence for a speculative attempt, the unrecognized-word
        // line for a deliberate one) and never a ligada line. A
        // house word (creator_customer_id NULL) skips this check
        // and binds normally, as does any OTHER customer using this
        // creator's word, and this creator using someone else's.
        if (codeRow.creator_customer_id && codeRow.creator_customer_id === customerId) {
            return { attributed: false, reason: 'self_word', creator_name: codeRow.creator_name };
        }
        const { error } = await supabase.from('customer_attribution').insert({
            customer_id: customerId,
            creator_code: word,
            word_raw: String(wordRaw || '').slice(0, 80),
            channel: ['whatsapp', 'pos', 'web'].includes(channel) ? channel : 'whatsapp'
        });
        if (error) {
            // The PRIMARY KEY is the backstop: a concurrent first
            // touch won the race — report it as already_attributed
            // and never overwrite.
            if (error.code === '23505') {
                const { data: row } = await supabase.from('customer_attribution')
                    .select('*').eq('customer_id', customerId).maybeSingle();
                let winner = row ? row.creator_code : null;
                if (row) {
                    const { data: wc } = await supabase.from('creator_codes')
                        .select('creator_name').eq('code', row.creator_code).maybeSingle();
                    if (wc && wc.creator_name) winner = wc.creator_name;
                }
                return { attributed: false, reason: 'already_attributed', creator_name: winner };
            }
            throw error;
        }
        return { attributed: true, creator_name: codeRow.creator_name };
    }

    // --- MISIONES DEL CAPITÁN: purchase-unlocked UGC challenges ---
    // A PAID order containing a mission's trigger item unlocks that
    // mission for the customer (one OPEN assignment per customer,
    // replays governed by the mission's max_completions_per_customer,
    // mission cap respected, mission must be active and inside its
    // date window, and the trigger item must have been paid with REAL
    // money — see missionBonusAppliedToItem). The bot reads the
    // unlocks through whatsapp_mission_check
    // and delivers them; the reward is decided later by staff in
    // /admin (admin_mission_decide) and lands as a PENDING row in
    // reward_grants for the loyalty build to mint — it never touches
    // rico_balance here. This helper NEVER throws: a mission bug must
    // not break an order, ever. It returns how many missions unlocked.
    // OWNER RULE: gift money never unlocks a mission. A mission
    // unlocks only when its trigger item was paid with REAL money —
    // cash, card, transfer, or the customer's own topped-up Rico
    // balance (their money). If any BONUS/gift balance (rico_bonus)
    // was applied to the trigger item, this returns > 0 and the order
    // does NOT unlock that mission — which also means a gift earned
    // from mission A can never fund mission B's trigger.
    // The split is read from the order: a per-item field first
    // (items[].rico_bonus_used, if the loyalty build records it),
    // else the order-level orders.rico_bonus_used. NEITHER FIELD
    // EXISTS YET — the two-bucket spend lands with the loyalty
    // build, which MUST populate rico_bonus_used on every order
    // where bonus balance was spent. Absent field = 0 = eligible:
    // safe today because bonus money cannot be spent at all yet.
    // With only the order-level figure, ANY bonus on the order
    // disqualifies the trigger item (conservative on purpose: the
    // two-bucket design draws bonus against house-made items first,
    // and mission triggers are house-made).
    function missionBonusAppliedToItem(order, itemId) {
        if (!order) return 0;
        const items = Array.isArray(order.items) ? order.items : [];
        const line = items.find(i => i && (i.id || i.item_id) === itemId);
        if (line && line.rico_bonus_used !== undefined && line.rico_bonus_used !== null) {
            return parseFloat(line.rico_bonus_used) || 0;
        }
        if (order.rico_bonus_used !== undefined && order.rico_bonus_used !== null) {
            return parseFloat(order.rico_bonus_used) || 0;
        }
        return 0;
    }

    async function unlockMissionsForOrder(order) {
        try {
            if (!order || order.status !== 'paid' || !order.customer_id) return 0;
            const itemIds = [...new Set((Array.isArray(order.items) ? order.items : [])
                .map(i => i && (i.id || i.item_id)).filter(Boolean))];
            if (!itemIds.length) return 0;
            const today = new Date().toISOString().slice(0, 10);
            const { data: missions, error: mErr } = await supabase.from('missions')
                .select('*').eq('is_active', true).in('trigger_item_id', itemIds);
            if (mErr) { console.error('[Missions] mission lookup failed:', mErr.message); return 0; }
            let unlocked = 0;
            for (const m of (missions || [])) {
                try {
                    if (m.active_from && today < String(m.active_from).slice(0, 10)) continue;
                    if (m.active_to && today > String(m.active_to).slice(0, 10)) continue;
                    // Gift money never unlocks (owner rule, above).
                    if (missionBonusAppliedToItem(order, m.trigger_item_id) > 0) continue;
                    // One OPEN assignment per customer (the partial
                    // unique index is the structural backstop), and
                    // replays stop at max_completions_per_customer
                    // counted from 'approved' assignments.
                    const { data: mineAll } = await supabase.from('mission_assignments')
                        .select('id, status, expires_at').eq('mission_id', m.id).eq('customer_id', order.customer_id);
                    const mine = mineAll || [];
                    const nowMs = Date.now();
                    let hasOpen = false;
                    let approvedCount = 0;
                    for (const a of mine) {
                        if (a.status === 'approved') { approvedCount++; continue; }
                        if (a.status === 'submitted') { hasOpen = true; continue; }
                        if (a.status === 'unlocked') {
                            if (a.expires_at && new Date(a.expires_at).getTime() <= nowMs) {
                                // Stale unlock: close it out so a
                                // fresh one can open in its place.
                                await supabase.from('mission_assignments')
                                    .update({ status: 'expired' }).eq('id', a.id).eq('status', 'unlocked');
                            } else { hasOpen = true; }
                        }
                    }
                    if (hasOpen) continue;
                    const maxCompletions = Math.max(1, parseInt(m.max_completions_per_customer) || 1);
                    if (approvedCount >= maxCompletions) continue;
                    if (m.cap_total) {
                        const { data: all } = await supabase.from('mission_assignments')
                            .select('id').eq('mission_id', m.id);
                        if ((all || []).length >= m.cap_total) continue;
                    }
                    const now = new Date();
                    const expires = new Date(now.getTime() + (parseInt(m.deadline_hours) || 48) * 3600 * 1000);
                    const { error } = await supabase.from('mission_assignments').insert({
                        id: 'masn_' + Date.now() + Math.floor(Math.random() * 100000),
                        mission_id: m.id,
                        customer_id: order.customer_id,
                        order_id: order.id,
                        status: 'unlocked',
                        unlocked_at: now.toISOString(),
                        expires_at: expires.toISOString()
                    });
                    if (!error) unlocked++;
                } catch (e) { /* one bad mission must not stop the others */ }
            }
            return unlocked;
        } catch (e) {
            console.error('[Missions] unlock failed (order unaffected):', e && e.message);
            return 0;
        }
    }

    // --- WhatsApp order-status notifications (bot-finalize) ---
    // A WhatsApp-originated order that turns 'ready' or 'cancelled'
    // owes its customer a message ("tu pedido está listo" / the
    // cancellation). The OS only SIGNALS: it POSTs order + status +
    // phone to the bot's /order-notify endpoint, authenticated with
    // the shared WHATSAPP_SIGNUP_SECRET; the bot formats, dedupes
    // (one send per order+status) and delivers via WhatsApp.
    // Failure-silent by the same doctrine as unlockMissionsForOrder:
    // a dead bot endpoint NEVER blocks a status change. Config:
    // BOT_NOTIFY_URL (the bot's /order-notify URL) — unset means the
    // hook is inert, so this half is safe to land before the bot's.
    function isWhatsAppOrder(order) {
        if (!order) return false;
        if (order.source === 'whatsapp' || order.channel === 'whatsapp') return true;
        return /whatsapp/i.test(order.notes || '');
    }

    async function notifyBotOrderStatus(order) {
        try {
            if (!order || !isWhatsAppOrder(order)) return false;
            if (order.status !== 'ready' && order.status !== 'cancelled') return false;
            const url = (process.env.BOT_NOTIFY_URL || '').trim();
            const secret = (process.env.WHATSAPP_SIGNUP_SECRET || '').trim();
            if (!url || !secret) {
                // A WhatsApp customer is owed a message and the hook
                // cannot run — say so LOUDLY in the function logs.
                // (2026-10-26: notifications died silently in
                // production because this gate returned false without
                // a trace; the PATCH still succeeded, so the KDS/POS
                // looked fine and nobody could see why no message
                // ever arrived.)
                console.error(`[Notify] SKIPPED order ${order.order_number || order.id} (${order.status}): ${!url ? 'BOT_NOTIFY_URL' : 'WHATSAPP_SIGNUP_SECRET'} not configured in this deployment's env`);
                return false;
            }
            let phone = '';
            if (order.customer_id) {
                const { data: cust } = await supabase.from('customers')
                    .select('phone').eq('id', order.customer_id).maybeSingle();
                phone = (cust && cust.phone) || '';
            }
            if (!phone) {
                const m = /\[TEL:\s*([^\]]+)\]/.exec(order.notes || '');
                if (m) phone = m[1].trim();
            }
            if (!phone) {
                console.error(`[Notify] SKIPPED order ${order.order_number || order.id} (${order.status}): no customer phone (customer_id=${order.customer_id || 'none'}, no [TEL:] in notes)`);
                return false;
            }
            const reason = String(order.cancel_reason || order.cancellation_reason || '').trim();
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + secret },
                body: JSON.stringify({
                    order_id: order.id,
                    order_number: order.order_number,
                    status: order.status,
                    phone,
                    ...(reason ? { reason } : {}),
                }),
            });
            if (!resp || !resp.ok) {
                // A bot-side rejection (bad secret, bad payload,
                // Meta send failure) used to vanish into this bare
                // false — log the status so the logs name the gate.
                console.error(`[Notify] bot endpoint answered HTTP ${resp ? resp.status : 'no-response'} for order ${order.order_number || order.id} (${order.status})`);
                return false;
            }
            return true;
        } catch (e) {
            console.error('[Notify] bot notify failed (order unaffected):', e && e.message);
            return false;
        }
    }

    try {
        // --- 1. STORE STATUS ---
        if (action === 'store_status' || action === 'status') {
            if (req.method === 'PATCH') {
                if (!(await requireStaff())) return;
                const newStatus = req.body?.isOpen ? 'active' : 'closed';
                const { data, error } = await supabase.from('restaurants').update({ status: newStatus }).eq('id', finalResId).select().single();
                if (error) throw error;
                return res.json({ success: true, isOpen: data.status === 'active' });
            }
            
            // Timezone-aware local shift calculations
            const localTimeStr = new Date().toLocaleString("en-US", { timeZone: "America/Tegucigalpa" });
            const localDate = new Date(localTimeStr);
            const localHour = localDate.getHours();
            const localMin = localDate.getMinutes();
            const currentMinOfDay = localHour * 60 + localMin;
            
            let isShiftOpen = true;
            let statusMessage = "";
            
            const { data: resData } = await supabase.from('restaurants').select('status, settings').eq('id', finalResId).maybeSingle();
            const settings = resData?.settings || {};
            const oh = settings.operating_hours;
            
            if (oh && oh.open && oh.close) {
                const parseTimeToMin = (timeStr) => {
                    if (!timeStr) return null;
                    const parts = timeStr.split(':');
                    if (parts.length < 2) return null;
                    const h = parseInt(parts[0], 10);
                    const m = parseInt(parts[1], 10);
                    if (isNaN(h) || isNaN(m)) return null;
                    return h * 60 + m;
                };

                const currentDay = localDate.getDay(); // 0 = Sunday, 1 = Monday, etc.
                const openDays = Array.isArray(oh.open_days) ? oh.open_days.map(Number) : [1, 2, 3, 4, 5, 6, 0]; // Default all days

                if (!openDays.includes(currentDay)) {
                    isShiftOpen = false;
                    statusMessage = "Cerrado hoy por descanso semanal.";
                } else {
                    const openMin = parseTimeToMin(oh.open) ?? 360; 
                    const closeMin = parseTimeToMin(oh.close) ?? 1320; 
                    const midStartMin = parseTimeToMin(oh.midday_close_start);
                    const midEndMin = parseTimeToMin(oh.midday_close_end);

                    const closingBuffer = parseInt(oh.closing_buffer_min) || 0;
                    const effectiveCloseMin = closeMin - closingBuffer;

                    if (currentMinOfDay < openMin || currentMinOfDay >= effectiveCloseMin) {
                        isShiftOpen = false;
                        if (currentMinOfDay >= effectiveCloseMin && currentMinOfDay < closeMin) {
                            statusMessage = `Cocina cerrada. Ya no se aceptan pedidos 15 min antes del cierre.`;
                        } else {
                            statusMessage = `Cerrado. Abrimos a las ${oh.open}.`;
                        }
                    } else if (midStartMin !== null && midEndMin !== null && currentMinOfDay >= midStartMin && currentMinOfDay < midEndMin) {
                        isShiftOpen = false;
                        statusMessage = `Cerrado por preparación. Reabrimos a las ${oh.midday_close_end}.`;
                    }
                }
            } else if (finalResId === 'rich-aroma') {
                // Fallback to legacy hardcoded shifts
                if (localHour >= 14 && localHour < 16) {
                    isShiftOpen = false;
                    statusMessage = "Cerrado por preparación. ¡Te esperamos a las 4:00 PM para Rico's Smash & Social!";
                } else if (localHour >= 22 || localHour < 6) {
                    isShiftOpen = false;
                    statusMessage = "Cerrado. Abrimos a las 6:00 AM.";
                }
            }

            const isOpen = resData ? (resData.status === 'active' && isShiftOpen) : isShiftOpen;
            return res.json({ isOpen, statusMessage, activeShift: { id: 'shift_today' } });
        }

        // --- 2. ORDERS (GET & UPDATE) ---
        if (action === 'orders' || action === 'order_update') {
            if (req.method === 'PATCH' || (req.method === 'POST' && id)) {
                if (!(await requireStaff())) return;
                const targetId = id || req.body?.orderId;
                const { status, notes, subtotal, discount, total, paymentMethod, secondaryPaymentMethod, customerId, shiftId, items } = req.body || {};
                if (!targetId) return res.status(400).json({ error: "Order ID required" });
                
                const updates = {};
                if (status) updates.status = status;
                if (notes) updates.notes = notes;
                if (items) updates.items = items;
                if (subtotal !== undefined) updates.subtotal = parseFloat(subtotal);
                if (discount !== undefined) updates.discount = parseFloat(discount);
                if (total !== undefined) updates.total = parseFloat(total);
                if (paymentMethod) updates.payment_method = paymentMethod;
                if (secondaryPaymentMethod) updates.secondary_payment_method = secondaryPaymentMethod;
                if (customerId) updates.customer_id = customerId;
                if (shiftId) updates.shift_id = shiftId;

                const { data: prevOrder } = await supabase.from('orders')
                    .select('status, rico_amount_paid').eq('id', targetId).maybeSingle();
                const { data, error } = await supabase.from('orders').update(updates).eq('id', targetId).select().single();
                if (error) throw error;
                // LOYALTY SETTLE (2026-10-30): when THIS update is the
                // payment event (a pending order settled at the till
                // with a Rico tender) and no wallet debit exists yet,
                // run the two-bucket spend against the stored order —
                // gift money first (house-made only), then own money —
                // BEFORE the readers below consume the split.
                if (data && data.status === 'paid' && prevOrder && prevOrder.status !== 'paid' && data.customer_id) {
                    try {
                        const pm = paymentMethod || data.payment_method || '';
                        const sm = secondaryPaymentMethod || data.secondary_payment_method || '';
                        const ricoTender = ['rico_balance', 'rico_cash'].includes(pm) || ['rico_balance', 'rico_cash'].includes(sm);
                        const alreadyDebited = (parseFloat(prevOrder.rico_amount_paid) || 0) > 0;
                        if (ricoTender && !alreadyDebited) {
                            const settled = await ricoLoyalty.settleWalletForOrder(supabase, data, {});
                            if (settled.bonusUsed > 0 || settled.paidUsed > 0) {
                                const { data: updOrder } = await supabase.from('orders').update({
                                    rico_amount_paid: round2(settled.bonusUsed + settled.paidUsed),
                                    rico_bonus_used: settled.bonusUsed,
                                    items: settled.items
                                }).eq('id', data.id).select().single();
                                if (updOrder) { data.rico_amount_paid = updOrder.rico_amount_paid; data.rico_bonus_used = updOrder.rico_bonus_used; data.items = updOrder.items; }
                            }
                        }
                    } catch (settleErr) { console.error('[Rico] settle on order_update failed (order unaffected):', settleErr.message); }
                }
                // MISIONES: an order that just became PAID here (counter
                // sale, transfer approval) unlocks its missions. The
                // helper is failure-silent — the order response below
                // is unaffected either way.
                if (data && data.status === 'paid') await unlockMissionsForOrder(data);
                // LOYALTY (2026-10-30): an order that TRANSITIONS into
                // 'paid' here earns its gift + drops campaign gifts
                // (idempotent per order — see rico-loyalty).
                if (data && data.status === 'paid' && (!prevOrder || prevOrder.status !== 'paid')) await ricoLoyalty.processPaidOrder(supabase, data);
                // NOTIFICACIONES (bot-finalize): a WhatsApp-originated
                // order that just turned ready/cancelled tells its
                // customer through the bot (failure-silent helper).
                if (data && (data.status === 'ready' || data.status === 'cancelled')) await notifyBotOrderStatus(data);
                return res.json({ success: true, order: data });
            }
            if (req.method === 'GET') {
                let query = supabase.from('orders').select('*, customers(name, phone)');
                if (id) {
                    const { data, error } = await query.eq('id', id).maybeSingle();
                    if (error) throw error;
                    return res.json(data);
                }
                const cId = req.query.customerId;
                if (cId) {
                    query = query.eq('customer_id', cId);
                } else {
                    query = query.eq('restaurant_id', finalResId);
                }
                const { data, error } = await query.order('created_at', { ascending: false }).limit(50);
                if (error) throw error;
                return res.json({ orders: data || [] });
            } else if (req.method === 'POST') {
                const { items, total, subtotal, discount, paymentMethod, customerId, notes, fulfillment, guestPhone, shiftId } = req.body || {};
                
                let ricoAmountPaid = 0;
                let allowanceUsedThisOrder = 0;

                // --- 0. SEC-FIX 2b: SERVER-SIDE PRICING (audit F4) ---
                // Client-supplied item prices, subtotal and total are NOT
                // trusted on this path either (same rule as SEC-FIX 2 on
                // /api/orders-v2): every item is repriced from menu_items
                // and the totals below are the server's. An item whose id
                // is not on the menu (e.g. a QuimiEats booking line, which
                // carries no id at all) keeps its client price, is flagged
                // server_priced:false, and can never be charged to Rico
                // Cash (see section 1). A claimed discount is a staff
                // courtesy on this path: it is honored only with a verified
                // staff credential (SEC-FIX 1's staffActor) and never
                // exceeds the server subtotal — promo codes are validated
                // and clamped on the orders-v2 path, not here.
                const rawItems = Array.isArray(items) ? items : [];
                const itemIds = [...new Set(rawItems.map(i => i && i.id).filter(Boolean))];
                const [menuRes, pricingSettingsRes] = await Promise.all([
                    supabase.from('menu_items').select('id, name, price, category, is_house_made, is_vip_free_eligible').in('id', itemIds),
                    supabase.from('restaurants').select('settings').eq('id', finalResId).maybeSingle()
                ]);
                const menuById = {};
                (menuRes.data || []).forEach(m => { if (!(m.id in menuById)) menuById[m.id] = m; });
                const pricingSettings = (pricingSettingsRes && pricingSettingsRes.data && pricingSettingsRes.data.settings) || {};

                // Modifier options for the groups linked to the ordered items
                const optionsByItem = {};
                if (itemIds.length > 0) {
                    const { data: links } = await supabase.from('item_modifier_groups').select('item_id, group_id').in('item_id', itemIds);
                    const groupIds = [...new Set((links || []).map(l => l.group_id).filter(Boolean))];
                    if (groupIds.length > 0) {
                        const { data: opts } = await supabase.from('modifier_options').select('id, group_id, name, price_adjustment').in('group_id', groupIds);
                        const optsByGroup = {};
                        (opts || []).forEach(o => { (optsByGroup[o.group_id] = optsByGroup[o.group_id] || []).push(o); });
                        (links || []).forEach(l => { (optionsByItem[l.item_id] = optionsByItem[l.item_id] || []).push(...(optsByGroup[l.group_id] || [])); });
                    }
                }
                // MOD-STANDARD: countable options (e.g. Splenda sobres) carry
                // a qty in the client snapshot; price once per unit.
                const modQty = (mod) => { const q = parseInt(mod && mod.qty); return Number.isInteger(q) && q > 0 ? Math.min(q, 8) : 1; };
                const matchOption = (itemId, mod) => {
                    const pool = optionsByItem[itemId] || [];
                    if (!pool.length || mod === null || mod === undefined) return null;
                    const modId = (typeof mod === 'object') ? (mod.id || mod.option_id || mod.optionId) : null;
                    if (modId) {
                        const byId = pool.find(o => o.id === modId);
                        if (byId) return byId;
                    }
                    const modName = String(typeof mod === 'object' ? (mod.name || '') : mod).trim().toLowerCase();
                    if (!modName) return null;
                    return pool.find(o => String(o.name || '').trim().toLowerCase() === modName) || null;
                };

                let serverSubtotal = 0;
                let hasUnpricedItem = false;
                const pricedItems = rawItems.map(item => {
                    const safeItem = (item && typeof item === 'object') ? item : {};
                    const meta = menuById[safeItem.id];
                    const qty = parseInt(safeItem.qty) || 1;
                    if (!meta) {
                        hasUnpricedItem = true;
                        const fallbackPrice = parseFloat(safeItem.price) || 0;
                        serverSubtotal += fallbackPrice * qty;
                        return {
                            ...safeItem,
                            qty,
                            price: fallbackPrice,
                            finalPrice: round2(fallbackPrice * qty),
                            category: safeItem.category || 'General',
                            is_house_made: safeItem.is_house_made || false,
                            is_vip_free_eligible: false,
                            server_priced: false
                        };
                    }
                    let unit = displayPriceFor(meta, pricingSettings, finalResId);
                    const mods = Array.isArray(safeItem.mods) ? safeItem.mods : (Array.isArray(safeItem.modifiers) ? safeItem.modifiers : []);
                    mods.forEach(mod => {
                        const opt = matchOption(safeItem.id, mod);
                        if (opt) unit += (parseFloat(opt.price_adjustment) || 0) * modQty(mod);
                    });
                    unit = round2(unit);
                    serverSubtotal += unit * qty;
                    return {
                        ...safeItem,
                        qty,
                        price: unit,
                        finalPrice: round2(unit * qty),
                        category: meta?.category || 'General',
                        is_house_made: meta?.is_house_made || false,
                        is_vip_free_eligible: meta?.is_vip_free_eligible || false,
                        server_priced: true
                    };
                });
                serverSubtotal = round2(serverSubtotal);

                const claimedDiscount = parseFloat(discount) || 0;
                let serverDiscount = 0;
                if (claimedDiscount > 0 && (await staffActor())) {
                    serverDiscount = Math.min(claimedDiscount, serverSubtotal);
                }
                const serverTotal = Math.max(0, round2(serverSubtotal - serverDiscount));

                // --- 1. EMPLOYEE ALLOWANCE LOGIC ---
                if (customerId && paymentMethod === 'rico_balance') {
                    // SEC-FIX 1: a wallet debit needs the account holder's PIN
                    // (self-service) or a staff credential (till) — never a
                    // bare customerId.
                    if (!(await staffActor()) && !(await customerPinMatches(customerId, req.body?.customerPin))) {
                        return res.status(401).json({ error: "Se requiere el PIN del cliente para pagar con Rico Cash" });
                    }
                    // SEC-FIX 2b: an item the server could not price can
                    // never be charged to a wallet — not even from the
                    // employee allowance (same rule as SEC-FIX 2).
                    if (hasUnpricedItem) {
                        return res.status(400).json({ error: 'RICO_UNPRICED_ITEM: No se puede cobrar con Rico Cash un artículo que no está en el menú', code: 'RICO_UNPRICED_ITEM' });
                    }
                    const { data: cust } = await supabase.from('customers').select('*').eq('id', customerId).single();
                    if (cust) {
                        const today = new Date().toISOString().split('T')[0];
                        const lastReset = cust.last_allowance_date || '';
                        let currentUsed = lastReset === today ? (parseFloat(cust.allowance_used_today) || 0) : 0;
                        const limit = parseFloat(cust.daily_allowance) || 0;
                        
                        if (limit > 0) {
                            const remainingAllowance = Math.max(0, limit - currentUsed);
                            allowanceUsedThisOrder = Math.min(serverTotal, remainingAllowance);
                            
                            // Update the allowance tracker
                            await supabase.from('customers').update({
                                allowance_used_today: currentUsed + allowanceUsedThisOrder,
                                last_allowance_date: today
                            }).eq('id', customerId);

                            console.log(`[Allowance] Order Total: L.${serverTotal}. Using L.${allowanceUsedThisOrder} from daily allowance.`);
                        }

                        // --- 2. REMAINING BALANCE FROM REAL RICO CASH ---
                        const remainingToPay = serverTotal - allowanceUsedThisOrder;
                        if (remainingToPay > 0) {
                            const realBalance = parseFloat(cust.rico_balance) || 0;
                            if (realBalance < remainingToPay) throw new Error("Saldo insuficiente en Rico Cash");
                            
                            await supabase.from('customers').update({
                                rico_balance: realBalance - remainingToPay
                            }).eq('id', customerId);
                            
                            ricoAmountPaid = remainingToPay;
                            console.log(`[RicoCash] Charging remaining L.${remainingToPay} to real balance.`);
                        }
                    }
                }

                const { data, error } = await supabase.from('orders').insert({
                    id: 'ord_' + Date.now(),
                    order_number: Math.floor(Date.now() / 1000) - 1769000000,
                    items: pricedItems,
                    total: serverTotal,
                    subtotal: serverSubtotal,
                    discount: serverDiscount,
                    payment_method: paymentMethod, 
                    customer_id: customerId, 
                    shift_id: shiftId,
                    rico_amount_paid: ricoAmountPaid + allowanceUsedThisOrder,
                    notes: `[FULFILLMENT: ${fulfillment || 'pickup'}] ` + (guestPhone ? `[TEL: ${guestPhone}] ` : '') + (notes || '') + (allowanceUsedThisOrder > 0 ? ` [ALLOWANCE: L.${allowanceUsedThisOrder.toFixed(2)}]` : ''), 
                    status: req.body?.status || 'pending', 
                    restaurant_id: finalResId,
                    scheduled_for: req.body?.scheduled_for || null
                }).select().single();
                if (error) throw error;

                // MISIONES: an order created already-PAID on this path
                // unlocks its missions (failure-silent helper).
                if (data && data.status === 'paid') await unlockMissionsForOrder(data);
                // LOYALTY (2026-10-30): a born-paid order on this path
                // also earns (idempotent — see rico-loyalty).
                if (data && data.status === 'paid') await ricoLoyalty.processPaidOrder(supabase, data);

                // --- 2.5 FIFO BATCH INVENTORY DEDUCTION (JSONB fallback) ---
                if (items && Array.isArray(items)) {
                    try {
                        const { data: resData } = await supabase.from('restaurants').select('settings').eq('id', finalResId).single();
                        if (resData) {
                            const settings = resData.settings || {};
                            const productInventory = settings.product_inventory || {};
                            const batches = settings.batches || [];
                            let settingsUpdated = false;

                            for (const orderItem of items) {
                                const itemId = orderItem.id;
                                const qtyOrdered = parseInt(orderItem.qty) || 1;

                                const itemConfig = productInventory[itemId];
                                if (itemConfig && itemConfig.is_unlimited === false) {
                                    let remainingToDeduct = qtyOrdered;
                                    settingsUpdated = true;

                                    // Filter active batches for this item and sort by oldest first
                                    const itemBatches = batches.filter(b => b.menu_item_id === itemId && b.quantity > 0);
                                    itemBatches.sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at));

                                    for (const batch of itemBatches) {
                                        if (remainingToDeduct <= 0) break;
                                        const deductFromBatch = Math.min(batch.quantity, remainingToDeduct);
                                        batch.quantity -= deductFromBatch;
                                        remainingToDeduct -= deductFromBatch;
                                    }

                                    // Re-calculate remaining stock
                                    const now = new Date();
                                    const validBatches = batches.filter(b => b.menu_item_id === itemId && new Date(b.expires_at) > now);
                                    const newStockQty = validBatches.reduce((sum, b) => sum + b.quantity, 0);

                                    productInventory[itemId].stock_quantity = newStockQty;

                                    // Sync item availability in menu_items table
                                    const isAvailable = newStockQty > 0;
                                    await supabase.from('menu_items')
                                        .update({ available: isAvailable })
                                        .eq('id', itemId);
                                }
                            }

                            if (settingsUpdated) {
                                settings.product_inventory = productInventory;
                                settings.batches = batches;
                                await supabase.from('restaurants').update({ settings }).eq('id', finalResId);
                            }
                        }
                    } catch(e) {
                        console.error("[FIFO JSONB error]", e);
                    }
                }

                if (customerId && finalResId === 'rich-aroma') {
                    try {
                        await awardPoints(customerId, serverTotal, paymentMethod, supabase);
                        
                        // Check if this is the customer's first completed order
                        const { data: priorOrders } = await supabase.from('orders').select('id').eq('customer_id', customerId);
                        if (priorOrders && priorOrders.length <= 1) {

                            // --- SEC-FIX 2c: MINTING GATE (audit F11) ---
                            // Both rewards below CREATE Rico Cash out of
                            // client-supplied data: welcomePromo comes
                            // straight from the request body, and
                            // referral_code is whatever was stored on the
                            // profile at signup. Customer creation is
                            // public and spending needs only the PIN the
                            // creator picked, so ungated this mints
                            // L.50 / L.30 for every fresh account, forever.
                            // Minting now requires a verified staff
                            // credential (SEC-FIX 1's staffActor - e.g. a
                            // cashier ringing a genuine in-store welcome
                            // offer). The order itself is NEVER blocked:
                            // a skipped mint is tagged on the order in
                            // the [PROMO REJECTED: ...] style that
                            // order-service uses, so the skip stays
                            // visible in the record.
                            // GRANT-RECORD ANCHOR: no server-side grant
                            // record exists today (the gacha wheel
                            // outcome lives only in the client's
                            // localStorage, and promo_codes are shared
                            // discount codes, not per-customer grants).
                            // When one exists - e.g. the loyalty build's
                            // campaign engine writing a grant row for
                            // this customer - OR its check into
                            // mintAllowed() below. Never substitute
                            // another client-supplied flag.
                            let promoMintAllowed = null;
                            const promoMintSkipped = [];
                            const mintAllowed = async () => {
                                if (promoMintAllowed === null) promoMintAllowed = !!(await staffActor());
                                return promoMintAllowed;
                            };

                            // 1. Process Welcome Wheel Cashback (L. 50 or L. 25)
                            if (req.body.welcomePromo === 'CASHBACK_50' || req.body.welcomePromo === 'CASHBACK_25') {
                                if (await mintAllowed()) {
                                    const cashbackAmount = req.body.welcomePromo === 'CASHBACK_50' ? 50.00 : 25.00;
                                    const { data: cust } = await supabase.from('customers').select('rico_balance').eq('id', customerId).single();
                                    if (cust) {
                                        const newBal = (parseFloat(cust.rico_balance) || 0) + cashbackAmount;
                                        await supabase.from('customers').update({ rico_balance: newBal }).eq('id', customerId);
                                        console.log(`[Promo] Welcomed customer ${customerId} with L.${cashbackAmount} cashback.`);
                                    }
                                } else {
                                    promoMintSkipped.push(req.body.welcomePromo);
                                }
                            }

                            // 2. Process Referral Rewards (Double-sided L. 30 reward)
                            const { data: custProfile } = await supabase.from('customers').select('referral_code').eq('id', customerId).single();
                            if (custProfile && custProfile.referral_code) {
                                if (await mintAllowed()) {
                                    const refPhone = custProfile.referral_code.trim();

                                    // Reward Referrer
                                    const { data: referrer } = await supabase.from('customers').select('id, rico_balance').eq('phone', refPhone).maybeSingle();
                                    if (referrer) {
                                        const refBal = (parseFloat(referrer.rico_balance) || 0) + 30.00;
                                        await supabase.from('customers').update({ rico_balance: refBal }).eq('id', referrer.id);
                                        console.log(`[Referral] Credited L.30 reward to referrer: ${referrer.id}`);
                                    }

                                    // Reward Referee (new customer)
                                    const { data: newCust } = await supabase.from('customers').select('rico_balance').eq('id', customerId).single();
                                    if (newCust) {
                                        const newCustBal = (parseFloat(newCust.rico_balance) || 0) + 30.00;
                                        await supabase.from('customers').update({ rico_balance: newCustBal }).eq('id', customerId);
                                        console.log(`[Referral] Credited L.30 reward to Referee: ${customerId}`);
                                    }
                                } else {
                                    promoMintSkipped.push('REFERRAL');
                                }
                            }

                            // A skipped mint stays visible on the order
                            // record (and in this response) - the sale
                            // above already went through untouched.
                            if (promoMintSkipped.length > 0) {
                                const taggedNotes = (data.notes || '') + ` [PROMO REJECTED: ${promoMintSkipped.join(' + ')}]`;
                                data.notes = taggedNotes;
                                await supabase.from('orders').update({ notes: taggedNotes }).eq('id', data.id);
                                console.log(`[Promo] Skipped unverified mint (${promoMintSkipped.join(', ')}) on order ${data.id}: no staff credential, no server grant.`);
                            }
                        }
                    } catch(e) {
                        console.error("[Launch Promo Error]", e);
                    }
                }
                return res.json(data);
            }
        }

        // --- 2b. KDS ITEM TOGGLE (per-item check-off) ---
        // kitchen.html's cycleItemState has always called this action, but
        // store.js never had a handler for it, so item taps never persisted
        // and the re-render reset them. Staff-gated like every other write
        // (SEC-FIX 1): the KDS sends its staff PIN as Bearer (staffHeaders).
        if (action === 'toggle_item_ready') {
            if (req.method === 'PATCH') {
                if (!(await requireStaff())) return;
                const { orderId, itemIdx, status } = req.body || {};
                if (!orderId) return res.status(400).json({ error: "Order ID required" });
                if (!Number.isInteger(itemIdx)) return res.status(400).json({ error: "Item index required" });
                if (status !== null && status !== 'preparing' && status !== 'ready') {
                    return res.status(400).json({ error: "Invalid item status" });
                }

                const { data: order, error: loadError } = await supabase.from('orders').select('id, items').eq('id', orderId).maybeSingle();
                if (loadError) throw loadError;
                if (!order) return res.status(404).json({ error: "Orden no encontrada" });
                const items = Array.isArray(order.items) ? order.items : [];
                if (itemIdx < 0 || itemIdx >= items.length) return res.status(400).json({ error: "Item index out of range" });

                const newItems = items.map((it, i) => (i === itemIdx ? { ...it, status } : it));
                const { data, error } = await supabase.from('orders').update({ items: newItems }).eq('id', orderId).select().single();
                if (error) throw error;
                return res.json({ success: true, order: data });
            }
        }

        // --- 2c. KDS BUILD CARD DATA (admin-recipes build, 2026-10-26) ---
        // ONE staff-gated read for the kitchen build card: for a set of menu
        // item ids, return each item's recipe steps, base ingredient lines
        // (per serving, with their step tie) and the modifier-ingredient
        // DELTA rows for the item's modifier options — item-specific rows
        // plus the global (item_id NULL) ones. The KDS page combines these
        // with the ticket's chosen mods (matched by option id, else name)
        // to render adjusted amounts inline per step. Resilient by design:
        // a missing recipe_steps column, a missing step_no column, or the
        // legacy modifier_ingredients table (seed v3 not yet applied) each
        // degrade to an empty layer instead of failing the whole read.
        if (action === 'kds_recipe_data') {
            if (!(await requireStaff())) return;
            const ids = [...new Set(String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean))].slice(0, 50);
            if (!ids.length) return res.status(400).json({ error: "ids requeridos" });
            try {
                const titleizeSlug = (s) => String(s || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

                // Menu items + steps (recipe_steps may not exist pre-migration)
                let menuRows = [];
                {
                    const r = await supabase.from('menu_items').select('id, name, recipe_steps').in('id', ids);
                    if (r.error) {
                        const r2 = await supabase.from('menu_items').select('id, name').in('id', ids);
                        menuRows = (r2.data || []).map(m => ({ ...m, recipe_steps: [] }));
                    } else menuRows = r.data || [];
                }
                const stepsByItem = {};
                menuRows.forEach(m => { stepsByItem[m.id] = Array.isArray(m.recipe_steps) ? m.recipe_steps : []; });

                // Base lines (step_no may not exist pre-migration)
                let lineRows = [];
                {
                    const r = await supabase.from('menu_item_ingredients')
                        .select('menu_item_id, inventory_item_id, quantity, unit, step_no')
                        .in('menu_item_id', ids);
                    if (r.error) {
                        const r2 = await supabase.from('menu_item_ingredients')
                            .select('menu_item_id, inventory_item_id, quantity, unit')
                            .in('menu_item_id', ids);
                        lineRows = (r2.data || []).map(x => ({ ...x, step_no: null }));
                    } else lineRows = r.data || [];
                }

                // Inventory catalog (resolve names/slugs for base lines AND
                // delta rows — delta slugs may match a row by slug OR by id)
                const { data: invAll } = await supabase.from('inventory').select('id, name, slug, unit');
                const invByKey = {};
                (invAll || []).forEach(v => {
                    if (v.id) invByKey[v.id] = v;
                    if (v.slug) invByKey[v.slug] = v;
                });
                const invFor = (key) => invByKey[key] || null;

                // Modifier options linked to these items
                const { data: links } = await supabase.from('item_modifier_groups').select('item_id, group_id').in('item_id', ids);
                const groupIds = [...new Set((links || []).map(l => l.group_id).filter(Boolean))];
                let optRows = [];
                let groupName = {};
                if (groupIds.length) {
                    const [oRes, gRes] = await Promise.all([
                        supabase.from('modifier_options').select('id, group_id, name, allow_qty, default_qty').in('group_id', groupIds),
                        supabase.from('modifier_groups').select('id, name').in('id', groupIds)
                    ]);
                    optRows = oRes.data || [];
                    (gRes.data || []).forEach(g => { groupName[g.id] = g.name; });
                }
                const optById = {};
                optRows.forEach(o => { optById[o.id] = o; });
                const optionsByItem = {};
                (links || []).forEach(l => {
                    (optionsByItem[l.item_id] = optionsByItem[l.item_id] || []);
                });
                optRows.forEach(o => {
                    (links || []).filter(l => l.group_id === o.group_id).forEach(l => {
                        if (optionsByItem[l.item_id] && !optionsByItem[l.item_id].some(x => x.id === o.id)) {
                            optionsByItem[l.item_id].push({ id: o.id, name: o.name, group: groupName[o.group_id] || '', allow_qty: !!o.allow_qty, default_qty: o.default_qty ?? null });
                        }
                    });
                });

                // Delta rows: option-keyed (seed v3 shape). Legacy table or
                // unseeded DB -> no deltas; the card still renders base recipes.
                let deltaRows = [];
                if (optRows.length) {
                    try {
                        const r = await supabase.from('modifier_ingredients')
                            .select('modifier_option_id, item_id, inventory_item_id, quantity, unit')
                            .in('modifier_option_id', optRows.map(o => o.id));
                        if (!r.error) deltaRows = r.data || [];
                    } catch (e) { deltaRows = []; }
                }

                const items = {};
                ids.forEach(itemId => {
                    const lines = lineRows.filter(x => x.menu_item_id === itemId).map(x => {
                        const inv = invFor(x.inventory_item_id);
                        return {
                            slug: (inv && inv.slug) || x.inventory_item_id,
                            name: (inv && inv.name) || titleizeSlug(x.inventory_item_id),
                            unit: x.unit || (inv && inv.unit) || '',
                            qty: parseFloat(x.quantity) || 0,
                            step_no: (x.step_no === undefined || x.step_no === null) ? null : parseInt(x.step_no)
                        };
                    });
                    const myOptIds = new Set((optionsByItem[itemId] || []).map(o => o.id));
                    const deltas = deltaRows
                        .filter(d => myOptIds.has(d.modifier_option_id) && (d.item_id === null || d.item_id === itemId))
                        .map(d => {
                            const inv = invFor(d.inventory_item_id);
                            return {
                                option_id: d.modifier_option_id,
                                slug: d.inventory_item_id,
                                name: (inv && inv.name) || titleizeSlug(d.inventory_item_id),
                                unit: d.unit || (inv && inv.unit) || '',
                                qty_delta: parseFloat(d.quantity) || 0
                            };
                        });
                    items[itemId] = {
                        steps: stepsByItem[itemId] || [],
                        lines,
                        options: optionsByItem[itemId] || [],
                        deltas
                    };
                });
                return res.json({ success: true, items });
            } catch (err) {
                console.error("[KDS Recipe Data Error]", err);
                return res.status(500).json({ error: err.message });
            }
        }

        // --- 3. CASH / SHIFT ACTIONS ---
        if (action === 'current-shift' || action === 'current_shift') {
            const { data: shift } = await supabase.from('cash_shifts').select('*').eq('status', 'open').eq('restaurant_id', 'rich-aroma').order('opened_at', { ascending: false }).limit(1).maybeSingle();
            return res.json({ shift });
        }

        if (action === 'close-shift-preview') {
            const { shiftId } = req.query;
            if (!shiftId) return res.status(400).json({ error: "Shift ID required" });
            
            try {
                const { data: shift } = await supabase.from('cash_shifts').select('*').eq('id', shiftId).single();
                if (!shift) throw new Error('Shift not found');

                // 1. Fetch all orders that happened since the shift started
                const { data: allToday, error: ordersErr } = await supabase.from('orders')
                    .select('total, payment_method, secondary_payment_method, rico_amount_paid, shift_id, created_at')
                    .eq('restaurant_id', 'rich-aroma')
                    .gte('created_at', shift.opened_at)
                    .not('status', 'eq', 'cancelled');
                
                if (ordersErr) throw ordersErr;

                // 2. Filter for orders linked to this shift OR orders with no shift_id but within timeframe
                const shiftOrders = (allToday || []).filter(o => 
                    o.shift_id === shiftId || (!o.shift_id && o.created_at >= shift.opened_at)
                );

                const sales = { cash: 0, card: 0, transfer: 0, rico: 0 };
                (shiftOrders || []).forEach(o => {
                    const finalTotal = parseFloat(o.total) || 0;
                    const r = parseFloat(o.rico_amount_paid) || 0;
                    sales.rico += r; 
                    const net = finalTotal - r;

                    const method = o.secondary_payment_method || o.payment_method;
                    if (method === 'cash') sales.cash += net;
                    else if (method === 'card') sales.card += net;
                    else if (method === 'transfer') sales.transfer += net;
                });
                
                const { data: rTxns, error: txnsErr } = await supabase.from('cash_transactions').select('amount, reason').eq('shift_id', shiftId);
                if (txnsErr) throw txnsErr;

                let petty = 0;
                (rTxns || []).forEach(t => { 
                    const amt = parseFloat(t.amount) || 0;
                    // In this DB, Negative = payout, Positive = drop
                    petty += amt; 
                });

                return res.json({ sales, transactions: petty });
            } catch (err) {
                console.error("[Preview Error]", err);
                return res.status(500).json({ error: err.message });
            }
        }

        if (action === 'close-shift') {
            if (!(await requireStaff())) return;
            const { shiftId, closingAmount, declaredCard, declaredTransfer, notes } = req.body || {};
            if (!shiftId) return res.status(400).json({ error: "Shift ID required" });

            try {
                const { data: shift, error: shiftErr } = await supabase.from('cash_shifts').select('*').eq('id', shiftId).single();
                if (shiftErr || !shift) throw new Error("No se encontró la sesión");

                // 1. Fetch data for the final report
                const { data: allOrders, error: ordersErr } = await supabase.from('orders')
                    .select('total, payment_method, secondary_payment_method, rico_amount_paid, shift_id, created_at')
                    .eq('restaurant_id', 'rich-aroma')
                    .gte('created_at', shift.opened_at)
                    .not('status', 'eq', 'cancelled');
                
                if (ordersErr) throw ordersErr;

                const shiftOrders = (allOrders || []).filter(o => 
                    o.shift_id === shiftId || (!o.shift_id && o.created_at >= shift.opened_at)
                );

                const sales = { cash: 0, card: 0, transfer: 0, rico: 0 };
                (shiftOrders || []).forEach(o => {
                    const finalTotal = parseFloat(o.total) || 0; 
                    const r = parseFloat(o.rico_amount_paid) || 0;
                    sales.rico += r; 
                    const net = finalTotal - r;

                    const method = o.secondary_payment_method || o.payment_method;
                    if (method === 'cash') sales.cash += net;
                    else if (method === 'card') sales.card += net;
                    else if (method === 'transfer') sales.transfer += net;
                });

                const { data: rTxns, error: txnsErr } = await supabase.from('cash_transactions').select('amount, reason').eq('shift_id', shiftId);
                if (txnsErr) throw txnsErr;

                let petty = 0;
                (rTxns || []).forEach(t => { 
                    const amt = parseFloat(t.amount) || 0;
                    petty += amt; 
                });

                const opening = parseFloat(shift.opening_amount) || 0;
                const expected = opening + sales.cash + petty;
                const declared = parseFloat(closingAmount) || 0;
                const diff = declared - expected;

                const auditNotes = JSON.stringify({
                    user_notes: notes || '',
                    declared_card: parseFloat(declaredCard) || 0,
                    declared_transfer: parseFloat(declaredTransfer) || 0
                });

                const { data: updated, error: closeErr } = await supabase.from('cash_shifts').update({ 
                    status: 'closed', 
                    closed_at: new Date().toISOString(), 
                    closing_amount_declared: declared,
                    expected_amount: expected,
                    discrepancy: diff,
                    notes: auditNotes 
                }).eq('id', shiftId).select().single();
                
                if (closeErr) throw closeErr;

                return res.json({ 
                    success: true, 
                    shift: updated, 
                    report: { 
                        opening_amount: opening, 
                        sales, 
                        transactions: petty, 
                        declared: { cash: declared, card: declaredCard, transfer: declaredTransfer },
                        expected_amount: expected,
                        discrepancy: diff
                    } 
                });
            } catch (err) {
                console.error("[Close Shift Error]", err);
                return res.status(500).json({ error: err.message });
            }
        }

        if (action === 'open-shift') {
            if (!(await requireStaff())) return;
            const { openingAmount, employeeId } = req.body || {};
            
            // Safety check: Is there already an open shift?
            const { data: existing } = await supabase.from('cash_shifts').select('*').eq('status', 'open').eq('restaurant_id', 'rich-aroma').maybeSingle();
            if (existing) {
                console.log("[Shift] Returning existing open shift:", existing.id);
                return res.json({ success: true, ...existing });
            }

            const { data, error } = await supabase.from('cash_shifts').insert({ opening_amount: parseFloat(openingAmount) || 0, employee_id: employeeId || 'master', restaurant_id: finalResId, status: 'open', opened_at: new Date().toISOString() }).select().single();
            if (error) throw error;
            return res.json({ success: true, ...data });
        }

        if (action === 'verify-pin') {
            const { pin } = req.body || {};
            // SEC-FIX 4 (F12): throttle PIN guessing; never echo the PIN back.
            if (pinThrottleCheck(req, pin)) return res.status(429).json({ error: "Demasiados intentos. Espera unos minutos." });
            if (isMasterPin(pin)) { pinThrottleSuccess(req, pin); return res.json({ success: true, employee: { id: 'master', name: 'Admin', role: 'admin', restaurant_id: 'rich-aroma' } }); }

            const { data: emp } = await supabase.from('employees').select('*').eq('pin', pin).eq('active', true).maybeSingle();
            if (emp) { pinThrottleSuccess(req, pin); const { pin: _empPin, ...safeEmp } = emp; return res.json({ success: true, employee: safeEmp }); }

            // Fallback: Check if matching master PIN exists in restaurants settings JSONB
            const { data: resList, error: resErr } = await supabase.from('restaurants').select('*').contains('settings', { pin: pin });
            if (resList && resList.length > 0) {
                const resData = resList[0];
                pinThrottleSuccess(req, pin);
                return res.json({
                    success: true,
                    employee: {
                        id: 'master',
                        name: resData.name,
                        role: 'admin',
                        restaurant_id: resData.id
                    }
                });
            }

            pinThrottleFail(req, pin);
            return res.status(401).json({ error: "PIN Inválido" });
        }

        // --- 4. CUSTOMERS ---
        if (action === 'customer_login') {
            const { phone, pin } = req.body || {};
            if (!phone || !pin) return res.status(400).json({ error: "Phone and PIN required" });

            const cleanPhone = phone.replace(/\D/g, '');
            let phoneToSearch = cleanPhone;
            if (cleanPhone.length === 8) phoneToSearch = `504${cleanPhone}`;

            // 1. Try search with 504 prefix
            let { data: customer, error } = await supabase.from('customers')
                .select('*')
                .eq('phone', phoneToSearch)
                .maybeSingle();

            if (error) throw error;

            // 2. Fallback to exact raw input if nothing found
            if (!customer) {
                const { data: fallbackCustomer, error: fallbackError } = await supabase.from('customers')
                    .select('*')
                    .eq('phone', cleanPhone)
                    .maybeSingle();
                
                if (fallbackError) throw fallbackError;
                customer = fallbackCustomer;
            }

            if (!customer) return res.status(404).json({ error: "Cuenta no encontrada" });
            if (customer.pin !== pin) return res.status(401).json({ error: "PIN Incorrecto" });

            const synced = await syncMembershipState(customer, supabase);
            return res.json({ success: true, user: sanitizeCustomer(synced) });
        }

        if (action === 'customer_link_phone') {
            const { walletAddress, email, phone, pin } = req.body || {};
            if (!walletAddress || !phone || !pin) return res.status(400).json({ error: "Wallet address, phone, and pin are required" });

            const cleanPhone = phone.replace(/\D/g, '');
            let phoneToStore = cleanPhone;
            if (cleanPhone.length === 8) phoneToStore = `504${cleanPhone}`;

            // Check if phone number already linked to a different wallet
            const { data: existing } = await supabase.from('customers')
                .select('*')
                .eq('phone', phoneToStore)
                .maybeSingle();

            let pendingBalance = 0;
            let pendingPoints = 0;

            if (existing && existing.id !== walletAddress) {
                // If it's a pending placeholder account created during a referral transfer, merge it!
                if (existing.id.startsWith('cust_pending_') || (existing.tags && existing.tags.includes('pending_onboarding'))) {
                    pendingBalance = parseFloat(existing.rico_balance) || 0;
                    pendingPoints = parseInt(existing.points) || 0;

                    // Delete the placeholder account
                    const { error: delErr } = await supabase.from('customers').delete().eq('id', existing.id);
                    if (delErr) {
                        console.error("[customer_link_phone] Failed to delete pending placeholder:", delErr);
                        return res.status(500).json({ error: "Error al unificar cuenta referida." });
                    }

                    // Update any references to point to the new wallet ID
                    try {
                        await Promise.all([
                            supabase.from('balance_history').update({ customer_id: walletAddress }).eq('customer_id', existing.id),
                            supabase.from('orders').update({ customer_id: walletAddress }).eq('customer_id', existing.id)
                        ]);
                    } catch (syncErr) {
                        console.error("[customer_link_phone] Data sync warning:", syncErr);
                    }
                } else {
                    return res.status(400).json({ error: "Este número de teléfono ya está vinculado a otra cuenta." });
                }
            }

            // Get existing customer to preserve points/visits
            const { data: existingCustomer } = await supabase.from('customers')
                .select('*')
                .eq('id', walletAddress)
                .maybeSingle();

            // SEC-FIX 1: if the account already HAS a PIN, it can only be
            // replaced by staff — otherwise anyone could re-link a wallet
            // to their own phone+PIN and keep its balance (takeover chain).
            if (existingCustomer && existingCustomer.pin && String(existingCustomer.pin) !== String(pin)) {
                if (!(await staffActor())) return res.status(401).json({ error: "Se requiere la credencial de personal para cambiar el PIN de una cuenta existente" });
            }

            // Check if already verified
            const isVerified = existingCustomer?.tags?.includes('verified') || false;
            const verifyCode = 'QE-' + String(Math.floor(1000 + Math.random() * 9000));
            const newTags = isVerified ? (existingCustomer.tags || ['verified']) : ['unverified', verifyCode];

            // Upsert profile (merging any pending balance and points from the referral)
            const finalBalance = (parseFloat(existingCustomer?.rico_balance) || 0) + pendingBalance;
            const finalPoints = (parseInt(existingCustomer?.points) || 0) + pendingPoints;

            const { data: customer, error } = await supabase.from('customers')
                .upsert({
                    id: walletAddress,
                    email: email || existingCustomer?.email || null,
                    phone: phoneToStore,
                    pin: pin,
                    name: existingCustomer?.name || (email ? email.split('@')[0] : 'Socio QuimiEats'),
                    rico_balance: finalBalance,
                    points: finalPoints,
                    visits: existingCustomer?.visits || 0,
                    tags: newTags
                })
                .select()
                .single();

            if (error) throw error;
            return res.json({ success: true, customer: sanitizeCustomer(customer), needsVerification: !isVerified, verifyCode });
        }

        if (action === 'load_balance' && req.method === 'POST') {
            if (!(await requireStaff())) return;
            const id = req.query.id || req.body.id;
            const { amount } = req.body;
            if (!id || !amount) return res.status(400).json({ error: "Missing ID or amount" });

            const { data: customer, error: fetchErr } = await supabase.from('customers').select('*').eq('id', id).single();
            if (fetchErr || !customer) return res.status(404).json({ error: "Customer not found" });

            const baseAmount = parseFloat(amount) || 0;
            const vipBonus = customer.is_vip ? baseAmount * 0.10 : 0;
            const reloadAmount = baseAmount + vipBonus;

            const newBalance = (parseFloat(customer.rico_balance) || 0) + reloadAmount;
            const { data, error } = await supabase.from('customers').update({ rico_balance: newBalance }).eq('id', id).select().single();

            if (error) return res.status(500).json({ error: error.message });
            // LOYALTY (2026-10-30): the top-up is ledgered now, and the
            // recarga ladder mints its gift lot on top (L.100→+10 ·
            // L.200→+25 · L.500→+75 — the ladder rides the amount the
            // customer actually paid, not the VIP-inflated credit).
            let ladderBonus = 0;
            try {
                await supabase.from('balance_history').insert({
                    customer_id: id, type: 'load', bucket: 'paid', amount: reloadAmount,
                    source: 'recarga', notes: vipBonus > 0 ? 'Recarga (incluye bono VIP)' : 'Recarga'
                });
                ladderBonus = await ricoLoyalty.grantRecargaBonus(supabase, { customerId: id, amount: baseAmount, restaurantId: finalResId });
            } catch (loyErr) { console.error('[Rico] load_balance loyalty steps failed:', loyErr.message); }
            const bonusBalance = await ricoLoyalty.getBonusBalance(supabase, id).catch(() => 0);
            return res.json({ success: true, newBalance, ladderBonus, bonusBalance, customer: sanitizeCustomer(data) });
        }

        // POS RECARGA (loyalty build, 2026-10-30): the POS "Recargar
        // Rico Cash" modal has always called customer_update_balance —
        // the action did not exist, so register top-ups failed silently.
        // Staff-gated; the amount lands in the customer's OWN money and
        // the recarga ladder mints its gift on top, same as load_balance.
        if (action === 'customer_update_balance' && req.method === 'POST') {
            if (!(await requireStaff())) return;
            const cid = req.body?.customerId || req.body?.customer_id || req.body?.id || req.query.id;
            const amount = parseFloat(req.body?.amount);
            if (!cid || !(amount > 0)) return res.status(400).json({ error: 'customerId y amount requeridos' });
            const { data: cust } = await supabase.from('customers').select('*').eq('id', cid).maybeSingle();
            if (!cust) return res.status(404).json({ error: 'Cliente no encontrado' });
            const newBalance = round2((parseFloat(cust.rico_balance) || 0) + amount);
            const { data: updated, error } = await supabase.from('customers').update({ rico_balance: newBalance }).eq('id', cid).select().single();
            if (error) return res.status(500).json({ error: error.message });
            let ladderBonus = 0;
            try {
                await supabase.from('balance_history').insert({
                    customer_id: cid, type: 'load', bucket: 'paid', amount, source: 'recarga', notes: 'Recarga en caja'
                });
                ladderBonus = await ricoLoyalty.grantRecargaBonus(supabase, { customerId: cid, amount, restaurantId: finalResId });
            } catch (loyErr) { console.error('[Rico] customer_update_balance loyalty steps failed:', loyErr.message); }
            const bonusBalance = await ricoLoyalty.getBonusBalance(supabase, cid).catch(() => 0);
            return res.json({ success: true, newBalance, ladderBonus, bonusBalance, customer: sanitizeCustomer(updated) });
        }

        // POS "DAR REGALO" (loyalty build, 2026-10-30): the staff gift
        // from the POS customer card. The REASON is required — it is the
        // audit trail. Above the settings cap, a MANAGER credential must
        // arrive in managerPin (master PIN, or an active encargado/admin
        // employee PIN); the cashier's own login is not enough.
        if (action === 'pos_manual_grant' && req.method === 'POST') {
            const actor = await requireStaff();
            if (!actor) return;
            const cid = req.body?.customerId || req.body?.customer_id;
            const amount = round2(req.body?.amount);
            const reason = String(req.body?.reason || '').trim();
            if (!cid || !(amount > 0)) return res.status(400).json({ error: 'Elegí el cliente y el monto del regalo' });
            if (!reason) return res.status(400).json({ error: 'Contanos el motivo del regalo (queda en el registro)' });
            const settings = await ricoLoyalty.getLoyaltySettings(supabase, finalResId);
            if (amount > (parseFloat(settings.manual_grant_cap) || 0)) {
                const mp = String(req.body?.managerPin || '').trim();
                let managerOk = !!mp && isMasterPin(mp);
                if (!managerOk && mp) {
                    const { data: emp } = await supabase.from('employees').select('id, role').eq('pin', mp).eq('active', true).maybeSingle();
                    managerOk = !!emp && ['admin', 'manager', 'encargado'].includes(String(emp.role || '').toLowerCase().trim());
                }
                if (!managerOk) return res.status(403).json({ error: `Los regalos sobre L.${settings.manual_grant_cap} necesitan el PIN de un encargado`, code: 'MANAGER_PIN_REQUIRED', cap: settings.manual_grant_cap });
            }
            const { data: cust } = await supabase.from('customers').select('id, name').eq('id', cid).maybeSingle();
            if (!cust) return res.status(404).json({ error: 'Cliente no encontrado' });
            const lot = await ricoLoyalty.mintBonusLot(supabase, {
                customerId: cid, amount, source: 'manual', settings,
                notes: `Regalo del equipo: ${reason} (por ${actor.name || actor.id || 'personal'})`
            });
            return res.json({ success: true, lot_id: lot && lot.lot_id, expires_at: lot && lot.expires_at, message: `🎁 Regalo de L.${amount} acreditado a ${cust.name || 'el cliente'} — vence en ${settings.gift_expiry_days} días` });
        }

        // Loyalty config the POS is allowed to see (ladder, caps, expiry).
        if (action === 'loyalty_config' && req.method === 'GET') {
            if (!(await requireStaff())) return;
            const settings = await ricoLoyalty.getLoyaltySettings(supabase, finalResId);
            return res.json({ ok: true, earn_rate: settings.earn_rate, launch_week: settings.launch_week, launch_multiplier: settings.launch_multiplier, ladder: settings.ladder, gift_expiry_days: settings.gift_expiry_days, manual_grant_cap: settings.manual_grant_cap });
        }

        // THE DAILY SWEEP (loyalty build, 2026-10-30): expire gift lots
        // (ledger row per lot), mint pending mission grants, and send
        // the ~3-day expiry heads-ups. Triggered daily at 09:00
        // America/Tegucigalpa by the Vercel cron in vercel.json
        // (15:00 UTC) with the CRON_SECRET bearer; also runnable by the
        // bot (shared secret) or staff (the Regalos tab's "Correr
        // barrido ahora" button).
        if (action === 'loyalty_sweep' && (req.method === 'POST' || req.method === 'GET')) {
            const cronSecret = (process.env.CRON_SECRET || '').trim();
            const cronOk = !!cronSecret && bearerCred() === cronSecret;
            if (!botSecretOk() && !cronOk && !(await staffActor())) return res.status(401).json({ error: 'No autorizado' });
            const summary = await ricoLoyalty.runSweep(supabase);
            // Bonus attempt: the Especial VIP push, in case its hour has
            // already passed today (its own cron fires at 09:30 TGU).
            let especialPush = null;
            try { especialPush = await ricoLoyalty.runEspecialPush(supabase, {}); } catch (e) { /* sweep result stands */ }
            return res.json({ ok: true, summary, especial_push: especialPush });
        }

        // ESPECIAL VIP PUSH (2026-10-30): the daily trigger for the
        // Especial del Día push to VIPs. Vercel cron at 09:30
        // America/Tegucigalpa (15:30 UTC) with the CRON_SECRET bearer;
        // the runner itself enforces the owner-set hour, the
        // once-a-day rule and the no-special-no-push rule.
        if (action === 'especial_push' && (req.method === 'POST' || req.method === 'GET')) {
            const cronSecret = (process.env.CRON_SECRET || '').trim();
            const cronOk = !!cronSecret && bearerCred() === cronSecret;
            if (!botSecretOk() && !cronOk && !(await staffActor())) return res.status(401).json({ error: 'No autorizado' });
            const summary = await ricoLoyalty.runEspecialPush(supabase, {});
            return res.json({ ok: true, summary });
        }

        // WHATSAPP PRESENCE (2026-10-30): the bot stamps every inbound
        // message here — wa_last_inbound_at is the broadcast opt-in
        // evidence and the 24h-window clock. The words ALTO / STOP /
        // BAJA opt the customer out of Difusión AND the Especial push,
        // absolutely. Bot-secret gated, like every whatsapp_* action.
        if (action === 'whatsapp_presence' && req.method === 'POST') {
            if (!botSecretOk()) return res.status(401).json({ error: 'No autorizado' });
            const phoneToStore = normalizePhone(req.body?.phone);
            if (!phoneToStore) return res.status(400).json({ error: 'phone requerido' });
            const cust = await findCustomerByPhone(phoneToStore);
            if (!cust) return res.json({ ok: true, found: false });
            const norm = String(req.body?.text || '').trim().toUpperCase()
                .normalize('NFD').replace(/[̀-ͯ]/g, '');
            const isOptOut = ['ALTO', 'STOP', 'BAJA'].includes(norm);
            const updates = { wa_last_inbound_at: new Date().toISOString() };
            let justOptedOut = false;
            if (isOptOut && !cust.wa_opt_out) {
                updates.wa_opt_out = true;
                updates.especial_opt_out = true;
                justOptedOut = true;
            }
            const { error } = await supabase.from('customers').update(updates).eq('id', cust.id);
            if (error) throw error;
            return res.json({ ok: true, found: true, opted_out: isOptOut || !!cust.wa_opt_out, just_opted_out: justOptedOut });
        }

        // ESPECIAL DEL DÍA — the pull door (2026-10-30): the bot calls
        // this when a customer texts ESPECIAL. Get-or-create the account
        // by phone (phone IS the identity), claim today's special for
        // them server-side (cap enforced here), and answer with the
        // reveal copy — composed once, in rico-loyalty.especialReveal.
        if (action === 'whatsapp_special' && req.method === 'POST') {
            if (!botSecretOk()) return res.status(401).json({ error: 'No autorizado' });
            const phoneToStore = normalizePhone(req.body?.phone);
            if (!phoneToStore) return res.status(400).json({ error: 'phone requerido' });
            let cust = await findCustomerByPhone(phoneToStore);
            if (!cust) {
                const { data, error } = await supabase.from('customers').insert({
                    id: 'cust_' + Date.now() + Math.floor(Math.random() * 1000),
                    name: 'Cliente WhatsApp',
                    phone: phoneToStore,
                    points: 0,
                    rico_balance: 0
                }).select().single();
                if (error) throw error;
                cust = data;
            }
            const reveal = await ricoLoyalty.especialReveal(supabase, { customerId: cust.id });
            return res.json({ ok: true, ...reveal });
        }

        if (action === 'purchase_membership' && req.method === 'POST') {
            const customerId = req.query.id;
            if (!customerId) return res.status(400).json({ error: "Customer ID required" });

            const { data: customer, error: fetchErr } = await supabase.from('customers').select('*').eq('id', customerId).single();
            if (fetchErr || !customer) return res.status(404).json({ error: "Customer not found" });

            // SEC-FIX 1: spending a customer's balance needs their PIN or staff.
            if (!(await staffActor()) && !(await customerPinMatches(customerId, req.body?.pin || bearerCred()))) {
                return res.status(401).json({ error: "Se requiere el PIN del cliente para esta compra" });
            }

            const VIP_PRICE = 250;
            if ((customer.rico_balance || 0) < VIP_PRICE) {
                return res.status(400).json({ error: "Saldo Rico Cash insuficiente (L 250 requeridos)" });
            }

            const { data: updated, error: updateErr } = await supabase.from('customers')
                .update({ 
                    is_vip: true, 
                    rico_balance: customer.rico_balance - VIP_PRICE,
                    vip_expiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
                })
                .eq('id', customerId)
                .select().single();

            if (updateErr) throw updateErr;
            return res.json({ success: true, customer: sanitizeCustomer(updated) });
        }

        if (action === 'customer_transfer') {
            const { senderId, recipientPhone, amountHNL } = req.body || {};
            if (!senderId || !recipientPhone || !amountHNL) {
                return res.status(400).json({ error: "Datos incompletos para la transferencia" });
            }

            const transferAmt = parseFloat(amountHNL);
            if (isNaN(transferAmt) || transferAmt <= 0) {
                return res.status(400).json({ error: "Monto inválido" });
            }

            // 1. Fetch Sender
            const { data: sender, error: senderErr } = await supabase.from('customers').select('*').eq('id', senderId).single();
            if (senderErr || !sender) {
                return res.status(404).json({ error: "Remitente no encontrado" });
            }

            // SEC-FIX 1: moving money out of a wallet needs the sender's own
            // PIN (self-service) or a staff credential — never the id alone.
            const senderPinOk = req.body?.pin && sender.pin && String(sender.pin) === String(req.body.pin);
            if (!senderPinOk && !(await staffActor())) {
                return res.status(401).json({ error: "PIN del remitente requerido o inválido" });
            }

            const senderBal = parseFloat(sender.rico_balance) || 0;
            if (senderBal < transferAmt) {
                return res.status(400).json({ error: "Saldo insuficiente" });
            }

            // 2. Fetch Recipient (Phone format clean-up)
            const cleanPhone = recipientPhone.replace(/\D/g, '');
            let phoneToSearch = cleanPhone;
            if (cleanPhone.length === 8) phoneToSearch = `504${cleanPhone}`;

            let recipient = null;
            let isNewOnboarding = false;

            const { data: existingRec, error: recErr } = await supabase.from('customers').select('*').eq('phone', phoneToSearch).maybeSingle();
            
            if (existingRec) {
                recipient = existingRec;
                if (recipient.tags && recipient.tags.includes('privacy_private')) {
                    return res.status(400).json({ error: "Este usuario tiene desactivada la recepción de transferencias (cuenta privada)." });
                }
            } else {
                isNewOnboarding = true;
                const pendingId = 'cust_pending_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
                const { data: newCust, error: createErr } = await supabase.from('customers').insert({
                    id: pendingId,
                    phone: phoneToSearch,
                    name: 'Invitado (' + phoneToSearch.slice(-4) + ')',
                    rico_balance: 0,
                    tags: ['pending_onboarding']
                }).select().single();

                if (createErr || !newCust) {
                    console.error("Failed to create pending customer:", createErr);
                    return res.status(500).json({ error: "No se pudo preparar la transferencia para este número." });
                }
                recipient = newCust;
            }

            if (sender.id === recipient.id) {
                return res.status(400).json({ error: "No puedes transferirte a ti mismo" });
            }

            // 3. Deduct from Sender and credit Recipient
            const newSenderBal = senderBal - transferAmt;
            const newRecBal = (parseFloat(recipient.rico_balance) || 0) + transferAmt;

            const { error: sendUpdErr } = await supabase.from('customers').update({ rico_balance: newSenderBal }).eq('id', sender.id);
            if (sendUpdErr) throw sendUpdErr;

            const { error: recUpdErr } = await supabase.from('customers').update({ rico_balance: newRecBal }).eq('id', recipient.id);
            if (recUpdErr) {
                // Rollback sender balance on failure
                await supabase.from('customers').update({ rico_balance: senderBal }).eq('id', sender.id);
                throw recUpdErr;
            }

            // 4. Log to balance history if it exists
            try {
                await supabase.from('balance_history').insert([
                    { customer_id: sender.id, change: -transferAmt, type: 'transfer_out', notes: `Enviado a ${recipient.name || recipient.phone}` },
                    { customer_id: recipient.id, change: transferAmt, type: 'transfer_in', notes: `Recibido de ${sender.name || sender.phone}` }
                ]);
            } catch(e) { console.error("History logging failed", e); }

            const inviteLink = isNewOnboarding 
                ? `https://wa.me/${phoneToSearch}?text=${encodeURIComponent(`¡Hola! Te he enviado L. ${transferAmt.toFixed(2)} en QuimiEats. Regístrate aquí para reclamar tus fondos: https://quimieats.com/quimieats.html?signup=true&phone=${phoneToSearch.slice(-8)}`)}`
                : null;

            return res.json({ 
                success: true, 
                senderBalance: newSenderBal,
                recipientName: recipient.name || recipient.phone,
                isNewOnboarding,
                inviteLink
            });
        }

        if (action === 'customer_by_phone' || action === 'customer_by_query') {
            const query = req.query.query || req.query.phone;
            if (!query) return res.status(400).json({ error: "Query required" });

            // 1. Try exact phone match (with or without 504) or ID or Name
            const cleanQuery = query.replace(/\D/g, '');
            let phoneQuery = query;
            if (cleanQuery.length === 8) phoneQuery = `504${cleanQuery}`;

            const { data: results, error } = await supabase.from('customers')
                .select('*')
                .or(`phone.eq.${query},phone.eq.${phoneQuery},name.ilike.%${query}%,id.eq.${query}`)
                .order('points', { ascending: false }) // Return most active first
                .limit(5); // Get a few to be safe
            
            if (error) throw error;
            if (!results || results.length === 0) return res.status(404).json({ error: "Customer not found" });

            // For now, take the best match (first one)
            const synced = await syncMembershipState(results[0], supabase);
            return res.json(sanitizeCustomer(synced));
        }

        if (action === 'customer_profile') {
            const searchId = id || req.query.id;
            const phone = req.query.phone;
            
            if (!searchId && !phone) return res.status(400).json({ error: "ID or Phone required" });

            let query = supabase.from('customers').select('*');
            
            if (searchId) {
                query = query.eq('id', searchId);
            } else {
                const cleanPhone = phone.replace(/\D/g, '');
                query = query.or(`phone.eq.${cleanPhone},phone.eq.504${cleanPhone}`);
            }

            const { data, error } = await query.maybeSingle();

            if (error) throw error;
            if (!data) return res.status(404).json({ error: "Customer not found" });

            const synced = await syncMembershipState(data, supabase);
            return res.json(sanitizeCustomer(synced));
        }

        if (action === 'customer_list') {
            if (!(await requireStaff())) return;
            const { data, error } = await supabase.from('customers')
                .select('*')
                .order('created_at', { ascending: false });
            if (error) throw error;
            return res.json((data || []).map(sanitizeCustomer));
        }

        if (action === 'customer_delete') {
            if (!(await requireStaff())) return;
            const targetId = id || req.query.id;
            if (!targetId) return res.status(400).json({ error: "ID required" });

            // --- CLEANUP RELATED DATA FIRST ---
            // These tables have foreign keys to customers. To delete a customer, 
            // we must either CASCADE (DB level) or delete manually here.
            try {
                // 1. Anonymize orders (keep the sales data, just remove the link to the customer)
                await supabase.from('orders').update({ customer_id: null }).eq('customer_id', targetId);

                // 2. Delete strictly personal/loyalty data
                await Promise.all([
                    supabase.from('customer_points').delete().eq('customer_id', targetId),
                    supabase.from('reward_claims').delete().eq('customer_id', targetId),
                    supabase.from('balance_history').delete().eq('customer_id', targetId),
                    supabase.from('membership_billing_events').delete().eq('customer_id', targetId)
                ]);
            } catch (cleanupErr) {
                console.warn("[CustomerDelete] Cleanup warning:", cleanupErr.message);
            }

            const { error } = await supabase.from('customers')
                .delete()
                .eq('id', targetId);

            if (error) throw error;
            return res.json({ success: true });
        }

        if (action === 'customer_create') {
            const { name, phone, email, tags, birthday, customer_type, pin } = req.body || {};
            const cleanPhone = (phone || '').replace(/\D/g, '');
            let phoneToStore = cleanPhone;
            if (cleanPhone.length === 8) phoneToStore = `504${cleanPhone}`;
            
            // SEC-FIX 1: benefit tags can only be granted by staff. A public
            // signup gets no tags and no customer_type privileges — the tags
            // unlock free-drink benefits in the order service, so letting a
            // caller self-assign them at registration is a mint.
            const creator = await staffActor();
            const newTags = creator ? (tags || []) : [];
            if (creator) {
                if (customer_type === 'employee' || customer_type === 'Employee') {
                    if (!newTags.includes('Employee')) newTags.push('Employee');
                } else if (customer_type === 'senior') {
                    if (!newTags.includes('Tercera Edad')) newTags.push('Tercera Edad');
                } else if (customer_type === 'senior_plus') {
                    if (!newTags.includes('Cuarta Edad')) newTags.push('Cuarta Edad');
                } else if (customer_type === 'hero') {
                    if (!newTags.includes('Hero')) newTags.push('Hero');
                }
            }

            // Check if there is an existing pending profile
            const { data: existing } = await supabase.from('customers').select('*').eq('phone', phoneToStore).maybeSingle();
            
            if (existing) {
                if (existing.tags && existing.tags.includes('pending_onboarding')) {
                    const finalTags = (existing.tags || []).filter(t => t !== 'pending_onboarding');
                    newTags.forEach(t => { if (!finalTags.includes(t)) finalTags.push(t); });
                    
                    const { data: updated, error: updErr } = await supabase.from('customers').update({
                        name: name || existing.name,
                        email: email || existing.email,
                        pin: pin || existing.pin,
                        tags: finalTags,
                        birthday: birthday || existing.birthday
                    }).eq('id', existing.id).select().single();
                    
                    if (updErr) throw updErr;
                    return res.json(sanitizeCustomer(updated));
                } else {
                    return res.status(400).json({ error: "Este número de teléfono ya está registrado." });
                }
            }

            const { data, error } = await supabase.from('customers').insert({
                id: 'cust_' + Date.now(),
                name: name || 'Nuevo Cliente',
                phone: phoneToStore,
                email,
                pin,
                tags: newTags,
                birthday,
                points: 0,
                rico_balance: 0
            }).select().single();

            if (error) throw error;
            return res.json(sanitizeCustomer(data));
        }

        // --- WHATSAPP INTRO BOT (Honduras) — server-to-server only ---
        // Gated by botSecretOk() (WHATSAPP_SIGNUP_SECRET). The bot's
        // get-to-know-you flow uses exactly three actions:
        //   whatsapp_lookup   — is this phone already a customer?
        //   whatsapp_signup   — get-or-create the account (idempotent)
        //   whatsapp_preventa — append a bottle-preorder intent record
        // The L.100 welcome gift signup used to record here was
        // RETIRED by owner decision (bot-menu-fix, 2026-10-26):
        // whatsapp_signup mints NO grant now (see the gate at the
        // signup handler). Pre-existing pending 'welcome_bottle'
        // rows were left untouched — lookup still reports one
        // read-only when it exists. Mission rewards remain pending
        // rows in reward_grants via the missions actions, a
        // separate writer, unaffected by the retirement.
        if (action === 'whatsapp_lookup' && req.method === 'POST') {
            if (!botSecretOk()) return res.status(401).json({ error: 'No autorizado' });
            const phoneToStore = normalizePhone(req.body?.phone);
            if (!phoneToStore) return res.status(400).json({ error: 'phone requerido' });
            const cust = await findCustomerByPhone(phoneToStore);
            if (!cust) return res.json({ found: false });
            const { data: grant } = await supabase.from('reward_grants')
                .select('status, amount')
                .eq('customer_id', cust.id).eq('grant_type', 'welcome_bottle')
                .maybeSingle();
            return res.json({
                found: true,
                customer: sanitizeCustomer(cust),
                gift: grant ? { status: grant.status, amount: parseFloat(grant.amount) || 0 } : null
            });
        }

        if (action === 'whatsapp_signup' && req.method === 'POST') {
            if (!botSecretOk()) return res.status(401).json({ error: 'No autorizado' });
            const { name, birthday, ref_word } = req.body || {};
            const phoneToStore = normalizePhone(req.body?.phone);
            if (!phoneToStore) return res.status(400).json({ error: 'phone requerido' });

            let cust = await findCustomerByPhone(phoneToStore);
            let created = false;
            if (!cust) {
                const { data, error } = await supabase.from('customers').insert({
                    id: 'cust_' + Date.now() + Math.floor(Math.random() * 1000),
                    name: (String(name || 'Cliente WhatsApp').trim() || 'Cliente WhatsApp').slice(0, 80),
                    phone: phoneToStore,
                    birthday_dm: birthday || null,
                    points: 0,
                    rico_balance: 0
                }).select().single();
                if (error) throw error;
                cust = data;
                created = true;
            } else {
                // Fill only what the account is missing — never overwrite
                // a name/birthday the shop already has.
                const fill = {};
                if (birthday && !cust.birthday_dm) fill.birthday_dm = birthday;
                if (name && (!cust.name || cust.name === 'Nuevo Cliente' || cust.name === 'Cliente WhatsApp')) {
                    fill.name = String(name).trim().slice(0, 80);
                }
                if (Object.keys(fill).length > 0) {
                    const { data: updated } = await supabase.from('customers')
                        .update(fill).eq('id', cust.id).select().single();
                    if (updated) cust = updated;
                }
            }

            // WELCOME GIFT RETIRED (owner decision, bot-menu-fix
            // 2026-10-26): whatsapp_signup no longer mints the
            // pending L.100 'welcome_bottle' grant — the insert that
            // used to live here is gated OFF. The SELECT stays,
            // read-only: a grant created BEFORE the cutoff is still
            // reported in the response below, and existing pending
            // rows are deliberately NOT touched (their fate is a
            // separate owner decision — nothing is voided here).
            // Mission grants (grant_type 'mission%') are a different
            // writer entirely and are unaffected.
            let { data: grant } = await supabase.from('reward_grants')
                .select('*')
                .eq('customer_id', cust.id).eq('grant_type', 'welcome_bottle')
                .maybeSingle();
            const grantCreated = false;
            // Creadores: if the bot carried a signup word (ref_word),
            // attempt first-touch attribution for this account. A
            // failed attribution NEVER fails the signup: an unknown
            // or retired word comes back 'silently null' — the
            // customer was never promised anything, and their account
            // is exactly as if no word had been sent.
            let attribution = null;
            if (ref_word) {
                try {
                    const att = await attributeCustomer(cust.id, ref_word, 'whatsapp');
                    if (att && (att.attributed || att.reason === 'already_attributed')) attribution = att;
                } catch (e) {
                    console.warn('attribution attempt failed (signup unaffected):', e && e.message);
                    attribution = null;
                }
            }
            return res.json({
                ok: true,
                created,
                grantCreated,
                customer: sanitizeCustomer(cust),
                gift: grant ? { status: grant.status, amount: parseFloat(grant.amount) || 0 } : null,
                attribution
            });
        }

        // --- FLIGHT LANE (campaign fast lane, 2026-10-26) ---
        // The campaign sells ONE product — EL FLIGHT DEL CAPITÁN,
        // a fixed 5-pack (packs_5=1) in preventa — through this
        // same whatsapp_preventa action, via TWO doors into ONE
        // ledger: the WhatsApp bot flags flight:true (its customer
        // signed up in-thread first), and the WEBSITE claim
        // (account.js / /quimistan, server-to-server with this same
        // secret) sends source:'web' with {phone, name, packs_5:1}
        // and NO prior signup — the flight path then find-or-creates
        // the customer by phone (the given name names a NEW account
        // only, never overwrites). The source column records the
        // door ('flight_lane' | 'web'); the accounting is identical.
        // Flight records carry a 15-MINUTE HOLD (hold_expires_at)
        // and race a DAILY CAP of 100 bottles, enforced HERE at
        // record time (the bot only renders the verdict):
        //   bottles_today (America/Tegucigalpa calendar day) =
        //     paid_confirmed rows, counted in full
        //       (packs_5×5 + bottles + boxes_20×20)
        //   + flight intents whose hold is still live
        //   + standard (non-flight) intents, counted until staff
        //     cancel them or the day ends (staff-managed — there is
        //     no hold to expire on those rows)
        //   'cancelled' / 'expired' / 'waitlist' rows never count.
        // A flight that doesn't fit lands as status 'waitlist'
        // (with its position) instead of 'intent'. Expiry is LAZY
        // (the missions pattern — no cron): stale flight holds flip
        // to 'expired' opportunistically whenever availability is
        // computed. whatsapp_preorders.status is free TEXT (no
        // CHECK/enum anywhere in the schema), so 'waitlist' and
        // 'expired' need no DDL — the migration only adds
        // hold_expires_at (source already exists).
        const FLIGHT_SOURCE = 'flight_lane';
        const FLIGHT_DAILY_CAP_BOTTLES = 100;
        const FLIGHT_HOLD_MINUTES = 15;
        const TGU_OFFSET_MS = 6 * 60 * 60 * 1000; // America/Tegucigalpa = UTC-6 (no DST)
        const preorderBottles = (r) => (parseInt(r.packs_5) || 0) * 5
            + (parseInt(r.bottles) || 0) + (parseInt(r.boxes_20) || 0) * 20;
        function tguDayWindow(now) {
            const local = new Date(now.getTime() - TGU_OFFSET_MS);
            const startUtc = Date.UTC(local.getUTCFullYear(),
                local.getUTCMonth(), local.getUTCDate()) + TGU_OFFSET_MS;
            return { start: new Date(startUtc).toISOString(),
                     end: new Date(startUtc + 24 * 60 * 60 * 1000).toISOString() };
        }
        async function expireStaleFlightHolds(nowIso) {
            // Any held intent (bot or web — the hold is what marks
            // it, not the source) flips to 'expired' once stale.
            await supabase.from('whatsapp_preorders')
                .update({ status: 'expired' })
                .eq('status', 'intent')
                .not('hold_expires_at', 'is', null)
                .lt('hold_expires_at', nowIso);
        }
        async function flightAvailability(now) {
            const nowIso = now.toISOString();
            await expireStaleFlightHolds(nowIso);
            const w = tguDayWindow(now);
            const { data: rows } = await supabase.from('whatsapp_preorders')
                .select('*').gte('created_at', w.start).lt('created_at', w.end);
            let used = 0;
            let waitlistCount = 0;
            for (const r of rows || []) {
                if (r.status === 'waitlist') { waitlistCount++; continue; }
                if (r.status === 'paid_confirmed') { used += preorderBottles(r); continue; }
                if (r.status === 'intent') {
                    if (r.hold_expires_at) {
                        // A HELD intent (flight lane, either channel)
                        // counts only while its hold lives.
                        if (r.hold_expires_at > nowIso) used += preorderBottles(r);
                    } else {
                        // A standard intent carries no hold: it
                        // counts until staff cancel it or the day ends.
                        used += preorderBottles(r);
                    }
                }
                // 'cancelled' / 'expired' never count.
            }
            return { cap: FLIGHT_DAILY_CAP_BOTTLES, used,
                     remaining: Math.max(0, FLIGHT_DAILY_CAP_BOTTLES - used),
                     waitlistCount };
        }

        if (action === 'whatsapp_preventa' && req.method === 'POST') {
            if (!botSecretOk()) return res.status(401).json({ error: 'No autorizado' });
            const phoneToStore = normalizePhone(req.body?.phone);
            if (!phoneToStore) return res.status(400).json({ error: 'phone requerido' });
            const clampQty = (v) => Math.max(0, Math.min(999, parseInt(v) || 0));
            // The web shape names its quantities packs_5 / boxes_20;
            // the bot shape says packs / boxes. Same numbers either way.
            const packs = clampQty(req.body?.packs ?? req.body?.packs_5);
            const bottles = clampQty(req.body?.bottles);
            const boxes = clampQty(req.body?.boxes ?? req.body?.boxes_20);
            if (packs + bottles + boxes === 0) return res.status(400).json({ error: 'Sin cantidades' });
            // MULTI-BANK (bank-accounts): the caller may already
            // know which bank the customer transferred from and pass
            // it as `bank`; it is stored verbatim on the row as
            // payment_bank so staff verifying in /admin Clientes see
            // which account to check. The usual declaration arrives
            // AFTER recording and goes through
            // whatsapp_preventa_set_bank, which validates the name
            // against the configured accounts.
            const declaredBank = String(req.body?.bank || '').trim().slice(0, 40) || null;
            // FLIGHT LANE trigger: the bot flags flight:true; the WEB
            // shape (account.js / /quimistan, server-to-server with
            // this same secret) flags source:'web'. Both run the ONE
            // hold/cap/waitlist path below — one ledger, two doors.
            const isFlight = req.body?.flight === true || req.body?.flight === 'true'
                || req.body?.source === 'web';
            let cust = await findCustomerByPhone(phoneToStore);
            if (!cust && !isFlight) return res.status(404).json({ error: 'Cliente no registrado' });
            // Prices are computed HERE, never taken from the caller
            // (FINAL-MENU.md formats: botella L.100, preventa 5-pack
            // L.350, caja 20+ a L.70 c/u = L.1,400 la caja).
            const total = packs * 350 + bottles * 100 + boxes * 1400;
            if (isFlight) {
                // FLIGHT LANE: hold + cap, decided before the insert.
                // The source column records the door: 'flight_lane'
                // (bot) or 'web' (website claim).
                const rowSource = req.body?.source === 'web' ? 'web' : FLIGHT_SOURCE;
                if (!cust) {
                    // WEB shape: no prior signup exists. Find-or-create
                    // by phone — the given name names a NEW account
                    // only; an existing customer's name is never
                    // overwritten (this branch doesn't even run then).
                    const givenName = (String(req.body?.name || '').trim()
                        || 'Cliente').slice(0, 80);
                    const { data: newCust, error: createErr } = await supabase.from('customers').insert({
                        id: 'cust_' + Date.now() + Math.floor(Math.random() * 1000),
                        name: givenName,
                        phone: phoneToStore,
                        points: 0,
                        rico_balance: 0
                    }).select().single();
                    if (createErr) {
                        // Lost a create race or a transient error:
                        // re-read before giving up.
                        cust = await findCustomerByPhone(phoneToStore);
                        if (!cust) throw createErr;
                    } else {
                        cust = newCust;
                    }
                }
                const now = new Date();
                const avail = await flightAvailability(now);
                const rowBottles = packs * 5 + bottles + boxes * 20;
                const fits = rowBottles <= avail.remaining;
                const holdExpiresAt = fits
                    ? new Date(now.getTime() + FLIGHT_HOLD_MINUTES * 60 * 1000).toISOString()
                    : null;
                const row = {
                    id: 'wpre_' + Date.now() + Math.floor(Math.random() * 1000),
                    customer_id: cust.id,
                    phone: phoneToStore,
                    name: cust.name,
                    packs_5: packs,
                    bottles,
                    boxes_20: boxes,
                    quoted_total: total,
                    status: fits ? 'intent' : 'waitlist',
                    source: rowSource,
                    hold_expires_at: holdExpiresAt,
                    payment_bank: declaredBank
                };
                let ins = await supabase.from('whatsapp_preorders').insert(row).select().single();
                if (ins.error && /hold_expires_at|payment_bank/.test(ins.error.message || '')) {
                    // A migration hasn't run yet: keep the flight
                    // (source exists since the intro schema) without
                    // the missing stamps, and say so in the log —
                    // never lose the sale to a missing column.
                    console.error('[Flight] optional column missing (hold_expires_at / payment_bank) — run flight-lane-migration.sql + bank-accounts-migration.sql; recording without those stamps:', ins.error.message);
                    const { hold_expires_at: _dropped, payment_bank: _droppedBank, ...bareRow } = row;
                    ins = await supabase.from('whatsapp_preorders').insert(bareRow).select().single();
                }
                if (ins.error) throw ins.error;
                // RESPONSE CONTRACT (the web build relays these
                // verbatim): status, remaining_bottles,
                // hold_expires_at, customer_id, preorder_id — plus
                // waitlist_position ONLY when waitlisted.
                const payload = {
                    ok: true,
                    status: ins.data.status,
                    remaining_bottles: fits ? avail.remaining - rowBottles : avail.remaining,
                    hold_expires_at: ins.data.hold_expires_at || null,
                    customer_id: cust.id,
                    preorder_id: ins.data.id
                };
                if (ins.data.status === 'waitlist') {
                    payload.waitlist_position = avail.waitlistCount + 1;
                }
                return res.json(payload);
            }
            const stdRow = {
                id: 'wpre_' + Date.now() + Math.floor(Math.random() * 1000),
                customer_id: cust.id,
                phone: phoneToStore,
                name: cust.name,
                packs_5: packs,
                bottles,
                boxes_20: boxes,
                quoted_total: total,
                status: 'intent',
                source: 'whatsapp_intro',
                payment_bank: declaredBank
            };
            let stdIns = await supabase.from('whatsapp_preorders').insert(stdRow).select().single();
            if (stdIns.error && /payment_bank/.test(stdIns.error.message || '')) {
                // Same degrade as the flight path: the migration
                // hasn't run — record the preventa without the bank
                // stamp rather than losing the sale.
                console.error('[Bank] payment_bank column missing — run bank-accounts-migration.sql; recording without the bank stamp');
                const { payment_bank: _droppedBank, ...noBankRow } = stdRow;
                stdIns = await supabase.from('whatsapp_preorders').insert(noBankRow).select().single();
            }
            if (stdIns.error) throw stdIns.error;
            return res.json({ ok: true, preorder: stdIns.data });
        }

        // --- MULTI-BANK: the shop's REAL transfer accounts ---
        // Source of truth is restaurants.settings (the same record
        // partner-os writes and the storefront reads):
        //   settings.bank_accounts = [{bank, account, owner}...]
        //     — up to 3 accounts, written by partner-os;
        //   settings.bank_details {name, account, owner} — the
        //     legacy single account; wherever bank_accounts is
        //     absent/empty it counts as account #1 (name -> bank).
        // An entry is a PLACEHOLDER when any of its fields is empty
        // after trim OR any field's uppercased value is one of the
        // shipped placeholder strings (verified live 2026-10-26:
        // "BANK NAME" / "ACCOUNT NUMBER" / "ACCOUNT HOLDER NAME") —
        // the exact rule the v1 whatsapp_bank_details applied to
        // the single record, now applied per entry. Only REAL
        // entries leave this helper; the bot applies its own
        // structural check on top — two guards, either one can
        // stop a print.
        const KNOWN_BANK_PLACEHOLDERS = ['BANK NAME', 'ACCOUNT NUMBER', 'ACCOUNT HOLDER NAME'];
        function bankEntryIsPlaceholder(e) {
            return !e.bank || !e.account || !e.owner
                || KNOWN_BANK_PLACEHOLDERS.includes(e.bank.toUpperCase())
                || KNOWN_BANK_PLACEHOLDERS.includes(e.account.toUpperCase())
                || KNOWN_BANK_PLACEHOLDERS.includes(e.owner.toUpperCase());
        }
        async function loadBankSettings() {
            const { data: rest } = await supabase.from('restaurants')
                .select('settings').eq('id', 'rich-aroma').maybeSingle();
            const settings = (rest && rest.settings) || {};
            const bd = settings.bank_details || {};
            const legacyDetails = {
                name: String(bd.name || '').trim(),
                account: String(bd.account || '').trim(),
                owner: String(bd.owner || '').trim()
            };
            const raw = Array.isArray(settings.bank_accounts) && settings.bank_accounts.length
                ? settings.bank_accounts
                : null;
            const candidates = raw
                ? raw.map(a => ({
                    bank: String((a && a.bank) || '').trim(),
                    account: String((a && a.account) || '').trim(),
                    owner: String((a && a.owner) || '').trim()
                }))
                : [{ bank: legacyDetails.name, account: legacyDetails.account, owner: legacyDetails.owner }];
            return { accounts: candidates.filter(a => !bankEntryIsPlaceholder(a)), legacyDetails };
        }

        // --- FLIGHT LANE: transfer details for the bot (v2) ---
        // v2 returns the full REAL accounts list; `placeholder` is
        // true ONLY when zero real accounts exist. `bank_details`
        // stays for backward readability: the first real account in
        // the legacy shape, or the legacy record verbatim (trimmed,
        // exactly as v1 returned it) when nothing real exists — so
        // nothing unfixed breaks mid-deploy.
        if (action === 'whatsapp_bank_details' && req.method === 'POST') {
            if (!botSecretOk()) return res.status(401).json({ error: 'No autorizado' });
            const { accounts, legacyDetails } = await loadBankSettings();
            const first = accounts[0];
            return res.json({
                ok: true,
                accounts,
                bank_details: first
                    ? { name: first.bank, account: first.account, owner: first.owner }
                    : legacyDetails,
                placeholder: accounts.length === 0
            });
        }

        // --- MULTI-BANK: the customer's bank declaration ---
        // After the payment message the bot asks "¿a cuál banco
        // transferiste?" (one tap, or typed). This stamps
        // payment_bank on the customer's most recent TODAY
        // (America/Tegucigalpa) non-cancelled preorder, so staff
        // verifying in /admin Clientes see which account to check.
        // The name is validated against the configured REAL
        // accounts (case-insensitive) and stored with the
        // CONFIGURED casing; an unknown bank answers {ok:false}
        // with HTTP 200 (the bot renders from data — the
        // declaration never blocks the flow).
        if (action === 'whatsapp_preventa_set_bank' && req.method === 'POST') {
            if (!botSecretOk()) return res.status(401).json({ error: 'No autorizado' });
            const phoneToStore = normalizePhone(req.body?.phone);
            if (!phoneToStore) return res.status(400).json({ error: 'phone requerido' });
            const wanted = String(req.body?.bank || '').trim();
            if (!wanted) return res.status(400).json({ error: 'bank requerido' });
            const { accounts } = await loadBankSettings();
            const match = accounts.find(a => a.bank.toLowerCase() === wanted.toLowerCase());
            if (!match) return res.json({ ok: false, updated: false });
            const w = tguDayWindow(new Date());
            const { data: rows } = await supabase.from('whatsapp_preorders')
                .select('*')
                .eq('phone', phoneToStore)
                .neq('status', 'cancelled')
                .gte('created_at', w.start).lt('created_at', w.end)
                .order('created_at', { ascending: false })
                .limit(1);
            const target = (rows || [])[0];
            if (!target) return res.json({ ok: true, updated: false });
            const { error: updErr } = await supabase.from('whatsapp_preorders')
                .update({ payment_bank: match.bank })
                .eq('id', target.id);
            if (updErr) {
                if (/payment_bank/.test(updErr.message || '')) {
                    // Migration not run yet: say so loudly and
                    // answer updated:false — never crash the bot.
                    console.error('[Bank] payment_bank column missing — run bank-accounts-migration.sql; declaration dropped');
                    return res.json({ ok: true, updated: false });
                }
                throw updErr;
            }
            return res.json({ ok: true, updated: true });
        }

        // --- CREADORES: bind a signup word to an EXISTING account ---
        // Same gate as the intro actions: botSecretOk(). Used when a
        // customer who already signed up sends a creator's word (or
        // sends it after their signup completed). First-touch rules
        // live in attributeCustomer: a second word never overwrites.
        // Answers mirror the helper's reasons so the bot can render
        // each one kindly; no_customer is the only bot-level reason.
        if (action === 'whatsapp_attribute' && req.method === 'POST') {
            if (!botSecretOk()) return res.status(401).json({ error: 'No autorizado' });
            const phoneToStore = normalizePhone(req.body?.phone);
            if (!phoneToStore) return res.status(400).json({ error: 'phone requerido' });
            const cust = await findCustomerByPhone(phoneToStore);
            if (!cust) return res.json({ ok: false, reason: 'no_customer' });
            const att = await attributeCustomer(cust.id, req.body?.word, 'whatsapp');
            return res.json({ ok: !!att.attributed, ...att });
        }

        // --- MISIONES DEL CAPITÁN (bot side) ---
        // Same gate as the intro actions: botSecretOk()
        // (WHATSAPP_SIGNUP_SECRET). The bot delivers missions the OS
        // unlocked at purchase time and collects the customer's post
        // link back. Delivery state lives in the bot's conversation —
        // the OS only answers "what does this customer have?" and
        // records submissions. Approval is staff-only (below), never
        // the bot's call and never automatic.
        if (action === 'whatsapp_mission_check' && req.method === 'POST') {
            if (!botSecretOk()) return res.status(401).json({ error: 'No autorizado' });
            const phoneToStore = normalizePhone(req.body?.phone);
            if (!phoneToStore) return res.status(400).json({ error: 'phone requerido' });
            const cust = await findCustomerByPhone(phoneToStore);
            if (!cust) return res.json({ ok: true, found: false, unlocked: [], submitted: [], completions: {} });
            const nowIso = new Date().toISOString();
            const { data: rows } = await supabase.from('mission_assignments')
                .select('*').eq('customer_id', cust.id).in('status', ['unlocked', 'submitted'])
                .order('unlocked_at', { ascending: true });
            const list = rows || [];
            const missionIds = [...new Set(list.map(a => a.mission_id))];
            const missionsById = {};
            if (missionIds.length) {
                const { data: ms } = await supabase.from('missions').select('*').in('id', missionIds);
                (ms || []).forEach(m => { missionsById[m.id] = m; });
            }
            const itemIds = [...new Set(Object.values(missionsById).map(m => m.trigger_item_id).filter(Boolean))];
            const itemNameById = {};
            if (itemIds.length) {
                const { data: its } = await supabase.from('menu_items').select('id, name').in('id', itemIds);
                (its || []).forEach(i => { itemNameById[i.id] = i.name; });
            }
            const submittedIds = list.filter(a => a.status === 'submitted').map(a => a.id);
            const subByAssignment = {};
            if (submittedIds.length) {
                const { data: subs } = await supabase.from('mission_submissions').select('*').in('assignment_id', submittedIds);
                (subs || []).forEach(s => { subByAssignment[s.assignment_id] = s; });
            }
            // Approved completions per mission — the bot uses this
            // for status answers ("¿y mi misión?") and to know when a
            // customer has finished a replayable mission.
            const { data: appr } = await supabase.from('mission_assignments')
                .select('mission_id').eq('customer_id', cust.id).eq('status', 'approved');
            const completions = {};
            (appr || []).forEach(a => { completions[a.mission_id] = (completions[a.mission_id] || 0) + 1; });
            const fillBrief = (m) => String(m.brief_template || '')
                .split('{item}').join(itemNameById[m.trigger_item_id] || '')
                .split('{reward}').join(String(parseFloat(m.reward_amount) || 0))
                .split('{hours}').join(String(parseInt(m.deadline_hours) || 48))
                .split('{handle}').join(m.ig_handle || '@richaromacoffee');
            const unlocked = [];
            const submitted = [];
            for (const a of list) {
                const m = missionsById[a.mission_id];
                if (!m) continue;
                if (a.status === 'unlocked') {
                    if (a.expires_at && a.expires_at <= nowIso) continue;
                    unlocked.push({
                        assignment_id: a.id,
                        mission_id: m.id,
                        name: m.name,
                        brief: fillBrief(m),
                        reward_amount: parseFloat(m.reward_amount) || 0,
                        expires_at: a.expires_at,
                        completions: completions[m.id] || 0
                    });
                } else {
                    const s = subByAssignment[a.id];
                    submitted.push({
                        assignment_id: a.id,
                        mission_id: m.id,
                        name: m.name,
                        reward_amount: parseFloat(m.reward_amount) || 0,
                        submission_status: s ? s.status : 'pending',
                        post_url: s ? s.post_url : null,
                        submitted_at: s ? s.created_at : null,
                        completions: completions[m.id] || 0
                    });
                }
            }
            return res.json({ ok: true, found: true, customer: sanitizeCustomer(cust), unlocked, submitted, completions });
        }

        if (action === 'whatsapp_mission_submit' && req.method === 'POST') {
            if (!botSecretOk()) return res.status(401).json({ error: 'No autorizado' });
            const phoneToStore = normalizePhone(req.body?.phone);
            if (!phoneToStore) return res.status(400).json({ error: 'phone requerido' });
            const postUrl = String(req.body?.post_url || req.body?.postUrl || '').trim();
            const cust = await findCustomerByPhone(phoneToStore);
            if (!cust) return res.json({ ok: false, reason: 'no_active_mission' });
            const { data: rows } = await supabase.from('mission_assignments')
                .select('*').eq('customer_id', cust.id).eq('status', 'unlocked')
                .order('unlocked_at', { ascending: true });
            const mine = rows || [];
            if (!mine.length) return res.json({ ok: false, reason: 'no_active_mission' });
            const nowIso = new Date().toISOString();
            const live = mine.filter(a => !a.expires_at || a.expires_at > nowIso);
            if (!live.length) return res.json({ ok: false, reason: 'expired' });
            // A post link, not a profile/home link: host must be one
            // of the three networks and the path must look like a post.
            let parsed = null;
            try { parsed = new URL(postUrl); } catch (e) { parsed = null; }
            const host = parsed ? parsed.hostname.replace(/^www\./, '').toLowerCase() : '';
            const pth = parsed ? parsed.pathname.toLowerCase() : '';
            let linkOk = false;
            if (parsed && host === 'instagram.com') linkOk = /^\/(p|reel|reels|tv)\/[a-z0-9_-]+/.test(pth);
            else if (parsed && host === 'tiktok.com') linkOk = /\/@[a-z0-9_.-]+\/(video|photo)\/\d+/.test(pth);
            else if (parsed && (host === 'facebook.com' || host === 'm.facebook.com')) {
                linkOk = /^\/(share|watch|photo\.php|reel)\b/.test(pth) || /\/(posts|videos)\//.test(pth)
                    || !!(parsed.searchParams.get('v') || parsed.searchParams.get('fbid'));
            }
            if (!linkOk) return res.json({ ok: false, reason: 'bad_link' });
            // One reward per post, ever (the table's UNIQUE index is
            // the hard backstop; this check gives the friendly reason).
            const { data: dup } = await supabase.from('mission_submissions')
                .select('id').eq('post_url', postUrl).limit(1);
            if (dup && dup.length) return res.json({ ok: false, reason: 'duplicate_link' });
            const assignment = live[0];
            const { data: sub, error: sErr } = await supabase.from('mission_submissions').insert({
                id: 'msub_' + Date.now() + Math.floor(Math.random() * 100000),
                assignment_id: assignment.id,
                customer_id: cust.id,
                post_url: postUrl,
                status: 'pending'
            }).select().single();
            if (sErr) {
                if (sErr.code === '23505' || /duplicate|unique/i.test(sErr.message || '')) {
                    return res.json({ ok: false, reason: 'duplicate_link' });
                }
                throw sErr;
            }
            await supabase.from('mission_assignments')
                .update({ status: 'submitted' }).eq('id', assignment.id).eq('status', 'unlocked');
            return res.json({ ok: true, assignment_id: assignment.id, submission_id: sub.id });
        }

        // --- OWNER'S DOOR (2026-10-29) — live shop snapshot for the
        // bot's owner interface. READ-ONLY: sales today, active
        // orders, low stock, preventa, Rico Cash outstanding. Same
        // botSecretOk() gate as every whatsapp_* action; the bot
        // calls it ONLY for numbers on its OWNER_WHATSAPP list, and
        // the owner's number itself never reaches this action.
        // "Today" = the America/Tegucigalpa calendar day (UTC-6, no
        // DST) expressed as a UTC window. Sales follow the close-
        // shift semantics: every non-cancelled order counts.
        if (action === 'whatsapp_owner_snapshot' && req.method === 'POST') {
            if (!botSecretOk()) return res.status(401).json({ error: 'No autorizado' });
            try {
                const nowMs = Date.now();
                const tgu = new Date(nowMs - 6 * 3600 * 1000);
                const yy = tgu.getUTCFullYear();
                const mm = String(tgu.getUTCMonth() + 1).padStart(2, '0');
                const dd = String(tgu.getUTCDate()).padStart(2, '0');
                const dayStart = `${yy}-${mm}-${dd}T06:00:00.000Z`;
                const dayEnd = new Date(Date.parse(dayStart) + 24 * 3600 * 1000).toISOString();

                const { data: ords } = await supabase.from('orders')
                    .select('total, status, payment_method, secondary_payment_method, rico_amount_paid, items, created_at')
                    .eq('restaurant_id', 'rich-aroma')
                    .gte('created_at', dayStart).lt('created_at', dayEnd)
                    .not('status', 'eq', 'cancelled');
                const orders = ords || [];
                const byMethod = { cash: 0, card: 0, transfer: 0, rico: 0 };
                let salesTotal = 0;
                const itemCount = {};
                const active = { cocina: 0, por_cobrar: 0, listos: 0 };
                orders.forEach(o => {
                    const tot = parseFloat(o.total) || 0;
                    salesTotal += tot;
                    const r = parseFloat(o.rico_amount_paid) || 0;
                    byMethod.rico += r;
                    const method = o.secondary_payment_method || o.payment_method;
                    const net = tot - r;
                    if (method === 'cash') byMethod.cash += net;
                    else if (method === 'card') byMethod.card += net;
                    else if (method === 'transfer') byMethod.transfer += net;
                    const st = String(o.status || '');
                    if (['paid', 'preparing', 'in_progress'].includes(st)) active.cocina++;
                    else if (['pending', 'pending_verification', 'awaiting_transfer_approval'].includes(st)) active.por_cobrar++;
                    else if (['ready', 'drinks_ready', 'food_ready'].includes(st)) active.listos++;
                    (Array.isArray(o.items) ? o.items : []).forEach(it => {
                        const nm = it && (it.name || it.item_name);
                        if (nm) itemCount[nm] = (itemCount[nm] || 0) + (parseFloat(it.quantity || it.qty) || 1);
                    });
                });
                const topItems = Object.entries(itemCount)
                    .sort((a, b) => b[1] - a[1]).slice(0, 5)
                    .map(([name, qty]) => ({ name, qty }));

                const { data: inv } = await supabase.from('inventory')
                    .select('name, current_stock, min_stock, unit');
                const lowStock = (inv || [])
                    .filter(r => (parseFloat(r.min_stock) || 0) > 0 && (parseFloat(r.current_stock) || 0) <= (parseFloat(r.min_stock) || 0))
                    .map(r => ({ name: r.name, current_stock: parseFloat(r.current_stock) || 0, min_stock: parseFloat(r.min_stock) || 0, unit: r.unit || '' }))
                    .slice(0, 15);

                const { data: prev } = await supabase.from('whatsapp_preorders')
                    .select('status, packs, bottles, hold_expires_at, created_at')
                    .gte('created_at', dayStart).lt('created_at', dayEnd);
                let pvIntents = 0, pvPaid = 0, pvPacks = 0, pvBottles = 0, pvHolds = 0;
                const nowIso = new Date(nowMs).toISOString();
                (prev || []).forEach(pr => {
                    const st = String(pr.status || '');
                    if (st === 'cancelled') return;
                    if (st === 'paid') pvPaid++; else pvIntents++;
                    pvPacks += parseInt(pr.packs) || 0;
                    pvBottles += parseInt(pr.bottles) || 0;
                    if (pr.hold_expires_at && pr.hold_expires_at > nowIso && st !== 'paid') pvHolds++;
                });

                const { data: custs } = await supabase.from('customers').select('rico_balance');
                const ricoOutstanding = (custs || []).reduce((s, c) => s + (parseFloat(c.rico_balance) || 0), 0);

                return res.json({ ok: true, snapshot: {
                    day: `${yy}-${mm}-${dd}`,
                    sales_today: { orders: orders.length, total: Math.round(salesTotal * 100) / 100, by_method: byMethod },
                    active,
                    top_items: topItems,
                    low_stock: lowStock,
                    preventa_today: { intents: pvIntents, paid: pvPaid, packs: pvPacks, bottles: pvBottles, holds_active: pvHolds },
                    rico_outstanding: Math.round(ricoOutstanding * 100) / 100,
                    clock: null
                } });
            } catch (err) {
                console.error('[OwnerSnapshot]', err);
                return res.status(500).json({ error: err.message });
            }
        }

        // Manual/idempotent unlock for one order — for orders that are
        // born PAID outside this file (the /api/orders-v2 engine in
        // order-service creates Rico-paid orders directly) until that
        // file grows its own call. Either credential works: staff
        // (admin/POS) or the bot secret. Never throws into the caller.
        if (action === 'missions_unlock_for_order' && req.method === 'POST') {
            if (!botSecretOk() && !(await staffActor())) return res.status(401).json({ error: 'No autorizado' });
            const orderId = req.body?.order_id || req.body?.orderId || id || req.query.id;
            if (!orderId) return res.status(400).json({ error: 'order_id requerido' });
            const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
            if (!order) return res.status(404).json({ error: 'Orden no encontrada' });
            if (order.status !== 'paid') return res.json({ ok: true, unlocked: 0, reason: 'order_not_paid' });
            const unlocked = await unlockMissionsForOrder(order);
            return res.json({ ok: true, unlocked });
        }

        // --- ADMIN: CLIENTES (cuentas nuevas, regalos y preventas) ---
        // Staff-only data for the /admin "Clientes" view: the newest
        // ~100 customers with their welcome-gift records (reward_grants)
        // and WhatsApp preventa intents (whatsapp_preorders) joined in.
        // Display + one write (preventa confirm) only — minting a
        // pending grant into Rico Cash belongs to the loyalty build,
        // never to this view. Gated by requireStaff() (SEC-FIX 1) like
        // customer_list, NEVER by the bot secret: WHATSAPP_SIGNUP_SECRET
        // is server-to-server only and must not unlock admin reads.
        if (action === 'admin_signups') {
            if (!(await requireStaff())) return;
            const { data: custs, error } = await supabase.from('customers')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(100);
            if (error) throw error;
            const list = custs || [];
            const ids = list.map(c => c.id);
            let grants = [];
            let preorders = [];
            if (ids.length > 0) {
                const g = await supabase.from('reward_grants')
                    .select('*').in('customer_id', ids)
                    .order('created_at', { ascending: false });
                if (g.error) throw g.error;
                grants = g.data || [];
                const p = await supabase.from('whatsapp_preorders')
                    .select('*').in('customer_id', ids)
                    .order('created_at', { ascending: false });
                if (p.error) throw p.error;
                preorders = p.data || [];
            }
            const groupByCustomer = (rows) => {
                const m = {};
                for (const r of rows) (m[r.customer_id] = m[r.customer_id] || []).push(r);
                return m;
            };
            const grantsBy = groupByCustomer(grants);
            const preordersBy = groupByCustomer(preorders);
            return res.json({
                customers: list.map(c => {
                    const gs = grantsBy[c.id] || [];
                    const ps = preordersBy[c.id] || [];
                    return {
                        ...sanitizeCustomer(c),
                        // customers has no source column to read; a
                        // customer arrived via WhatsApp exactly when
                        // the intro bot left them a grant or a
                        // preventa (both carry source='whatsapp_intro'
                        // on their own rows).
                        origin: (gs.length > 0 || ps.length > 0) ? 'whatsapp' : null,
                        grants: gs.map(g => ({
                            id: g.id,
                            grant_type: g.grant_type,
                            amount: parseFloat(g.amount) || 0,
                            status: g.status,
                            source: g.source,
                            created_at: g.created_at,
                            expires_at: g.expires_at
                        })),
                        preorders: ps.map(p => ({
                            id: p.id,
                            packs_5: p.packs_5 || 0,
                            bottles: p.bottles || 0,
                            boxes_20: p.boxes_20 || 0,
                            total: parseFloat(p.quoted_total) || 0,
                            status: p.status,
                            // MULTI-BANK: the bank the customer
                            // declared they transferred from (null
                            // until declared) — /admin renders it
                            // as a tag on the preorder row.
                            payment_bank: p.payment_bank || null,
                            created_at: p.created_at
                        }))
                    };
                })
            });
        }

        // Staff confirms a preventa was paid — the transfer was
        // verified by a human; payment never happens in chat. Only an
        // open intent can flip ('intent' -> 'paid_confirmed'), and the
        // UPDATE repeats the status guard so a double-tap or a race
        // can't re-confirm or resurrect a cancelled preorder.
        // Re-confirming an already-paid preorder is a no-op success.
        if (action === 'admin_preventa_confirm' && req.method === 'POST') {
            if (!(await requireStaff())) return;
            const preorderId = req.body?.preorder_id || req.body?.preorderId || id || req.query.id;
            if (!preorderId) return res.status(400).json({ error: 'preorder_id requerido' });
            const { data: pre, error: fErr } = await supabase.from('whatsapp_preorders')
                .select('*').eq('id', preorderId).maybeSingle();
            if (fErr) throw fErr;
            if (!pre) return res.status(404).json({ error: 'Preventa no encontrada' });
            if (pre.status === 'paid_confirmed') {
                return res.json({ ok: true, already_confirmed: true, preorder: pre });
            }
            if (pre.status !== 'intent') {
                return res.status(400).json({ error: `La preventa no está pendiente (estado: ${pre.status})` });
            }
            const { data: updated, error: uErr } = await supabase.from('whatsapp_preorders')
                .update({ status: 'paid_confirmed' })
                .eq('id', preorderId).eq('status', 'intent')
                .select().single();
            if (uErr) throw uErr;
            return res.json({ ok: true, preorder: updated });
        }

        // --- ADMIN: CREADORES — creator signup words ---
        // Staff-only (requireStaff, SEC-FIX 1) — the bot secret does
        // NOT unlock any of this. One action, three ops:
        //   list       — every code with its attribution count
        //   create     — normalize + insert a creator's word
        //                (duplicate word -> 409)
        //   deactivate — retire a word (binds nobody new; existing
        //                attributions are history and stay)
        // Earnings, standings and the Creadores admin view are the
        // month-2 build; this is the codes registry the capture
        // stands on.
        if (action === 'admin_creator_codes' && req.method === 'POST') {
            if (!(await requireStaff())) return;
            const b = req.body || {};
            const op = String(b.op || 'list');
            if (op === 'list') {
                const { data: codes, error } = await supabase.from('creator_codes')
                    .select('*').order('created_at', { ascending: false });
                if (error) throw error;
                const { data: attrs } = await supabase.from('customer_attribution').select('creator_code');
                const counts = {};
                (attrs || []).forEach(a => { counts[a.creator_code] = (counts[a.creator_code] || 0) + 1; });
                return res.json({
                    ok: true,
                    codes: (codes || []).map(c => ({ ...c, attributions: counts[c.code] || 0 }))
                });
            }
            if (op === 'create') {
                const code = normalizeWord(b.code || b.word);
                const creatorName = String(b.creator_name || '').trim().slice(0, 80);
                if (!code) return res.status(400).json({ error: 'code requerido (una sola palabra)' });
                if (!creatorName) return res.status(400).json({ error: 'creator_name requerido' });
                const { data: existing } = await supabase.from('creator_codes')
                    .select('code').eq('code', code).maybeSingle();
                if (existing) return res.status(409).json({ error: 'Ese código ya existe' });
                const { data, error } = await supabase.from('creator_codes').insert({
                    code,
                    creator_name: creatorName,
                    creator_customer_id: b.creator_customer_id || null,
                    is_active: true
                }).select().single();
                if (error) {
                    if (error.code === '23505') return res.status(409).json({ error: 'Ese código ya existe' });
                    throw error;
                }
                return res.json({ ok: true, code: data });
            }
            if (op === 'deactivate') {
                const code = normalizeWord(b.code || b.word);
                if (!code) return res.status(400).json({ error: 'code requerido' });
                const { data, error } = await supabase.from('creator_codes')
                    .update({ is_active: false }).eq('code', code).select();
                if (error) throw error;
                if (!data || data.length === 0) return res.status(404).json({ error: 'Código no encontrado' });
                return res.json({ ok: true, code: data[0] });
            }
            return res.status(400).json({ error: 'op no soportada' });
        }

        // --- ADMIN: MISIONES DEL CAPITÁN ---
        // Staff-only (requireStaff, SEC-FIX 1) — the bot secret does
        // NOT unlock any of this. Staff define missions, watch the
        // liability they commit (face value and its ~30% real cost at
        // house COGS), and decide submissions. Approving a submission
        // writes a PENDING row into reward_grants (grant_type
        // 'mission', source 'mission:<slug>') for the loyalty build to
        // mint — exactly the welcome-gift pattern; rico_balance is
        // never touched here. Deciding is idempotent.
        if (action === 'admin_missions_list') {
            if (!(await requireStaff())) return;
            const { data: ms, error } = await supabase.from('missions')
                .select('*').order('created_at', { ascending: false });
            if (error) throw error;
            const missions = ms || [];
            const { data: assigns } = await supabase.from('mission_assignments')
                .select('id, mission_id, customer_id, status');
            const counts = {};
            (assigns || []).forEach(a => {
                const c = counts[a.mission_id] = counts[a.mission_id] || { unlocked: 0, submitted_pending: 0, approved: 0, rejected: 0, expired: 0 };
                if (a.status === 'unlocked') c.unlocked++;
                else if (a.status === 'submitted') c.submitted_pending++;
                else if (a.status === 'approved') c.approved++;
                else if (a.status === 'rejected') c.rejected++;
                else if (a.status === 'expired') c.expired++;
            });
            const itemIds = [...new Set(missions.map(m => m.trigger_item_id).filter(Boolean))];
            const itemNameById = {};
            if (itemIds.length) {
                const { data: its } = await supabase.from('menu_items').select('id, name').in('id', itemIds);
                (its || []).forEach(i => { itemNameById[i.id] = i.name; });
            }
            const outMissions = missions.map(m => {
                const c = counts[m.id] || { unlocked: 0, submitted_pending: 0, approved: 0, rejected: 0, expired: 0 };
                const face = c.approved * (parseFloat(m.reward_amount) || 0);
                return {
                    ...m,
                    trigger_item_name: itemNameById[m.trigger_item_id] || null,
                    counts: { ...c, cap_total: m.cap_total != null ? m.cap_total : null },
                    committed_face: Math.round(face * 100) / 100,
                    committed_est_cost: Math.round(face * 0.30 * 100) / 100
                };
            });
            const { data: pendSubs } = await supabase.from('mission_submissions')
                .select('*').eq('status', 'pending').order('created_at', { ascending: true });
            const queue = pendSubs || [];
            const custIds = [...new Set(queue.map(s => s.customer_id))];
            const custById = {};
            if (custIds.length) {
                const { data: cs } = await supabase.from('customers').select('id, name, phone').in('id', custIds);
                (cs || []).forEach(c => { custById[c.id] = c; });
            }
            const asgIds = [...new Set(queue.map(s => s.assignment_id))];
            const missionNameByAsg = {};
            if (asgIds.length) {
                const { data: asgs } = await supabase.from('mission_assignments').select('id, mission_id').in('id', asgIds);
                const mById = {};
                missions.forEach(m => { mById[m.id] = m.name; });
                (asgs || []).forEach(a => { missionNameByAsg[a.id] = mById[a.mission_id] || a.mission_id; });
            }
            const outQueue = queue.map(s => ({
                id: s.id,
                assignment_id: s.assignment_id,
                customer_id: s.customer_id,
                customer_name: custById[s.customer_id] ? custById[s.customer_id].name : null,
                customer_phone: custById[s.customer_id] ? custById[s.customer_id].phone : null,
                mission_name: missionNameByAsg[s.assignment_id] || null,
                post_url: s.post_url,
                created_at: s.created_at
            }));
            const totalFace = outMissions.reduce((t, m) => t + m.committed_face, 0);
            return res.json({
                missions: outMissions,
                pending_submissions: outQueue,
                totals: {
                    committed_face: Math.round(totalFace * 100) / 100,
                    committed_est_cost: Math.round(totalFace * 0.30 * 100) / 100
                }
            });
        }

        if (action === 'admin_mission_create' && req.method === 'POST') {
            if (!(await requireStaff())) return;
            const b = req.body || {};
            const slug = String(b.slug || b.id || '').trim().toLowerCase()
                .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            if (!slug) return res.status(400).json({ error: 'slug requerido (ej: botella-viajera)' });
            const trigger = String(b.trigger_item_id || '').trim();
            if (!trigger) return res.status(400).json({ error: 'trigger_item_id requerido' });
            const { data: item } = await supabase.from('menu_items')
                .select('id, name').eq('id', trigger).maybeSingle();
            if (!item) return res.status(400).json({ error: 'Ese artículo no existe en el menú' });
            const { data: dup } = await supabase.from('missions')
                .select('id').eq('id', slug).maybeSingle();
            if (dup) return res.status(409).json({ error: 'Ya existe una misión con ese id' });
            const today = new Date().toISOString().slice(0, 10);
            const row = {
                id: slug,
                name: String(b.name || '').trim().slice(0, 120) || slug,
                trigger_item_id: trigger,
                reward_amount: Math.max(0, parseFloat(b.reward_amount) || 50),
                cap_total: (b.cap_total === '' || b.cap_total === null || b.cap_total === undefined)
                    ? null : Math.max(0, parseInt(b.cap_total) || 0),
                max_completions_per_customer: Math.max(1, parseInt(b.max_completions_per_customer) || 1),
                brief_template: String(b.brief_template || '').trim() ||
                    '📸 MISIÓN: Subí una foto de tu {item}, etiquetanos {handle} y mandame el link acá. Premio: L.{reward} de regalo en tu Rico Cash 🎁 Tenés {hours} horas.',
                ig_handle: String(b.ig_handle || '@richaromacoffee').trim() || '@richaromacoffee',
                active_from: b.active_from || today,
                active_to: b.active_to || null,
                deadline_hours: Math.max(1, parseInt(b.deadline_hours) || 48),
                is_active: b.is_active !== false
            };
            const { data, error } = await supabase.from('missions').insert(row).select().single();
            if (error) throw error;
            return res.json({ ok: true, mission: { ...data, trigger_item_name: item.name } });
        }

        if (action === 'admin_mission_toggle' && req.method === 'POST') {
            if (!(await requireStaff())) return;
            const mid = req.body?.id || req.body?.mission_id || id || req.query.id;
            if (!mid) return res.status(400).json({ error: 'id requerido' });
            const { data: m } = await supabase.from('missions').select('*').eq('id', mid).maybeSingle();
            if (!m) return res.status(404).json({ error: 'Misión no encontrada' });
            const next = req.body?.is_active !== undefined ? !!req.body.is_active : !m.is_active;
            const { data: updated, error } = await supabase.from('missions')
                .update({ is_active: next }).eq('id', mid).select().single();
            if (error) throw error;
            return res.json({ ok: true, mission: updated });
        }

        if (action === 'admin_mission_decide' && req.method === 'POST') {
            const actor = await requireStaff();
            if (!actor) return;
            const subId = req.body?.submission_id || req.body?.submissionId;
            const decision = req.body?.decision;
            if (!subId) return res.status(400).json({ error: 'submission_id requerido' });
            if (decision !== 'approved' && decision !== 'rejected') {
                return res.status(400).json({ error: "decision debe ser 'approved' o 'rejected'" });
            }
            const { data: sub } = await supabase.from('mission_submissions')
                .select('*').eq('id', subId).maybeSingle();
            if (!sub) return res.status(404).json({ error: 'Envío no encontrado' });
            if (sub.status !== 'pending') {
                return res.json({ ok: true, already_decided: true, submission: sub });
            }
            const { data: asg } = await supabase.from('mission_assignments')
                .select('*').eq('id', sub.assignment_id).maybeSingle();
            const { data: mission } = asg ? await supabase.from('missions')
                .select('*').eq('id', asg.mission_id).maybeSingle() : { data: null };
            const nowIso = new Date().toISOString();
            const decidedBy = actor.name || actor.id || 'staff';
            if (decision === 'approved') {
                const { data: cust } = await supabase.from('customers')
                    .select('id, phone').eq('id', sub.customer_id).maybeSingle();
                const amount = mission ? (parseFloat(mission.reward_amount) || 0) : 0;
                // The grant lands as a PENDING reward_grants row, the
                // same shape as the welcome gift. The live schema's
                // UNIQUE (customer_id, grant_type) allows only ONE
                // 'mission' grant per customer — so if this customer
                // already earned one from another mission, the retry
                // below records this mission's grant under its own
                // type ('mission:<slug>') instead of losing it.
                const grantRow = (grantType) => ({
                    id: 'grant_' + Date.now() + Math.floor(Math.random() * 100000),
                    customer_id: sub.customer_id,
                    phone: (cust && cust.phone) || '',
                    grant_type: grantType,
                    amount,
                    status: 'pending',
                    source: 'mission:' + (mission ? mission.id : 'unknown')
                });
                let ins = await supabase.from('reward_grants').insert(grantRow('mission'));
                let grantType = 'mission';
                if (ins.error && (ins.error.code === '23505' || /duplicate|unique/i.test(ins.error.message || ''))) {
                    grantType = 'mission:' + (mission ? mission.id : 'unknown');
                    ins = await supabase.from('reward_grants').insert(grantRow(grantType));
                }
                if (ins.error) throw ins.error;
                // LOYALTY (2026-10-30): mint the pending grant into a
                // gift lot NOW so the reward is spendable when the
                // customer hears about it (the daily sweep backstops
                // any miss). Treats 'mission' and 'mission:<slug>'
                // alike; never throws.
                await ricoLoyalty.mintPendingMissionGrants(supabase, { customerId: sub.customer_id });
                await supabase.from('mission_submissions')
                    .update({ status: 'approved', decided_at: nowIso, decided_by: decidedBy })
                    .eq('id', sub.id).eq('status', 'pending');
                if (asg) await supabase.from('mission_assignments')
                    .update({ status: 'approved' }).eq('id', asg.id);
                return res.json({ ok: true, decision: 'approved', submission_id: sub.id, grant_type: grantType, amount });
            }
            const reason = String(req.body?.reject_reason || req.body?.rejectReason || '').slice(0, 200) || null;
            await supabase.from('mission_submissions')
                .update({ status: 'rejected', reject_reason: reason, decided_at: nowIso, decided_by: decidedBy })
                .eq('id', sub.id).eq('status', 'pending');
            if (asg) await supabase.from('mission_assignments')
                .update({ status: 'rejected' }).eq('id', asg.id);
            return res.json({ ok: true, decision: 'rejected', submission_id: sub.id });
        }

        if (action === 'customer_update') {
            const targetId = id || req.query.id;
            if (!targetId) return res.status(400).json({ error: "ID required" });

            // SEC-FIX 1: this used to run .update(req.body) with no auth at
            // all — anyone could rewrite any customer's balance or PIN.
            // Now: staff may edit profile fields + pin/tags/is_vip (the
            // members page's PIN-reset and tier tools live here); the
            // account holder may edit their own profile + PIN only by
            // proving the CURRENT PIN (body.currentPin or Bearer). Money
            // and benefit counters (rico_balance, points, allowance,
            // visits, vip_expiry) are NEVER editable here — they have
            // dedicated, gated paths (load_balance, purchase_membership).
            const actor = await staffActor();
            const body = req.body || {};
            if (!actor) {
                const proof = body.currentPin || bearerCred();
                if (!(await customerPinMatches(targetId, proof))) {
                    return res.status(401).json({ error: "Se requiere el PIN actual del cliente o credencial de personal" });
                }
            }
            const allowed = ['name', 'email', 'birthday'];
            allowed.push('pin');
            if (actor) allowed.push('tags', 'is_vip');
            const updates = {};
            for (const k of allowed) if (body[k] !== undefined) updates[k] = body[k];
            if (Object.keys(updates).length === 0) return res.status(400).json({ error: "Nada para actualizar" });

            const { data, error } = await supabase.from('customers')
                .update(updates)
                .eq('id', targetId)
                .select()
                .single();

            if (error) throw error;
            return res.json(sanitizeCustomer(data));
        }

        // --- RESTAURANT-SPECIFIC STAMP LOYALTY CARDS ---
        if (action === 'get_customer_stamp_cards') {
            const phone = req.query.phone || req.body?.phone;
            if (!phone) return res.status(400).json({ error: "Phone number is required" });

            const cleanPhone = phone.replace(/\D/g, '');
            const phoneVariants = [cleanPhone];
            if (cleanPhone.length === 8) phoneVariants.push(`504${cleanPhone}`);
            if (cleanPhone.startsWith('504') && cleanPhone.length === 11) phoneVariants.push(cleanPhone.slice(3));

            const { data: cards, error } = await supabase.from('restaurant_loyalty_cards')
                .select('*')
                .in('customer_phone', phoneVariants);

            if (error) {
                const isMissingTable = error.code === 'PGRST205' || (error.message && (error.message.includes('restaurant_loyalty_cards') || error.message.includes('relation')));
                if (!isMissingTable) {
                    throw error;
                }
            }

            // Fetch restaurant details for these cards
            const resIds = (cards || []).map(c => c.restaurant_id);
            let restaurantsMap = {};
            if (resIds.length > 0) {
                const { data: resList } = await supabase.from('restaurants')
                    .select('id, name, logo_url, category')
                    .in('id', resIds);
                (resList || []).forEach(r => { restaurantsMap[r.id] = r; });
            }

            const formattedCards = (cards || []).map(card => ({
                id: card.id,
                restaurant_id: card.restaurant_id,
                restaurant_name: restaurantsMap[card.restaurant_id]?.name || card.restaurant_id.replace(/-/g, ' ').toUpperCase(),
                logo_url: restaurantsMap[card.restaurant_id]?.logo_url || '/icon-192.png',
                category: restaurantsMap[card.restaurant_id]?.category || 'Restaurante',
                stamps_count: card.stamps_count || 0,
                stamps_goal: card.stamps_goal || 6,
                rewards_earned: card.rewards_earned || 0,
                rewards_redeemed: card.rewards_redeemed || 0,
                reward_description: card.reward_description || '1 Producto Gratis',
                updated_at: card.updated_at
            }));

            return res.json({ success: true, cards: formattedCards });
        }

        if (action === 'redeem_stamp_reward' && req.method === 'POST') {
            const { phone, restaurantId, cardId } = req.body || {};
            if (!restaurantId && !cardId) return res.status(400).json({ error: "restaurantId or cardId is required" });

            let query = supabase.from('restaurant_loyalty_cards').select('*');
            if (cardId) {
                query = query.eq('id', cardId);
            } else {
                const cleanPhone = (phone || '').replace(/\D/g, '');
                query = query.eq('restaurant_id', restaurantId).eq('customer_phone', cleanPhone);
            }

            const { data: card, error } = await query.maybeSingle();
            if (error || !card) return res.status(404).json({ error: "Tarjeta de sellos no encontrada" });

            if ((card.rewards_earned || 0) <= 0) {
                return res.status(400).json({ error: "No tienes recompensas acumuladas pendientes para canjear en este negocio." });
            }

            // SEC-FIX 1: redeeming a reward spends value — require the card
            // owner's PIN (self-service) or a staff credential.
            {
                const { data: cardCust } = await supabase.from('customers').select('id, pin').eq('phone', card.customer_phone).maybeSingle();
                const pinOk = cardCust && (await customerPinMatches(cardCust.id, req.body?.pin || bearerCred()));
                if (!pinOk && !(await staffActor())) {
                    return res.status(401).json({ error: "Se requiere el PIN del cliente o credencial de personal" });
                }
            }

            const { data: updated, error: updErr } = await supabase.from('restaurant_loyalty_cards')
                .update({
                    rewards_earned: card.rewards_earned - 1,
                    rewards_redeemed: (card.rewards_redeemed || 0) + 1,
                    updated_at: new Date().toISOString()
                })
                .eq('id', card.id)
                .select()
                .single();

            if (updErr) throw updErr;

            return res.json({
                success: true,
                message: `¡Recompensa canjeada con éxito! Disfruta tu "${card.reward_description || 'Premio'}".`,
                card: updated
            });
        }

        if (action === 'partner_update_loyalty' && req.method === 'POST') {
            if (!(await requireStaff())) return;
            const { restaurantId, loyaltyEnabled, loyaltyStampGoal, loyaltyRewardText, whatsappOrdersPhone } = req.body || {};
            if (!restaurantId) return res.status(400).json({ error: "restaurantId is required" });

            const updates = {
                loyalty_enabled: loyaltyEnabled !== false,
                loyalty_stamp_goal: parseInt(loyaltyStampGoal) || 6,
                loyalty_reward_text: loyaltyRewardText || '1 Producto Gratis',
                whatsapp_orders_phone: whatsappOrdersPhone || null
            };

            const { data, error } = await supabase.from('restaurants')
                .update(updates)
                .eq('id', restaurantId)
                .select('id, name, loyalty_enabled, loyalty_stamp_goal, loyalty_reward_text, whatsapp_orders_phone')
                .maybeSingle();

            if (error) {
                // If column doesn't exist in restaurants table yet, store inside settings json
                const { data: resData } = await supabase.from('restaurants').select('settings').eq('id', restaurantId).single();
                const settings = resData?.settings || {};
                settings.loyalty = updates;
                await supabase.from('restaurants').update({ settings }).eq('id', restaurantId);
            }

            return res.json({ success: true, loyalty: updates });
        }

        // --- COMMISSION TOPUPS (RECEIPT UPLOADS) ---
        if (action === 'submit_commission_topup' && req.method === 'POST') {
            if (!(await requireStaff())) return;
            const { restaurantId, amount, receiptUrl, bankName, referenceNumber, notes } = req.body || {};
            const targetId = restaurantId || finalResId;
            if (!targetId) return res.status(400).json({ error: "restaurantId is required" });
            if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: "Monto válido es requerido" });
            if (!receiptUrl) return res.status(400).json({ error: "Foto / Comprobante de transferencia es requerido" });

            const payload = {
                restaurant_id: targetId,
                amount: parseFloat(amount),
                receipt_url: receiptUrl,
                bank_name: bankName || 'BAC Credomatic',
                reference_number: referenceNumber || null,
                notes: notes || null,
                status: 'pending'
            };

            const { data, error } = await supabase.from('commission_topups')
                .insert(payload)
                .select()
                .single();

            if (error) {
                console.error("Error submitting commission topup:", error);
                // SEC-FIX 1: never fake success — the old code returned a
                // fabricated 'temp-' topup on DB error, so a partner could
                // believe a payment was registered when nothing was saved.
                return res.status(500).json({ error: "No se pudo registrar el comprobante. Inténtalo de nuevo." });
            }

            return res.json({
                success: true,
                message: "¡Comprobante enviado con éxito! Tu saldo será acreditado en breve tras la verificación.",
                topup: data
            });
        }

        if (action === 'get_partner_topups') {
            if (!(await requireStaff())) return;
            const targetId = req.query.restaurantId || finalResId;
            const { data, error } = await supabase.from('commission_topups')
                .select('*')
                .eq('restaurant_id', targetId)
                .order('created_at', { ascending: false })
                .limit(10);

            if (error) {
                return res.json({ success: true, topups: [] });
            }

            return res.json({ success: true, topups: data || [] });
        }

        // --- CUSTOMER ORDER HISTORY ---
        if (action === 'customer_orders') {
            const { phone, customerId } = req.query;
            const cleanPhone = phone ? phone.replace(/\D/g, '') : '';
            const phoneVariants = [];
            if (cleanPhone) {
                phoneVariants.push(cleanPhone);
                if (cleanPhone.length === 8) phoneVariants.push(`504${cleanPhone}`);
                if (cleanPhone.startsWith('504') && cleanPhone.length === 11) phoneVariants.push(cleanPhone.slice(3));
            }

            let customerIds = customerId ? [customerId] : [];
            if (phoneVariants.length > 0) {
                const { data: matchedCusts } = await supabase.from('customers')
                    .select('id')
                    .in('phone', phoneVariants);
                if (matchedCusts) {
                    customerIds = customerIds.concat(matchedCusts.map(c => c.id));
                }
            }

            let query = supabase.from('orders')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(20);

            if (customerIds.length > 0) {
                query = query.in('customer_id', customerIds);
            } else {
                return res.json({ orders: [] });
            }

            const { data: orders, error } = await query;
            if (error) return res.status(500).json({ error: error.message });

            return res.json({ orders: orders || [] });
        }

        // --- PARTNER SELLS RICO CASH (OFFSETS PLATFORM FEES) ---
        if (action === 'partner_topup' && req.method === 'POST') {
            if (!(await requireStaff())) return;
            const { restaurant_id, phone, amount } = req.body || {};
            const targetId = restaurant_id || finalResId;
            const topupAmount = parseFloat(amount);

            if (!targetId) return res.status(400).json({ error: "restaurant_id is required" });
            if (!phone) return res.status(400).json({ error: "Teléfono del cliente es requerido" });
            if (!topupAmount || topupAmount <= 0) return res.status(400).json({ error: "Monto válido es requerido" });

            const cleanPhone = phone.replace(/\D/g, '');
            const phoneVariants = [cleanPhone];
            if (cleanPhone.length === 8) phoneVariants.push(`504${cleanPhone}`);
            if (cleanPhone.startsWith('504') && cleanPhone.length === 11) phoneVariants.push(cleanPhone.slice(3));

            // 1. Find or create customer
            let { data: customer } = await supabase.from('customers')
                .select('*')
                .in('phone', phoneVariants)
                .maybeSingle();

            if (!customer) {
                const newId = 'cust_' + Date.now() + Math.floor(Math.random()*1000);
                const { data: newCust, error: createErr } = await supabase.from('customers')
                    .insert({
                        id: newId,
                        phone: cleanPhone,
                        name: `Cliente ${cleanPhone.slice(-4)}`,
                        rico_balance: topupAmount,
                        points: 0
                    })
                    .select()
                    .single();
                if (createErr) throw createErr;
                customer = newCust;
            } else {
                const newBal = (parseFloat(customer.rico_balance) || 0) + topupAmount;
                const { data: updatedCust, error: updErr } = await supabase.from('customers')
                    .update({ rico_balance: newBal })
                    .eq('id', customer.id)
                    .select()
                    .single();
                if (updErr) throw updErr;
                customer = updatedCust;
            }

            // 2. Record in ledger: Merchant received physical cash, so it counts as fee settlement / cash collected
            await supabase.from('quimieats_ledger').insert({
                restaurant_id: targetId,
                amount: -topupAmount, // Deducts from merchant platform balance / offsets fees
                type: 'rico_cash_sold',
                status: 'settled',
                customer_id: customer.id,
                order_id: `Venta Rico Cash a ${cleanPhone} (Efectivo cobrado por negocio)`
            });

            // 3. Return updated info
            return res.json({
                success: true,
                customerName: customer.name || cleanPhone,
                amount: topupAmount,
                newBalance: parseFloat(customer.rico_balance) || 0,
                message: `¡Recarga de L. ${topupAmount.toFixed(2)} acreditada con éxito al cliente!`
            });
        }

        // --- 5. MENU ---
        if (action === 'menu') {
            const [rItems, rModGroups, rModOptions, rItemModGroups, restaurant] = await Promise.all([
                supabase.from('menu_items').select('*').eq('restaurant_id', finalResId).order('name'),
                supabase.from('modifier_groups').select('*').eq('restaurant_id', finalResId).order('name'),
                supabase.from('modifier_options').select('*').order('name'),
                supabase.from('item_modifier_groups').select('*'),
                supabase.from('restaurants').select('settings').eq('id', finalResId).maybeSingle()
            ]);
            let items = rItems.data || [];
            const settings = restaurant?.data?.settings || {};
            const productInventory = settings.product_inventory || {};
            const activeBatches = settings.batches || [];
            const gachaPromoItemIds = settings.gachaPromoItemIds || [];
            
            items = items.map(item => ({
                ...item,
                is_gacha_promo: gachaPromoItemIds.includes(item.id)
            }));
            
            // Apply Chameleon Shift menu filters (America/Tegucigalpa timezone)
            const localTimeStr = new Date().toLocaleString("en-US", { timeZone: "America/Tegucigalpa" });
            const localDate = new Date(localTimeStr);
            const localHour = localDate.getHours();

            const nightOnlyIds = ['food_captain_rico_smash', 'food_double_social_smash', 'food_jungle_melt', 'food_griddled_skins'];
            const morningOnlyIds = ['food_fitness_baleada', 'food_fit_burger', 'food_protein_bowl'];

            if (localHour >= 6 && localHour < 14) {
                // Morning Shift: Hide Night-only smash burgers
                items = items.filter(i => !nightOnlyIds.includes(i.id));
            } else if (localHour >= 16 && localHour < 22) {
                // Night Shift: Hide Morning-only baleadas/fit-bowls
                items = items.filter(i => !morningOnlyIds.includes(i.id));
            } else if (localHour >= 14 && localHour < 16) {
                // Mid-day Rest: Show night menu for preview
                items = items.filter(i => !morningOnlyIds.includes(i.id));
            }

            const isAdmin = req.query.admin === 'true';
            const now = new Date();

            const filteredItems = items.filter(i => isAdmin || i.available !== false).map(item => {
                let p = (parseFloat(item.price) || 0);
                let finalPrice = p;
                let originalPrice = p;
                let promoTag = null;
                
                const itemConfig = productInventory[item.id] || { is_unlimited: true };
                let stockQuantity = itemConfig.stock_quantity;
                let expiresInHours = undefined;
                let isUnlimited = itemConfig.is_unlimited !== false;

                if (!isUnlimited) {
                    const itemBatches = activeBatches.filter(b => b.menu_item_id === item.id);
                    const validBatches = itemBatches.filter(b => new Date(b.expires_at) > now && b.quantity > 0);
                    stockQuantity = validBatches.reduce((sum, b) => sum + b.quantity, 0);

                    if (validBatches.length > 0) {
                        const sorted = [...validBatches].sort((a,b) => new Date(a.expires_at) - new Date(b.expires_at));
                        const closest = sorted[0];
                        expiresInHours = (new Date(closest.expires_at) - now) / (1000 * 60 * 60);

                        if (expiresInHours <= 12) {
                            finalPrice = p * 0.50; // 50% OFF
                            promoTag = "50% OFF Próximo a vencer";
                        } else if (expiresInHours <= 24) {
                            finalPrice = p * 0.80; // 20% OFF
                            promoTag = "20% OFF Lote del día";
                        }
                    } else {
                        stockQuantity = 0;
                    }
                }

                return { 
                    ...item, 
                    price: finalPrice, 
                    original_price: originalPrice, 
                    promo_tag: promoTag, 
                    stock_quantity: stockQuantity,
                    is_unlimited: isUnlimited,
                    default_daily_stock: itemConfig.default_daily_stock || null,
                    expires_in_hours: expiresInHours
                };
            });

            // Gather items expiring in under 12 hours with active stock to push as Gacha rewards
            const expiringPrizes = filteredItems.filter(i => !i.is_unlimited && i.expires_in_hours !== undefined && i.expires_in_hours <= 12 && i.stock_quantity > 0).map(i => ({
                id: i.id,
                name: i.name,
                category: i.category
            }));

            const grouped = {};
            filteredItems.forEach(item => {
                const cat = (item.category || 'otros').toLowerCase();
                if (!grouped[cat]) grouped[cat] = [];
                grouped[cat].push({ 
                    id: item.id, 
                    name: item.name, 
                    price: item.price, 
                    original_price: item.original_price,
                    promo_tag: item.promo_tag,
                    available: item.is_unlimited ? item.available : (item.stock_quantity > 0), 
                    stock_quantity: item.stock_quantity,
                    is_unlimited: item.is_unlimited,
                    expires_in_hours: item.expires_in_hours,
                    image_url: item.image_url 
                });
            });
            const categories = Object.keys(grouped).map(c => ({ id: c, name: c.charAt(0).toUpperCase() + c.slice(1), items: grouped[c] }));
            const groups = rModGroups.data || [];
            const groupIds = groups.map(g => g.id);
            const options = (rModOptions.data || []).filter(o => groupIds.includes(o.group_id));
            const itemIds = filteredItems.map(i => i.id);
            const mappings = (rItemModGroups.data || []).filter(m => itemIds.includes(m.item_id) && groupIds.includes(m.group_id));

            return res.json({ 
                items: filteredItems, 
                categories, 
                expiringPrizes, 
                modGroups: groups, 
                modOptions: options, 
                itemModGroups: mappings, 
                acceptedPayments: settings.accepted_payments || {}, 
                taxRate: 0 
            });
        }

        // --- 6. PARTNER DASHBOARD ---
        if (action === 'partner_register') {
            // SEC-FIX 1: onboarding a new restaurant mints a master PIN and
            // seeds platform credit — administrator-only, never public.
            if (!isAdminCredential(req.headers.authorization)) return res.status(401).json({ error: "Se requiere credencial de administrador" });
            const { name, owner, phone, category } = req.body || {};
            if (!name || !phone) return res.status(400).json({ error: "Nombre y teléfono son obligatorios" });

            // Generate clean unique restaurant ID slug
            let baseSlug = name.toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-z0-9]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '');
                
            if (!baseSlug) baseSlug = 'negocio';
            const suffix = Math.floor(1000 + Math.random() * 9000);
            const generatedResId = `${baseSlug}-${suffix}`;
            
            // Generate random 4-digit PIN
            const generatedPin = String(Math.floor(1000 + Math.random() * 9000));
            
            const trialEnd = new Date();
            trialEnd.setDate(trialEnd.getDate() + 7);

            const { data, error } = await supabase.from('restaurants').insert({
                id: generatedResId,
                name: name,
                contact_phone: phone.replace(/\D/g, ''),
                status: 'active',
                settings: {
                    pin: generatedPin,
                    owner: owner || 'Propietario',
                    category: category || 'general',
                    plan: 'elite_trial',
                    trial_end: trialEnd.toISOString(),
                    is_taking_orders: true
                }
            }).select().single();

            if (error) {
                return res.status(500).json({ error: error.message });
            }

            // Automatically seed L. 500 Launch Commission Credit in QuimiEats Ledger
            await supabase.from('quimieats_ledger').insert({
                restaurant_id: generatedResId,
                amount: 500.00,
                type: 'welcome_promo_credit',
                status: 'settled',
                customer_id: 'system_promo',
                order_id: 'promo_welcome_500'
            }).catch(err => console.error("[Partner Registration] Failed to seed welcome credit:", err));

            // Send WhatsApp credentials notification to the registered merchant
            const cleanPhone = phone.replace(/\D/g, '');
            let phoneToMsg = cleanPhone;
            if (cleanPhone.length === 8) phoneToMsg = `504${cleanPhone}`;
            
            const welcomeText = `¡Hola! Tu negocio *${name}* ha sido registrado con éxito en QuimiEats 🚀.\n\n🔑 Tu PIN maestro para entrar al sistema es: *${generatedPin}*\n\nUsa este PIN para iniciar sesión en: https://quimieats.com/os\n\n¡Liderando la nueva era comercial de Quimistán! 🐒`;
            
            sendWhatsAppNotification(phoneToMsg, welcomeText).catch(err => {
                console.error("[Partner Registration] Failed to send credentials WhatsApp notification:", err);
            });

            return res.json({ success: true, resId: generatedResId, pin: generatedPin });
        }

        if (action === 'partner_update_plan') {
            if (!(await requireStaff())) return;
            const { restaurant_id, plan, in_person_onboarding } = req.body || {};
            if (!restaurant_id || !plan) return res.status(400).json({ error: "Missing parameters" });

            // Fetch current settings
            const { data: resData, error: fetchErr } = await supabase.from('restaurants').select('settings').eq('id', restaurant_id).single();
            if (fetchErr) return res.status(500).json({ error: fetchErr.message });

            const settings = resData?.settings || {};
            settings.plan = plan;
            settings.in_person_onboarding = !!in_person_onboarding;
            if (plan === 'basic') {
                settings.trial_end = null;
            } else {
                const trialEnd = new Date();
                trialEnd.setDate(trialEnd.getDate() + 7);
                settings.trial_end = trialEnd.toISOString();
            }

            const { error: updateErr } = await supabase.from('restaurants').update({ settings }).eq('id', restaurant_id);
            if (updateErr) return res.status(500).json({ error: updateErr.message });

            return res.json({ success: true, plan, in_person_onboarding: settings.in_person_onboarding });
        }

        if (action === 'restaurant_info') {
            const targetResId = id || req.query.id;
            if (!targetResId) return res.status(400).json({ error: "Missing id parameter" });
            const { data, error } = await supabase.from('restaurants').select('id, name, logo_url, settings, category').eq('id', targetResId).maybeSingle();
            if (error || !data) return res.status(404).json({ error: "Restaurant not found" });
            // SEC-FIX 1 (F6): this public endpoint handed out the full
            // settings object — including the partner PIN that verify-pin
            // accepts as an admin credential. The PIN never leaves the API.
            if (data.settings) { const { pin, ...publicSettings } = data.settings; data.settings = publicSettings; }
            return res.json(data);
        }

        if (action === 'partner_login') {
            const { restaurantId, pin } = req.body || {};
            if (!restaurantId || !pin) return res.status(400).json({ error: "Missing parameters" });

            const targetResId = restaurantId.toLowerCase().replace(/[^a-z0-9-]/g, '');
            const { data: resData, error } = await supabase.from('restaurants').select('*').eq('id', targetResId).maybeSingle();
            
            if (error || !resData) {
                return res.status(401).json({ error: "Restaurante no encontrado" });
            }

            const expectedPin = resData.settings?.pin || null; // fail-closed: no default master PIN
            if (pin !== expectedPin) {
                return res.status(401).json({ error: "PIN incorrecto" });
            }

            // SEC-FIX 1 (F6): never echo the PIN back in the login response.
            const { pin: _omitPin, ...safeSettings } = resData.settings || {};
            return res.json({ success: true, partner: { id: resData.id, name: resData.name, phone: resData.contact_phone, settings: safeSettings } });
        }

        if (action === 'partner_update_settings') {
            if (!(await requireStaff())) return;
            const { restaurantId, acceptedPayments, bankDetails, bankAccounts, gachaCampaign, operatingHours, bookingLeadTime, bookingBuffer } = req.body || {};
            if (!restaurantId) return res.status(400).json({ error: "restaurantId is required" });

            const { data: resData } = await supabase.from('restaurants').select('settings').eq('id', restaurantId).single();
            const settings = resData?.settings || {};
            settings.accepted_payments = acceptedPayments || {};
            if (Array.isArray(bankAccounts)) {
                // MULTI-BANK (bank-accounts): partner-os sends up to
                // 3 account blocks. Sanitize (trim, drop fully-empty
                // blocks, cap 3), store the array, and MIRROR
                // account #1 into the legacy bank_details so every
                // unfixed reader keeps working mid-deploy.
                const clean = bankAccounts.map(a => ({
                    bank: String((a && a.bank) || '').trim().slice(0, 60),
                    account: String((a && a.account) || '').trim().slice(0, 60),
                    owner: String((a && a.owner) || '').trim().slice(0, 80)
                })).filter(a => a.bank || a.account || a.owner).slice(0, 3);
                settings.bank_accounts = clean;
                const first = clean[0];
                settings.bank_details = first
                    ? { name: first.bank, account: first.account, owner: first.owner }
                    : (bankDetails || {});
            } else {
                settings.bank_details = bankDetails || {};
            }
            if (operatingHours) {
                settings.operating_hours = operatingHours;
            }
            if (req.body.ugc_codes) {
                settings.ugc_codes = req.body.ugc_codes;
            }
            if (bookingLeadTime !== undefined) {
                settings.booking_lead_time = bookingLeadTime;
            }
            if (bookingBuffer !== undefined) {
                settings.booking_buffer = bookingBuffer;
            }

            if (gachaCampaign) {
                // Enforce Thursday lock rule (locks on Friday day=5)
                const localTimeStr = new Date().toLocaleString("en-US", { timeZone: "America/Tegucigalpa" });
                const localDate = new Date(localTimeStr);
                const currentDay = localDate.getDay();
                if (currentDay === 5) {
                    return res.status(400).json({ error: "No puedes modificar tu campaña de Gacha los días viernes de ruleta activa." });
                }

                const currentCampaign = settings.gachaCampaign || {};
                const qty = parseInt(gachaCampaign.quantity) || 5;

                settings.gachaCampaign = {
                    isActive: !!gachaCampaign.isActive,
                    itemId: gachaCampaign.itemId || '',
                    quantity: qty,
                    remainingStock: currentCampaign.remainingStock !== undefined ? currentCampaign.remainingStock : qty,
                    automateWeekly: !!gachaCampaign.automateWeekly,
                    lastResetWeek: currentCampaign.lastResetWeek || ''
                };
            }

            const { data, error } = await supabase.from('restaurants')
                .update({ settings })
                .eq('id', restaurantId)
                .select()
                .single();

            if (error) throw error;
            const { pin: _omitPin2, ...safeUpdatedSettings } = data.settings || {};
            return res.json({ success: true, settings: safeUpdatedSettings });
        }

        if (action === 'partner_orders') {
            if (!(await requireStaff())) return;
            const resId = req.query.restaurantId;
            if (!resId) return res.status(400).json({ error: "restaurantId is required" });

            const { data, error } = await supabase.from('orders')
                .select('*, customers(name, phone)')
                .eq('restaurant_id', resId)
                .order('created_at', { ascending: false })
                .limit(50);

            if (error) throw error;
            return res.json({ orders: data || [] });
        }

        if (action === 'partner_update_order') {
            if (!(await requireStaff())) return;
            const { orderId, status } = req.body || {};
            if (!orderId || !status) return res.status(400).json({ error: "Missing parameters" });

            const { data, error } = await supabase.from('orders')
                .update({ status })
                .eq('id', orderId)
                .select()
                .single();

            if (error) throw error;
            // NOTIFICACIONES (bot-finalize): same hook as order_update
            // — a flip to ready/cancelled owes a WhatsApp customer
            // their message no matter which surface set it (this
            // action previously flipped status with no hook at all).
            if (data && (data.status === 'ready' || data.status === 'cancelled')) await notifyBotOrderStatus(data);
            return res.json({ success: true, order: data });
        }

        if (action === 'partner_update_item') {
            if (!(await requireStaff())) return;
            const { itemId, price, available, is_unlimited, default_daily_stock, stock_quantity, is_gacha_promo } = req.body || {};
            if (!itemId) return res.status(400).json({ error: "itemId is required" });

            const updates = {};
            if (price !== undefined) updates.price = parseFloat(price);
            if (available !== undefined) updates.available = !!available;

            let itemData = null;
            if (Object.keys(updates).length > 0) {
                const { data, error } = await supabase.from('menu_items')
                    .update(updates)
                    .eq('id', itemId)
                    .select()
                    .single();
                if (error) throw error;
                itemData = data;
            } else {
                const { data, error } = await supabase.from('menu_items')
                    .select('*')
                    .eq('id', itemId)
                    .single();
                if (error) throw error;
                itemData = data;
            }

            if (itemData) {
                const resId = itemData.restaurant_id;
                const { data: resData } = await supabase.from('restaurants').select('settings').eq('id', resId).single();
                const settings = resData?.settings || {};
                settings.product_inventory = settings.product_inventory || {};
                
                settings.product_inventory[itemId] = settings.product_inventory[itemId] || {};
                if (is_unlimited !== undefined) settings.product_inventory[itemId].is_unlimited = !!is_unlimited;
                if (default_daily_stock !== undefined) {
                    settings.product_inventory[itemId].default_daily_stock = default_daily_stock === '' ? null : parseInt(default_daily_stock);
                }
                if (stock_quantity !== undefined) {
                    settings.product_inventory[itemId].stock_quantity = stock_quantity === '' ? null : parseInt(stock_quantity);
                }
                if (req.body.duration !== undefined) {
                    settings.product_inventory[itemId].duration = req.body.duration === '' ? null : parseInt(req.body.duration);
                }

                // Gacha promo handling
                if (is_gacha_promo !== undefined) {
                    settings.gachaPromoItemIds = settings.gachaPromoItemIds || [];
                    if (is_gacha_promo) {
                        if (!settings.gachaPromoItemIds.includes(itemId)) {
                            settings.gachaPromoItemIds.push(itemId);
                        }
                    } else {
                        settings.gachaPromoItemIds = settings.gachaPromoItemIds.filter(id => id !== itemId);
                    }
                }

                await supabase.from('restaurants').update({ settings }).eq('id', resId);
                
                // Add tag dynamically to return payload
                itemData.is_gacha_promo = (settings.gachaPromoItemIds || []).includes(itemId);
            }

            return res.json({ success: true, item: itemData });
        }

        if (action === 'partner_ai_describe') {
            if (!(await requireStaff())) return;
            const { imageBase64 } = req.body || {};
            if (!imageBase64) return res.status(400).json({ error: "imageBase64 is required" });
            const result = await describeMenuItemPhoto(imageBase64);
            return res.json(result);
        }

        if (action === 'partner_create_item' || action === 'partner_save_item') {
            if (!(await requireStaff())) return;
            try {
                const { restaurant_id, name, price, category, is_unlimited, default_daily_stock, imageBase64, is_gacha_promo } = req.body || {};
                if (!restaurant_id || !name || !price) return res.status(400).json({ error: "Faltan campos obligatorios (nombre, precio o restaurante)" });

                // Ensure restaurant exists in DB
                let { data: resData } = await supabase.from('restaurants').select('id, settings').eq('id', restaurant_id).maybeSingle();
                if (!resData) {
                    const { data: newRes, error: insertResErr } = await supabase.from('restaurants').insert({
                        id: restaurant_id,
                        name: restaurant_id.replace(/-/g, ' ').toUpperCase(),
                        status: 'active',
                        settings: { is_taking_orders: true }
                    }).select().single();
                    if (insertResErr) {
                        console.error("[partner_save_item] Auto-restaurant create warning:", insertResErr);
                    }
                    resData = newRes || { settings: {} };
                }

                let imageUrl = null;
                if (imageBase64) {
                    try {
                        const rawBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
                        const buffer = Buffer.from(rawBase64, 'base64');
                        const filePath = `uploads/${Date.now()}_item.jpg`;
                        const { error: uploadErr } = await supabase.storage.from('menu-images').upload(filePath, buffer, { contentType: 'image/jpeg', upsert: true });
                        if (!uploadErr) {
                            imageUrl = supabase.storage.from('menu-images').getPublicUrl(filePath).data.publicUrl;
                        } else {
                            console.warn("[partner_save_item] Storage upload warning:", uploadErr);
                        }
                    } catch(e) { console.error("[partner_save_item] Image parse failed:", e); }
                }

                const itemId = `${restaurant_id}-${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Math.floor(100 + Math.random() * 900)}`;

                const { data: itemData, error } = await supabase.from('menu_items').insert({
                    id: itemId,
                    restaurant_id,
                    name,
                    price: parseFloat(price),
                    category: category || 'comida',
                    image_url: imageUrl,
                    available: true
                }).select().single();

                if (error) {
                    console.error("[partner_save_item] menu_items insert error:", error);
                    return res.status(500).json({ error: "Error al registrar plato: " + error.message });
                }

                // Save JSONB config to settings
                const settings = resData?.settings || {};
                settings.product_inventory = settings.product_inventory || {};
                settings.product_inventory[itemId] = {
                    is_unlimited: is_unlimited !== false,
                    default_daily_stock: default_daily_stock ? parseInt(default_daily_stock) : null,
                    stock_quantity: is_unlimited !== false ? null : 0,
                    duration: req.body.duration ? parseInt(req.body.duration) : null
                };

                if (is_gacha_promo) {
                    settings.gachaPromoItemIds = settings.gachaPromoItemIds || [];
                    settings.gachaPromoItemIds.push(itemId);
                }

                await supabase.from('restaurants').update({ settings }).eq('id', restaurant_id);

                if (itemData) {
                    itemData.is_gacha_promo = !!is_gacha_promo;
                }

                return res.json({ success: true, item: itemData });
            } catch (err) {
                console.error("[partner_save_item] Catch-all error:", err);
                return res.status(500).json({ error: "Error interno del servidor: " + (err.message || "Error desconocido") });
            }
        }

        if (action === 'partner_delete_item') {
            if (!(await requireStaff())) return;
            const { itemId } = req.body || {};
            if (!itemId) return res.status(400).json({ error: "itemId is required" });

            const { data: itemData } = await supabase.from('menu_items').select('restaurant_id').eq('id', itemId).single();

            const { error } = await supabase.from('menu_items').delete().eq('id', itemId);
            if (error) throw error;

            if (itemData) {
                const resId = itemData.restaurant_id;
                const { data: resData } = await supabase.from('restaurants').select('settings').eq('id', resId).single();
                const settings = resData?.settings || {};
                if (settings.product_inventory) {
                    delete settings.product_inventory[itemId];
                }
                if (settings.batches) {
                    settings.batches = settings.batches.filter(b => b.menu_item_id !== itemId);
                }
                await supabase.from('restaurants').update({ settings }).eq('id', resId);
            }

            return res.json({ success: true });
        }

        if (action === 'partner_add_batch') {
            if (!(await requireStaff())) return;
            const { itemId, batchName, quantity, hoursToExpire } = req.body || {};
            if (!itemId || !batchName || quantity === undefined || !hoursToExpire) {
                return res.status(400).json({ error: "Missing required batch parameters" });
            }

            const { data: itemData } = await supabase.from('menu_items').select('restaurant_id').eq('id', itemId).single();
            if (!itemData) return res.status(404).json({ error: "Item not found" });
            const resId = itemData.restaurant_id;

            const expiresAt = new Date(Date.now() + parseInt(hoursToExpire) * 60 * 60 * 1000).toISOString();

            const { data: resData } = await supabase.from('restaurants').select('settings').eq('id', resId).single();
            const settings = resData?.settings || {};
            settings.batches = settings.batches || [];
            settings.product_inventory = settings.product_inventory || {};

            const newBatch = {
                id: 'batch_' + Date.now() + '_' + Math.floor(Math.random() * 100),
                menu_item_id: itemId,
                batch_name: batchName,
                quantity: parseInt(quantity),
                expires_at: expiresAt,
                created_at: new Date().toISOString()
            };

            settings.batches.push(newBatch);

            // Update item stock quantity
            settings.product_inventory[itemId] = settings.product_inventory[itemId] || {};
            const currentStock = settings.product_inventory[itemId].stock_quantity || 0;
            settings.product_inventory[itemId].stock_quantity = currentStock + parseInt(quantity);
            settings.product_inventory[itemId].is_unlimited = false;

            await supabase.from('restaurants').update({ settings }).eq('id', resId);

            // Set item available in menu_items table
            await supabase.from('menu_items').update({ available: true }).eq('id', itemId);

            return res.json({ success: true, batch: newBatch });
        }

        if (action === 'partner_generate_ugc_codes') {
            if (!(await requireStaff())) return;
            const { restaurantId, rewardType, rewardValue, count, maxClaims } = req.body || {};
            if (!restaurantId || !rewardType || !rewardValue || !count) {
                return res.status(400).json({ error: "Missing required parameters" });
            }

            const { data: rest, error } = await supabase.from('restaurants').select('*').eq('id', restaurantId).maybeSingle();
            if (error || !rest) return res.status(404).json({ error: "Restaurant not found" });

            const settings = rest.settings || {};
            if (!settings.ugc_codes) settings.ugc_codes = {};

            const limit = parseInt(maxClaims) || 1;
            const codes = [];
            for (let i = 0; i < count; i++) {
                const code = `${restaurantId}_UGC_${Math.floor(100000 + Math.random() * 900000)}`;
                settings.ugc_codes[code] = {
                    reward_type: rewardType,
                    reward_value: rewardValue,
                    max_claims: limit,
                    is_redeemed: false,
                    claims: []
                };
                codes.push(code);
            }

            await supabase.from('restaurants').update({ settings }).eq('id', restaurantId);
            return res.json({ success: true, codes });
        }

        if (action === 'get_ugc_code_info') {
            const { code } = req.query;
            if (!code) return res.status(400).json({ error: "Code is required" });

            const parts = code.split('_UGC_');
            if (parts.length < 2) return res.status(400).json({ error: "Invalid claim code format" });
            const restaurantId = parts[0];

            const { data: rest } = await supabase.from('restaurants').select('*').eq('id', restaurantId).maybeSingle();
            if (!rest) return res.status(404).json({ error: "Restaurant not found" });

            const settings = rest.settings || {};
            if (!settings.ugc_codes || !settings.ugc_codes[code]) {
                return res.status(404).json({ error: "Código de regalo inválido o no existe." });
            }

            const claimData = settings.ugc_codes[code];
            const maxClaims = parseInt(claimData.max_claims) || 1;
            const currentClaimsCount = (claimData.claims || []).length;

            let itemName = null;
            if (claimData.reward_type === 'item') {
                const { data: item } = await supabase.from('menu_items').select('name').eq('id', claimData.reward_value).maybeSingle();
                if (item) itemName = item.name;
            }

            return res.json({
                success: true,
                reward_type: claimData.reward_type,
                reward_value: claimData.reward_value,
                reward_item_name: itemName,
                max_claims: maxClaims,
                claims_count: currentClaimsCount,
                is_fully_redeemed: claimData.is_redeemed || currentClaimsCount >= maxClaims,
                restaurant_name: rest.name
            });
        }

        if (action === 'claim_ugc_code') {
            const { code, customerId } = req.body || {};
            if (!code || !customerId) return res.status(400).json({ error: "Code and Customer ID are required" });

            const parts = code.split('_UGC_');
            if (parts.length < 2) return res.status(400).json({ error: "Invalid claim code format" });
            const restaurantId = parts[0];

            const { data: rest } = await supabase.from('restaurants').select('*').eq('id', restaurantId).maybeSingle();
            if (!rest) return res.status(404).json({ error: "Restaurant not found" });

            const settings = rest.settings || {};
            if (!settings.ugc_codes || !settings.ugc_codes[code]) {
                return res.status(404).json({ error: "Código de regalo inválido o no existe." });
            }

            const claimData = settings.ugc_codes[code];
            const maxClaims = parseInt(claimData.max_claims) || 1;
            if (!claimData.claims) claimData.claims = [];

            // 1. Check if limit is reached
            if (claimData.is_redeemed || claimData.claims.length >= maxClaims) {
                return res.status(400).json({ error: "Este código de regalo ya alcanzó su límite de ganadores." });
            }

            // 2. Check if customer has already claimed it
            if (claimData.claims.some(c => c.customer_id === customerId)) {
                return res.status(400).json({ error: "Ya has reclamado esta recompensa." });
            }

            // Fetch customer to award points
            const { data: cust } = await supabase.from('customers').select('*').eq('id', customerId).maybeSingle();
            if (!cust) return res.status(404).json({ error: "Cliente no encontrado." });

            if (claimData.reward_type === 'points' || claimData.reward_type === 'gacha_spin') {
                const ptsToAdd = parseInt(claimData.reward_value) || 0;
                const newPoints = (cust.points || 0) + ptsToAdd;
                
                // Tier logic check
                let newTier = cust.tier || 'bronze';
                if (newPoints >= 1500) newTier = 'gold';
                else if (newPoints >= 500) newTier = 'silver';
                
                await supabase.from('customers').update({ 
                    points: newPoints,
                    tier: newTier
                }).eq('id', customerId);
            }

            if (claimData.reward_type === 'item') {
                // Verify menu item exists
                const { data: item } = await supabase.from('menu_items').select('id, name').eq('id', claimData.reward_value).maybeSingle();
                if (!item) return res.status(404).json({ error: "El producto de regalo ya no existe." });

                // Push new voucher entry into restaurant's gachaClaims array
                if (!settings.gachaClaims) settings.gachaClaims = [];
                settings.gachaClaims.push({
                    claimCode: `QL-UGC-${Math.floor(1000 + Math.random() * 9000)}-${Math.floor(1000 + Math.random() * 9000)}`,
                    customerId: customerId,
                    itemId: claimData.reward_value,
                    isRedeemed: false,
                    createdAt: new Date().toISOString()
                });
            }

            // Append claim record
            claimData.claims.push({
                customer_id: customerId,
                claimed_at: new Date().toISOString()
            });

            // Mark as redeemed if full
            if (claimData.claims.length >= maxClaims) {
                claimData.is_redeemed = true;
            }

            await supabase.from('restaurants').update({ settings }).eq('id', restaurantId);

            return res.json({
                success: true,
                reward_type: claimData.reward_type,
                reward_value: claimData.reward_value,
                restaurant_name: rest.name
            });
        }

        if (action === 'list_drivers') {
            const { data, error } = await supabase.from('employees').select('id, name').eq('role', 'driver').eq('active', true).order('name');
            if (error) throw error;
            return res.json({ success: true, drivers: data || [] });
        }

        if (action === 'assign_driver' && req.method === 'POST') {
            if (!(await requireStaff())) return;
            const { orderId, driverId } = req.body || {};
            if (!orderId || !driverId) return res.status(400).json({ error: "orderId and driverId are required" });

            const { data: driver } = await supabase.from('employees').select('name').eq('id', driverId).maybeSingle();
            if (!driver) return res.status(404).json({ error: "Driver not found" });

            const { data: order } = await supabase.from('orders').select('notes').eq('id', orderId).single();
            const cleanNotes = (order.notes || '').replace(/\[DRIVER:[^\]]+\]/g, '').trim();
            const updatedNotes = (cleanNotes + ` [DRIVER: id=${driverId}, status=assigned]`).trim();

            const { data, error } = await supabase.from('orders')
                .update({ 
                    driver_id: driverId, 
                    delivery_status: 'assigned',
                    notes: updatedNotes
                })
                .eq('id', orderId)
                .select()
                .single();

            if (error) throw error;
            return res.json({ success: true, order: data });
        }

        // --- DRIVER FLOWS ---
        if (action === 'driver_login' && req.method === 'POST') {
            const { pin } = req.body;
            const { data: driver, error } = await supabase
                .from('employees')
                .select('*')
                .eq('pin', pin)
                .eq('role', 'driver')
                .eq('active', true)
                .maybeSingle();

            if (error || !driver) return res.status(401).json({ success: false, error: "PIN invalido" });
            return res.json({ success: true, driver });
        }

        if (action === 'driver_signup' && req.method === 'POST') {
            const { name, phone, vehicle } = req.body;
            const cleanPhone = phone.replace(/\D/g, '');
            const driverId = 'drv_' + Date.now() + Math.floor(Math.random()*1000);
            const tempPin = Math.floor(Math.random() * 9000 + 1000).toString();

            // SEC-FIX 1: a self-registered driver must NOT be active on
            // creation — verify-pin accepts any active employee's PIN, so
            // an instantly-active signup was a self-service staff
            // credential. Staff activate the driver in /admin to approve.
            const { data, error } = await supabase.from('employees').insert({
                id: driverId,
                name: name,
                role: 'driver',
                pin: tempPin,
                active: false,
                color: 'cyan',
                hourly_rate: 0
            }).select().single();

            if (error) throw error;
            return res.json({ success: true, pin: tempPin, driverId: data.id, pendingApproval: true });
        }

        if (action === 'driver_orders' && req.method === 'GET') {
            const { driverId, mode } = req.query;
            try {
                let query = supabase.from('orders')
                    .select('*, customers(name, phone)')
                    .eq('status', 'ready');

                if (mode === 'available') {
                    query = query.is('driver_id', null);
                } else {
                    query = query.eq('driver_id', driverId).not('delivery_status', 'eq', 'delivered');
                }

                const { data, error } = await query.order('created_at', { ascending: false });
                if (error) throw error;
                return res.json({ orders: data || [] });
            } catch (e) {
                // Fallback: search within notes field metadata
                const { data, error } = await supabase.from('orders')
                    .select('*, customers(name, phone)')
                    .order('created_at', { ascending: false });
                
                if (error) throw error;
                const filtered = (data || []).filter(o => {
                    const hasDriver = o.notes?.includes('[DRIVER:');
                    if (mode === 'available') {
                        return !hasDriver && (o.status === 'ready' || o.status === 'preparing');
                    } else {
                        return o.notes?.includes(`[DRIVER: id=${driverId}`) && !o.notes?.includes('status=delivered');
                    }
                });
                return res.json({ orders: filtered });
            }
        }

        if (action === 'driver_claim' && req.method === 'POST') {
            const { id } = req.query;
            const { driverId } = req.body;

            try {
                const { data: existing } = await supabase.from('orders').select('driver_id').eq('id', id).single();
                if (existing && existing.driver_id) return res.status(409).json({ error: "Ya reclamado" });

                const { data, error } = await supabase.from('orders')
                    .update({ 
                        driver_id: driverId, 
                        delivery_status: 'assigned' 
                    })
                    .eq('id', id)
                    .select()
                    .single();

                if (error) throw error;
                return res.json({ success: true, order: data });
            } catch (e) {
                const { data: order } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
                if (!order) return res.status(404).json({ error: "Orden no encontrada" });
                if (order.notes?.includes('[DRIVER:')) return res.status(409).json({ error: "Ya reclamado" });

                const updatedNotes = (order.notes || '') + ` [DRIVER: id=${driverId}, status=assigned]`;
                const { data: updated, error } = await supabase.from('orders')
                    .update({ notes: updatedNotes })
                    .eq('id', id)
                    .select()
                    .single();
                
                if (error) throw error;
                return res.json({ 
                    success: true, 
                    order: { 
                        ...updated, 
                        driver_id: driverId, 
                        delivery_status: 'assigned' 
                    } 
                });
            }
        }

        if (action === 'order_delivery_status' && req.method === 'PATCH') {
            const { id } = req.query;
            const { status, driverId, pin } = req.body;

            // PIN Verification Check for Courier Deliveries
            if (status === 'delivered') {
                const { data: order, error: orderErr } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
                if (order) {
                    let expectedPin = order.delivery_pin;
                    if (!expectedPin && order.notes) {
                        const match = order.notes.match(/\[DELIVERY_PIN:\s*(\d{4})\]/);
                        if (match) expectedPin = match[1];
                    }
                    if (expectedPin && expectedPin.trim() !== (pin || '').trim()) {
                        return res.status(400).json({ error: "Código de entrega PIN incorrecto" });
                    }
                }
            }

            try {
                const { data, error } = await supabase.from('orders')
                    .update({ 
                        delivery_status: status,
                        status: status === 'delivered' ? 'completed' : 'ready'
                    })
                    .eq('id', id)
                    .eq('driver_id', driverId)
                    .select()
                    .single();

                if (error) throw error;
                return res.json({ success: true, order: data });
            } catch (e) {
                const { data: order } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
                if (!order) return res.status(404).json({ error: "Orden no encontrada" });

                const cleanNotes = (order.notes || '').replace(/\[DRIVER:[^\]]+\]/g, '').trim();
                const updatedNotes = (cleanNotes + ` [DRIVER: id=${driverId}, status=${status}]`).trim();
                
                const { data: updated, error } = await supabase.from('orders')
                    .update({ 
                        status: status === 'delivered' ? 'completed' : order.status,
                        notes: updatedNotes 
                    })
                    .eq('id', id)
                    .select()
                    .single();

                if (error) throw error;
                return res.json({ 
                    success: true, 
                    order: { 
                        ...updated, 
                        driver_id: driverId, 
                        delivery_status: status 
                    } 
                });
            }
        }

        // --- DYNAMIC CASHOUT OTP (DRIVER & RESTAURANT INSTANT CASH-OUT) ---
        if (action === 'driver_generate_cashout_otp' && req.method === 'POST') {
            const { driverId, amount } = req.body || {};
            if (!driverId) return res.status(400).json({ error: "driverId is required" });

            const otp = Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit random OTP
            const otpNumeric = parseFloat(otp);

            let { data: driver, error } = await supabase.from('employees')
                .update({
                    hourly_rate: otpNumeric, // store temporary OTP safely
                    updated_at: new Date().toISOString()
                })
                .eq('id', driverId)
                .select('id, name')
                .maybeSingle();

            if (!driver) {
                // Fallback: update any active driver
                const { data: fallbackDrv } = await supabase.from('employees')
                    .update({ hourly_rate: otpNumeric })
                    .eq('role', 'driver')
                    .select('id, name')
                    .limit(1);
                if (fallbackDrv && fallbackDrv.length > 0) driver = fallbackDrv[0];
            }

            if (!driver) return res.status(404).json({ error: "Driver no encontrado" });

            return res.json({
                success: true,
                otp,
                expiresInMinutes: 15,
                message: `Tu código de retiro seguro es ${otp}. Muéstralo al cajero del restaurante para recibir tu efectivo.`
            });
        }

        if (action === 'partner_payout_driver_with_otp' && req.method === 'POST') {
            const { restaurantId, driverOtp, amount } = req.body || {};
            const payoutAmount = parseFloat(amount);

            if (!restaurantId) return res.status(400).json({ error: "restaurantId is required" });
            if (!driverOtp || driverOtp.toString().length !== 4) return res.status(400).json({ error: "Código PIN de 4 dígitos inválido" });
            if (!payoutAmount || payoutAmount <= 0) return res.status(400).json({ error: "Monto inválido" });

            // 1. Find driver by active OTP
            const { data: drivers, error: drvErr } = await supabase.from('employees')
                .select('*')
                .eq('hourly_rate', parseFloat(driverOtp))
                .eq('role', 'driver')
                .limit(1);

            const driver = drivers && drivers.length > 0 ? drivers[0] : null;

            if (drvErr || !driver) {
                return res.status(400).json({ error: "Código PIN incorrecto o expirado. Pide al motorista generar un nuevo código en su portal." });
            }

            // 2. Invalidate OTP immediately to prevent reuse
            await supabase.from('employees')
                .update({ hourly_rate: 0 })
                .eq('id', driver.id);

            // 3. Credit Restaurant Ledger (They gave cash out of register, so QuimiEats credits their balance)
            await supabase.from('quimieats_ledger').insert({
                restaurant_id: restaurantId,
                amount: payoutAmount, // Credits restaurant balance
                type: 'driver_payout_advance',
                status: 'settled',
                customer_id: driver.id,
                order_id: `Pago en efectivo a motorista ${driver.name} (Retiro Nocturno PIN ${driverOtp})`
            });

            return res.json({
                success: true,
                driverName: driver.name,
                amount: payoutAmount,
                message: `✅ ¡Retiro validado con éxito! Entrega L. ${payoutAmount.toFixed(2)} en efectivo a ${driver.name}. El monto fue acreditado a tu saldo QuimiEats.`
            });
        }

        if (action === 'customer_confirm_delivery' && req.method === 'POST') {
            const { id } = req.query;
            try {
                const { data, error } = await supabase.from('orders')
                    .update({ 
                        delivery_status: 'delivered',
                        status: 'completed'
                    })
                    .eq('id', id)
                    .select()
                    .single();

                if (error) throw error;
                return res.json({ success: true, order: data });
            } catch (e) {
                const { data: order } = await supabase.from('orders').select('*').eq('id', id).single();
                const cleanNotes = (order.notes || '').replace(/\[DRIVER:[^\]]+\]/g, '').trim();
                const updatedNotes = (cleanNotes + ` [DRIVER: status=delivered]`).trim();

                const { data: updated, error } = await supabase.from('orders')
                    .update({ 
                        status: 'completed',
                        notes: updatedNotes 
                    })
                    .eq('id', id)
                    .select()
                    .single();

                if (error) throw error;
                return res.json({ 
                    success: true, 
                    order: { 
                        ...updated, 
                        delivery_status: 'delivered' 
                    } 
                });
            }
        }

        return res.status(404).json({ error: `Action '${action}' not found`, debug: { url: req.url, action, id } });

    } catch (e) {
        console.error("Store API Error:", e);
        return res.status(500).json({ error: e.message });
    }
};

async function sendWhatsAppNotification(toPhone, text) {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    if (!accessToken || !phoneId) {
        console.warn("[Partner Notification] Missing WhatsApp environment variables. Mocking send:");
        console.log(`[Mock WhatsApp Send] To: ${toPhone}, Content: "${text}"`);
        return;
    }

    const fetch = require('node-fetch');
    const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;
    
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to: toPhone,
                type: "text",
                text: { body: text }
            })
        });

        if (!res.ok) {
            const errBody = await res.text();
            console.error("[Partner Notification] Failed to send WhatsApp message:", errBody);
        } else {
            console.log(`[Partner Notification] Credentials message sent successfully to ${toPhone}`);
        }
    } catch (e) {
        console.error("[Partner Notification] Error sending WhatsApp request:", e);
    }
}
