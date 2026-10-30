"""
End-of-shift owner report: OS -> bot -> owner's WhatsApp.

When the cashier closes a shift in the POS, api/store.js computes
the shift's totals itself and POSTs ONE payload to this bot's
/owner-report route, authenticated with the shared
WHATSAPP_SIGNUP_SECRET (Bearer, constant-time, fail-closed — the
same gate as server/notify.py). This module formats the report and
sends it to EVERY number on the OWNER_WHATSAPP list
(server/owner_door.py owns that list).

24-HOUR WINDOW RULE — defined, never silent:
    The report is a free-form service message, which Meta only
    delivers inside an open 24h conversation window with the
    recipient. Close-shift usually follows a day of owner messages,
    but that is NOT guaranteed. So when a send fails (Meta window
    error included), the report is QUEUED here per owner number —
    and the OS independently records the miss in owner_reports, so
    the next on-demand snapshot header names it. Queued reports
    flush the moment that owner writes to the shop again: their
    inbound message reopens the window, and webhook.py calls
    flush_pending_for() BEFORE answering them, so the close report
    arrives first, then their answer. A template fallback would
    need a Meta-approved utility template; until the owner approves
    one, queue + surface is the behavior — a report is never
    silently dropped.

Idempotent per process: one (shift) report delivers at most once
per owner number; a duplicate POST is acknowledged without
re-sending. A failed send is NOT marked delivered, so the queue
(and a repeated POST) can still deliver it.
"""

import re

try:
    import notify
    import owner_door
except ImportError:  # pragma: no cover - package import on the host
    from server import notify
    from server import owner_door

_sent = set()    # (shift_id, phone) already delivered
_pending = {}    # phone -> list of payloads awaiting a window


def _money(v) -> str:
    v = float(v or 0)
    if abs(v - round(v)) < 0.005:
        return f"L.{int(round(v)):,}"
    return f"L.{v:,.2f}"


def _hm(iso_label: str) -> str:
    return (iso_label or "").strip()


def format_report(payload: dict) -> str:
    """The ONE WhatsApp message for a close. Spanish — the shop's
    owner surface is Spanish-first; payload fields are shaped by
    api/lib/clock-utils.js buildShiftReportPayload (keep in sync)."""
    s = payload.get("sales") or {}
    parts = []
    if float(s.get("cash") or 0):
        parts.append("efectivo " + _money(s["cash"]))
    if float(s.get("card") or 0):
        parts.append("tarjeta " + _money(s["card"]))
    if float(s.get("transfer") or 0):
        parts.append("transferencia " + _money(s["transfer"]))
    if float(s.get("rico") or 0):
        parts.append("Rico " + _money(s["rico"]))
    lines = ["🧑‍✈️ Rich Aroma — cierre de turno",
             f"💰 Ventas del turno: {_money(s.get('total'))} en "
             f"{payload.get('orders', 0)} pedidos"]
    if parts:
        lines.append("   (" + " · ".join(parts) + ")")
    disc = float(payload.get("discrepancy") or 0)
    if abs(disc) >= 0.005:
        lines.append(f"🧾 Caja: esperado {_money(payload.get('expected_amount'))} · "
                     f"declarado {_money(payload.get('declared_cash'))} · "
                     f"diferencia {_money(disc)}")
    top = payload.get("top_items") or []
    if top:
        lines.append("⭐ Top: " + " · ".join(
            f"{i.get('name')} ×{i.get('qty')}" for i in top))
    low = payload.get("low_stock") or []
    if low:
        lines.append("📦 Stock bajo:")
        for r in low:
            cur = r.get("current_stock")
            cur = int(cur) if float(cur or 0) == int(float(cur or 0)) else cur
            lines.append(f"• {r.get('name')}: {cur} {r.get('unit', '')} "
                         f"(mín {r.get('min_stock')})")
    else:
        lines.append("✅ Nada bajo mínimo en inventario.")
    lines.append(f"💵 Rico Cash circulando: {_money(payload.get('rico_outstanding'))}")
    staff = payload.get("staff") or []
    if staff:
        lines.append("🕐 Personal del turno:")
        for p in staff:
            seg = f"• {p.get('name')}: entró {_hm(p.get('in_label', ''))}"
            if p.get("out_label"):
                seg += f" · salió {_hm(p['out_label'])}"
            else:
                seg += " · sin salida marcada"
            if int(p.get("late_minutes") or 0) > 0:
                seg += f" · ⚠️ tarde {int(p['late_minutes'])} min"
            lines.append(seg)
    else:
        lines.append("🕐 Personal: sin registros de reloj en este turno.")
    return "\n".join(lines)


