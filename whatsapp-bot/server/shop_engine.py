"""
Shop ordering engine for Rich Aroma Honduras (Quimistán) — tenant
rich-aroma-honduras ONLY. This is the café-menu ordering the intro
flow used to park: a registered customer in the LOUNGE can see the
real menu and order from it, end to end:

  parse (rules) -> validate against the OS catalog (menu_client)
  -> price from the catalog ONLY -> confirm -> pay choice
  -> persist locally -> push to the OS (/api/orders-v2 via kds_push)
  shaped exactly like a storefront order, born UNPAID
  ('cash' = pay at pickup -> OS 'pending'; 'transfer' -> OS
  'awaiting_transfer_approval', the staff verification queue).

The engine is the cash register: the customer's words never set a
price, an item the catalog doesn't hold is rejected gracefully, and
unknown text changes nothing. Modifiers ride in the SAME snapshot
shape the POS writes ({id, group_id, group, name, price_adjustment,
qty?}) and are priced from the catalog's own option adjustments —
Dulzor (Normal default · Poco dulce · Con Splenda with a selectable
packet count 1-4, default 2 · Sin azúcar), leche especial, extras —
but ONLY for groups the OS menu actually attaches to the item. Sizes
and temperature are separate menu items (never a question); combos
are fixed items (no builder).

Conversation shape follows the modifier standard: the house build
is pre-selected, so ordering the regular item means answering
nothing. Modifier cues in the message ("poco dulce", "de avena",
"con huevo extra") apply to the items named in that same message.
An ambiguous name shared by several sizes asks ONE question
("¿8oz o 12oz?") and nothing else.

try_handle() returns None whenever the shop can't act — no catalog
(fetch down, import not run yet) or the message isn't shop business
— so the intro flow's legacy replies (preventa, gifts, words) run
exactly as before. The cart lives on the intro conversation
(convo.shop_cart); the intro state stays LOUNGE throughout, so the
missions pull-model append keeps working over shop replies.
"""

import re
import time
import unicodedata
from typing import Optional

try:
    import menu_client
    import kds_push
    from orders import save_order
except ImportError:  # running as part of the server package
    from server import menu_client, kds_push
    from server.orders import save_order

BUSINESS_SLUG = "rich-aroma-honduras"
CURRENCY = "HNL"

NUMBER_WORDS = {
    "uno": 1, "una": 1, "un": 1, "dos": 2, "tres": 3, "cuatro": 4,
    "cinco": 5, "seis": 6, "siete": 7, "ocho": 8,
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
}

MENU_ASK_CUES = ("menú", "menu", "carta", "qué venden", "que venden",
                 "qué tienen", "que tienen")
PRICE_CUES = ("cuánto", "cuanto", "precio", "cuesta", "cuestan", "vale",
              "valen")
PACK_CUES = ("paquete", "caja de", "cajas")  # preventa territory
REMOVE_CUES = ("quita", "quitá", "saca", "sacá", "elimina", "borra",
               "sin el", "sin la", "no quiero")
YES_CUES = ("sí", "si", "yes", "dale", "correcto", "confirmo", "ok")

# Token canonicalization: the OS menu mixes Spanish display names
# with English flavor words (name_es "Botella Vainilla Francesa" vs
# name "Botella French Vanilla" / "Latte Caramel"). Map the few
# crossings so a customer writing either language matches.
_SYNONYMS = {
    "caramelo": "caramel",
    "vainilla": "vanilla",
    "francesa": "french",
    "frances": "french",
    "iced": "helado",
    "te": "te",
}
_STOPWORDS = {"de", "del", "la", "el", "los", "las", "y", "con", "en",
              "un", "una", "unos", "unas", "al", "a"}
_SIZE_TOKENS = {"8oz", "12oz", "16oz", "8", "12", "16", "oz"}

