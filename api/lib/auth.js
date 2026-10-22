// api/lib/auth.js
// Central credential checks. Env-based and FAIL-CLOSED: if the env vars
// are not set, nothing is accepted. Set in Vercel env before deploy:
//   MASTER_PINS=pin1,pin2        (NEW master PINs -- never the old ones)
//   ADMIN_API_TOKEN=token        (server-to-server admin token)
function masterPins() {
    return (process.env.MASTER_PINS || '').split(',').map(s => s.trim()).filter(Boolean);
}
function isMasterPin(pin) {
    if (pin === undefined || pin === null) return false;
    const pins = masterPins();
    return pins.length > 0 && pins.includes(String(pin).trim());
}
function adminTokens() {
    return (process.env.ADMIN_API_TOKEN || '').split(',').map(s => s.trim()).filter(Boolean);
}
function isAdminToken(token) {
    if (!token) return false;
    const tokens = adminTokens();
    return tokens.length > 0 && tokens.includes(String(token).trim());
}
function isAdminCredential(value) {
    if (!value) return false;
    const v = String(value).replace(/^Bearer\s+/i, '').trim();
    return isMasterPin(v) || isAdminToken(v);
}
module.exports = { masterPins, isMasterPin, adminTokens, isAdminToken, isAdminCredential };