def _deliver(payload: dict, phones: list, send_fn) -> dict:
    """Send to each phone not already delivered. Returns
    {sent: [phones], failed: [(phone, err)]} and queues failures."""
    shift_id = str(payload.get("shift_id") or "")
    sent, failed = [], []
    for phone in phones:
        if (shift_id, phone) in _sent:
            continue
        try:
            send_fn(phone, format_report(payload))
            _sent.add((shift_id, phone))
            sent.append(phone)
        except Exception as e:
            failed.append((phone, str(e)))
            queue = _pending.setdefault(phone, [])
            if not any(str(p.get("shift_id") or "") == shift_id for p in queue):
                queue.append(payload)
    return {"sent": sent, "failed": failed}


def process(payload, auth_header: str, send_fn):
    """Validate + deliver one shift report. Returns (http_status,
    dict); raises nothing. 200 only when every owner number got it
    (or already had it); 502 when at least one number failed — the
    OS records the miss in owner_reports and the bot queues the
    retry, so the failure is visible on BOTH sides."""
    if not notify.authorized(auth_header):
        return 403, {"ok": False, "error": "unauthorized"}
    if not isinstance(payload, dict):
        return 400, {"ok": False, "error": "bad payload"}
    if payload.get("kind") != "shift_report" or not payload.get("shift_id"):
        return 400, {"ok": False, "error": "missing kind/shift_id"}
    phones = owner_door.owner_numbers()
    if not phones:
        print("[OwnerReport] OWNER_WHATSAPP is empty — nowhere to "
              "send the shift report", flush=True)
        return 503, {"ok": False, "error": "no owner numbers configured"}
    result = _deliver(payload, phones, send_fn)
    if result["failed"]:
        for phone, err in result["failed"]:
            print(f"[OwnerReport] send FAILED for shift "
                  f"{payload.get('shift_id')} to ...{phone[-4:]}: {err} "
                  f"— queued for that owner's next message (24h window)",
                  flush=True)
        return 502, {"ok": False, "sent_to": len(result["sent"]),
                     "queued_for": [p for p, _ in result["failed"]],
                     "error": "one or more sends failed; queued"}
    return 200, {"ok": True, "sent_to": len(result["sent"]),
                 "already": len(phones) - len(result["sent"])}


def flush_pending_for(phone: str, send_fn) -> int:
    """Deliver any queued reports to this owner (their inbound
    message just reopened the 24h window). Returns how many reports
    were delivered. Raises nothing."""
    digits = re.sub(r"\D", "", str(phone or ""))
    if not digits:
        return 0
    # Match the owner list's suffix tolerance like owner_door.is_owner.
    key = None
    for k in list(_pending.keys()):
        short, long_ = (digits, k) if len(digits) < len(k) else (k, digits)
        if digits == k or (len(short) >= 10 and long_.endswith(short)):
            key = k
            break
    if key is None or not _pending.get(key):
        return 0
    delivered = 0
    remaining = []
    for payload in _pending[key]:
        shift_id = str(payload.get("shift_id") or "")
        if (shift_id, key) in _sent:
            continue
        try:
            send_fn(key, format_report(payload))
            _sent.add((shift_id, key))
            delivered += 1
            print(f"[OwnerReport] queued report for shift {shift_id} "
                  f"delivered on the owner's new window", flush=True)
        except Exception as e:
            print(f"[OwnerReport] queued flush FAILED for shift "
                  f"{shift_id}: {e}", flush=True)
            remaining.append(payload)
    _pending[key] = remaining
    return delivered


def reset():
    _sent.clear()
    _pending.clear()