# Shorthand customers actually type for the fixed combos and a few
# signature items (token sets, normalized like item cores).
ALIASES = {
    "combo-baleada": [{"combo", "1"}, {"combo", "baleada"}],
    "combo-burrito": [{"combo", "2"}, {"combo", "burrito"}],
    "combo-capitana": [{"combo", "3"}, {"capitana"},
                       {"combo", "capitana"}],
    "combo-avocado-toast": [{"combo", "4"}, {"avocado", "toast"},
                            {"combo", "avocado"}],
    "combo-pb-banana-toast": [{"combo", "5"}, {"pb", "banana", "toast"},
                              {"combo", "pb"}],
    "lonchera-del-capitan": [{"lonchera"}],
    "baleada-sencilla": [{"baleada"}],
    "te": [{"te", "caliente"}, {"taza", "te"}],
    "americano-8oz": [{"americano"}],
    "americano-12oz": [{"americano"}],
    "batch-coffee-8oz": [{"filtrado"}, {"batch"}],
    "batch-coffee-12oz": [{"filtrado"}, {"batch"}],
}

CATEGORY_LABELS = [
    ("combos", "Combos de la mañana"),
    ("espresso_bar", "Café y espresso"),
    ("tea_matcha", "Té y matcha"),
    ("supremes_icees", "Fríos y supremes"),
    ("grill_toast_crepes", "De la plancha y más"),
    ("bakery", "Panadería"),
    ("bowls_salads", "Bowls y ensaladas"),
    ("reposteria", "Repostería"),
]


# ---------------------------------------------------------------- text

def _norm(s: str) -> str:
    s = unicodedata.normalize("NFD", (s or "").lower())
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _singular(tok: str) -> str:
    """Gentle Spanish plural strip for MATCHING only (baleadas ->
    baleada, fresas -> fresa). Never applied to quantity words —
    _find_matches keeps an index-aligned raw token list for those."""
    if len(tok) > 3 and tok.endswith("s") and not tok.endswith("ss"):
        return tok[:-1]
    return tok


def _tokens(s: str, singular: bool = True):
    out = []
    for tok in _norm(s).split():
        if not tok:
            continue
        tok = _SYNONYMS.get(tok, tok)
        out.append(_singular(tok) if singular else tok)
    return out


def _fmt(amount: float) -> str:
    if abs(amount - round(amount)) < 0.005:
        return f"L.{int(round(amount))}"
    return f"L.{amount:.2f}"


def _core_tokens(item: dict):
    """Matchable token set for an item: union over name_es and name
    (the catalog keeps the display name; both spellings are indexed
    here by re-tokenizing the raw fields when present)."""
    cores = []
    for raw in (item.get("name") or "", item.get("_name_alt") or ""):
        toks = [t for t in _tokens(raw)
                if t not in _STOPWORDS and t not in _SIZE_TOKENS]
        if toks:
            cores.append(set(toks))
    return cores


def _size_of(item: dict):
    m = re.search(r"(8|12|16)\s*oz", (item.get("name") or "").lower())
    return int(m.group(1)) if m else None


# ---------------------------------------------------------------- parsing

