"""
Loyalty notifications: OS -> bot -> customer (loyalty build, 2026-10-30).

The OS (api/lib/rico-loyalty.js) SIGNALS; this bot delivers. Two kinds:

  grant       -> a gift lot was minted ("Regalo de la casa"): the 10%
                 earn, a recarga-ladder bonus, a campaign drop, a
                 mission reward, or a staff "Dar regalo". The wording
                 varies by source; every variant names the amount and
                 the expiry date — a gift the customer never hears
                 about does not bring them back.
  expire_warn -> the ~3-day expiry heads-up, in the owner's reworded
                 shape (2026-10-27): the warning carries a PERSONAL
                 suggestion — the house-made item from the customer's
                 most recent order. One warning per lot; the OS marks
                 the lot warned in its ledger, which is the durable
                 dedupe — this module only guards against POST retries.

Authenticated with the shared WHATSAPP_SIGNUP_SECRET as a Bearer token,
constant-time, fail-closed — identical to notify.py. Sends ride the
open 24h service window when there is one (the grant usually follows
a purchase conversation minutes earlier); outside a window Meta may
reject the send, which surfaces here as a 502 and is logged by the OS
— nothing is silently dropped.
"""

import hmac
import os
import re
import time

_sent_warns = set()   # (phone, expires_at) already warned by this process
_recent_grants = {}   # dedupe key -> epoch seconds (retry guard, 10 min)


def _secret() -> str:
    return os.environ.get("WHATSAPP_SIGNUP_SECRET", "").strip()


def authorized(auth_header: str) -> bool:
    """Constant-time Bearer check. Fail-closed: no secret configured
    on the bot -> nobody is authorized."""
    secret = _secret()
    if not secret:
        return False
    token = ""
    if auth_header and auth_header.lower().startswith("bearer "):
        token = auth_header[7:].strip()
    return bool(token) and hmac.compare_digest(token, secret)


def reset():
    _sent_warns.clear()
    _recent_grants.clear()


def _money(amount) -> str:
    try:
        v = float(amount)
    except (TypeError, ValueError):
        return "L.0"
    return f"L.{v:,.0f}" if v == int(v) else f"L.{v:,.2f}"


def _date_label(iso: str) -> str:
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", str(iso or ""))
    if not m:
        return ""
    return f"{m.group(3)}/{m.group(2)}/{m.group(1)}"


def message_for(payload: dict) -> str:
    kind = (payload.get("kind") or "").strip().lower()
    amount = _money(payload.get("amount"))
    vence = _date_label(payload.get("expires_at"))
    vence_txt = f" Vence el {vence}." if vence else ""
    if kind == "expire_warn":
        days = payload.get("days_left")
        try:
            days = int(days)
        except (TypeError, ValueError):
            days = None
        if days is not None and days <= 1:
            head = f"🎁 Te quedan {amount} de regalo de la casa y vencen mañana."
        elif days:
            head = f"🎁 Te quedan {amount} de regalo de la casa y vencen en {days} días."
        else:
            head = f"🎁 Te quedan {amount} de regalo de la casa por vencer."
        item = (payload.get("item_name") or "").strip()
        if item:
            return (head + f" ¿Te guardamos tu {item} de siempre? "
                    "Pedilo por aquí y pagás con tu regalo ☕")
        return head + " Pedilo por aquí y pagás con tu regalo ☕"
    if kind == "streak":
        n = payload.get("streak_weeks") or 1
        pct = payload.get("streak_pct") or 2
        return (f"🔥 ¡Racha del Capitán! Ya llevás {n} semana(s) "
                f"seguida(s) pidiendo 🎉 En tu próxima compra tenés "
                f"{pct}% en lo hecho en casa.")
    source = (payload.get("source") or "").strip().lower()
    streak_line = ""
    if payload.get("streak_weeks"):
        streak_line = (f"\n🔥 ¡Racha del Capitán! Semana "
                       f"{payload.get('streak_weeks')} — en tu próxima "
                       f"compra tenés {payload.get('streak_pct') or 2}% "
                       "en lo hecho en casa.")
    if source == "earn_10pct":
        return (f"🎁 ¡Tenés un regalo de la casa! Por tu compra te "
                f"acreditamos {amount} en tu Rico Cash.{vence_txt} "
                "Usalo en lo hecho en casa ☕" + streak_line)
    if source == "recarga_bonus":
        return (f"🎁 ¡Bono por tu recarga! Te acreditamos {amount} de "
                f"regalo de la casa en tu Rico Cash.{vence_txt} ☕")
    if source == "mission":
        return (f"🎁 ¡Misión cumplida! Te acreditamos {amount} de "
                f"regalo de la casa en tu Rico Cash.{vence_txt} ☕")
    if source == "manual":
        return (f"🎁 ¡La casa te regala {amount} en Rico Cash! "
                f"Ya está en tu cuenta.{vence_txt} ☕")
    return (f"🎁 ¡Regalo de la casa! Te acreditamos {amount} en tu "
            f"Rico Cash.{vence_txt} Válido en lo hecho en casa ☕")


def process(payload, auth_header: str, send_fn):
    """Validate + dedupe + send one loyalty notification.

    send_fn(phone, text) performs the Meta send (injected by the
    webhook route; captured by tests). Returns (http_status, dict);
    raises nothing.
    """
    if not authorized(auth_header):
        return 403, {"ok": False, "error": "unauthorized"}
    if not isinstance(payload, dict):
        return 400, {"ok": False, "error": "bad payload"}
    kind = (payload.get("kind") or "").strip().lower()
    if kind not in ("grant", "expire_warn", "streak"):
        return 400, {"ok": False, "error": "unsupported kind"}
    if kind == "streak":
        phone = re.sub(r"\D", "", str(payload.get("phone") or ""))
        if len(phone) < 8:
            return 400, {"ok": False, "error": "missing phone"}
        try:
            send_fn(phone, message_for(payload))
        except Exception as e:
            return 502, {"ok": False, "error": f"send failed: {e}"}
        return 200, {"ok": True, "sent": True}
    phone = re.sub(r"\D", "", str(payload.get("phone") or ""))
    if len(phone) < 8:
        return 400, {"ok": False, "error": "missing phone"}
    if kind == "expire_warn":
        key = (phone, str(payload.get("expires_at") or ""))
        if key in _sent_warns:
            return 200, {"ok": True, "deduped": True}
        try:
            send_fn(phone, message_for(payload))
        except Exception as e:
            return 502, {"ok": False, "error": f"send failed: {e}"}
        _sent_warns.add(key)
        return 200, {"ok": True, "sent": True}
    # grant: dedupe only against an identical POST retried within
    # 10 minutes — two genuine grants of the same amount on the same
    # day must both reach the customer.
    gkey = "|".join([phone, str(payload.get("source") or ""),
                     str(payload.get("amount") or ""),
                     str(payload.get("expires_at") or "")])
    now = time.time()
    if now - _recent_grants.get(gkey, 0) < 600:
        return 200, {"ok": True, "deduped": True}
    try:
        send_fn(phone, message_for(payload))
    except Exception as e:
        return 502, {"ok": False, "error": f"send failed: {e}"}
    _recent_grants[gkey] = now
    return 200, {"ok": True, "sent": True}
