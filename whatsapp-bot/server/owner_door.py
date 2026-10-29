"""
OWNER'S DOOR — the bot's privileged owner interface (2026-10-29).

The owner texts the shop's WhatsApp number and asks about the shop —
sales today, active orders, low stock, preventa, Rico Cash — and gets
live answers computed by the OS (os_client.owner_snapshot ->
api/store action whatsapp_owner_snapshot). Customers never see any
of this: the door opens ONLY for numbers on the OWNER_WHATSAPP env
list (comma-separated, full international digits, set in the host
dashboard — never committed to the repo).

Security model (settled 2026-10-26): the WhatsApp number is the
doorbell, not the safe key. This door is READ-ONLY — it answers
questions and moves nothing. Money/stock actions (refunds, comps,
grants, price changes) still go through /admin + PIN. If the env
list is empty, the door is closed for everyone (fail-closed).

Routing contract with webhook.py: reply_for_owner() returns
(text, lang) when it claims the message, or None to let the normal
customer pipeline handle it — so the owner can still order and test
like a customer. Short reply-ish tokens (a bare number, "si", "no",
"cancelar") and order-shaped openers never get claimed.

Clock questions ("who's clocked in / who was late") answer honestly
that clock-in is not live yet; the intents are wired so the real
answers slot in when the clock build lands (Oct 30 - Nov 2 window).

Env:
    OWNER_WHATSAPP   e.g. "19097068510" (or several, comma-separated)
"""

import os
import re

try:
    import os_client
except ImportError:  # pragma: no cover - package import on the host
    from server import os_client


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s or "")


def owner_numbers() -> list:
    raw = os.environ.get("OWNER_WHATSAPP", "")
    return [d for d in (_digits(p) for p in raw.split(",")) if d]


def is_owner(phone: str) -> bool:
    """True when the sender's WhatsApp id is on the owner list.
    Compares digit strings; also accepts a suffix match when the
    shorter side has at least 10 digits (country-code drift)."""
    me = _digits(phone)
    if not me:
        return False
    for num in owner_numbers():
        if me == num:
            return True
        short, long_ = (me, num) if len(me) < len(num) else (num, me)
        if len(short) >= 10 and long_.endswith(short):
            return True
    return False


# ------------------------------------------------------------------
# Intent routing (deterministic keywords, EN + ES — the owner writes
# both). First match wins; order matters: specific beats general.
# ------------------------------------------------------------------

_ES_MARKERS = ("¿", "á", "é", "í", "ó", "ú", "ñ")


def _lang(text: str, intents: set) -> str:
    low = (text or "").lower()
    if any(m in low for m in _ES_MARKERS) or intents & {"es_only"}:
        return "es"
    return "en"


def _intent(text: str) -> str:
    low = " " + (text or "").lower().strip() + " "
    if any(k in low for k in ("clock", "clocked", "tarde", "late ",
                              "entró", "entro ", "llegó", "llego ",
                              "personal", "equipo", "staff", "empleado")):
        return "clock"
    if any(k in low for k in ("stock", "inventario", "bajo", "low ",
                              "falta", "quedan", "left")):
        return "stock"
    if any(k in low for k in ("preventa", "flight", "apartad")):
        return "preventa"
    if any(k in low for k in ("rico",)):
        return "rico"
    if any(k in low for k in ("pedido", "order", "cocina", "kitchen",
                              "activos", "active", "preparando")):
        return "orders"
    if any(k in low for k in ("ayuda", "help", "qué puedo", "que puedo",
                              "what can")):
        return "help"
    if any(k in low for k in ("venta", "sales", "sold", "vend",
                              "cómo vamos", "como vamos", "cómo va",
                              "como va", "hoy", "today", "resumen",
                              "summary", "todo", "everything", "qué pasa",
                              "que pasa", "status", "estado")):
        return "snapshot"
    return "unknown"


_ORDER_OPENERS = ("quiero", "quisiera", "ordenar", "pedir", "order ",
                  "menu", "menú", "ver el menu", "ver el menú")