def _find_matches(catalog, text: str):
    """Greedy longest-core matching over the message tokens.

    Returns (matches, ambiguous): matches = [(item, qty)] fully
    resolved; ambiguous = [item, ...] sharing one winning core that
    only a size cue can split (empty when nothing is ambiguous).
    Each matched item claims its tokens so a short name can't fire
    inside a longer one, and a quantity word/number just before the
    claimed span becomes the qty (default 1).
    """
    toks = _tokens(text)
    raw_toks = _tokens(text, singular=False)
    claimed = [False] * len(toks)
    candidates = []
    for item in catalog.items.values():
        cores = _core_tokens(item)
        cores += [set(a) for a in ALIASES.get(item["id"], [])]
        for core in cores:
            if not core:
                continue
            # A one-token core shorter than 3 letters ("te") is the
            # Spanish pronoun too often to match bare — such items
            # stay reachable through their multi-token aliases.
            if len(core) == 1 and len(next(iter(core))) < 3:
                continue
            idx = [i for i, tk in enumerate(toks) if tk in core]
            # subset match: every core token present somewhere unclaimed
            present = {}
            ok = True
            for ct in core:
                hit = next((i for i, tk in enumerate(toks)
                            if tk == ct and not claimed[i]
                            and i not in present.values()), None)
                if hit is None:
                    ok = False
                    break
                present[ct] = hit
            if ok:
                candidates.append((len(core), item, present))
    candidates.sort(key=lambda c: -c[0])
    matches = []
    ambiguous = []
    used_items = set()
    for _score, item, present in candidates:
        if item["id"] in used_items:
            continue
        if any(claimed[i] for i in present.values()):
            continue
        # Same core claimed by several items (sizes): a size cue in
        # the message resolves it on the spot; without one, defer to
        # the ambiguity path instead of guessing.
        rivals = [c for c in candidates
                  if c[1]["id"] != item["id"]
                  and set(c[2].values()) == set(present.values())
                  and not any(claimed[i] for i in c[2].values())]
        if rivals:
            group = [item] + [r[1] for r in rivals]
            if not any(g["id"] in used_items for g in group):
                picked = _size_cue(text, group)
                if picked is None:
                    ambiguous = group
                    for g in group:
                        used_items.add(g["id"])
                    for i in present.values():
                        claimed[i] = True
                    continue
                item = picked
        qty = 1
        first = min(present.values())
        for j in range(first - 1, max(first - 3, -1), -1):
            if claimed[j]:
                break
            tk = raw_toks[j]
            if tk.isdigit():
                qty = max(1, min(20, int(tk)))
                claimed[j] = True
                break
            if tk in NUMBER_WORDS:
                qty = NUMBER_WORDS[tk]
                claimed[j] = True
                break
        for i in present.values():
            claimed[i] = True
        used_items.add(item["id"])
        matches.append((item, qty))
    return matches, ambiguous


def _size_cue(text: str, group):
    """Resolve an ambiguity group from a size cue, or None."""
    t = _norm(text)
    m = re.search(r"\b(8|12|16)\s*oz\b", t)
    if m:
        want = int(m.group(1))
        for it in group:
            if _size_of(it) == want:
                return it
        return None
    sizes = sorted((_size_of(it) or 0, it) for it in group)
    if any(w in t for w in ("grande", "gran", "largo")):
        return sizes[-1][1]
    if any(w in t for w in ("pequeno", "pequena", "chico", "corto")):
        return sizes[0][1]
    return None


_SPLENDA_COUNT_RES = (
    re.compile(r"(\d)\s*(?:sobres?|splenda)"),
    re.compile(r"splenda\s*(?:x|por)?\s*(\d)"),
)


def _splenda_count(text: str, option: dict) -> int:
    t = _norm(text)
    for rx in _SPLENDA_COUNT_RES:
        m = rx.search(t)
        if m:
            return max(1, min(4, int(m.group(1))))
    return max(1, min(4, int(option.get("default_qty") or 2)))


def _pick_option(options, *cue_words):
    for opt in options:
        name = _norm(opt["name"])
        if any(cue in name for cue in cue_words):
            return opt
    return None


