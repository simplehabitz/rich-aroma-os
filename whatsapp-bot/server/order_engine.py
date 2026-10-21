"""
Order-taking engine for Rich Aroma Coffee Co. (first client of the sellable AI front desk).

Menu: premium bottled coffee, 12 oz, USD. Source: rich-aroma/MENU.md (menu board photo, 2026-10-15).

Conversation states per customer phone:
  GREETING -> COLLECTING -> CONFIRMING -> DONE
  COLLECTING -> BUNDLE_BUILDER (when a bundle is requested) -> COLLECTING

The state machine is business-agnostic; the MENU table is what makes it Rich Aroma.
"""

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

# In-memory conversation store (v1). Replace with DB when selling.
_conversations: Dict[str, "Conversation"] = {}

# name -> {whole: price, oat: price, aliases}
# Americano has no milk options: both prices equal, milk choice skipped.
MENU: Dict[str, dict] = {
    "caramel latte": {"whole": 5.00, "oat": 6.00, "aliases": ["caramel"]},
    "vanilla latte": {"whole": 5.00, "oat": 6.00, "aliases": ["vanilla"]},
    "french vanilla": {"whole": 5.00, "oat": 6.00, "aliases": []},
    "mocha latte": {"whole": 5.00, "oat": 6.00, "aliases": ["mocha"]},
    "white chocolate mocha": {"whole": 5.00, "oat": 6.00, "aliases": ["white chocolate", "white mocha"]},
    "dirty chai": {"whole": 5.00, "oat": 6.00, "aliases": ["chai"]},
    "classic black americano": {"whole": 5.00, "oat": 5.00, "aliases": ["americano", "black americano"]},
    "pumpkin spice": {"whole": 6.00, "oat": 7.00, "aliases": ["pumpkin"]},
    "biscoff": {"whole": 6.00, "oat": 7.00, "aliases": []},
}
# Longest names first so "french vanilla" wins over "vanilla".
SORTED_DRINKS = sorted(MENU.keys(), key=len, reverse=True)

BUNDLES = {
    "whole": {"label": "Bundle of 3 Whole Milk", "price": 14.00},
    "oat": {"label": "Bundle of 3 Oat Milk", "price": 17.00},
}

NUMBER_WORDS = {
    "one": 1, "uno": 1, "una": 1, "un": 1,
    "two": 2, "dos": 2,
    "three": 3, "tres": 3,
    "four": 4, "cuatro": 4,
    "five": 5, "cinco": 5,
    "six": 6, "seis": 6,
}

CURRENCY = "USD"

# TEMPORARY placeholder (user, 2026-10-17) — confirm real days/times with owner.
DELIVERY_DAYS_ES = "lunes, miércoles y viernes"
DELIVERY_DAYS_EN = "Mondays, Wednesdays, and Fridays"


@dataclass
class OrderItem:
    name: str
    milk: str = "whole"  # whole | oat
    quantity: int = 1
    unit_price: float = 0.0

    @property
    def line_total(self) -> float:
        return self.quantity * self.unit_price

    def describe(self) -> str:
        milk = "" if self.name == "classic black americano" else f" ({self.milk} milk)"
        return f"{self.quantity}x {self.name.title()}{milk} — ${self.line_total:.2f}"


@dataclass
class BundleItem:
    milk: str  # whole | oat
    flavors: List[str] = field(default_factory=list)

    @property
    def price(self) -> float:
        return BUNDLES[self.milk]["price"]

    def describe(self) -> str:
        flavors = ", ".join(f.title() for f in self.flavors)
        return f"{BUNDLES[self.milk]['label']} ({flavors}) — ${self.price:.2f}"


@dataclass
class Conversation:
    customer_phone: str
    business_slug: str = "rich-aroma"
    default_lang: str = "es"
    state: str = "GREETING"
    items: list = field(default_factory=list)  # OrderItem | BundleItem
    pending_bundle_milk: Optional[str] = None
    break_room: str = ""
    lang: str = ""  # detected once from the first message, then sticky
    order_id: str = ""


def _convo_key(business_slug: str, customer_phone: str) -> str:
    return f"{business_slug}:{customer_phone}"


