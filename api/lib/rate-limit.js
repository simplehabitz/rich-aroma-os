// api/lib/rate-limit.js
// SEC-FIX 4 (2026-10-24): PIN-attempt throttle for the verify endpoints
// (audit F12). In-memory, therefore per-instance — Vercel may run
// several warm instances, so this is not a global counter. It removes
// the "unlimited, silent guessing" property inside every instance,
// which is the launch gate; a durable cross-instance limiter (shared
// table or Upstash) is the documented follow-up.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS_PER_PAIR = 8;  // same source IP + same PIN
const MAX_FAILS_PER_IP = 30;   // any PINs from one source IP

const pairFails = new Map(); // `${ip}|${pin}` -> { count, firstAt }
const ipFails = new Map();   // ip -> { count, firstAt }

function clientIp(req) {
    const xf = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
    return xf || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function fresh(map, key, now) {
    const e = map.get(key);
    if (!e) return null;
    if (now - e.firstAt > WINDOW_MS) { map.delete(key); return null; }
    return e;
}

// True = this source is throttled right now; the endpoint should 429.
function pinThrottleCheck(req, pin) {
    const now = Date.now();
    const ip = clientIp(req);
    const pair = fresh(pairFails, ip + '|' + String(pin || ''), now);
    if (pair && pair.count >= MAX_FAILS_PER_PAIR) return true;
    const ipEntry = fresh(ipFails, ip, now);
    if (ipEntry && ipEntry.count >= MAX_FAILS_PER_IP) return true;
    return false;
}

function pinThrottleFail(req, pin) {
    const now = Date.now();
    const ip = clientIp(req);
    const targets = [[pairFails, ip + '|' + String(pin || '')], [ipFails, ip]];
    for (const [map, key] of targets) {
        const e = fresh(map, key, now) || { count: 0, firstAt: now };
        e.count += 1;
        map.set(key, e);
    }
}

function pinThrottleSuccess(req, pin) {
    pairFails.delete(clientIp(req) + '|' + String(pin || ''));
}

module.exports = { pinThrottleCheck, pinThrottleFail, pinThrottleSuccess };