def _build_mods(catalog, item: dict, text: str):
    """Snapshot mods for one item, from catalog data + message cues.

    Returns (mods, unit_price). Every required/single group lands in
    the snapshot — the cued option when a cue matches, else the
    group's default (else its first option: the standard guarantees
    a house build) — priced by the option's own adjustment. Optional
    multi groups (Extras) appear only when cued.
    """
    t = _norm(text)
    mods = []
    unit = float(item["price"])
    for group, options in catalog.groups_for(item["id"]):
        gname = _norm(group["name"])
        single = (group.get("max_selections") or 1) <= 1
        chosen = []
        if "dulzor" in gname:
            opt = None
            splenda_qty = None
            if "sin azucar" in t:
                opt = _pick_option(options, "sin azucar")
            elif "splenda" in t:
                opt = _pick_option(options, "splenda")
                if opt and opt.get("allow_qty"):
                    splenda_qty = _splenda_count(text, opt)
            elif "poco dulce" in t:
                opt = _pick_option(options, "poco dulce")
            if opt is None:
                opt = next((o for o in options if o["is_default"]),
                           options[0] if options else None)
            if opt:
                entry = _snapshot(group, opt, splenda_qty)
                mods.append(entry)
                unit += entry["price_adjustment"] * (splenda_qty or 1)
            continue
        if "leche" in gname:
            opt = None
            for cue in ("avena", "deslactosada", "descremada", "entera"):
                if cue in t:
                    opt = _pick_option(options, cue)
                    if opt:
                        break
            if opt is None:
                opt = next((o for o in options if o["is_default"]),
                           options[0] if options else None)
            if opt:
                entry = _snapshot(group, opt, None)
                mods.append(entry)
                unit += entry["price_adjustment"]
            continue
        if single or group.get("required"):
            opt = next((o for o in options if o["is_default"]),
                       options[0] if options else None)
            if opt:
                entry = _snapshot(group, opt, None)
                mods.append(entry)
                unit += entry["price_adjustment"]
            continue
        # Optional multi group (Extras): only cued options.
        for cue, words in (("huevo", ("huevo",)),
                           ("aguacate", ("aguacate",)),
                           ("queso crema", ("queso crema",))):
            if any(w in t for w in words):
                opt = _pick_option(options, cue)
                if opt:
                    entry = _snapshot(group, opt, None)
                    mods.append(entry)
                    unit += entry["price_adjustment"]
    return mods, unit


def _snapshot(group: dict, opt: dict, qty):
    entry = {"id": opt["id"], "group_id": group["id"],
             "group": group["name"], "name": opt["name"],
             "price_adjustment": float(opt["price_adjustment"])}
    if qty:
        entry["qty"] = int(qty)
    return entry


# ---------------------------------------------------------------- cart

def _new_cart():
    return {"stage": "collecting", "items": [], "pending": None}


def _cart_total(cart) -> float:
    return sum(l["qty"] * l["unit_price"] for l in cart["items"])


def _line_text(line) -> str:
    mods = ""
    if line["mods"]:
        parts = []
        for m in line["mods"]:
            s = f"{m['group']}: {m['name']}"
            if m.get("qty"):
                s += f" ×{m['qty']}"
            parts.append(s)
        mods = " (" + "; ".join(parts) + ")"
    return (f"{line['qty']}x {line['name']}{mods} — "
            f"{_fmt(line['qty'] * line['unit_price'])}")


def _summary(cart) -> str:
    lines = [_line_text(l) for l in cart["items"]]
    lines.append(f"*Total: {_fmt(_cart_total(cart))}*")
    return "\n".join(lines)


def _add_matches(cart, catalog, matches, text):
    added = []
    for item, qty in matches:
        mods, unit = _build_mods(catalog, item, text)
        cart["items"].append({
            "id": item["id"], "name": item["name"], "qty": qty,
            "unit_price": unit, "mods": mods,
        })
        added.append(item["name"])
    return added


def menu_text(catalog, lang: str = "es") -> str:
    by_cat = {}
    for item in catalog.items.values():
        by_cat.setdefault(item["category"], []).append(item)
    order = [c for c, _ in CATEGORY_LABELS if c in by_cat]
    order += sorted(c for c in by_cat if c not in order)
    labels = dict(CATEGORY_LABELS)
    if lang == "en":
        lines = ["*Rich Aroma — Menu* ☕"]
    else:
        lines = ["*Rich Aroma — Menú* ☕"]
    for cat in order:
        lines.append("")
        lines.append(f"*{labels.get(cat, cat.replace('_', ' ').title())}*")
        for item in sorted(by_cat[cat], key=lambda i: i["name"]):
            lines.append(f"• {item['name']} — {_fmt(item['price'])}")
    if lang == "en":
        lines.append("\nTell me what you'd like, e.g. "
                     "'a 12oz caramel latte'.")
    else:
        lines.append("\nPedime lo que querás, ej: "
                     "'un latte de caramelo 12oz'.")
    return "\n".join(lines)


