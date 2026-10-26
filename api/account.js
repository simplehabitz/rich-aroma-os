// api/account.js — Mi Rich Aroma: customer account access (2026-10-26).
//
// IDENTITY LAW (owner-settled, do not redesign): the phone number IS
// the account. There are no customer passwords or PINs anywhere, ever.
// Access arrives BY WHATSAPP: the customer asks for a link on
// public/cuenta.html, this function mints a single-use token
// (15 minutes, only its SHA-256 hash is stored), and POSTs the link
// to the bot's /account-link route — the bot texts it to the number
// on file, which is the proof of possession. Redeeming the token
// mints a 30-day session (also stored hashed). Every read is scoped
// to the SESSION's customer_id — no action accepts a customer id
// from the client, so there is nothing to tamper with.
//
// Actions (POST, ?action=):
//   request_link {phone}  PUBLIC. ALWAYS answers the identical
//                         {ok:true} — whether the number is a
//                         customer, a stranger, or throttled — so
//                         the endpoint can never be used to enumerate
//                         the customer list. A token is minted and
//                         sent ONLY when the customer exists.
//   redeem {token}        PUBLIC. Expired / used / unknown tokens
//                         are rejected with the identical response.
//   me {session}          The session's own snapshot: profile,
//                         rico_balance, preorders, recent orders.
//   logout {session}      Deletes the session row. Idempotent.
//   flight_claim {name, phone}
//                         PUBLIC (Build B2, 2026-10-26). The Flight,
//                         claimed on the WEBSITE. This action is a
//                         pure relay: it POSTs the web shape
//                         {phone, name, packs_5:1, source:'web'} to
//                         the OS's whatsapp_preventa action (Build
//                         A's contract — the SAME cap/hold/waitlist
//                         ledger the WhatsApp fast lane uses) with
//                         the shared secret, and relays the verdict
//                         verbatim. It NEVER computes a hold, a
//                         remaining count, or a waitlist position
//                         itself; if the OS is unreachable or answers
//                         non-OK, the claim fails honestly ({ok:false})
//                         instead of inventing a hold. On a held
//                         claim it also fetches whatsapp_bank_details
//                         and attaches the transfer details ONLY when
//                         the OS says they are not placeholders (the
//                         one definition of "placeholder" lives
//                         OS-side); otherwise bank_details is null
//                         and the page shows its fallback line.
//
// Fail-closed everywhere (the notify-fix lesson): a missing env var
// or a dead bot endpoint logs a loud [Account] line in the function
// logs instead of failing silently — but NEVER changes the public
// answer of request_link.
//
// This is the 12th Vercel function (Hobby plan cap: 12). Do not add
// another api/*.js without removing one.

const crypto = require('crypto');
const { supabase } = require('./lib/supabase');

// ---------------------------------------------------------------------------
// Small helpers (mirroring api/store.js's whatsapp_* patterns)
// ---------------------------------------------------------------------------

// Phone normalization shared with store.js's whatsapp_* actions:
// digits only, 8-digit local numbers gain the 504 country code.
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

