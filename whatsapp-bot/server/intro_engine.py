"""
Intro engine for Rich Aroma Honduras (Quimistán) — tenant rich-aroma-honduras ONLY.

Scope (owner decision, 2026-10-25): this is NOT café-menu ordering. A
customer texts the shop number before the reopening and gets a short
get-to-know-you session:
  1. greeting + offer (botella gratis con la primera compra),
  2. nombre (required) and cumpleaños día/mes (optional, skippable),
  3. confirm/correct, then the account is created in the OS and the
     L.100 welcome gift is recorded as a PENDING grant,
  4. the preventa (bottle preorder) offer, intent captured for the owner.

The OS (Supabase customers, phone-keyed) is the system of record; this
module talks to it only through os_client.py (shared-secret,
server-to-server). The gift is NEVER credited to rico_balance here — it
stays a pending grant for the loyalty build to mint as a bonus lot.
One welcome gift per customer: the WhatsApp signup gift and the
preventa campaign grant are the same L.100 (same grant row).

Payment for a preventa is by transfer, confirmed by a human. This bot
NEVER asks for a PIN or any payment credential in chat.

Cali (order_engine.py) is untouched; webhook.py routes only the
rich-aroma-honduras slug here.
"""

import re
from dataclasses import dataclass, field
from typing import Optional

try:
    import os_client
    from orders import save_order
    from order_engine import detect_language, NUMBER_WORDS as _ENGINE_NUMWORDS
except ImportError:  # running as part of the server package
    from server import os_client
    from server.orders import save_order
    from server.order_engine import detect_language, NUMBER_WORDS as _ENGINE_NUMWORDS

BUSINESS_SLUG = "rich-aroma-honduras"
INSTAGRAM = "@richaromacoffee"

# Preventa pricing (FINAL-MENU.md formats; the OS recomputes totals
# server-side when recording, so a drift here can never misbill).
BOTTLE_PRICE = 100
PACK5_PREVENTA = 350
PACK5_COUNTER = 400
BOX_MIN = 20
BOX_UNIT = 70
BOX_PRICE = BOX_MIN * BOX_UNIT  # L.1,400 la caja de 20

MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio",
             "julio", "agosto", "septiembre", "octubre", "noviembre",
             "diciembre"]
MONTHS_EN = ["January", "February", "March", "April", "May", "June",
             "July", "August", "September", "October", "November",
             "December"]
_DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

NUMWORDS = dict(_ENGINE_NUMWORDS)
NUMWORDS.update({
    "siete": 7, "ocho": 8, "nueve": 9, "diez": 10, "once": 11, "doce": 12,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
})

YES_CUES = ("sí", "si", "yes", "ok", "dale", "correcto", "correct",
            "está bien", "esta bien", "perfecto", "confirmo", "👍")
SKIP_CUES = ("saltar", "paso", "skip", "omitir", "no gracias", "después",
             "despues", "luego", "prefiero no", "no quiero", "no tengo",
             "sin cumple", "ninguno")
NO_CUES = ("no por ahora", "no gracias", "por ahora no", "después",
           "despues", "luego", "not now", "no")
MENU_CUES = ("menú", "menu", "carta", "qué venden", "que venden",
             "qué tienen", "que tienen", "opciones")
PRICE_CUES = ("cuánto", "cuanto", "precio", "cuesta", "cuestan", "vale",
              "valen", "price", "cost")
GIFT_CUES = ("regalo", "botella gratis", "mi regalo", "gift", "gratis")
_KEYBOARD_MASH = {"asdf", "asdfg", "qwer", "qwerty", "zxcv", "zxcvb",
                  "zxcvbn", "jkl", "lkjh", "poiuy", "hjkl"}

# In-memory conversation store (v1, same pattern as order_engine).
_intro_conversations = {}


@dataclass
class IntroConversation:
    customer_phone: str
    business_slug: str = BUSINESS_SLUG
    lang: str = ""
    state: str = "NEW"
    name: str = ""
    birthday_dm: str = ""          # normalized "DD/MM", "" when skipped
    registered: bool = False
    gift_status: str = ""          # 'pending' | 'minted' | '' (none)
    strikes: int = 0
    pending_signup: Optional[dict] = field(default=None)  # OS retry queue


