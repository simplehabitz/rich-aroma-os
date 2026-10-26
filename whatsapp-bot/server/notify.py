"""
Order-status notifications: OS -> bot -> customer.

When a WhatsApp-originated order transitions in the OS to 'ready'
or 'cancelled', store.js POSTs to this bot's /order-notify route
(the OS-side hook) carrying order id + new status + customer
phone, authenticated with the shared WHATSAPP_SIGNUP_SECRET as a
Bearer token — the same secret this bot uses to call the OS —
compared in constant time and fail-closed when unset.

The notification set is deliberately tight: the customer already
heard 'received' in-thread when they placed the order, so this
module sends only:
  ready     -> "tu pedido está listo 🎉"
  cancelled -> the cancellation + a straight path back to a human
               (reply in the same thread)
No 'preparing' ping. The order conversation opened the WhatsApp
24h service window, so these ride as free service messages — no
templates.

Idempotent: each (order, status) notifies at most once per
process; a duplicate transition POST is acknowledged without
re-sending. A failed send is NOT marked notified, so a repeated
POST can still deliver it.
"""

import hmac
import os
import re

_notified = {}  # order_key -> set of statuses already sent


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


def reset():
    _notified.clear()


def _label(payload: dict, order_key: str) -> str:
    return f"#{order_key}" if order_key.isdigit() else order_key


def message_for(payload: dict, status: str, order_key: str) -> str:
    label = _label(payload, order_key)
    lang = (payload.get("lang") or "es").lower()
    if status == "ready":
        if lang == "en":
            return (f"Your order is ready! 🎉\nOrder {label} — "
                    "you can pick it up at Rich Aroma now. "
                    "Thanks! ☕")
        return (f"¡Tu pedido está listo! 🎉\nPedido {label} — "
                "ya podés pasar a recogerlo a Rich Aroma. "
                "¡Gracias! ☕")
    reason = (payload.get("reason") or "").strip()
    if lang == "en":
        text = f"Your order {label} was cancelled 🙏"
        if reason:
            text += f"\nReason: {reason}"
        return (text + "\nIf that was a mistake or you'd like to "
                "order something else, just reply here and the "
                "team will help you.")
    text = f"Tu pedido {label} fue cancelado 🙏"
    if reason:
        text += f"\nMotivo: {reason}"
    return (text + "\nSi fue un error o querés pedir otra cosa, "
            "escribinos por acá y te ayudamos.")


def process(payload, auth_header: str, send_fn):
    """Validate + dedupe + send one status notification.

    send_fn(phone, text) performs the Meta send (injected by the
    webhook route; captured by tests). Returns (http_status, dict);
    raises nothing.
    """
    if not authorized(auth_header):
        return 403, {"ok": False, "error": "unauthorized"}
    if not isinstance(payload, dict):
        return 400, {"ok": False, "error": "bad payload"}
    status = (payload.get("status") or "").strip().lower()
    if status not in ("ready", "cancelled"):
        return 400, {"ok": False, "error": "unsupported status"}
    phone = re.sub(r"\D", "", str(payload.get("phone") or ""))
    if len(phone) < 8:
        return 400, {"ok": False, "error": "missing phone"}
    order_key = str(payload.get("order_number")
                    or payload.get("order_id") or "").strip()
    if not order_key:
        return 400, {"ok": False, "error": "missing order id"}
    sent = _notified.setdefault(order_key, set())
    if status in sent:
        return 200, {"ok": True, "deduped": True}
    try:
        send_fn(phone, message_for(payload, status, order_key))
    except Exception as e:
        return 502, {"ok": False, "error": f"send failed: {e}"}
    sent.add(status)
    return 200, {"ok": True, "sent": True}
