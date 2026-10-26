"""
Account access links: OS -> bot -> customer (Mi Rich Aroma).

Identity law (owner-settled): the phone number IS the account; no
customer passwords or PINs exist anywhere. api/account.js mints a
single-use login token (15-minute expiry, hash-only storage) and
POSTs {phone, url} to this bot's /account-link route, authenticated
with the shared WHATSAPP_SIGNUP_SECRET as a Bearer token — the same
secret pattern as /order-notify (see notify.py) — compared in
constant time and fail-closed when unset.

The bot's one job here is delivery: text the link to the number ON
FILE (api/account.js resolved it from the customer record — that
delivery is the proof of possession). The message is sent inside
the customer's existing conversation whenever they have one; the
token's 15-minute life does not depend on the 24h window — if Meta
rejects a send outside a window, the failure surfaces to the OS as
a 502 and is logged there ([Account] line) instead of vanishing.
"""

import hmac
import os
import re


def _secret() -> str:
    return os.environ.get("WHATSAPP_SIGNUP_SECRET", "").strip()


def authorized(auth_header: str) -> bool:
    """Constant-time Bearer check. Fail-closed: no secret
    configured on the bot -> nobody is authorized."""
    secret = _secret()
    if not secret:
        return False
    token = ""
    if auth_header and auth_header.lower().startswith("bearer "):
        token = auth_header[7:].strip()
    return bool(token) and hmac.compare_digest(token, secret)


def message_for(url: str, lang: str = "es") -> str:
    if (lang or "es").lower() == "en":
        return (f"Your *Rich Aroma* account 👉 {url}\n"
                "The link expires in 15 minutes. Your account is "
                "your number — no passwords 🔐")
    return (f"Tu cuenta *Rich Aroma* 👉 {url}\n"
            "El link vence en 15 minutos. Tu cuenta es tu "
            "número — sin contraseñas 🔐")


def process(payload, auth_header: str, send_fn):
    """Validate + send one account link.

    send_fn(phone, text) performs the Meta send (injected by the
    webhook route; captured by tests). Returns (http_status, dict);
    raises nothing.
    """
    if not authorized(auth_header):
        return 403, {"ok": False, "error": "unauthorized"}
    if not isinstance(payload, dict):
        return 400, {"ok": False, "error": "bad payload"}
    phone = re.sub(r"\D", "", str(payload.get("phone") or ""))
    if len(phone) < 8:
        return 400, {"ok": False, "error": "missing phone"}
    url = str(payload.get("url") or "").strip()
    if not url.startswith("https://"):
        return 400, {"ok": False, "error": "missing url"}
    try:
        send_fn(phone, message_for(url, payload.get("lang") or "es"))
    except Exception as e:
        return 502, {"ok": False, "error": f"send failed: {e}"}
    return 200, {"ok": True, "sent": True}