def get_conversation(customer_phone: str, business_slug: str = "rich-aroma",
                     default_lang: str = "es") -> Conversation:
    key = _convo_key(business_slug, customer_phone)
    if key not in _conversations:
        _conversations[key] = Conversation(
            customer_phone=customer_phone,
            business_slug=business_slug,
            default_lang=default_lang,
        )
    return _conversations[key]


def reset_conversation(convo: Conversation):
    _conversations.pop(_convo_key(convo.business_slug, convo.customer_phone), None)


def detect_language(text: str, default: str = "es") -> str:
    """Simple heuristic; falls back to the business's default language."""
    spanish_hints = ["hola", "buenas", "quiero", "quisiera", "gracias", "por favor",
                     "leche", "avena", "entera", "listo", "pedido", "sí", "si"]
    english_hints = ["hello", "thanks", "please"]
    t = text.lower()
    if any(h in t for h in spanish_hints):
        return "es"
    if any(re.search(r"\b" + h + r"\b", t) for h in english_hints):
        return "en"
    return default


def detect_milk(text: str) -> Optional[str]:
    t = text.lower()
    if any(w in t for w in ["oat", "avena"]):
        return "oat"
    if any(w in t for w in ["whole", "entera", "regular", "normal", "leche de vaca"]):
        return "whole"
    return None


def parse_quantity(text: str, drink: str) -> int:
    t = text.lower()
    m = re.search(r"(\d+)\s*" + re.escape(drink), t) or re.search(re.escape(drink) + r"\s*(\d+)", t)
    if m:
        try:
            return max(1, int(m.group(1)))
        except ValueError:
            pass
    for word, num in NUMBER_WORDS.items():
        if re.search(r"\b" + word + r"\b\s*" + re.escape(drink), t):
            return num
    return 1


def find_drinks(text: str) -> List[Tuple[str, str]]:
    """Return [(drink_name, milk, qty)] found in text. Milk defaults to whole.

    Names are tried longest-first and each matched span is masked out, so a
    short name can never match inside a longer one ("vanilla" must not fire
    inside "french vanilla", nor "mocha" inside "white chocolate mocha").
    """
    t = text.lower()
    work = t  # spans get blanked out as drinks claim them
    found = []
    for drink in SORTED_DRINKS:
        names = sorted([drink] + MENU[drink]["aliases"], key=len, reverse=True)
        for name in names:
            if re.search(r"\b" + re.escape(name) + r"\b", work):
                milk = detect_milk(t) or "whole"
                qty = parse_quantity(t, name)
                found.append((drink, milk, qty))
                work = re.sub(r"\b" + re.escape(name) + r"\b", " " * len(name), work)
                break
    # de-dupe keeping first occurrence
    seen = set()
    unique = []
    for drink, milk, qty in found:
        if drink not in seen:
            seen.add(drink)
            unique.append((drink, milk, qty))
    return unique


def wants_bundle(text: str) -> bool:
    t = text.lower()
    return any(w in t for w in ["bundle", "paquete", "combo", "3 pack", "trio"])


def menu_text() -> str:
    lines = ["*Rich Aroma Coffee Co. — Bottled Coffee 12oz*", ""]
    lines.append("*Core Lattes* — $5 Whole / $6 Oat:")
    for d in ["caramel latte", "vanilla latte", "french vanilla", "mocha latte",
              "white chocolate mocha", "dirty chai"]:
        lines.append(f"• {d.title()}")
    lines.append("• Classic Black Americano — $5")
    lines.append("")
    lines.append("*Seasonal* — $6 Whole / $7 Oat:")
    lines.append("• Pumpkin Spice  • Biscoff")
    lines.append("")
    lines.append("*Bundles (any 3 bottles):*")
    lines.append("• 3 Whole Milk — $14   • 3 Oat Milk — $17")
    return "\n".join(lines)


def order_total(convo: Conversation) -> float:
    total = 0.0
    for it in convo.items:
        total += it.line_total if isinstance(it, OrderItem) else it.price
    return total


def summary_text(convo: Conversation) -> str:
    lines = [it.describe() for it in convo.items]
    lines.append(f"*Total: ${order_total(convo):.2f} {CURRENCY}*")
    return "\n".join(lines)