_SHORT_OK = {"si", "sí", "no", "ok", "gracias", "thanks", "cancelar",
             "cancel", "hola", "hi", "hey", "buenas", "buenos dias",
             "buenos días"}


def _falls_through(text: str) -> bool:
    """Messages the door must NOT claim (customer-flow oxygen)."""
    low = (text or "").lower().strip()
    if not low:
        return True
    if low in _SHORT_OK:
        return True
    if re.fullmatch(r"\d{1,3}", low):
        return True
    if len(low) <= 12 and _intent(text) == "unknown":
        return True
    if any(low.startswith(o) or (" " + o) in low for o in _ORDER_OPENERS) \
            and _intent(text) == "unknown":
        return True
    return False


# ------------------------------------------------------------------
# Formatting
# ------------------------------------------------------------------

def _money(v) -> str:
    v = float(v or 0)
    if abs(v - round(v)) < 0.005:
        return f"L.{int(round(v)):,}"
    return f"L.{v:,.2f}"


def _fmt_sales(snap: dict, lang: str) -> str:
    s = snap.get("sales_today") or {}
    m = s.get("by_method") or {}
    parts = []
    if float(m.get("cash") or 0):
        parts.append(("efectivo" if lang == "es" else "cash") + " " + _money(m["cash"]))
    if float(m.get("card") or 0):
        parts.append(("tarjeta" if lang == "es" else "card") + " " + _money(m["card"]))
    if float(m.get("transfer") or 0):
        parts.append(("transferencia" if lang == "es" else "transfer") + " " + _money(m["transfer"]))
    if float(m.get("rico") or 0):
        parts.append("Rico " + _money(m["rico"]))
    head = (f"💰 Ventas de hoy: {_money(s.get('total'))} en {s.get('orders', 0)} pedidos"
            if lang == "es" else
            f"💰 Sales today: {_money(s.get('total'))} across {s.get('orders', 0)} orders")
    if parts:
        head += " (" + " · ".join(parts) + ")"
    return head


def _fmt_active(snap: dict, lang: str) -> str:
    a = snap.get("active") or {}
    if lang == "es":
        return (f"🍳 Activos: {a.get('cocina', 0)} en cocina · "
                f"{a.get('por_cobrar', 0)} por cobrar · {a.get('listos', 0)} listos")
    return (f"🍳 Active: {a.get('cocina', 0)} in the kitchen · "
            f"{a.get('por_cobrar', 0)} awaiting payment · {a.get('listos', 0)} ready")


def _fmt_top(snap: dict, lang: str) -> str:
    top = snap.get("top_items") or []
    if not top:
        return ""
    label = "⭐ Top: " if lang == "es" else "⭐ Top sellers: "
    return label + " · ".join(f"{i.get('name')} ×{i.get('qty')}" for i in top)


def _fmt_stock(snap: dict, lang: str) -> str:
    low = snap.get("low_stock") or []
    if not low:
        return ("✅ Nada bajo mínimo en inventario." if lang == "es"
                else "✅ Nothing below minimum in inventory.")
    lines = ["📦 " + ("Stock bajo:" if lang == "es" else "Low stock:")]
    for r in low:
        cur = r.get("current_stock")
        cur = int(cur) if float(cur) == int(float(cur)) else cur
        lines.append(f"• {r.get('name')}: {cur} {r.get('unit', '')} "
                     f"({'mín' if lang == 'es' else 'min'} {r.get('min_stock')})")
    return "\n".join(lines)


def _fmt_preventa(snap: dict, lang: str) -> str:
    p = snap.get("preventa_today") or {}
    if lang == "es":
        return (f"🧳 Preventa hoy: {p.get('intents', 0)} apartados por confirmar · "
                f"{p.get('paid', 0)} pagados · {p.get('holds_active', 0)} apartados activos "
                f"({p.get('packs', 0)} packs, {p.get('bottles', 0)} botellas sueltas)")
    return (f"🧳 Preorders today: {p.get('intents', 0)} awaiting confirmation · "
            f"{p.get('paid', 0)} paid · {p.get('holds_active', 0)} active holds "
            f"({p.get('packs', 0)} packs, {p.get('bottles', 0)} single bottles)")


