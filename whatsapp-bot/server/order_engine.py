"""
RETIRED Cali order engine — kept only as a compatibility shell.

History: this module was the SoCal bottled-coffee order engine
(hardcoded USD menu, bundles, Kaiser Baldwin Park delivery) from
the front desk's first test. The +504 number was decided to belong
to the Quimistán SHOP (2026-10-20), the shop got its own engines
(intro_engine.py + shop_engine.py), and the Cali menu was removed
for good in the bot-finalize build (Oct 26): nothing Cali — no USD
menu, no bundles, no delivery flow — is reachable from this bot.
Cali gets its own US number and its own deployment someday.

What remains, deliberately:
  - detect_language() and NUMBER_WORDS: shared helpers that
    intro_engine.py imports.
  - get_conversation()/reply_for()/reset_conversation(): a thin
    shell over the shop greeting, kept import-compatible because
    the frozen missions battery smoke-tests that this module still
    answers as Rich Aroma and carries no missions leakage. It
    cannot take an order and holds no prices.
"""

import re
from dataclasses import dataclass, field
from typing import Dict, Optional

_conversations: Dict[str, "Conversation"] = {}

NUMBER_WORDS = {
    "one": 1, "uno": 1, "una": 1, "un": 1,
    "two": 2, "dos": 2,
    "three": 3, "tres": 3,
    "four": 4, "cuatro": 4,
    "five": 5, "cinco": 5,
    "six": 6, "seis": 6,
}


@dataclass
class Conversation:
    customer_phone: str
    business_slug: str = "rich-aroma-honduras"
    default_lang: str = "es"
    state: str = "GREETING"
    items: list = field(default_factory=list)
    lang: str = ""


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
    _conversations.pop(_convo_key(convo.business_slug, convo.customer_phone),
                       None)


def detect_language(text: str, default: str = "es") -> str:
    """Simple heuristic; falls back to the business's default language."""
    spanish_hints = ["hola", "buenas", "quiero", "quisiera", "gracias",
                     "por favor", "leche", "avena", "entera", "listo",
                     "pedido", "sí", "si"]
    english_hints = ["hello", "thanks", "please"]
    t = text.lower()
    if any(h in t for h in spanish_hints):
        return "es"
    if any(re.search(r"\b" + h + r"\b", t) for h in english_hints):
        return "en"
    return default


def reply_for(convo: Conversation, incoming_text: str) -> str:
    """Compatibility greeting only — real ordering lives in
    intro_engine/shop_engine on the shop's number."""
    if not convo.lang:
        convo.lang = detect_language(incoming_text,
                                     default=convo.default_lang)
    t = (incoming_text or "").strip().lower()
    if t in ("menu", "menú", "carta"):
        try:
            import shop_engine
            menu = shop_engine.menu_reply(convo.lang)
        except Exception:
            menu = None
        if menu:
            return menu
        if convo.lang == "en":
            return ("The menu is being updated right now 🙏 "
                    "Write to the shop number and we'll help you "
                    "right away.")
        return ("El menú se está actualizando en este momento 🙏 "
                "Escribinos y te atendemos enseguida.")
    if convo.lang == "en":
        return ("Hi! Welcome to Rich Aroma Coffee Co. ☕ "
                "We sell bottled coffee, lattes, frappés, baleadas "
                "and more in Quimistán. Type 'menu' to see the "
                "full menu.")
    return ("¡Hola! Bienvenido a *Rich Aroma* en Quimistán ☕ "
            "Vendemos café embotellado, lattes, frappés, baleadas "
            "y más. Escribí 'menú' para ver el menú completo.")