def menu_reply(lang: str = "es") -> Optional[str]:
    """The real menu when a catalog is available, else None (the
    intro flow's parked copy takes over — pre-import behavior)."""
    catalog = menu_client.get_catalog()
    if catalog is None or not catalog.items:
        return None
    return menu_text(catalog, lang)


# ---------------------------------------------------------------- orders

def build_order(convo, cart, payment_method: str) -> dict:
    total = _cart_total(cart)
    oid = "RA-" + f"{abs(hash(convo.customer_phone + str(total) + str(time.time()))) % 100000:05d}"
    items = []
    for l in cart["items"]:
        items.append({
            "id": l["id"],
            "name": l["name"],
            "qty": l["qty"],
            "unit_price": l["unit_price"],
            "line_total": round(l["qty"] * l["unit_price"], 2),
            "mods": l["mods"],
        })
    return {
        "order_id": oid,
        "business": BUSINESS_SLUG,
        "channel": "whatsapp",
        "source": "whatsapp",
        "customer_phone": convo.customer_phone,
        "customer_name": convo.name or "",
        "customer_lang": convo.lang or "es",
        "items": items,
        "total": round(total, 2),
        "currency": CURRENCY,
        "fulfillment": "pickup",
        "payment_method": payment_method,  # 'cash' | 'transfer'
        "status": "new",
    }


def _finalize(convo, cart, payment_method: str, lang: str) -> str:
    order = build_order(convo, cart, payment_method)
    try:
        save_order(BUSINESS_SLUG, order)
    except Exception as e:
        print(f"[shop] local save failed: {e}", flush=True)
    result = kds_push.push_order(order)
    if not result.get("ok"):
        print(f"[shop] OS push skipped/failed: {result.get('error')}",
              flush=True)
    convo.shop_cart = None
    total = _fmt(order["total"])
    if lang == "en":
        head = (f"Order confirmed! 🎉\nOrder {order['order_id']} — "
                f"*Total: {total}*\n📍 Pickup at Rich Aroma, Quimistán.")
        if payment_method == "transfer":
            return (head + "\n🏦 Pay by transfer — the team will "
                    "share the account details here and verify it; "
                    "we'll message you when your order is ready 😊")
        return (head + "\nYou pay when you pick it up. We'll "
                "message you here when it's ready 😊")
    head = (f"¡Pedido confirmado! 🎉\nPedido {order['order_id']} — "
            f"*Total: {total}*\n📍 Para recoger en Rich Aroma, "
            "Quimistán.")
    if payment_method == "transfer":
        return (head + "\n🏦 Pagás por transferencia — el equipo te "
                "pasa los datos de la cuenta por acá, la verifica, "
                "y te avisamos cuando tu pedido esté listo 😊")
    return (head + "\nPagás al recoger. Te avisamos por acá cuando "
            "esté listo 😊")


# ---------------------------------------------------------------- engine

def _is_menu_ask(t: str) -> bool:
    return any(c in t for c in MENU_ASK_CUES)