def build_order(convo: Conversation) -> dict:
    """Structured order dict for persistence and KDS push (Rich Aroma OS)."""
    items = []
    for it in convo.items:
        if isinstance(it, OrderItem):
            items.append({
                "type": "drink",
                "name": it.name,
                "milk": it.milk,
                "quantity": it.quantity,
                "unit_price": it.unit_price,
                "line_total": round(it.line_total, 2),
            })
        else:
            items.append({
                "type": "bundle",
                "name": BUNDLES[it.milk]["label"],
                "milk": it.milk,
                "flavors": it.flavors,
                "quantity": 1,
                "unit_price": it.price,
                "line_total": round(it.price, 2),
            })
    return {
        "order_id": convo.order_id,
        "business": convo.business_slug,
        "channel": "whatsapp",
        "customer_phone": convo.customer_phone,
        "customer_lang": convo.lang,
        "items": items,
        "total": round(order_total(convo), 2),
        "currency": CURRENCY,
        "fulfillment": "delivery",
        "delivery_location": "Kaiser Baldwin Park",
        "break_room": convo.break_room,
        "status": "new",
    }


def reply_for(convo: Conversation, incoming_text: str) -> str:
    if not convo.lang:
        convo.lang = detect_language(incoming_text, default=convo.default_lang)
    lang = convo.lang
    t = incoming_text.strip().lower()

    if t in ("cancelar", "cancel", "empezar de nuevo", "reiniciar", "start over"):
        reset_conversation(convo)
        msg = ("Pedido cancelado. ¿Empezamos de nuevo? Dime qué te gustaría."
               if lang == "es" else "Order cancelled. Want to start over?")
        return msg

    if t in ("menu", "menú", "carta"):
        return menu_text()

    # ---------- bundle builder sub-flow ----------
    if convo.state == "BUNDLE_BUILDER":
        milk = detect_milk(incoming_text)
        if convo.pending_bundle_milk is None:
            if milk is None:
                return ("¿El bundle de leche entera ($14) o de avena ($17)?"
                        if lang == "es" else "Whole milk bundle ($14) or oat milk bundle ($17)?")
            convo.pending_bundle_milk = milk
            return ("Perfecto. Dime los 3 sabores (ej: caramel latte, mocha latte, biscoff)."
                    if lang == "es" else "Great. Tell me the 3 flavors (e.g. caramel latte, mocha latte, biscoff).")
        picks = find_drinks(incoming_text)
        if not picks:
            return ("Necesito 3 sabores para el bundle. ¿Cuáles eliges?"
                    if lang == "es" else "I need 3 flavors for the bundle. Which ones?")
        flavors: List[str] = []
        for d, _, q in picks:
            flavors.extend([d] * q)
        if len(flavors) != 3:
            counted = ", ".join(f"{q}x {d.title()}" for d, _, q in picks)
            if lang == "es":
                return (f"Conté {len(flavors)} botella(s): {counted}. "
                        "El bundle es de exactamente 3 — ¿cuáles 3 dejamos?")
            return (f"I counted {len(flavors)} bottle(s): {counted}. "
                    "The bundle is exactly 3 — which 3 should we keep?")
        convo.items.append(BundleItem(milk=convo.pending_bundle_milk, flavors=flavors))
        convo.pending_bundle_milk = None
        convo.state = "COLLECTING"
        msg = ("Bundle agregado ✅\n" + summary_text(convo)
               + ("\n¿Algo más? Escribe 'listo' para confirmar."
                  if lang == "es" else "\nAnything else? Type 'done' to confirm."))
        return msg

    # ---------- main flow ----------
    if convo.state == "GREETING":
        convo.state = "COLLECTING"
        # If the first message already carries an order intent (bundle request
        # or recognizable drinks), act on it instead of only greeting — this
        # also recovers gracefully if conversation memory was reset.
        if wants_bundle(t) or find_drinks(incoming_text):
            return reply_for(convo, incoming_text)
        if lang == "es":
            return ("¡Hola! Bienvenido a Rich Aroma Coffee Co. ☕\n"
                    "Vendemos café embotellado premium de 12oz.\n"
                    "¿Qué te gustaría ordenar? Escribe 'menu' para ver las opciones.")
        return ("Hi! Welcome to Rich Aroma Coffee Co. ☕\n"
                "We sell premium 12oz bottled coffee.\n"
                "What would you like to order? Type 'menu' to see options.")

    if convo.state == "COLLECTING":
        if wants_bundle(t):
            convo.state = "BUNDLE_BUILDER"
            return ("¡Buena elección! ¿El bundle de leche entera ($14) o de avena ($17)?"
                    if lang == "es" else "Great choice! Whole milk bundle ($14) or oat milk bundle ($17)?")
        drinks = find_drinks(incoming_text)
        if drinks:
            milk_msg = detect_milk(incoming_text)
            for drink, milk, qty in drinks:
                price = MENU[drink][milk]
                convo.items.append(OrderItem(name=drink, milk=milk, quantity=qty, unit_price=price))
            added = ", ".join(f"{q}x {d.title()}" for d, _, q in drinks)
            if lang == "es":
                return (f"Anotado: {added}.\n" + summary_text(convo)
                        + "\n¿Algo más? Escribe 'listo' para confirmar tu pedido.")
            return (f"Got it: {added}.\n" + summary_text(convo)
                    + "\nAnything else? Type 'done' to confirm.")
        if t in ("listo", "done", "eso es", "that's it", "that's all"):
            if not convo.items:
                return ("Aún no tengo ningún artículo. Escribe 'menu' para ver opciones."
                        if lang == "es" else "No items yet. Type 'menu' to see options.")
            convo.state = "CONFIRMING"
            if lang == "es":
                return ("Tu pedido:\n" + summary_text(convo)
                        + "\n¿Es correcto? Responde 'sí' para confirmar o 'no' para corregirlo.")
            return ("Your order:\n" + summary_text(convo)
                    + "\nIs that correct? Reply 'yes' to confirm or 'no' to change it.")
        if lang == "es":
            return ("No reconocí ese artículo. Escribe 'menu' para ver el menú "
                    "o dime por ejemplo: 'quiero 2 caramel latte de avena'.")
        return ("I didn't recognize that item. Type 'menu' to see the menu, "
                "or try e.g. '2 caramel lattes with oat milk'.")

    if convo.state == "CONFIRMING":
        if t in ("sí", "si", "yes", "s", "y", "confirmo", "correcto", "dale"):
            convo.state = "BREAKROOM"
            if lang == "es":
                return (f"¡Perfecto! Entregamos a Kaiser Baldwin Park los {DELIVERY_DAYS_ES}. 🏥\n"
                        "¿A qué departamento / break room lo llevamos?")
            return (f"Great! We deliver to Kaiser Baldwin Park on {DELIVERY_DAYS_EN}. 🏥\n"
                    "Which department / break room should we deliver to?")
        if t in ("no", "n", "corregir", "cambiar"):
            convo.state = "COLLECTING"
            convo.items = []
            return ("Sin problema, empecemos de nuevo. ¿Qué te gustaría ordenar?"
                    if lang == "es" else "No problem, let's start over. What would you like?")
        return ("¿Me confirmas con 'sí' o 'no'?"
                if lang == "es" else "Please confirm with 'yes' or 'no'.")

    if convo.state == "BREAKROOM":
        convo.break_room = incoming_text.strip()
        convo.state = "DONE"
        total = order_total(convo)
        convo.order_id = f"RA-{abs(hash(convo.customer_phone + str(total))) % 10000:04d}"
        order_id = convo.order_id
        if lang == "es":
            return ("¡Pedido confirmado! 🎉\n"
                    f"Orden {order_id}:\n" + summary_text(convo) +
                    f"\n📍 Entrega: Kaiser Baldwin Park — {convo.break_room}\n"
                    "Te escribiremos con los detalles de pago. "
                    "¡Gracias por elegir Rich Aroma!")
        return ("Order confirmed! 🎉\n"
                f"Order {order_id}:\n" + summary_text(convo) +
                f"\n📍 Delivery: Kaiser Baldwin Park — {convo.break_room}\n"
                "We'll message you with payment details. Thanks for choosing Rich Aroma!")

    if convo.state == "DONE":
        reset_conversation(convo)
        return reply_for(get_conversation(convo.customer_phone, convo.business_slug, convo.default_lang), incoming_text)

    return "¿Cómo te puedo ayudar con tu pedido?"