def get_intro_conversation(customer_phone: str) -> IntroConversation:
    if customer_phone not in _intro_conversations:
        _intro_conversations[customer_phone] = IntroConversation(
            customer_phone=customer_phone)
    return _intro_conversations[customer_phone]


def reset_intro_conversation(convo: IntroConversation):
    _intro_conversations.pop(convo.customer_phone, None)


# ---------------------------------------------------------------- parsing

def _clean_name(raw: str) -> str:
    """Strip 'me llamo/soy...' fillers and title-case, keeping accents."""
    t = raw.strip().strip(" .!¡¿?")
    t = re.sub(r"^(me llamo|mi nombre es|yo soy|soy|me dicen)\s+", "",
               t, flags=re.IGNORECASE)
    t = re.sub(r"\s+", " ", t).strip(" .!¡¿?")
    if not t:
        return ""
    particles = {"de", "del", "la", "las", "los"}
    words = []
    for i, w in enumerate(t.split(" ")):
        lw = w.lower()
        if lw in particles and i > 0:
            words.append(lw)
        else:
            words.append(lw[:1].upper() + lw[1:])
    return " ".join(words)


def _looks_like_name(candidate: str) -> bool:
    """Heuristic gate for the name step (rules only; the parked hybrid
    LLM pass can soften this later). Rejects digits, symbols and
    keyboard mash; requires a vowel in every token of 3+ letters."""
    if not candidate or len(candidate) > 60:
        return False
    if any(ch.isdigit() for ch in candidate):
        return False
    letters = [ch for ch in candidate if ch.isalpha()]
    if len(letters) < 2:
        return False
    if not re.fullmatch(r"[A-Za-zÁÉÍÓÚÜÑáéíóúüñ'’.\- ]+", candidate):
        return False
    vowels = set("aeiouáéíóúü")
    for token in candidate.lower().split(" "):
        if len(token) >= 3:
            if token in _KEYBOARD_MASH:
                return False
            if not any(ch in vowels for ch in token):
                return False
    return True


def _extract_introduced_name(text: str) -> str:
    m = re.search(r"(?:me llamo|mi nombre es|yo soy|soy)\s+(.+)$",
                  text.strip(), flags=re.IGNORECASE)
    if not m:
        return ""
    candidate = _clean_name(m.group(1))
    return candidate if _looks_like_name(candidate) else ""


def _parse_birthday(text: str):
    """Return "DD/MM" or None. Accepts 15/03, 15-3, '15 de marzo',
    'marzo 15', 'March 15'."""
    t = text.strip().lower()
    m = re.search(r"\b(\d{1,2})\s*[/\-. ]\s*(\d{1,2})\b", t)
    if m:
        d, mo = int(m.group(1)), int(m.group(2))
        return _valid_dm(d, mo)
    months = {name: i + 1 for i, name in enumerate(MONTHS_ES)}
    months.update({name.lower(): i + 1 for i, name in enumerate(MONTHS_EN)})
    m = re.search(r"\b(\d{1,2})\s+de\s+([a-záéíóú]+)\b", t)
    if m and m.group(2) in months:
        return _valid_dm(int(m.group(1)), months[m.group(2)])
    m = re.search(r"\b([a-záéíóú]+)\s+(\d{1,2})\b", t)
    if m and m.group(1) in months:
        return _valid_dm(int(m.group(2)), months[m.group(1)])
    return None


def _valid_dm(day: int, month: int):
    if 1 <= month <= 12 and 1 <= day <= _DAYS_IN_MONTH[month - 1]:
        return f"{day:02d}/{month:02d}"
    return None


def _birthday_display(dm: str, lang: str) -> str:
    if not dm:
        return ""
    d, mo = dm.split("/")
    names = MONTHS_EN if lang == "en" else MONTHS_ES
    if lang == "en":
        return f"{names[int(mo) - 1]} {int(d)}"
    return f"{int(d)} de {names[int(mo) - 1]}"


