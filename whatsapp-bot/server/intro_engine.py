"""
Intro engine for Rich Aroma Honduras (Quimistán) — tenant rich-aroma-honduras ONLY.

Scope (owner decision, 2026-10-25; ordering added by the
bot-finalize build, 2026-10-26): a customer texts the shop number
and gets a short get-to-know-you session:
  1. greeting,
  2. nombre (required) and cumpleaños día/mes (optional, skippable),
  3. confirm/correct, then the account is created in the OS,
  4. the preventa (bottle preorder) offer, intent captured for the owner.
Once registered (the LOUNGE), the customer can also see the real OS
menu and order from it end to end — that half lives in
shop_engine.py and engages only when a menu catalog is available;
with no catalog, every reply below is exactly what it was before.

The OS (Supabase customers, phone-keyed) is the system of record; this
module talks to it only through os_client.py (shared-secret,
server-to-server).

The L.100 Rico Cash WELCOME GIFT was RETIRED by owner decision
(bot-menu-fix, 2026-10-26): signup mints nothing and no copy
promises it; a customer who asks about "mi regalo" gets one honest
line (the welcome gift is no longer active) plus what Rico Cash
still is — every purchase earns 10% back in Rico Cash. Rico Cash
itself is untouched: the 10% earn, recarga bonuses, mission
rewards and creator credit all stay. Pending welcome rows created
before the cutoff were left in the OS exactly as they are; their
fate is a separate owner decision.

Payment for a preventa is by transfer, confirmed by a human. This bot
NEVER asks for a PIN or any payment credential in chat.

Missions (Misiones del Capitán): a paid purchase in the OS can unlock
a UGC mission for the customer. This bot only RECEIVES: on lounge
contact it announces an unlocked assignment once (pull model — the
bot never cold-sends; every message rides a customer-opened window),
accepts the customer's post link (Instagram/Facebook/TikTok) via
whatsapp_mission_submit, and answers status questions via
whatsapp_mission_check. Approval and the gift mint live in the OS /
loyalty build — mission copy here never promises a spendable balance
and never mentions reviews or ratings.

Attribution (Creadores): every creator has a signup word. A customer
who arrives carrying one — "palabra X", "vengo de X", or the bare
word as a first message — gets bound to that creator in the OS
(first-touch, permanent; the OS owns normalization and the rules).
Detection is deliberately conservative: it runs at first contact,
while confirming a signup, and in the lounge — NEVER in the
name/birthday steps, where an answer is data, not a word. A word
captured before signup rides the signup call as ref_word; a word
from an already-registered customer goes through
whatsapp_attribute. Speculative (bare-word) attempts the OS doesn't
recognize stay SILENT — the customer was never promised anything.
(The RETURNING_NO_GIFT state that used to be a fourth word-detection
point was retired with the welcome gift, 2026-10-26.)

Cali is GONE (bot-finalize, 2026-10-26): the old Cali order
engine was removed — webhook.py routes only the
rich-aroma-honduras slug here, and order_engine.py survives as a
helpers/compatibility shell with no menu and no prices.
"""

import re
from dataclasses import dataclass, field
from typing import Optional

try:
    import os_client
    import shop_engine
    from orders import save_order
    from order_engine import detect_language, NUMBER_WORDS as _ENGINE_NUMWORDS
    from wa_reply import WaReply