def _fmt_rico(snap: dict, lang: str) -> str:
    if lang == "es":
        return f"💵 Rico Cash circulando: {_money(snap.get('rico_outstanding'))}"
    return f"💵 Rico Cash outstanding: {_money(snap.get('rico_outstanding'))}"


_CLOCK_LINES = {
    "es": ("🕐 El reloj de entradas todavía no está activo — entra con la "
           "construcción del 30 oct–2 nov. Cuando esté, preguntame "
           "«¿quién está adentro?» o «¿quién llegó tarde?» y te respondo "
           "de los registros reales."),
    "en": ("🕐 Clock-in isn't live yet — it lands with the Oct 30–Nov 2 "
           "build. Once it's on, ask me \"who's clocked in\" or \"who was "
           "late\" and I'll answer from the real records."),
}

_HELP = {
    "es": ("Podés preguntarme:\n• «¿cómo vamos hoy?» — resumen del día\n"
           "• «¿ventas?» — ventas y métodos de pago\n"
           "• «¿pedidos?» — qué hay en cocina y por cobrar\n"
           "• «¿stock bajo?» — inventario bajo mínimo\n"
           "• «¿preventa?» — apartados de hoy\n"
           "• «¿cuánto Rico Cash circula?»\n"
           "Y si querés pedir algo como cliente, pedí normal — te atiendo igual."),
    "en": ("You can ask me:\n• \"how are we doing today?\" — the day summary\n"
           "• \"sales?\" — sales and payment mix\n"
           "• \"orders?\" — what's in the kitchen / awaiting payment\n"
           "• \"low stock?\" — inventory below minimum\n"
           "• \"preorders?\" — today's holds and paid preorders\n"
           "• \"how much Rico Cash is out there?\"\n"
           "And if you want to order like a customer, just order — "
           "I'll take it the same way."),
}

_ERR = {
    "es": "⚠️ No pude leer el sistema en este momento. Probá en un minuto.",
    "en": "⚠️ I couldn't read the system just now. Try again in a minute.",
}


def reply_for_owner(phone: str, text: str):
    """(text, lang) when the door claims the message, else None."""
    if not is_owner(phone):
        return None
    if _falls_through(text):
        return None
    intent = _intent(text)
    lang = _lang(text, {"es_only"} if any(
        k in (text or "").lower() for k in ("¿", "ventas", "cómo", "qué")) else set())
    if intent == "help":
        return _HELP[lang], lang
    if intent == "clock":
        return _CLOCK_LINES[lang], lang

    res = os_client.owner_snapshot()
    if not res.get("ok") or not (res.get("data") or {}).get("snapshot"):
        print(f"[OwnerDoor] snapshot failed for owner query "
              f"'{text}': {res.get('error')}", flush=True)
        return _ERR[lang], lang
    snap = res["data"]["snapshot"]

    if intent == "stock":
        return _fmt_stock(snap, lang), lang
    if intent == "orders":
        return _fmt_active(snap, lang), lang
    if intent == "preventa":
        return _fmt_preventa(snap, lang), lang
    if intent == "rico":
        return _fmt_rico(snap, lang), lang

    # snapshot / unknown owner chatter: the full day picture.
    lines = [("🧑‍✈️ Rich Aroma — resumen de hoy" if lang == "es"
              else "🧑‍✈️ Rich Aroma — today so far"),
             _fmt_sales(snap, lang), _fmt_active(snap, lang)]
    top = _fmt_top(snap, lang)
    if top:
        lines.append(top)
    lines.append(_fmt_stock(snap, lang))
    lines.append(_fmt_preventa(snap, lang))
    lines.append(_fmt_rico(snap, lang))
    return "\n".join(lines), lang