def _qty_near(text: str, keyword_pattern: str) -> Optional[int]:
    """Quantity attached to a keyword: '2 paquetes', 'dos paquetes',
    'paquete de 5' is NOT a quantity (that's the pack size)."""
    t = text.lower()
    m = re.search(r"\b(\d{1,3})\s*(?:" + keyword_pattern + r")", t)
    if m:
        return int(m.group(1))
    for word, num in NUMWORDS.items():
        if re.search(r"\b" + word + r"\b\s*(?:" + keyword_pattern + r")", t):
            return num
    if re.search(r"\b(un|una|uno)\s+(?:" + keyword_pattern + r")", t):
        return 1
    return None


def parse_preventa(text: str, bare_keyword_counts: bool = True):
    """Return (packs, bottles, boxes) the customer is asking for.

    With bare_keyword_counts, a bare 'un paquete'/'la caja' counts as 1
    (right inside the preventa question, where intent is established).
    parse_preventa_explicit() requires a real number/word, for use in
    open conversation where '¿tienen paquetes?' is a question, not an
    order."""
    t = text.lower()
    packs = _qty_near(t, r"paquetes?|packs?|5[\s-]?pack") or 0
    boxes = _qty_near(t, r"cajas?") or 0
    bottles = _qty_near(t, r"botellas?") or 0
    if not bare_keyword_counts:
        return packs, bottles, boxes
    if packs == 0 and re.search(r"\bpaquetes?\b", t) and not re.search(
            r"paquete\s+de\s+5", t):
        packs = 1
    if boxes == 0 and re.search(r"\b(caja|cajas)\b", t):
        boxes = 1
    return packs, bottles, boxes


def parse_preventa_explicit(text: str):
    return parse_preventa(text, bare_keyword_counts=False)


def preventa_total(packs: int, bottles: int, boxes: int) -> int:
    return packs * PACK5_PREVENTA + bottles * BOTTLE_PRICE + boxes * BOX_PRICE


def _preventa_lines(packs: int, bottles: int, boxes: int, lang: str):
    lines = []
    if lang == "en":
        if packs:
            lines.append(f"{packs}x 5-pack (preventa) — L.{packs * PACK5_PREVENTA}")
        if bottles:
            lines.append(f"{bottles}x bottle — L.{bottles * BOTTLE_PRICE}")
        if boxes:
            lines.append(f"{boxes}x box of {BOX_MIN} — L.{boxes * BOX_PRICE}")
    else:
        if packs:
            lines.append(f"{packs}x paquete de 5 (preventa) — L.{packs * PACK5_PREVENTA}")
        if bottles:
            lines.append(f"{bottles}x botella — L.{bottles * BOTTLE_PRICE}")
        if boxes:
            lines.append(f"{boxes}x caja de {BOX_MIN} — L.{boxes * BOX_PRICE}")
    return lines


# ---------------------------------------------------------------- texts

def _prices_text(lang: str) -> str:
    if lang == "en":
        return ("Our bottled coffee (12oz):\n"
                f"• Bottle — L.{BOTTLE_PRICE} each\n"
                f"• 5-pack PREVENTA — L.{PACK5_PREVENTA} (in store L.{PACK5_COUNTER})\n"
                f"• Box of {BOX_MIN}+ — L.{BOX_UNIT} per bottle")
    return ("Nuestro café embotellado (12oz):\n"
            f"• Botella — L.{BOTTLE_PRICE} c/u\n"
            f"• Paquete de 5 en PREVENTA — L.{PACK5_PREVENTA} (en tienda L.{PACK5_COUNTER})\n"
            f"• Caja de {BOX_MIN}+ — L.{BOX_UNIT} por botella")


def _greeting_text(lang: str) -> str:
    if lang == "en":
        return ("Hi! ☕ Welcome to *Rich Aroma* in Quimistán. "
                "We reopen on *November 7* 🎉\n"
                "Create your account today and get *a free bottle* "
                "with your first purchase.\n"
                "What's your name?")
    return ("¡Hola! ☕ Bienvenido a *Rich Aroma* en Quimistán. "
            "Reabrimos el *7 de noviembre* 🎉\n"
            "Creá tu cuenta hoy y recibí *una botella gratis* "
            "con tu primera compra.\n"
            "¿Cómo te llamás?")


