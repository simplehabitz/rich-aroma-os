"""
Owner notifications: OS -> bot -> OWNER (inventory core, 2026-10-30).

The OS SIGNALS; this bot delivers to the OWNER_WHATSAPP numbers (the
Owner's Door identity, owner_door.owner_numbers). Three kinds, all
from RECIPE-INVENTORY-DESIGN:

  drift       -> §7j live re-cost: an intake (or a production) pushed
                 menu items past 35% COGS. Item, old -> new COGS and
                 the sugerido — the owner moves prices, the system
                 never does, so this message IS the control loop.
  staff_alert -> §7i: a staff member tapped the alert button
                 (insumo bajo / algo se rompió / necesito ayuda). The
                 OS also keeps the alert in its Bitácora — delivery
                 here is best-effort, the record is not.
  sin_factura -> §7k.2 discipline: a purchase closed WITHOUT factura
                 under the Encargado override. Attributed (who
                 received, who overrode, the reason, the amount) so
                 the crédito-fiscal discipline stays visible.

Authenticated with the shared WHATSAPP_SIGNUP_SECRET as a Bearer credential,
constant-time, fail-closed — identical to notify.py / loyalty_notify.py.
Free-form sends ride whatever service window exists with the owner
(his own daily use of the Door keeps one open in practice); a Meta
rejection surfaces as a 502 and is logged by the OS, never swallowed.
"""

import hmac
import os
import re

try:
    from owner_door import owner_numbers
except ImportError:
    from server.owner_door import owner_numbers


def _secret() -> str:
    return os.environ.get("WHATSAPP_SIGNUP_SECRET", "").strip()


def authorized(auth_header: str) -> bool:
    """Constant-time Bearer credential Fail-closed: no secret
    configured on the bot -> nobody is authorized."""
    expected = _secret()
    if not expected:
        return False
    provided = ""
    if auth_header and auth_header.lower().startswith("bearer "):
        provided = auth_header[7:].strip()
    return bool(provided) and hmac.compare_digest(provided, expected)


def _money(amount) -> str:
    try:
        v = float(amount)
    except (TypeError, ValueError):
        return "L.0"
    return f"L.{v:,.0f}" if v == int(v) else f"L.{v:,.2f}"


def _pct(v) -> str:
    try:
        return f"{float(v):.1f}%"
    except (TypeError, ValueError):
        return "—"


_ALERT_LABELS = {
    "insumo_bajo": "📉 Insumo bajo",
    "se_rompio": "🔧 Algo se rompió",
    "ayuda": "🙋 Necesito ayuda",
}


def message_for(payload: dict) -> str:
    kind = (payload.get("kind") or "").strip().lower()
    if kind == "drift":
        lines = ["⚠️ *Costo subió — revisión de precios*"]
        cause = (payload.get("cause") or "intake").strip()
        lines.append("Por una producción:" if cause == "produce" else "Por una compra que entró:")
        for it in payload.get("items") or []:
            name = (it.get("name") or "Producto").strip()
            old = it.get("old_pct")
            old_txt = f"{_pct(old)} → " if old is not None else ""
            lines.append(
                f"• {name}: COGS {old_txt}{_pct(it.get('new_pct'))} "
                f"(precio {_money(it.get('price'))}, costo {_money(it.get('food_cost'))}) "
                f"— sugerido {_money(it.get('suggested'))}"
            )
        lines.append("El sistema no cambia precios: vos decidís en /admin.")
        return "\n".join(lines)
    if kind == "staff_alert":
        label = _ALERT_LABELS.get((payload.get("alert_kind") or "").strip(), "🔔 Aviso del equipo")
        lines = [f"{label}"]
        if payload.get("item_name"):
            lines.append(f"Insumo: {payload['item_name']}")
        if payload.get("note"):
            lines.append(str(payload["note"]))
        if payload.get("by_name"):
            lines.append(f"— {payload['by_name']}")
        return "\n".join(lines)
    if kind == "sin_factura":
        lines = ["🧾 *Compra SIN factura* (override del encargado)"]
        if payload.get("supplier"):
            lines.append(f"Proveedor: {payload['supplier']}")
        lines.append(f"Monto: {_money(payload.get('total'))}")
        if payload.get("reason"):
            lines.append(f"Motivo: {payload['reason']}")
        who = payload.get("override_by_name") or payload.get("by_name")
        if who:
            lines.append(f"Autorizó: {who}")
        if payload.get("by_name") and payload.get("by_name") != who:
            lines.append(f"Recibió: {payload['by_name']}")
        return "\n".join(lines)
    return ""


def process(payload, auth_header: str, send_fn):
    """Validate + send one owner notification to every owner number.

    send_fn(phone, text) performs the Meta send (injected by the
    webhook route; captured by tests). Returns (http_status, dict);
    raises nothing.
    """
    if not authorized(auth_header):
        return 403, {"ok": False, "error": "unauthorized"}
    if not isinstance(payload, dict):
        return 400, {"ok": False, "error": "bad payload"}
    kind = (payload.get("kind") or "").strip().lower()
    if kind not in ("drift", "staff_alert", "sin_factura"):
        return 400, {"ok": False, "error": "unsupported kind"}
    text = message_for(payload)
    if not text:
        return 400, {"ok": False, "error": "empty message"}
    numbers = owner_numbers()
    if not numbers:
        return 503, {"ok": False, "error": "no owner numbers configured"}
    sent = 0
    for num in numbers:
        try:
            send_fn(num, text)
            sent += 1
        except Exception as e:
            return 502, {"ok": False, "error": f"send failed: {e}", "sent": sent}
    return 200, {"ok": True, "sent": sent, "kind": kind}