function sha256Hex(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function newToken() {
    // 256 bits of entropy (>= the 128-bit floor), URL-safe.
    return crypto.randomBytes(32).toString('base64url');
}

const LINK_TTL_MS = 15 * 60 * 1000;          // magic link: 15 minutes
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // session: 30 days
const ACCOUNT_PAGE = 'https://www.richaromacoffee.com/cuenta';

// The bot's /account-link URL derives from BOT_NOTIFY_URL (the
// /order-notify URL the owner already configured) — one env var,
// two routes on the same bot. Returns '' when unset or mis-shaped.
function botAccountLinkUrl() {
    const notify = (process.env.BOT_NOTIFY_URL || '').trim();
    if (!notify) return '';
    if (/\/order-notify\/?$/.test(notify)) {
        return notify.replace(/\/order-notify\/?$/, '/account-link');
    }
    return '';
}

// ---------------------------------------------------------------------------
// OS relay (Build B2) — server-to-server calls to api/store.js's
// whatsapp_* actions, authenticated with the shared secret exactly
// the way the bot's os_client does it (Authorization: <secret>;
// store.js's botSecretOk/bearerCred accepts the raw secret and also
// strips an optional "Bearer " prefix). Returns the parsed JSON body
// on an OK response, null on ANY failure (non-OK, unreachable,
// unparseable) — callers must treat null as "no verdict", never as
// a success.
// ---------------------------------------------------------------------------
const STORE_API_URL = 'https://www.richaromacoffee.com/api/store';

async function osStorePost(action, body, secret) {
    const resp = await fetch(`${STORE_API_URL}?action=${encodeURIComponent(action)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': secret },
        body: JSON.stringify(body || {})
    });
    if (!resp || !resp.ok) return null;
    const j = await resp.json().catch(() => null);
    return (j && typeof j === 'object') ? j : null;
}

// ---------------------------------------------------------------------------
// In-memory rate limiter (api/lib/rate-limit.js style: per-instance
// Maps with a sliding first-hit window; Vercel may run several warm
// instances, so this removes unlimited guessing per instance — the
// same accepted launch posture as SEC-FIX 4).
// ---------------------------------------------------------------------------
const rlBuckets = new Map(); // key -> { count, firstAt }

function rateLimited(key, max, windowMs) {
    const now = Date.now();
    const e = rlBuckets.get(key);
    if (!e || now - e.firstAt > windowMs) {
        rlBuckets.set(key, { count: 1, firstAt: now });
        return false;
    }
    e.count += 1;
    return e.count > max;
}

function clientIp(req) {
    const xf = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
    return xf || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ---------------------------------------------------------------------------
// Snapshot — built ONLY from a server-side customer_id.
// ---------------------------------------------------------------------------
async function customerSnapshot(customerId) {
    const { data: cust } = await supabase.from('customers')
        .select('id, name, phone, birthday_dm, rico_balance')
        .eq('id', customerId).maybeSingle();
    if (!cust) return null;

    const [{ data: preorders }, { data: orders }] = await Promise.all([
        supabase.from('whatsapp_preorders').select('*')
            .eq('customer_id', customerId)
            .order('created_at', { ascending: false }).limit(5),
        supabase.from('orders').select('*')
            .eq('customer_id', customerId)
            .order('created_at', { ascending: false }).limit(10)
    ]);

    return {
        profile: {
            name: cust.name || '',
            first_name: (cust.name || '').trim().split(/\s+/)[0] || '',
            birthday_dm: cust.birthday_dm || null
        },
        // ONE balance — the existing customers.rico_balance column.
        // The two-bucket split (bonus lots) is NOT built yet; this
        // page must not invent it.
        rico_balance: parseFloat(cust.rico_balance) || 0,
        preorders: (preorders || []).map(p => ({
            id: p.id,
            packs_5: p.packs_5 || 0,
            bottles: p.bottles || 0,
            boxes_20: p.boxes_20 || 0,
            quoted_total: parseFloat(p.quoted_total) || 0,
            status: p.status,
            hold_expires_at: p.hold_expires_at || null,
            created_at: p.created_at
        })),
        orders: (orders || []).map(o => ({
            id: o.id,
            order_number: o.order_number,
            status: o.status,
            total: parseFloat(o.total) || 0,
            requested_for_label: o.requested_for_label || null,
            created_at: o.created_at
        }))
    };
}

async function sessionCustomerId(sessionRaw) {
    const session = String(sessionRaw || '').trim();
    if (!session) return null;
    const { data } = await supabase.from('account_sessions')
        .select('customer_id, expires_at')
        .eq('session_hash', sha256Hex(session)).maybeSingle();
    if (!data) return null;
    if (new Date(data.expires_at).getTime() <= Date.now()) return null;
    return data.customer_id;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function actionRequestLink(req, res) {
    // The public answer NEVER varies: {ok:true} for customers,
    // strangers, throttled callers and broken internals alike.
    try {
        const phone = normalizePhone(req.body?.phone);
        const ip = clientIp(req);
        if (!phone) return res.json({ ok: true });
        if (rateLimited(`link:ip:${ip}`, 20, 10 * 60 * 1000)) return res.json({ ok: true });
        if (rateLimited(`link:phone:${phone}`, 5, 60 * 60 * 1000)) return res.json({ ok: true });

        const cust = await findCustomerByPhone(phone);
        if (!cust) return res.json({ ok: true });

        const secret = (process.env.WHATSAPP_SIGNUP_SECRET || '').trim();
        const botUrl = botAccountLinkUrl();
        if (!secret || !botUrl) {
            console.error(`[Account] LINK NOT SENT for customer ${cust.id}: ${!botUrl ? 'BOT_NOTIFY_URL unset or not an /order-notify URL' : 'WHATSAPP_SIGNUP_SECRET not configured'} in this deployment's env`);
            return res.json({ ok: true });
        }

        // One live link per customer: prior unused tokens die here.
        await supabase.from('account_login_tokens')
            .update({ used_at: new Date().toISOString() })
            .eq('customer_id', cust.id).is('used_at', null);

        const token = newToken();
        const { error } = await supabase.from('account_login_tokens').insert({
            token_hash: sha256Hex(token),
            customer_id: cust.id,
            expires_at: new Date(Date.now() + LINK_TTL_MS).toISOString()
        });
        if (error) {
            console.error(`[Account] LINK NOT MINTED for customer ${cust.id}: token insert failed: ${error.message}`);
            return res.json({ ok: true });
        }

        const url = `${ACCOUNT_PAGE}?t=${encodeURIComponent(token)}`;
        const resp = await fetch(botUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + secret },
            body: JSON.stringify({
                phone: cust.phone,
                url,
                ...(req.body?.lang === 'en' ? { lang: 'en' } : {})
            })
        });
        if (!resp || !resp.ok) {
            console.error(`[Account] bot /account-link answered HTTP ${resp ? resp.status : 'no-response'} for customer ${cust.id} (link minted but not delivered)`);
        }
    } catch (e) {
        console.error('[Account] request_link failed (public answer unchanged):', e && e.message);
    }
    return res.json({ ok: true });
}