except ImportError:  # running as part of the server package
    from server import os_client
    from server import shop_engine
    from server.orders import save_order
    from server.order_engine import detect_language, NUMBER_WORDS as _ENGINE_NUMWORDS
    from server.wa_reply import WaReply

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
    strikes: int = 0
    pending_signup: Optional[dict] = field(default=None)  # OS retry queue
    # Mission assignment_ids already announced in THIS conversation
    # (in-memory, like the rest of the convo state — a redeploy resets
    # it and an assignment may be announced once more; see build note).
    missions_delivered: set = field(default_factory=set)
    mission_cache: Optional[dict] = field(default=None)  # per-turn check cache
    # Creator signup word (Creadores) captured pre-signup, carried
    # into whatsapp_signup as ref_word; attribution_note is the
    # one-line confirmation appended to the signup-completion reply
    # when the OS binds the word ("" when it didn't).
    pending_word: str = ""
    attribution_note: str = ""
    # Shop ordering cart (shop_engine.py): None while the customer
    # isn't mid-order. Lives here so the intro state can stay LOUNGE
    # for the whole order (missions pull-delivery keeps working).
    shop_cart: Optional[dict] = field(default=None)
    # Menu browsing (bot-menu-fix): the curated section ids as last
    # presented by shop_engine.menu_reply, in order — a bare number
    # reply ("respondé con el número") opens that section.
    menu_sections: list = field(default_factory=list)


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
                "Create your account in a minute and you're ready "
                "to order.\n"
                "What's your name?")
    return ("¡Hola! ☕ Bienvenido a *Rich Aroma* en Quimistán. "
            "Reabrimos el *7 de noviembre* 🎉\n"
            "Creá tu cuenta en un minuto y quedás listo para "
            "pedir.\n"
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


def _account_created_text(convo: "IntroConversation") -> str:
    """Signup completion. (The old copy also announced the L.100
    welcome gift — retired 2026-10-26; what Rico Cash still is gets
    one honest line instead, no balance promised.)"""
    first = convo.name.split(" ")[0] if convo.name else ""
    if convo.lang == "en":
        return (f"Done, {first}! 🎉 Your account is created.\n"
                "Every purchase earns you *10% back in Rico Cash* "
                "for house-made items 😉")
    return (f"¡Listo, {first}! 🎉 Tu cuenta quedó creada.\n"
            "Con cada compra ganás el *10% en Rico Cash* para "
            "productos hechos en casa 😉")


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


def _gift_retired_text(convo: "IntroConversation") -> str:
    """The honest answer to '¿y mi regalo?' since the welcome gift
    was retired (owner decision, 2026-10-26): one short line, no
    promised balance — plus what Rico Cash still is."""
    if convo.lang == "en":
        return ("The welcome gift isn't active anymore 🙏 But "
                "your Rico Cash is alive and well: every purchase "
                "earns you *10% in Rico Cash* for house-made "
                "items 🎁")
    return ("El regalo de bienvenida ya no está activo 🙏 Pero "
            "tu Rico Cash sigue vivo: con cada compra ganás el "
            "*10% en Rico Cash* para productos hechos en casa 🎁")


def _returning_greeting(convo: "IntroConversation") -> str:
    first = convo.name.split(" ")[0] if convo.name else ""
    if convo.lang == "en":
        return f"Hi again, {first}! ☕ Good to see you."
    return f"¡Hola de nuevo, {first}! ☕ Qué bueno verte por acá."


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
    """Create/fetch the OS account. True when the OS confirms; on
    failure the signup is queued locally for retry. (No grant is
    requested or read — the welcome gift was retired 2026-10-26;
    the OS gates off minting too.)"""
    convo.attribution_note = ""
    res = os_client.signup_customer(convo.customer_phone, convo.name,
                                    convo.birthday_dm,
                                    ref_word=convo.pending_word)
    if res.get("ok") and res.get("data"):
        data = res["data"]
        convo.registered = True
        convo.pending_signup = None
        att = data.get("attribution") or {}
        if att.get("attributed"):
            convo.attribution_note = _ligada_line(
                convo, att.get("creator_name") or convo.pending_word)
        convo.pending_word = ""
        return True
    convo.pending_signup = {"name": convo.name,
                            "birthday": convo.birthday_dm}
    _record_local("intro_signup_pending", convo,
                  {"birthday_dm": convo.birthday_dm})
    convo.registered = True  # recorded durably; OS sync retries later
    print(f"[intro] signup OS call failed for {convo.customer_phone}: "
          f"{res.get('error')}", flush=True)
    return False


def _retry_pending_signup(convo: "IntroConversation"):
    if not convo.pending_signup:
        return
    res = os_client.signup_customer(convo.customer_phone,
                                    convo.pending_signup["name"],
                                    convo.pending_signup.get("birthday", ""),
                                    ref_word=convo.pending_word)
    if res.get("ok"):
        convo.pending_signup = None
        # The word rode this retry too; once the signup lands it has
        # been attempted — win or lose, it doesn't ride again. (The
        # OS row is what matters; the ligada line is a nicety that
        # only fires on the interactive path.)
        convo.pending_word = ""


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


# ---------------------------------------------------------------- missions

MISSION_CUES = ("misión", "mision", "misiones", "mission")
SOCIAL_HOSTS = ("instagram.com", "facebook.com", "tiktok.com")
_URL_TOKEN_RE = re.compile(r"(?:https?://)?[a-z0-9.-]+\.[a-z]{2,}(?:/[^\s]*)?",
                           re.IGNORECASE)


def _extract_social_url(text: str) -> str:
    """First Instagram/Facebook/TikTok URL in the message, or ''.
    Host match is exact-or-subdomain, so lookalike hosts don't count
    (and neither do vm./www. short forms of other sites)."""
    for m in _URL_TOKEN_RE.finditer(text or ""):
        raw = m.group(0).strip(".,)\"'”>")
        host = raw.split("://", 1)[-1].split("/", 1)[0].lower()
        if any(host == h or host.endswith("." + h) for h in SOCIAL_HOSTS):
            return raw if raw.lower().startswith("http") else "https://" + raw
    return ""


def _mission_check(convo: "IntroConversation"):
    """whatsapp_mission_check, cached for the current message turn.
    Returns the data dict, or None when the OS can't answer (treated
    as 'no missions' — a mission hiccup must never break the chat)."""
    if convo.mission_cache is not None:
        return convo.mission_cache or None
    res = os_client.mission_check(convo.customer_phone)
    data = res.get("data") if res.get("ok") else None
    convo.mission_cache = data if isinstance(data, dict) else {}
    return convo.mission_cache or None


def _sub_status(assignment: dict) -> str:
    """Submission status of an assignment, read tolerantly (the OS may
    nest it or flatten it): 'pending' | 'approved' | 'rejected' | ''."""
    s = assignment.get("submission_status")
    if isinstance(s, dict):
        s = s.get("status")
    if not s and isinstance(assignment.get("submission"), dict):
        s = assignment["submission"].get("status")
    return str(s or "").strip().lower()


def _a_status(assignment: dict) -> str:
    return str(assignment.get("status") or "").strip().lower()


def _mission_brief(assignment: dict) -> str:
    brief = str(assignment.get("brief") or "").strip()
    if brief:
        return brief
    name = assignment.get("name") or "Misión del Capitán"
    amt = assignment.get("reward_amount")
    tail = f" Premio: L.{amt} de regalo en tu Rico Cash." if amt else ""
    return (f"{name}: publicá una foto o video con tu compra, "
            f"etiquetanos y mandame el link por acá.{tail}")


def _undelivered_missions(convo: "IntroConversation"):
    """Unlocked, unsubmitted assignments this conversation has not
    announced yet."""
    data = _mission_check(convo)
    if not data:
        return []
    out = []
    for a in data.get("assignments") or []:
        if not isinstance(a, dict):
            continue
        if _sub_status(a):
            continue  # already submitted — status answers cover it
        if _a_status(a) not in ("", "unlocked", "active"):
            continue
        if a.get("assignment_id") in convo.missions_delivered:
            continue
        out.append(a)
    return out


def _mission_delivery_text(convo: "IntroConversation", a: dict) -> str:
    first = convo.name.split(" ")[0] if convo.name else ""
    brief = _mission_brief(a)
    if convo.lang == "en":
        return f"\n🎁 You have a MISSION from the Captain, {first}! {brief}"
    return f"\n🎁 ¡Tenés una MISIÓN del Capitán, {first}! {brief}"


def _append_mission_delivery(convo: "IntroConversation", start_state: str,
                             incoming_text: str, reply: str) -> str:
    """Pull-model mission announcement. Fires only when the customer
    was already in the LOUNGE as this message arrived — a follow-up
    message in the sitting, or any later day (the conversation
    persists) — so the turn that first lands a customer in the lounge
    keeps the greeting flow's exact shape. Their actual question is
    answered first; the mission rides after, once per assignment."""
    if start_state != "LOUNGE" or convo.state != "LOUNGE":
        return reply
    if not convo.registered:
        return reply
    if _extract_social_url(incoming_text):
        return reply  # the link intake already answered this turn
    if _has_cue(incoming_text.lower(), MISSION_CUES):
        return reply  # the status answer already covered missions
    pending = _undelivered_missions(convo)
    if not pending:
        return reply
    first = pending[0]
    convo.missions_delivered.add(first.get("assignment_id"))
    line = _mission_delivery_text(convo, first)
    if isinstance(reply, WaReply):
        # A menu presentation carries the mission line in BOTH its
        # renderings (interactive body + text fallback).
        return reply.append(line.lstrip("\n"))
    return reply + line


def _submit_mission_link(convo: "IntroConversation", url: str) -> str:
    """Register a post link with the OS and render its verdict. The OS
    validates (active mission, link, duplicate, expiry) and owns the
    approval queue — the bot never approves or mints anything."""
    lang = convo.lang
    res = os_client.mission_submit(convo.customer_phone, url)
    data = res.get("data") if res.get("ok") else None
    if not isinstance(data, dict) or "ok" not in data:
        _record_local("mission_submit_pending", convo,
                      {"post_url": url, "os_error": res.get("error")})
        if lang == "en":
            return ("I couldn't register that link just now 🙏 "
                    "Send it again in a little while.")
        return ("No pude registrar ese link ahorita 🙏 "
                "Mandalo de nuevo en un ratito.")
    if data.get("ok"):
        if lang == "en":
            return ("Received! 📸 The Captain reviews your post today "
                    "and I'll let you know here. If it's approved, "
                    "your gift lands right in your Rico Cash 🎁")
        return ("¡Recibido! 📸 El Capitán revisa tu publicación hoy "
                "y te aviso por acá. Si se aprueba, tu regalo cae "
                "directo en tu Rico Cash 🎁")
    reason = str(data.get("reason") or "")
    if reason == "duplicate_link":
        if lang == "en":
            return ("That link is already registered in a mission 🙏 "
                    "Got another post?")
        return ("Ese link ya está registrado en una misión 🙏 "
                "¿Tenés otra publicación?")
    if reason == "no_active_mission":
        if lang == "en":
            return ("You don't have an active mission right now 🎯 "
                    "Missions unlock when you buy — order something "
                    "tasty and yours will drop 😉")
        return ("Por ahora no tenés una misión activa 🎯 Las "
                "misiones se desbloquean al comprar — pedí algo "
                "rico y te cae la tuya 😉")
    if reason == "expired":
        if lang == "en":
            return ("That mission already expired 🕐 More are "
                    "coming — your next purchase can unlock a new one.")
        return ("Esa misión ya venció 🕐 Pero vienen más — con tu "
                "próxima compra te puede caer una nueva.")
    # bad_link (or anything unexpected): plain and kind.
    if lang == "en":
        return ("I couldn't validate that link as a post 🙏 Check "
                "it's your post's link on Instagram, Facebook or "
                "TikTok and send it again.")
    return ("Ese link no lo pude validar como publicación 🙏 "
            "Revisá que sea el link de tu post en Instagram, "
            "Facebook o TikTok y mandalo de nuevo.")


WHY_CUES = ("por qué", "porque", "por que", "no tengo", "no me llegó",
            "no me llego", "no recibí", "no recibi", "no me cayó",
            "no me cayo", "why")


def _completions_count(data: dict):
    """Approved-completion count for the status medal line, read
    tolerantly: a top-level `completions` on the check payload, else
    per-assignment `completions` (deduped per mission). None when the
    OS doesn't send it — the line is then omitted, never guessed."""
    top = data.get("completions")
    if isinstance(top, int):
        return top
    per = {}
    for a in data.get("assignments") or []:
        if isinstance(a, dict) and isinstance(a.get("completions"), int):
            key = a.get("mission_id") or a.get("assignment_id") or id(a)
            per[key] = max(per.get(key, 0), a["completions"])
    return sum(per.values()) if per else None


def _mission_status_reply(convo: "IntroConversation",
                          incoming_text: str = "") -> str:
    """'¿Y mi misión?' — answered from whatsapp_mission_check only.
    An approved mission's gift is 'anotado' (noted), never promised
    as spendable: the loyalty mint is what activates it. The
    gift-balance explainer is added ONLY when the customer actually
    asked why they have no mission — never unprompted."""
    lang = convo.lang
    data = _mission_check(convo)
    if data is None:
        if lang == "en":
            return ("I couldn't check your missions just now 🙏 "
                    "Try again in a bit.")
        return ("No pude revisar tus misiones ahorita 🙏 "
                "Intentá de nuevo en un ratito.")
    assignments = [a for a in (data.get("assignments") or [])
                   if isinstance(a, dict)]
    approved = [a for a in assignments
                if _sub_status(a) == "approved"
                or _a_status(a) == "approved"]
    pending = [a for a in assignments
               if _sub_status(a) == "pending"
               or _a_status(a) == "submitted"]
    unlocked = [a for a in assignments
                if not _sub_status(a)
                and _a_status(a) in ("", "unlocked", "active")]
    rejected = [a for a in assignments if _sub_status(a) == "rejected"]
    if approved:
        amt = approved[0].get("reward_amount")
        if lang == "en":
            amt_txt = f" L.{amt}" if amt else ""
            reply = (f"Mission approved! 🎉 Your{amt_txt} gift is "
                     "noted in your Rico Cash 🎁")
        else:
            amt_txt = f" de L.{amt}" if amt else ""
            reply = (f"¡Misión aprobada! 🎉 Tu regalo{amt_txt} está "
                     "anotado en tu Rico Cash 🎁")
    elif pending:
        if lang == "en":
            reply = ("Your mission is under review 🕐 The Captain is "
                     "taking a look — I'll tell you here as soon as "
                     "it's approved.")
        else:
            reply = ("Tu misión está en revisión 🕐 El Capitán la está "
                     "revisando; te aviso por acá apenas se apruebe.")
    elif unlocked:
        a = unlocked[0]
        convo.missions_delivered.add(a.get("assignment_id"))
        brief = _mission_brief(a)
        if lang == "en":
            reply = (f"You have an active mission 🎯 {brief}\n"
                     "Post it, tag us and send me the link here to "
                     "claim your gift.")
        else:
            reply = (f"Tenés una misión activa 🎯 {brief}\n"
                     "Publicala, etiquetanos y mandame el link por acá "
                     "para reclamar tu regalo.")
    elif rejected:
        if lang == "en":
            reply = ("Your last mission wasn't approved this time 🙏 "
                     "But your next purchase can unlock a new one.")
        else:
            reply = ("Tu última misión no se aprobó esta vez 🙏 Pero "
                     "con tu próxima compra te puede caer otra.")
    else:
        if lang == "en":
            reply = ("You don't have missions yet 🎯 Missions unlock "
                     "when you buy: order something tasty and the "
                     "Captain sends you a mission with a gift. Watch "
                     "for your next purchase!")
        else:
            reply = ("Todavía no tenés misiones 🎯 Las misiones se "
                     "desbloquean al comprar: pedís algo rico y el "
                     "Capitán te manda una misión con regalo. "
                     "¡Pendiente a tu próxima compra!")
        if _has_cue((incoming_text or "").lower(), WHY_CUES):
            if lang == "en":
                reply += ("\nHeads up: missions unlock with purchases "
                          "paid with your own money — what you pay "
                          "with gift balance doesn't unlock more "
                          "missions 😉")
            else:
                reply += ("\nOjo: las misiones se desbloquean con "
                          "compras pagadas con tu dinero — lo pagado "
                          "con regalo no desbloquea más misiones 😉")
    done = _completions_count(data)
    if done:
        if lang == "en":
            reply += f"\nMissions completed: {done} 🏅"
        else:
            reply += f"\nMisiones cumplidas: {done} 🏅"
    return reply


# ---------------------------------------------------------------- attribution

_WORD_CHARS = "A-Za-zÁÉÍÓÚÜÑáéíóúüñ"
_WORD_EXPLICIT_RES = (
    re.compile(r"palabra\s+(?:de\s+)?([" + _WORD_CHARS + r"]{3,20})",
               re.IGNORECASE),
    re.compile(r"c[oó]digo\s+(?:de\s+)?([" + _WORD_CHARS + r"]{3,20})",
               re.IGNORECASE),
    re.compile(r"(?:vengo\s+de\s+parte\s+de|de\s+parte\s+de|vengo\s+de)"
               r"\s+([" + _WORD_CHARS + r"]{3,20})", re.IGNORECASE),
)
# Bare words that are conversation, not creator words. A speculative
# (single-token) message matching one of these is NEVER an attempt.
WORD_STOPLIST = {
    "hola", "hello", "hi", "buenas", "menu", "menú", "ayuda", "help",
    "gracias", "thanks", "si", "sí", "yes", "no", "ok", "okay",
    "bueno", "preventa", "mision", "misión", "misiones", "mission",
    "regalo", "gift", "botella", "botellas", "paquete", "paquetes",
    "caja", "cajas", "precio", "precios", "cuanto", "cuánto", "vale",
    "carta", "quiero", "want", "saltar", "skip", "luego", "despues",
    "después", "cumple", "cumpleaños", "birthday", "nombre", "name",
    "adios", "adiós", "bye", "chao", "equipo", "team",
}


def _detect_word(text: str):
    """A creator-word attempt in this message, or None.

    Deliberate: an explicit frame ("palabra X", "código X", "vengo
    de X", "de parte de X") — the customer MEANS it. Speculative: a
    single-token wordlike message (3–20 letters) outside the
    stoplist — it MIGHT be a word; pre-signup it is only stashed,
    never announced. Conservative by design: detection is invoked
    only at first contact, at the confirm step and in the lounge
    — never while the customer is answering the name or birthday
    questions, where a token is data. (A deliberate frame inside a
    LONG message is left for another turn: short messages only, at
    first contact.)
    """
    t = (text or "").strip()
    if not t:
        return None
    for rx in _WORD_EXPLICIT_RES:
        m = rx.search(t)
        if m and m.group(1).lower() not in WORD_STOPLIST:
            return {"word": m.group(1), "deliberate": True}
    single = t.strip(" .!¡¿?")
    if single and " " not in single and \
            re.fullmatch("[" + _WORD_CHARS + "]{3,20}", single):
        low = single.lower()
        if low not in WORD_STOPLIST and low not in _KEYBOARD_MASH:
            return {"word": single, "deliberate": False}
    return None


def _ligada_line(convo: "IntroConversation", creator_name: str) -> str:
    name = creator_name or ""
    if convo.lang == "en":
        return (f"🎉 And your account was linked to {name}'s word — "
                "thanks for arriving with an invitation!")
    return (f"🎉 Y tu cuenta quedó ligada a la palabra de {name} — "
            "¡gracias por llegar con invitación!")


def _note_suffix(convo: "IntroConversation") -> str:
    """The bound-word line as an appendable suffix ('' when the
    signup carried no word, or the word didn't bind)."""
    return ("\n" + convo.attribution_note) if convo.attribution_note else ""


def _attribute_line(convo: "IntroConversation", det: dict) -> str:
    """Bind a word for an ALREADY-registered customer via
    whatsapp_attribute and render the verdict as one line. Returns
    '' when silence is right: a speculative word the OS doesn't know
    (the customer was never promised anything), a no_customer answer
    (the word is stashed instead, in case a signup follows), or an
    OS hiccup (the word can simply be resent)."""
    lang = convo.lang
    res = os_client.attribute_word(convo.customer_phone, det["word"])
    data = res.get("data") if isinstance(res, dict) else None
    if not isinstance(data, dict):
        return ""
    if data.get("ok") or data.get("attributed"):
        return _ligada_line(convo,
                             data.get("creator_name") or det["word"])
    reason = str(data.get("reason") or "")
    if reason == "already_attributed":
        name = data.get("creator_name") or ""
        if lang == "en":
            return (f"You already have a word linked to your account: "
                    f"{name}'s 🙏 (the first word is the one that "
                    "counts)")
        return (f"Ya tenés una palabra ligada a tu cuenta: la de "
                f"{name} 🙏 (la primera palabra es la que cuenta)")
    if reason == "no_customer":
        if not convo.pending_word:
            convo.pending_word = det["word"]
        return ""
    # unknown_word | inactive_code — a retired word renders as
    # unrecognized; only a DELIBERATE attempt earns the explanation,
    # a speculative one stays silent.
    if det.get("deliberate"):
        if lang == "en":
            return ("I don't recognize that word 🙏 Check the "
                    "spelling, or ask your creator to confirm it.")
        return ("No reconozco esa palabra 🙏 Revisá cómo se "
                "escribe, o pedile a tu creador que te la confirme.")
    return ""


def _word_invite_line(convo: "IntroConversation", det: dict) -> str:
    """The pre-signup invite for a DELIBERATE word: intent, not
    confirmation — validity is only known when the OS answers at
    signup time."""
    if convo.lang == "en":
        return (f"\nLove it! Finish your signup and the word of "
                f"{det['word']} gets linked to your account 🙌")
    return (f"\n¡Buena esa! Terminá tu registro y la palabra de "
            f"{det['word']} queda ligada a tu cuenta 🙌")


# ---------------------------------------------------------------- engine

def reply_for_intro(convo: IntroConversation, incoming_text: str):
    """One message in, one reply out (a string, or a WaReply when
    the turn is the menu presentation). Tenant: rich-aroma-honduras.

    Thin wrapper over _reply_core: once the core flow has answered, a
    registered customer who was ALREADY in the lounge when this
    message arrived gets any undelivered mission appended (pull
    model — see the missions note in the module docstring)."""
    start_state = convo.state
    convo.mission_cache = None
    reply = _reply_core(convo, incoming_text)
    return _append_mission_delivery(convo, start_state, incoming_text,
                                    reply)


def _reply_core(convo: IntroConversation, incoming_text: str) -> str:
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
            convo.registered = True
            convo.state = "LOUNGE"
            # Creadores: a word in a short first message from a
            # registered customer binds right away; the verdict line
            # rides whichever greeting this branch returns.
            _det = _detect_word(text) if len(text.split()) <= 6 else None
            _attr_line = _attribute_line(convo, _det) if _det else ""
            _attr_suffix = ("\n" + _attr_line) if _attr_line else ""
            # Registered: a post link as the very first message is a
            # mission submission — register it right away.
            _url = _extract_social_url(text)
            if _url:
                return (_returning_greeting(convo) + "\n"
                        + _submit_mission_link(convo, _url))
            # Registered: answer a direct intent right away if present.
            packs, bottles, boxes = parse_preventa_explicit(text)
            if packs or bottles or boxes:
                _record_preventa(convo, packs, bottles, boxes)
                return (_returning_greeting(convo) + "\n"
                        + _preventa_recorded_text(packs, bottles,
                                                  boxes, lang))
            if _has_cue(t, MENU_CUES):
                _shop_menu = shop_engine.menu_reply(lang, convo)
                if _shop_menu is not None:
                    _shop_menu.prepend(_returning_greeting(convo))
                    if _attr_line:
                        _shop_menu.append(_attr_line)
                    return _shop_menu
                return (_returning_greeting(convo) + "\n"
                        + _menu_park_text(lang) + _preventa_offer(lang)
                        + _attr_suffix)
            if _has_cue(t, PRICE_CUES):
                return _returning_greeting(convo) + "\n" + _prices_text(lang) \
                    + _preventa_offer(lang) + _attr_suffix
            return _returning_greeting(convo) + _preventa_offer(lang) \
                + _attr_suffix

        # New customer.
        convo.state = "ASK_NAME"
        # Creadores: stash any word this first message carries — it
        # rides the signup when it fires. Silent by itself; only a
        # deliberate word in a short message earns the invite line.
        _det = _detect_word(text)
        if _det and not convo.pending_word:
            convo.pending_word = _det["word"]
        _invite = ""
        if _det and _det["deliberate"] and len(text.split()) <= 8:
            _invite = _word_invite_line(convo, _det)
        introduced = _extract_introduced_name(text)
        if introduced:
            convo.name = introduced
            convo.state = "ASK_BIRTHDAY"
            return _birthday_ask(convo.name, lang)
        if _has_cue(t, MENU_CUES):
            return (_menu_park_text(lang) + "\n\n" + _greeting_text(lang)
                    + _invite)
        if _has_cue(t, PRICE_CUES):
            return (_prices_text(lang) + "\n\n" + _greeting_text(lang)
                    + _invite)
        return _greeting_text(lang) + _invite

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
                        "the account — what should I "
                        "put? (Just your first name is fine.)")
            return ("¡Sin problema! Solo que para tu cuenta "
                    "sí necesito un nombre — ¿cuál pongo? "
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
        # Creadores: a word sent WITH the confirmation ("sí, palabra
        # X") is stashed before the yes is handled, so it rides this
        # very signup. Stash only — the flow's replies don't change.
        _det = _detect_word(text)
        if _det and not convo.pending_word:
            convo.pending_word = _det["word"]
        if _is_yes(t):
            _do_signup(convo)
            convo.strikes = 0
            convo.state = "PREVENTA"
            return _account_created_text(convo) + _note_suffix(convo) \
                + _preventa_offer(lang)
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

    # (The RETURNING_NO_GIFT state was deleted with the welcome
    # gift, 2026-10-26: a registered customer with no gift on file
    # is simply a registered customer — the NEW branch sends them
    # straight to the LOUNGE path now.)

    # ---------------- missions: link intake ----------------
    # A social post link from a registered customer in the lounge (or
    # mid-preventa chat) is a mission submission attempt. The signup
    # states above are never hijacked by it.
    if convo.state in ("LOUNGE", "PREVENTA") and convo.registered:
        _url = _extract_social_url(text)
        if _url:
            return _submit_mission_link(convo, _url)

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
            _tail = ("¿Apartamos un paquete de 5? Decime la "
                     "cantidad o 'no por ahora'."
                     if lang != "en" else
                     "Shall we reserve a 5-pack? Tell me how many "
                     "or 'not now'.")
            _shop_menu = shop_engine.menu_reply(lang, convo)
            if _shop_menu is not None:
                return _shop_menu.append(_tail)
            return _menu_park_text(lang) + "\n" + _tail
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
        if _has_cue(t, MISSION_CUES):
            return _mission_status_reply(convo, incoming_text)
        # Shop ordering (bot-finalize): the real OS menu + café
        # orders. Returns None when no catalog is available or the
        # message isn't shop business, and every legacy branch
        # below runs exactly as before.
        _shop_reply = shop_engine.try_handle(convo, text)
        if _shop_reply is not None:
            return _shop_reply
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
            return _gift_retired_text(convo)
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
                        "preventa, or see the menu? Just tell me.")
            return (f"¡Hola, {first}! ☕ ¿Apartamos botellas en "
                    "preventa o vemos el menú? Contame.")
        # Creadores: a word attempt in the lounge binds (or is
        # answered) here — after every conversational cue above has
        # had its chance, so a bare "botella"/"menú" is never
        # mistaken for a word.
        _det = _detect_word(text)
        if _det:
            _line = _attribute_line(convo, _det)
            if _line:
                return _line
        if lang == "en":
            return ("I can help you reserve bottles in preventa, "
                    "see the menu, or answer price questions. "
                    "The full menu arrives November 7 🗓️")
        return ("Te puedo ayudar a apartar botellas en preventa, "
                "ver el menú o contarte precios. "
                "El menú completo llega el 7 de noviembre 🗓️")

    # ---------------- handoff holding pattern ----------------
    if convo.state == "HANDOFF":
        if lang == "en":
            return ("The team has your number and will write soon 🙏 "
                    f"You can also reach us on Instagram: {INSTAGRAM}")
        return ("El equipo ya tiene tu número y te escribe pronto 🙏 "
                f"También podés escribirnos por Instagram: {INSTAGRAM}")

    convo.state = "NEW"
    return _reply_core(convo, incoming_text)