def _handle_session(convo, text: str, catalog, lang: str) -> str:
    cart = convo.shop_cart
    t = text.lower()
    tn = _norm(text)

    # A pending size question outranks everything else in the cart.
    if cart.get("pending"):
        group = cart["pending"]["candidates"]
        picked = _size_cue(text, group)
        if picked is None:
            full, _amb = _find_matches(catalog, text) \
                if catalog else ([], [])
            if full:
                cart["pending"] = None  # moved on to a new item
            else:
                opts = "\n".join(
                    f"• {g['name']} — {_fmt(g['price'])}" for g in group)
                return ("¿Cuál tamaño preferís?\n" + opts) \
                    if lang != "en" else \
                    ("Which size would you like?\n" + opts)
        if picked is not None:
            qty = cart["pending"]["qty"]
            src = cart["pending"]["text"]
            cart["pending"] = None
            _add_matches(cart, catalog, [(picked, qty)], src)
            return ("Anotado ✅\n" + _summary(cart)
                    + "\n¿Algo más? Escribí 'listo' para confirmar."
                    if lang != "en" else
                    "Got it ✅\n" + _summary(cart)
                    + "\nAnything else? Type 'listo' to confirm.")

    if cart["stage"] == "paying":
        if tn.strip(" .!") in ("no", "n"):
            cart["stage"] = "collecting"
            return ("Sin problema, seguimos con tu pedido:\n"
                    + _summary(cart)
                    + "\nPodés agregar o quitar artículos, o "
                      "'cancelar' para anular todo."
                    if lang != "en" else
                    "No problem, let's keep editing:\n" + _summary(cart)
                    + "\nAdd or remove items, or 'cancelar' to void it.")
        if "transfer" in tn or tn.strip(" .!") == "2":
            return _finalize(convo, cart, "transfer", lang)
        if (tn.strip(" .!") in ("1", "si", "yes", "dale", "ok")
                or any(c in tn for c in ("recoger", "efectivo",
                                         "tarjeta", "contraentrega"))):
            return _finalize(convo, cart, "cash", lang)
        return ("¿Cómo pagás? Respondé *1* al recoger o "
                "*2* transferencia."
                if lang != "en" else
                "How will you pay? Reply *1* pay at pickup or "
                "*2* transfer.")

    # stage == collecting
    if tn.strip(" .!") in ("cancelar", "cancel", "anular"):
        convo.shop_cart = None
        return ("Pedido cancelado. ¿Querés empezar de nuevo? "
                "Escribí 'menú' para ver las opciones."
                if lang != "en" else
                "Order cancelled. Want to start over? Type 'menu'.")
    if _is_menu_ask(t) and catalog is not None:
        return (menu_text(catalog, lang)
                + "\n\nTu pedido hasta ahora:\n" + _summary(cart))
    matches, ambiguous = _find_matches(catalog, text) \
        if catalog is not None else ([], [])
    if ambiguous and not matches:
        cart["pending"] = {"candidates": ambiguous, "qty": 1,
                           "text": text}
        opts = "\n".join(f"• {g['name']} — {_fmt(g['price'])}"
                         for g in ambiguous)
        return ("¿Cuál tamaño preferís?\n" + opts
                if lang != "en" else
                "Which size would you like?\n" + opts)
    if any(c in tn for c in REMOVE_CUES) and matches:
        removed = []
        for item, _q in matches:
            kept = [l for l in cart["items"] if l["id"] != item["id"]]
            if len(kept) != len(cart["items"]):
                removed.append(item["name"])
            cart["items"] = kept
        if removed:
            head = "Quité: " + ", ".join(removed) + " ✅"
            if not cart["items"]:
                convo.shop_cart = None
                return (head + "\nTu pedido quedó vacío. "
                        "Escribí 'menú' para ver las opciones."
                        if lang != "en" else
                        head + "\nYour order is empty now. "
                        "Type 'menu' to see the options.")
            return (head + "\n" + _summary(cart)
                    + "\n¿Algo más? Escribí 'listo' para confirmar.")
        return ("No encontré eso en tu pedido.\n" + _summary(cart)
                if lang != "en" else
                "I didn't find that in your order.\n" + _summary(cart))
    if matches:
        added = _add_matches(cart, catalog, matches, text)
        return ("Anotado: " + ", ".join(added) + " ✅\n"
                + _summary(cart)
                + "\n¿Algo más? Escribí 'listo' para confirmar."
                if lang != "en" else
                "Got it: " + ", ".join(added) + " ✅\n"
                + _summary(cart)
                + "\nAnything else? Type 'listo' to confirm.")
    if tn.strip(" .!") in ("listo", "done", "eso es", "eso es todo",
                            "nada mas", "nada más"):
        if not cart["items"]:
            return ("Tu pedido está vacío — decime qué te gustaría "
                    "ordenar, o escribí 'menú'."
                    if lang != "en" else
                    "Your order is empty — tell me what you'd like, "
                    "or type 'menu'.")
        cart["stage"] = "paying"
        return ("Tu pedido:\n" + _summary(cart)
                + "\n¿Cómo pagás?\n1️⃣ Al recoger (efectivo o "
                  "tarjeta)\n2️⃣ Transferencia (el equipo la "
                  "verifica)\nRespondé *1* o *2*."
                if lang != "en" else
                "Your order:\n" + _summary(cart)
                + "\nHow will you pay?\n1️⃣ At pickup (cash or "
                  "card)\n2️⃣ Transfer (the team verifies it)\n"
                  "Reply *1* or *2*.")
    return ("No reconocí ese artículo 🙏 Tu pedido sigue así:\n"
            + _summary(cart)
            + "\nEscribí 'menú' para ver las opciones, o 'listo' "
              "para confirmar."
            if lang != "en" else
            "I didn't recognize that item 🙏 Your order so far:\n"
            + _summary(cart)
            + "\nType 'menu' for the options, or 'listo' to confirm.")