async function actionRedeem(req, res) {
    const reject = () => res.status(400).json({
        ok: false,
        error: 'Este link ya no sirve. Pedí uno nuevo y te lo mandamos por WhatsApp.'
    });
    const ip = clientIp(req);
    if (rateLimited(`redeem:ip:${ip}`, 30, 10 * 60 * 1000)) {
        return res.status(429).json({ ok: false, error: 'Demasiados intentos. Esperá unos minutos y pedí un link nuevo.' });
    }
    const token = String(req.body?.token || '').trim();
    if (!token) return reject();
    const { data: row } = await supabase.from('account_login_tokens')
        .select('customer_id, expires_at, used_at')
        .eq('token_hash', sha256Hex(token)).maybeSingle();
    if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) return reject();

    // Single-use: burn the token as part of the redemption, guarded
    // on it still being unused so a raced second redeem loses.
    const { data: burned } = await supabase.from('account_login_tokens')
        .update({ used_at: new Date().toISOString() })
        .eq('token_hash', sha256Hex(token)).is('used_at', null)
        .select('customer_id');
    if (!burned || burned.length === 0) return reject();

    const session = newToken();
    const { error } = await supabase.from('account_sessions').insert({
        session_hash: sha256Hex(session),
        customer_id: row.customer_id,
        expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString()
    });
    if (error) {
        console.error(`[Account] session insert failed for customer ${row.customer_id}: ${error.message}`);
        return res.status(500).json({ ok: false, error: 'Error interno. Probá de nuevo en un momento.' });
    }
    const snapshot = await customerSnapshot(row.customer_id);
    if (!snapshot) return reject();
    return res.json({ ok: true, session, customer: snapshot });
}

async function actionMe(req, res) {
    const bearer = String(req.headers?.authorization || '');
    const session = String(req.body?.session || '').trim()
        || (bearer.toLowerCase().startsWith('bearer ') ? bearer.slice(7).trim() : '');
    const customerId = await sessionCustomerId(session);
    if (!customerId) return res.status(401).json({ ok: false, error: 'sesion_invalida' });
    const snapshot = await customerSnapshot(customerId);
    if (!snapshot) return res.status(401).json({ ok: false, error: 'sesion_invalida' });
    return res.json({ ok: true, customer: snapshot });
}

async function actionLogout(req, res) {
    const session = String(req.body?.session || '').trim();
    if (session) {
        await supabase.from('account_sessions')
            .delete().eq('session_hash', sha256Hex(session));
    }
    return res.json({ ok: true });
}