def _birthday_ask(name: str, lang: str) -> str:
    first = name.split(" ")[0] if name else ""
    if lang == "en":
        return (f"Nice to meet you, {first}! 🎂\n"
                "What's your birthday? (day/month, e.g. 15/03) — it's "
                "optional, we only use it to surprise you. "
                "Type 'skip' if you'd rather not say.")
    return (f"¡Mucho gusto, {first}! 🎂\n"
            "¿Nos contás tu cumpleaños? (día/mes, ej: 15/03) — es "
            "opcional, solo lo usamos para sorprenderte. "
            "Escribí 'saltar' si preferís no decirlo.")


def _confirm_text(convo: "IntroConversation") -> str:
    lang = convo.lang
    bday = _birthday_display(convo.birthday_dm, lang)
    if lang == "en":
        bday_line = bday if bday else "(no birthday)"
        return (f"This is what I'll save:\n"
                f"• Name: {convo.name}\n"
                f"• Birthday: {bday_line}\n"
                "Is that right? Reply 'yes' to save it, or send me "
                "the correct name or date.")
    bday_line = bday if bday else "(sin cumpleaños)"
    return (f"Esto es lo que voy a guardar:\n"
            f"• Nombre: {convo.name}\n"
            f"• Cumpleaños: {bday_line}\n"
            "¿Está bien? Respondé 'sí' para guardar, o escribime "
            "el nombre o la fecha correcta.")


def _gift_saved_text(convo: "IntroConversation") -> str:
    first = convo.name.split(" ")[0] if convo.name else ""
    if convo.lang == "en":
        return (f"Done, {first}! 🎉 Your account is created and your "
                "gift is noted: *L.100 of Rico Cash* for house-made "
                "items, ready to use with your first purchase.\n"
                "Heads up: gifts have an expiry date, so use it at "
                "the reopening 😉")
    return (f"¡Listo, {first}! 🎉 Tu cuenta quedó creada y tu regalo "
            "quedó anotado: *L.100 de regalo en tu Rico Cash* para "
            "productos hechos en casa, listo para usar con tu "
            "primera compra.\n"
            "Ojo: los regalos tienen fecha de vencimiento, así que "
            "aprovechalo en la reapertura 😉")


def _preventa_offer(lang: str) -> str:
    if lang == "en":
        return ("\nYou can also reserve your bottles now in *preventa*:\n"
                + _prices_text("en") +
                "\nHow many 5-packs do you want? (e.g. '1 pack') "
                "— or 'not now'.")
    return ("\nAdemás, ya podés apartar tus botellas en *preventa*:\n"
            + _prices_text("es") +
            "\n¿Cuántos paquetes de 5 querés apartar? (ej: '1 paquete') "
            "— o 'no por ahora'.")


def _preventa_recorded_text(packs, bottles, boxes, lang: str) -> str:
    lines = _preventa_lines(packs, bottles, boxes, lang)
    total = preventa_total(packs, bottles, boxes)
    if lang == "en":
        return ("Noted! ✅\n" + "\n".join(lines) +
                f"\n*Total: L.{total}*\n"
                "Payment is by transfer — our team will confirm here "
                "when it arrives. Your order is reserved under your "
                "name. 🙌")
    return ("¡Anotado! ✅\n" + "\n".join(lines) +
            f"\n*Total: L.{total}*\n"
            "El pago es por transferencia; el equipo te confirma por "
            "acá cuando lo recibe. Tu pedido queda apartado a tu "
            "nombre. 🙌")


def _menu_park_text(lang: str) -> str:
    if lang == "en":
        return ("The full menu arrives with the reopening on "
                "*November 7* 🗓️ — lattes, frappés, baleadas, "
                "panadería y más. For now I can reserve bottled "
                "coffee for you in preventa.")
    return ("El menú completo llega con la reapertura el "
            "*7 de noviembre* 🗓️ — lattes, frappés, baleadas, "
            "panadería y más. Por ahora te puedo apartar café "
            "embotellado en preventa.")


