// ---------------------------------------------------------------------------
// clock-utils.js — pure helpers for the POS clock-in build + the
// end-of-shift owner report (2026-10-30, Oct 30–Nov 2 window, piece 5).
//
// Everything here is a pure function (no I/O, no supabase, no env) so the
// harness can exercise the REAL math the API ships:
//   - America/Tegucigalpa wall-clock reading of an instant (fixed UTC-6,
//     no DST — same convention the Owner's Door snapshot already uses)
//   - late minutes vs the shop's day-start ("07:00" default, overridable
//     in restaurants.settings.clock_day_start)
//   - device-token hashing (the OS stores only the SHA-256 of the token
//     the device holds)
//   - the /owner-report URL derivation from BOT_NOTIFY_URL (mirrors how
//     api/account.js derives /account-link from the same env var)
//   - assembly of the ONE shift-report payload the close-shift action
//     POSTs to the bot
// ---------------------------------------------------------------------------

const crypto = require('crypto');

const TGU_OFFSET_MS = 6 * 3600 * 1000; // America/Tegucigalpa = UTC-6, no DST

/** TGU wall-clock parts for an instant (Date, ms epoch, or ISO string). */
function tguParts(when) {
    const ms = when instanceof Date ? when.getTime()
        : (typeof when === 'number' ? when : Date.parse(when));
    const t = new Date(ms - TGU_OFFSET_MS);
    const hh = t.getUTCHours();
    const mm = t.getUTCMinutes();
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return {
        hh, mm,
        minutes: hh * 60 + mm,
        label: `${h12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`,
        date: `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`,
    };
}

/** Day-start minutes from a settings value like "07:00" (default 07:00). */
function dayStartMinutes(raw, fallback = 7 * 60) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(raw || '').trim());
    if (!m) return fallback;
    const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (hh > 23 || mm > 59) return fallback;
    return hh * 60 + mm;
}

/** Minutes late for a clock-in instant: 0 when at/before the day start. */
function lateMinutes(clockedInAt, settings) {
    const start = dayStartMinutes(settings && settings.clock_day_start);
    return Math.max(0, tguParts(clockedInAt).minutes - start);
}

/** SHA-256 hex of a device token (what staff_devices.token_hash holds). */
function hashDeviceToken(token) {
    return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

/**
 * The bot's /owner-report URL, derived from BOT_NOTIFY_URL exactly the
 * way api/account.js derives /account-link: BOT_NOTIFY_URL is the bot's
 * /order-notify URL; swap the trailing path. Returns '' when the env
 * var is unset or not the expected shape (callers treat '' as "not
 * configured" and log loudly — the silent-gate rule).
 */
function ownerReportUrl() {
    const notify = (process.env.BOT_NOTIFY_URL || '').trim();
    if (!notify) return '';
    if (/\/order-notify\/?$/.test(notify)) {
        return notify.replace(/\/order-notify\/?$/, '/owner-report');
    }
    return '';
}

/**
 * Assemble the ONE end-of-shift report payload. Pure assembly — the
 * caller (close-shift) gathers the numbers; this shapes them. The bot
 * (whatsapp-bot/server/owner_report.py) formats the WhatsApp text from
 * exactly these fields, so keep the two in sync.
 */
function buildShiftReportPayload(input) {
    const sales = input.sales || { cash: 0, card: 0, transfer: 0, rico: 0 };
    const total = (parseFloat(sales.cash) || 0) + (parseFloat(sales.card) || 0)
        + (parseFloat(sales.transfer) || 0) + (parseFloat(sales.rico) || 0);
    return {
        kind: 'shift_report',
        shift_id: input.shiftId,
        opened_at: input.openedAt || null,
        closed_at: input.closedAt || null,
        sales: {
            cash: Math.round((parseFloat(sales.cash) || 0) * 100) / 100,
            card: Math.round((parseFloat(sales.card) || 0) * 100) / 100,
            transfer: Math.round((parseFloat(sales.transfer) || 0) * 100) / 100,
            rico: Math.round((parseFloat(sales.rico) || 0) * 100) / 100,
            total: Math.round(total * 100) / 100,
        },
        orders: parseInt(input.orders) || 0,
        opening_amount: parseFloat(input.openingAmount) || 0,
        expected_amount: parseFloat(input.expectedAmount) || 0,
        declared_cash: parseFloat(input.declaredCash) || 0,
        discrepancy: parseFloat(input.discrepancy) || 0,
        top_items: Array.isArray(input.topItems) ? input.topItems.slice(0, 5) : [],
        low_stock: Array.isArray(input.lowStock) ? input.lowStock.slice(0, 15) : [],
        rico_outstanding: Math.round((parseFloat(input.ricoOutstanding) || 0) * 100) / 100,
        staff: Array.isArray(input.staff) ? input.staff : [],
        lang: 'es',
    };
}

module.exports = {
    tguParts,
    dayStartMinutes,
    lateMinutes,
    hashDeviceToken,
    ownerReportUrl,
    buildShiftReportPayload,
};