// ---------------------------------------------------------------------------
// flight_claim {name, phone} — the Flight, claimed on the website.
// Pure relay to the OS's whatsapp_preventa (web shape) so the web
// and WhatsApp lanes share ONE cap/hold/waitlist ledger. Nothing
// about the hold is computed here: status, remaining_bottles,
// hold_expires_at and waitlist_position are relayed verbatim, and
// any OS failure is an honest {ok:false} — never a fabricated hold.
// ---------------------------------------------------------------------------
async function actionFlightClaim(req, res) {
    const name = String(req.body?.name || '').trim();
    const phone = normalizePhone(req.body?.phone);
    // A claimable number must normalize to a full phone: every
    // Honduran number becomes 504 + 8 digits (11) via normalizePhone;
    // anything shorter cannot reach the customer on WhatsApp.
    if (!name || !phone || phone.length < 11) {
        return res.status(400).json({ ok: false, error: 'Escribí tu nombre y un número de WhatsApp válido.' });
    }
    const ip = clientIp(req);
    if (rateLimited(`claim:ip:${ip}`, 20, 10 * 60 * 1000)
        || rateLimited(`claim:phone:${phone}`, 5, 60 * 60 * 1000)) {
        return res.status(429).json({ ok: false, error: 'Demasiados intentos. Esperá unos minutos y probá de nuevo.' });
    }

    const secret = (process.env.WHATSAPP_SIGNUP_SECRET || '').trim();
    if (!secret) {
        console.error('[Account] flight_claim cannot run: WHATSAPP_SIGNUP_SECRET not configured in this deployment\'s env');
        return res.status(502).json({ ok: false, error: 'No pudimos apartar tu Flight ahorita 😅 Probá de nuevo en un momento, o apartalo por WhatsApp.' });
    }

    let verdict = null;
    try {
        verdict = await osStorePost('whatsapp_preventa', {
            phone, name, packs_5: 1, source: 'web'
        }, secret);
    } catch (e) {
        console.error('[Account] flight_claim: whatsapp_preventa unreachable:', e && e.message);
        verdict = null;
    }
    if (!verdict || verdict.ok !== true
        || (verdict.status !== 'intent' && verdict.status !== 'waitlist')) {
        console.error(`[Account] flight_claim: OS gave no usable verdict for phone ${phone}: ${verdict ? JSON.stringify(verdict).slice(0, 200) : 'null (non-OK / unreachable / unparseable)'}`);
        return res.status(502).json({ ok: false, error: 'No pudimos apartar tu Flight ahorita 😅 Probá de nuevo en un momento, o apartalo por WhatsApp.' });
    }

    const out = {
        ok: true,
        status: verdict.status,
        remaining_bottles: verdict.remaining_bottles != null ? verdict.remaining_bottles : null,
        hold_expires_at: verdict.hold_expires_at || null,
        customer_id: verdict.customer_id || null,
        preorder_id: verdict.preorder_id || null,
        bank_details: null
    };
    if (verdict.status === 'waitlist') {
        // Relayed verbatim; present ONLY because the OS sent it.
        if (verdict.waitlist_position != null) out.waitlist_position = verdict.waitlist_position;
        return res.json(out);
    }

    // Held. Fetch the transfer details; attach them ONLY when the OS
    // flags them as real (placeholder === false). Any doubt — call
    // failed, flagged, fields missing — means null, and the page
    // shows its "te pasamos los datos por WhatsApp" fallback. The
    // hold itself is already real either way.
    try {
        const bd = await osStorePost('whatsapp_bank_details', {}, secret);
        if (bd && bd.ok === true && bd.placeholder === false
            && bd.bank_details && bd.bank_details.name && bd.bank_details.account && bd.bank_details.owner) {
            out.bank_details = {
                name: bd.bank_details.name,
                account: bd.bank_details.account,
                owner: bd.bank_details.owner
            };
        } else {
            console.error(`[Account] flight_claim: bank details withheld for preorder ${out.preorder_id} (placeholder or unusable response from whatsapp_bank_details)`);
        }
    } catch (e) {
        console.error('[Account] flight_claim: whatsapp_bank_details unreachable (details withheld, hold stands):', e && e.message);
    }
    return res.json(out);
}

// ---------------------------------------------------------------------------
// Handler (api/store.js shape: ?action= routing, permissive CORS)
// ---------------------------------------------------------------------------
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const action = req.query?.action;
    try {
        if (action === 'request_link' && req.method === 'POST') return await actionRequestLink(req, res);
        if (action === 'redeem' && req.method === 'POST') return await actionRedeem(req, res);
        if (action === 'me' && (req.method === 'POST' || req.method === 'GET')) return await actionMe(req, res);
        if (action === 'logout' && req.method === 'POST') return await actionLogout(req, res);
        if (action === 'flight_claim' && req.method === 'POST') return await actionFlightClaim(req, res);
        return res.status(404).json({ ok: false, error: 'Acción no encontrada' });
    } catch (e) {
        console.error('[Account] handler error:', e && e.message);
        return res.status(500).json({ ok: false, error: 'Error interno' });
    }
};