def _gift_status_text(convo: "IntroConversation") -> str:
    first = convo.name.split(" ")[0] if convo.name else ""
    if convo.lang == "en":
        if convo.gift_status == "minted":
            return (f"Your L.100 gift is already in your Rico Cash, "
                    f"{first} 🎁 Use it with your first purchase — "
                    "gifts have an expiry date.")
        return (f"Your L.100 gift is noted and waiting for your "
                f"first purchase, {first} 🎁 It's for house-made "
                "items, and gifts have an expiry date.")
    if convo.gift_status == "minted":
        return (f"Tu regalo de L.100 ya está en tu Rico Cash, "
                f"{first} 🎁 Usalo con tu primera compra — los "
                "regalos tienen fecha de vencimiento.")
    return (f"Tu regalo de L.100 está anotado y te espera en tu "
            f"primera compra, {first} 🎁 Es para productos hechos "
            "en casa, y los regalos tienen fecha de vencimiento.")


def _returning_greeting(convo: "IntroConversation") -> str:
    first = convo.name.split(" ")[0] if convo.name else ""
    if convo.lang == "en":
        return (f"Hi again, {first}! ☕ Good to see you.\n"
                + _gift_status_text(convo))
    return f"¡Hola de nuevo, {first}! ☕ Qué bueno verte por acá.\n" \
        + _gift_status_text(convo)


# ---------------------------------------------------------------- helpers

def _record_local(kind: str, convo: "IntroConversation", extra: dict):
    """Local durable copy on the bot (orders/<slug>.jsonl), mirroring
    the 'persisted first, pushed second' rule. Never raises."""
    try:
        save_order(convo.business_slug, {
            "type": kind,
            "channel": "whatsapp",
            "customer_phone": convo.customer_phone,
            "customer_name": convo.name,
            "status": "new",
            **extra,
        })
    except Exception as e:
        print(f"[intro] local record failed ({kind}): {e}", flush=True)


def _handoff(convo: "IntroConversation", stage: str) -> str:
    _record_local("intro_handoff", convo, {"stage": stage})
    convo.state = "HANDOFF"
    if convo.lang == "en":
        return ("I think it's better if the team helps you directly 🙏 "
                "I've noted your number for them. You can also reach "
                f"us on Instagram: {INSTAGRAM}")
    return ("Creo que es mejor que te atienda el equipo directamente 🙏 "
            "Ya les dejo tu número anotado. También podés escribirnos "
            f"por Instagram: {INSTAGRAM}")


def _do_signup(convo: "IntroConversation") -> bool:
    """Create/fetch the OS account + pending gift. True when the OS
    confirms; on failure the signup is queued locally for retry."""
    res = os_client.signup_customer(convo.customer_phone, convo.name,
                                    convo.birthday_dm)
    if res.get("ok") and res.get("data"):
        data = res["data"]
        gift = data.get("gift") or {}
        convo.gift_status = gift.get("status") or "pending"
        convo.registered = True
        convo.pending_signup = None
        return True
    convo.pending_signup = {"name": convo.name,
                            "birthday": convo.birthday_dm}
    _record_local("intro_signup_pending", convo,
                  {"birthday_dm": convo.birthday_dm})
    convo.registered = True  # recorded durably; OS sync retries later
    convo.gift_status = "pending"
    print(f"[intro] signup OS call failed for {convo.customer_phone}: "
          f"{res.get('error')}", flush=True)
    return False


def _retry_pending_signup(convo: "IntroConversation"):
    if not convo.pending_signup:
        return
    res = os_client.signup_customer(convo.customer_phone,
                                    convo.pending_signup["name"],
                                    convo.pending_signup.get("birthday", ""))
    if res.get("ok"):
        gift = (res.get("data") or {}).get("gift") or {}
        convo.gift_status = gift.get("status") or convo.gift_status
        convo.pending_signup = None


def _record_preventa(convo: "IntroConversation", packs, bottles, boxes):
    res = os_client.record_preventa(convo.customer_phone, packs,
                                    bottles, boxes)
    if not res.get("ok"):
        _record_local("preventa_intent", convo, {
            "packs": packs, "bottles": bottles, "boxes": boxes,
            "total": preventa_total(packs, bottles, boxes),
            "os_error": res.get("error"),
        })
        print(f"[intro] preventa OS call failed for "
              f"{convo.customer_phone}: {res.get('error')}", flush=True)


