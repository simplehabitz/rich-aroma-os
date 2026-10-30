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

Clock questions ("who's clocked in / who was late") read the real
clock_records through the snapshot's `clock` section (clock-in build,
2026-10-30: the POS PIN login IS the clock, on registered devices).
When the OS answers clock: null (migration not run yet), the door
keeps the honest not-live line — never an invented roster.

Door fix (2026-10-30): the first matcher claimed any owner message
containing a keyword SUBSTRING — "rico" fired on the mascot's own
name ("Capitán Rico"), "late" hid inside "chocolate", "hoy" turned
plain orders into the full snapshot, and the owner could not order
a Flight from his own phone. Matching is now word-boundary and
question-aware, the mascot's name is stripped before matching, and
an order-shaped message ALWAYS falls through: the door answers
data questions, it doesn't eat orders.

MODO CLIENTE / MODO DUEÑO (2026-10-30): the owner can text
"modo cliente" ("customer mode") to switch his own number to
customer mode — the door then claims NOTHING, not even data
questions, and he orders/tests exactly like a real customer —
and "modo dueño" ("owner mode", "modo dueno") to switch back.
Default is owner mode; the flag lives in an in-memory dict like
the bot's other per-phone state, so a restart forgets it toward
owner mode, the safe direction. Outbound owner traffic (close
reports, the missed-report flush) is never gated by the mode.

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
#
# The 2026-10-30 fix adds three guards so the door answers data
# questions without eating the owner's own orders:
#   1. The mascot's name is stripped before matching — "Capitán
#      Rico" is how you GREET the bot, never a Rico Cash question.
#   2. An order-shaped message (order verb present, no question
#      shape, no "quiero saber" preface) ALWAYS falls through,
#      whatever keywords it carries: "quiero un latte hoy",
#      "quiero un flight", "quiero un frappé de chocolate".
#   3. Keywords match on word boundaries — "late" no longer hides
#      inside "chocolate" — and bare "rico" only claims a message
#      in a money context ("rico cash", "circula") or inside a
#      real question ("¿cuánto rico hay?").
# A legit door question is either question-shaped (¿…?, cuánto,
# quién, who, how many…) or a bare keyword ask with no order verb
# in it ("stock bajo", "preventa?", "ventas de hoy").
# ------------------------------------------------------------------

_ES_MARKERS = ("¿", "á", "é", "í", "ó", "ú", "ñ")


def _lang(text: str, intents: set) -> str:
    low = (text or "").lower()
    if any(m in low for m in _ES_MARKERS) or intents & {"es_only"}:
        return "es"
    return "en"


_MASCOT_RE = re.compile(r"capit[aá]n\s+rico", re.IGNORECASE)

_INTERROGATIVE_RE = re.compile(
    r"(¿|\?|\bcu[aá]nt\w*|\bqui[eé]n\w*|\bwho\b|"
    r"\bhow\s+(many|much)\b|\bwhat\b)", re.IGNORECASE)

_ORDER_VERB_RE = re.compile(
    r"\b(quiero|quisiera|ordenar|pedir|dame|poneme|m[aá]ndame|"
    r"i\s+want|i'd\s+like|can\s+i\s+(get|have)|let\s+me\s+get)\b",
    re.IGNORECASE)

_ASKING_RE = re.compile(r"\b(saber|preguntar\w*)\b", re.IGNORECASE)


def _order_shaped(low: str) -> bool:
    """A buying message, not a data question: an order verb is
    present, the message is not question-shaped, and it is not a
    'quiero saber…' preface to a question."""
    return bool(_ORDER_VERB_RE.search(low)) \
        and not _INTERROGATIVE_RE.search(low) \
        and not _ASKING_RE.search(low)


def _has(low: str, *words: str) -> bool:
    """Word-boundary keyword test (the text is already padded)."""
    return any(re.search(r"\b" + re.escape(w) + r"\b", low)
               for w in words)


def _intent(text: str) -> str:
    low = " " + _MASCOT_RE.sub(
        " ", (text or "").lower()).strip() + " "
    if _has(low, "clock", "clocked", "tarde", "late", "atraso",
            "retraso", "entró", "entro", "llegó", "llego", "adentro",
            "personal", "equipo", "staff", "empleado", "empleados"):
        return "clock"
    if _has(low, "stock", "inventario", "bajo", "falta", "quedan",
            "left", "low"):
        return "stock"
    if _has(low, "preventa", "flight") or "apartad" in low:
        return "preventa"
    if "rico cash" in low or "circula" in low or "circulando" in low \
            or (_has(low, "rico")
                and _INTERROGATIVE_RE.search(low)):
        return "rico"
    if _has(low, "pedido", "pedidos", "order", "orders", "cocina",
            "kitchen", "activos", "active", "preparando"):
        return "orders"
    if _has(low, "ayuda", "help") or "qué puedo" in low \
            or "que puedo" in low or "what can" in low:
        return "help"
    if _has(low, "venta", "ventas", "sales", "sold", "hoy", "today",
            "resumen", "summary", "todo", "everything", "status",
            "estado") or "cómo vamos" in low or "como vamos" in low \
            or "cómo va" in low or "como va" in low \
            or "qué pasa" in low or "que pasa" in low \
            or re.search(r"\bvend\w*\b", low):
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
    if _order_shaped(low):
        return True
    if len(low) <= 12 and _intent(text) == "unknown":
        return True
    if any(low.startswith(o) or (" " + o) in low for o in _ORDER_OPENERS) \
            and _intent(text) == "unknown":
        return True
    return False