def try_handle(convo, text: str) -> Optional[str]:
    """One shop turn for a LOUNGE conversation, or None when the
    shop has nothing to say (no catalog, or not shop business) and
    the intro flow should answer as it always has."""
    catalog = menu_client.get_catalog()
    lang = convo.lang or "es"

    if getattr(convo, "shop_cart", None):
        if catalog is None and convo.shop_cart.get("stage") != "paying":
            # Catalog vanished mid-order (fetch outage with an
            # expired cache is impossible — get_catalog keeps the
            # last-good — so this is a test/reset edge): keep serving
            # the cart from its own priced lines.
            catalog = None
        return _handle_session(convo, text, catalog, lang)

    if catalog is None or not catalog.items:
        return None

    t = text.lower()
    # Preventa packs/boxes stay the intro flow's business.
    if any(c in _norm(text) for c in PACK_CUES):
        return None

    matches, ambiguous = _find_matches(catalog, text)

    if _is_menu_ask(t) and not matches and not ambiguous:
        return menu_text(catalog, lang)

    if any(c in t for c in PRICE_CUES) and (matches or ambiguous):
        named = (matches[0][0] if matches else ambiguous[0])
        if lang == "en":
            return (f"{named['name']} — {_fmt(named['price'])}. "
                    "Want me to add one to your order?")
        return (f"{named['name']} — {_fmt(named['price'])}. "
                "¿Te lo anoto en tu pedido?")

    if ambiguous and not matches:
        convo.shop_cart = _new_cart()
        convo.shop_cart["pending"] = {
            "candidates": ambiguous, "qty": 1, "text": text}
        opts = "\n".join(f"• {g['name']} — {_fmt(g['price'])}"
                         for g in ambiguous)
        return ("¿Cuál tamaño preferís?\n" + opts
                if lang != "en" else
                "Which size would you like?\n" + opts)

    if not matches:
        return None

    convo.shop_cart = _new_cart()
    added = _add_matches(convo.shop_cart, catalog, matches, text)
    return ("Anotado: " + ", ".join(added) + " ✅\n"
            + _summary(convo.shop_cart)
            + "\n¿Algo más? Escribí 'listo' para confirmar."
            if lang != "en" else
            "Got it: " + ", ".join(added) + " ✅\n"
            + _summary(convo.shop_cart)
            + "\nAnything else? Type 'listo' to confirm.")