def _is_yes(t: str) -> bool:
    t = t.strip().lower().strip(" .!¡¿?")
    return t in YES_CUES or t.startswith("sí ") or t.startswith("si ")


def _is_skip(t: str) -> bool:
    t = t.strip().lower()
    return t in ("no",) or any(c in t for c in SKIP_CUES)


def _has_cue(t: str, cues) -> bool:
    t = t.lower()
    return any(c in t for c in cues)


# ---------------------------------------------------------------- engine

def reply_for_intro(convo: IntroConversation, incoming_text: str) -> str:
    """One message in, one reply out. Tenant: rich-aroma-honduras."""
    text = (incoming_text or "").strip()
    t = text.lower()
    if not convo.lang:
        convo.lang = detect_language(text, default="es")
    lang = convo.lang

    _retry_pending_signup(convo)

    # ---------------- first contact ----------------
    if convo.state == "NEW":
        res = os_client.lookup_customer(convo.customer_phone)
        data = res.get("data") if res.get("ok") else None
        if data and data.get("found"):
            cust = data.get("customer") or {}
            convo.name = cust.get("name") or convo.name
            gift = data.get("gift") or {}
            convo.gift_status = gift.get("status") or ""
            convo.registered = True
            convo.state = "LOUNGE"
            if not convo.gift_status:
                convo.state = "RETURNING_NO_GIFT"
                if lang == "en":
                    return (f"Hi again, {convo.name.split(' ')[0]}! ☕ "
                            "I see your account, but your welcome gift "
                            "isn't noted yet. Want me to add it? "
                            "It's *L.100 of Rico Cash* (a free bottle) "
                            "for your first purchase. Reply 'yes'.")
                return (f"¡Hola de nuevo, {convo.name.split(' ')[0]}! ☕ "
                        "Veo tu cuenta, pero tu regalo de bienvenida "
                        "todavía no está anotado. ¿Te lo anoto? Son "
                        "*L.100 de regalo en tu Rico Cash* (una botella "
                        "gratis) para tu primera compra. Respondé 'sí'.")
            # Registered: answer a direct intent right away if present.
            packs, bottles, boxes = parse_preventa_explicit(text)
            if packs or bottles or boxes:
                _record_preventa(convo, packs, bottles, boxes)
                return (_returning_greeting(convo) + "\n"
                        + _preventa_recorded_text(packs, bottles,
                                                  boxes, lang))
            if _has_cue(t, MENU_CUES):
                return (_returning_greeting(convo) + "\n"
                        + _menu_park_text(lang) + _preventa_offer(lang))
            if _has_cue(t, PRICE_CUES):
                return _returning_greeting(convo) + "\n" + _prices_text(lang) \
                    + _preventa_offer(lang)
            return _returning_greeting(convo) + _preventa_offer(lang)

        # New customer.
        convo.state = "ASK_NAME"
        introduced = _extract_introduced_name(text)
        if introduced:
            convo.name = introduced
            convo.state = "ASK_BIRTHDAY"
            return _birthday_ask(convo.name, lang)
        if _has_cue(t, MENU_CUES):
            return (_menu_park_text(lang) + "\n\n" + _greeting_text(lang))
        if _has_cue(t, PRICE_CUES):
            return (_prices_text(lang) + "\n\n" + _greeting_text(lang))
        return _greeting_text(lang)

    # ---------------- credential safety ----------------
    # The bot NEVER asks for a PIN, password or card data. If the
    # customer brings one up, say so plainly and return to the flow —
    # this reassurance is part of the product (phishing is real).
    if _has_cue(t, ("pin", "contraseña", "contrasena", "password",
                    "número de tarjeta", "numero de tarjeta",
                    "clave")):
        if lang == "en":
            return ("Heads up ⚠️ We will *never* ask for your PIN, "
                    "passwords or card details in this chat. Preventa "
                    "payment is by transfer and the team confirms it. "
                    "If anyone asks you for that, it isn't us.")
        return ("¡Ojo! ⚠️ Nosotros *nunca* te vamos a pedir tu PIN, "
                "contraseñas ni datos de tu tarjeta por este chat. "
                "El pago de la preventa es por transferencia y lo "
                "confirma el equipo. Si alguien te lo pide, no "
                "somos nosotros.")

    # ---------------- signup steps ----------------
    if convo.state == "ASK_NAME":
        if any(c in t for c in ("no quiero", "no gracias",
                                "prefiero no", "mejor no")):
            convo.strikes += 1
            if convo.strikes >= 2:
                return _handoff(convo, "ask_name_refused")
            if lang == "en":
                return ("No problem at all! I do need a name for "
                        "the account and the gift — what should I "
                        "put? (Just your first name is fine.)")
            return ("¡Sin problema! Solo que para tu cuenta y tu "
                    "regalo sí necesito un nombre — ¿cuál pongo? "
                    "(Con tu primer nombre basta.)")
        candidate = _clean_name(text)
        if _looks_like_name(candidate):
            convo.name = candidate
            convo.strikes = 0
            convo.state = "ASK_BIRTHDAY"
            return _birthday_ask(convo.name, lang)
        convo.strikes += 1
        if convo.strikes >= 2:
            return _handoff(convo, "ask_name")
        if lang == "en":
            return ("Sorry, I didn't catch that 🙏 "
                    "What's your name? (e.g. María José)")
        return ("Perdón, no lo capté 🙏 "
                "¿Cómo te llamás? (ej: María José)")

    if convo.state == "ASK_BIRTHDAY":
        if _is_skip(t):
            convo.birthday_dm = ""
            convo.strikes = 0
            convo.state = "CONFIRM"
            return _confirm_text(convo)
        parsed = _parse_birthday(text)
        if parsed:
            convo.birthday_dm = parsed
            convo.strikes = 0
            convo.state = "CONFIRM"
            return _confirm_text(convo)
        convo.strikes += 1
        if convo.strikes >= 2:
            return _handoff(convo, "ask_birthday")
        if lang == "en":
            return ("I couldn't read that date 🙏 Use day/month "
                    "(e.g. 15/03), or type 'skip'.")
        return ("No pude leer esa fecha 🙏 Escribila día/mes "
                "(ej: 15/03), o 'saltar' si preferís no decirla.")

    if convo.state == "CONFIRM":
        if _is_yes(t):
            _do_signup(convo)
            convo.strikes = 0
            convo.state = "PREVENTA"
            return _gift_saved_text(convo) + _preventa_offer(lang)
        if t.strip(" .!¡¿?") in ("no", "n", "nop", "nope"):
            if lang == "en":
                return ("No problem — what should I fix: your name "
                        "or your birthday? Send me the correct one.")
            return ("Sin problema — ¿qué corrijo: tu nombre o tu "
                    "cumpleaños? Escribime el dato correcto.")
        parsed = _parse_birthday(text)
        if parsed:
            convo.birthday_dm = parsed
            convo.strikes = 0
            return _confirm_text(convo)
        candidate = _clean_name(text)
        if (len(candidate) >= 3 and _looks_like_name(candidate)
                and candidate != convo.name):
            convo.name = candidate
            convo.strikes = 0
            return _confirm_text(convo)
        convo.strikes += 1
        if convo.strikes >= 2:
            return _handoff(convo, "confirm")
        if lang == "en":
            return ("Tell me 'yes' to save it, or send the correct "
                    "name or birthday date.")
        return ("Decime 'sí' para guardar, o escribime el nombre "
                "o la fecha correcta.")

    if convo.state == "RETURNING_NO_GIFT":
        if _is_yes(t):
            _do_signup(convo)
            convo.state = "PREVENTA"
            return _gift_saved_text(convo) + _preventa_offer(lang)
        convo.state = "LOUNGE"
        if lang == "en":
            return ("No problem! Your account stays as is. "
                    + _preventa_offer(lang).lstrip())
        return ("¡Sin problema! Tu cuenta queda como está. "
                + _preventa_offer(lang).lstrip())

    # ---------------- preventa ----------------
    if convo.state == "PREVENTA":
        packs, bottles, boxes = parse_preventa(text)
        if packs or bottles or boxes:
            _record_preventa(convo, packs, bottles, boxes)
            convo.state = "LOUNGE"
            return _preventa_recorded_text(packs, bottles, boxes, lang)
        if t.strip(" .!¡¿?") in NO_CUES:
            convo.state = "LOUNGE"
            if lang == "en":
                return ("No problem! See you on *November 7* 🎉 "
                        "Write anytime if you change your mind.")
            return ("¡Sin problema! Nos vemos el *7 de noviembre* 🎉 "
                    "Escribinos cuando quieras si cambiás de idea.")
        if _has_cue(t, MENU_CUES):
            return (_menu_park_text(lang)
                    + "\n¿Apartamos un paquete de 5? Decime la "
                      "cantidad o 'no por ahora'."
                    if lang != "en" else
                    _menu_park_text(lang)
                    + "\nShall we reserve a 5-pack? Tell me how many "
                      "or 'not now'.")
        if _has_cue(t, PRICE_CUES):
            return (_prices_text(lang)
                    + "\n¿Te aparto algún paquete? Decime la cantidad."
                    if lang != "en" else
                    _prices_text(lang)
                    + "\nWant me to reserve a pack? Tell me how many.")
        if _is_yes(t) or "quiero" in t or "want" in t:
            if lang == "en":
                return ("Great! How many 5-packs? (L.350 each) "
                        "You can also ask for single bottles or a "
                        "box of 20.")
            return ("¡Dale! ¿Cuántos paquetes de 5? (L.350 c/u) "
                    "También podés pedir botellas sueltas o caja de 20.")
        if lang == "en":
            return ("Tell me how many 5-packs you'd like "
                    "(e.g. '1 pack'), or 'not now'.")
        return ("Decime cuántos paquetes de 5 querés (ej: '1 "
                "paquete'), o 'no por ahora'.")

    # ---------------- lounge (registered) ----------------
    if convo.state == "LOUNGE":
        if _has_cue(t, MENU_CUES):
            return _menu_park_text(lang) + _preventa_offer(lang)
        if _has_cue(t, PRICE_CUES):
            return _prices_text(lang) + _preventa_offer(lang)
        packs, bottles, boxes = parse_preventa_explicit(text)
        if (packs or bottles or boxes) and _has_cue(
                t, ("quiero", "apart", "reserv", "dame", "want",
                    "reserve", "book")):
            _record_preventa(convo, packs, bottles, boxes)
            return _preventa_recorded_text(packs, bottles, boxes, lang)
        if _has_cue(t, GIFT_CUES):
            return _gift_status_text(convo)
        if _has_cue(t, ("botella", "botellas")):
            return _prices_text(lang) + _preventa_offer(lang)
        if _has_cue(t, ("paquete", "preventa", "apartar", "reservar",
                        "pack")):
            convo.state = "PREVENTA"
            if lang == "en":
                return ("Great — how many 5-packs? (L.350 each) "
                        "Or single bottles / a box of 20.")
            return ("¡Dale! ¿Cuántos paquetes de 5? (L.350 c/u) "
                    "O botellas sueltas / caja de 20.")
        if t.strip(" .!¡¿?") in ("hola", "buenas", "hello", "hi"):
            first = convo.name.split(" ")[0] if convo.name else ""
            if lang == "en":
                return (f"Hi, {first}! ☕ Want to reserve bottles in "
                        "preventa, or check your gift? Just tell me.")
            return (f"¡Hola, {first}! ☕ ¿Apartamos botellas en "
                    "preventa o revisamos tu regalo? Contame.")
        if lang == "en":
            return ("I can help you reserve bottles in preventa, "
                    "check your L.100 gift, or answer price questions. "
                    "The full menu arrives November 7 🗓️")
        return ("Te puedo ayudar a apartar botellas en preventa, "
                "revisar tu regalo de L.100 o contarte precios. "
                "El menú completo llega el 7 de noviembre 🗓️")

    # ---------------- handoff holding pattern ----------------
    if convo.state == "HANDOFF":
        if lang == "en":
            return ("The team has your number and will write soon 🙏 "
                    f"You can also reach us on Instagram: {INSTAGRAM}")
        return ("El equipo ya tiene tu número y te escribe pronto 🙏 "
                f"También podés escribirnos por Instagram: {INSTAGRAM}")

    convo.state = "NEW"
    return reply_for_intro(convo, incoming_text)