# ------------------------------------------------------------------
# MODO CLIENTE / MODO DUEÑO (2026-10-30) — see the module docstring.
# The commands are whole-message matches (after trim/punctuation),
# recognized in BOTH modes, and reachable only from owner numbers:
# reply_for_owner's is_owner gate runs before any of this, so a
# customer texting "modo cliente" just gets the customer flow.
# ------------------------------------------------------------------

_OWNER_MODES = {}  # owner digits -> "customer"; missing = owner mode

_MODE_COMMANDS = {
    "modo cliente": ("customer", "es"),
    "customer mode": ("customer", "en"),
    "modo dueño": ("owner", "es"),
    "modo dueno": ("owner", "es"),
    "owner mode": ("owner", "en"),
}

_MODE_REPLY = {
    ("customer", "es"): (
        "✅ Modo cliente activado. Ahora te atiendo como a cualquier "
        "cliente: pedí, mirá el menú, probá todo. La puerta quedó "
        "apagada hasta que escribas «modo dueño»."),
    ("customer", "en"): (
        "✅ Customer mode is on. I'll treat you like any customer "
        "now — order, browse the menu, test away. The door stays "
        "off until you text \"owner mode\"."),
    ("owner", "es"): (
        "✅ Modo dueño activado. La puerta está abierta: preguntame "
        "«¿cómo vamos hoy?», ventas, stock, preventa, el reloj o "
        "Rico Cash. «modo cliente» cuando quieras comprar como "
        "cliente."),
    ("owner", "en"): (
        "✅ Owner mode is on. The door is open: ask me \"how are we "
        "doing today?\", sales, stock, preorders, the clock or "
        "Rico Cash. \"customer mode\" when you want to shop like a "
        "customer."),
}


def _mode_command(text: str):
    """(mode, lang) when the WHOLE message is a mode command."""
    norm = re.sub(r"\s+", " ", (text or "").strip().lower())
    return _MODE_COMMANDS.get(norm.strip(" .!¡¿?"))


def _customer_mode(phone: str) -> bool:
    try:
        return _OWNER_MODES.get(_digits(phone)) == "customer"
    except Exception:
        return False  # unknown state fails toward owner mode


def _set_mode(phone: str, mode: str) -> None:
    try:
        if mode == "customer":
            _OWNER_MODES[_digits(phone)] = "customer"
        else:
            _OWNER_MODES.pop(_digits(phone), None)
    except Exception:
        pass  # a storage hiccup must never break the door


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
    # Reached only when the OS answers clock: null — since the
    # 2026-10-30 build that means the clock migration has not run
    # on the OS yet, not that the feature is unbuilt.
    "es": ("🕐 El reloj de entradas todavía no responde del sistema — "
           "falta correr su migración. En cuanto esté, preguntame "
           "«¿quién está adentro?» o «¿quién llegó tarde?» y te respondo "
           "de los registros reales."),
    "en": ("🕐 The clock isn't answering from the system yet — its "
           "migration hasn't run. Once it has, ask me \"who's clocked "
           "in\" or \"who was late\" and I'll answer from the real "
           "records."),
}


def _fmt_clock(snap: dict, lang: str) -> str:
    """The clock answer from REAL records. snap.clock is None only
    when the OS has no clock tables yet (migration not run) — that
    keeps the honest not-live line; an empty-but-real day says so."""
    clock = snap.get("clock")
    if clock is None:
        return _CLOCK_LINES[lang]
    on = clock.get("on_shift") or []
    late = clock.get("late_today") or []
    worked = clock.get("worked_today") or []
    if not on and not worked:
        return ("🕐 Nadie ha marcado entrada hoy todavía."
                if lang == "es" else
                "🕐 Nobody has clocked in yet today.")
    lines = []
    if on:
        joined = " · ".join(
            (f"{p.get('name')} (desde {p.get('since_label')})"
             if lang == "es" else
             f"{p.get('name')} (since {p.get('since_label')})")
            for p in on)
        lines.append(("🟢 En turno ahora: " if lang == "es"
                      else "🟢 On shift now: ") + joined)
    done = [w for w in worked if w.get("out")]
    if done:
        joined = " · ".join(
            f"{w.get('name')} ({w.get('since_label')} → {w.get('out_label')})"
            for w in done)
        lines.append(("✔️ Ya marcaron salida: " if lang == "es"
                      else "✔️ Already clocked out: ") + joined)
    if late:
        joined = " · ".join(
            (f"{p.get('name')} — {p.get('minutes_late')} min tarde "
             f"({p.get('since_label')})" if lang == "es" else
             f"{p.get('name')} — {p.get('minutes_late')} min late "
             f"({p.get('since_label')})")
            for p in late)
        lines.append(("⚠️ Tarde hoy: " if lang == "es"
                      else "⚠️ Late today: ") + joined)
    elif worked:
        lines.append("✅ Nadie llegó tarde hoy." if lang == "es"
                     else "✅ Nobody was late today.")
    return "\n".join(lines)


def _fmt_clock_brief(snap: dict, lang: str) -> str:
    """One compact clock line for the full snapshot ('' when the
    clock isn't live — the snapshot simply omits it)."""
    clock = snap.get("clock")
    if clock is None:
        return ""
    on = clock.get("on_shift") or []
    late = clock.get("late_today") or []
    worked = clock.get("worked_today") or []
    if not on and not worked:
        return ("🕐 Reloj: sin entradas hoy." if lang == "es"
                else "🕐 Clock: no punches today.")
    names = " · ".join(f"{p.get('name')} ({p.get('since_label')})" for p in on)
    head = ("🕐 En turno: " if lang == "es" else "🕐 On shift: ") + names
    if late:
        head += (f" · ⚠️ {len(late)} tarde" if lang == "es"
                 else f" · ⚠️ {len(late)} late")
    return head


def _fmt_missed(snap: dict, lang: str) -> str:
    """A close report that Meta couldn't take (24h window) is never
    dropped silently: the OS logs it and the next snapshot names it.
    The bot also retries delivery on this very conversation."""
    missed = snap.get("missed_reports") or []
    if not missed:
        return ""
    m = missed[0]
    if lang == "es":
        return (f"⚠️ El reporte del cierre del {m.get('day')} "
                f"({m.get('at_label')}) no se entregó a tiempo — "
                f"lo sigo reintentando con cada mensaje tuyo.")
    return (f"⚠️ The close report from {m.get('day')} "
            f"({m.get('at_label')}) wasn't delivered on time — "
            f"I keep retrying it with every message of yours.")

_HELP = {
    "es": ("Podés preguntarme:\n• «¿cómo vamos hoy?» — resumen del día\n"
           "• «¿ventas?» — ventas y métodos de pago\n"
           "• «¿pedidos?» — qué hay en cocina y por cobrar\n"
           "• «¿stock bajo?» — inventario bajo mínimo\n"
           "• «¿preventa?» — apartados de hoy\n"
           "• «¿quién está adentro?» / «¿quién llegó tarde?» — el reloj\n"
           "• «¿cuánto Rico Cash circula?»\n"
           "• «modo cliente» — apagá la puerta y comprá como un cliente más\n"
           "• «modo dueño» — volvé a modo dueño\n"
           "Y si querés pedir algo como cliente, pedí normal — te atiendo igual."),
    "en": ("You can ask me:\n• \"how are we doing today?\" — the day summary\n"
           "• \"sales?\" — sales and payment mix\n"
           "• \"orders?\" — what's in the kitchen / awaiting payment\n"
           "• \"low stock?\" — inventory below minimum\n"
           "• \"preorders?\" — today's holds and paid preorders\n"
           "• \"how much Rico Cash is out there?\"\n"
           "• \"customer mode\" — turn the door off and shop like any customer\n"
           "• \"owner mode\" — back to owner mode\n"
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
    cmd = _mode_command(text)
    if cmd is not None:
        mode, lang = cmd
        _set_mode(phone, mode)
        return _MODE_REPLY[(mode, lang)], lang
    if _customer_mode(phone):
        return None
    if _falls_through(text):
        return None
    intent = _intent(text)
    lang = _lang(text, {"es_only"} if any(
        k in (text or "").lower() for k in ("¿", "ventas", "cómo", "qué")) else set())
    if intent == "help":
        return _HELP[lang], lang

    res = os_client.owner_snapshot()
    if not res.get("ok") or not (res.get("data") or {}).get("snapshot"):
        print(f"[OwnerDoor] snapshot failed for owner query "
              f"'{text}': {res.get('error')}", flush=True)
        return _ERR[lang], lang
    snap = res["data"]["snapshot"]

    if intent == "clock":
        return _fmt_clock(snap, lang), lang
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
              else "🧑‍✈️ Rich Aroma — today so far")]
    missed = _fmt_missed(snap, lang)
    if missed:
        lines.append(missed)
    lines.append(_fmt_sales(snap, lang))
    lines.append(_fmt_active(snap, lang))
    top = _fmt_top(snap, lang)
    if top:
        lines.append(top)
    lines.append(_fmt_stock(snap, lang))
    lines.append(_fmt_preventa(snap, lang))
    brief = _fmt_clock_brief(snap, lang)
    if brief:
        lines.append(brief)
    lines.append(_fmt_rico(snap, lang))
    return "\n".join(lines), lang
