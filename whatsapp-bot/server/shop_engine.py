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

MENU PRESENTATION (bot-menu-fix, owner ruling 2026-10-26): the
catalog is NEVER dumped into chat as one long text. A menu ask
answers with a WaReply (wa_reply.py): a short body + an interactive
LIST of curated browsing sections (Bebidas calientes · Bebidas
frías · Frappés y granitas · Chai y té · Botellas y bolis · Comida
· Panadería y postres · Combos — NOT the raw DB categories).
Tapping a section (list_reply id "sec:<id>", or the section's
number after the text fallback) shows ONLY that section's items.
Browsing is presentation only: ordering by name works at any
point, exactly as before.

ONE MENU MESSAGE (bot-ux-fix, owner ruling 2026-10-26): the photo
storefront link rides ONLY in the WaReply's plain-text fallback —
the fallback IS the menu for clients that can't render the list,
so the link lives there. The interactive body and the section
views carry no link: in chat, the chat is the store.

MENU LINK LEADS (menu-link-pass, owner ruling 2026-10-31 —
SUPERSEDES the bot-ux-fix placement above): browsing belongs on
the photo page, not in chat — a menu ask now LEADS with the
storefront link in BOTH renderings (the interactive body and the
text fallback), exactly once in each. The section LIST stays
fully working as the in-chat alternative; section views still
carry no link. Customers can order on the page or here, their
pick — the reply says so up front.

FLAVOR QUESTION (bot-ux-fix, 2026-10-26): a bare family ask
("un latte de 12") names no single item — the flavor families are
honestly ambiguous (11 latte flavors, no plain latte) — so instead
of going silent the engine asks ONE question ("¿De qué sabor?")
and the one-word answer completes the pick through the normal
cart flow. Detection is data-driven over the live catalog (see
_detect_family); only true flavor x size matrices fire, so
single-format families (botellas, bolis, frescos) keep their
existing flows.

PREP TIME (owner-approved, 2026-10-26; mandaditos parked): at
checkout — after 'listo', before the payment question — the
customer picks WHEN: 🔥 Ahora mismo, or one of today's remaining
30-minute prep slots. All slot math runs in the shop's timezone
(America/Tegucigalpa — the host runs UTC): first slot = now +
20 min lead, rounded UP to the :00/:30 grid and never before
opening; last slot = 30 min before close; when no slot remains
today the question is skipped and the order is simply ASAP. The
pick rides the order end to end: build_order -> the kds_push
ticket (requestedFor / requestedForLabel) -> the OS orders row
(requested_for / requested_for_label). ASAP leaves the field
null/absent at every hop — the payloads are exactly what they
were before this feature.

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
from datetime import datetime, timedelta, timezone
from typing import Optional

try:
    import menu_client
    import kds_push
    from orders import save_order
    from wa_reply import WaReply
except ImportError:  # running as part of the server package
    from server import menu_client, kds_push
    from server.orders import save_order
    from server.wa_reply import WaReply

BUSINESS_SLUG = "rich-aroma-honduras"
CURRENCY = "HNL"
STORE_URL = "https://www.richaromacoffee.com/order"

# ------------------------------------------------------------ prep time
# All slot math is done in the SHOP's timezone — the host (Render)
# runs UTC, so server local time is never used here.
try:
    from zoneinfo import ZoneInfo
    SHOP_TZ = ZoneInfo("America/Tegucigalpa")
except Exception:  # host without a tz database: Honduras is a
    # fixed UTC-6 (no DST), so the offset fallback is exact.
    SHOP_TZ = timezone(timedelta(hours=-6))

# Shop hours by weekday (Mon=0 .. Sun=6) as (open, close) hours in
# shop time. These are the GOOGLE LISTING hours; the owner has NOT
# confirmed the real reopening hours yet — when he does, this dict
# is the one place to change.
SHOP_HOURS = {0: (7, 19), 1: (7, 19), 2: (7, 19), 3: (7, 19),
              4: (7, 19), 5: (7, 19), 6: (8, 18)}
PREP_LEAD_MINUTES = 20        # first slot = now + this lead,
                              # rounded UP to the :00/:30 grid
SLOT_STEP_MINUTES = 30
LAST_SLOT_BEFORE_CLOSE = 30   # last slot = close - this many min
PRESENTED_SLOTS = 9           # + the ASAP row = the list's
                              # 10-row cap

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

# ------------------------------------------------------------ menu curation
# Browsing sections are CURATED, not the raw OS categories (the
# espresso_bar category alone holds 41 items). Every sellable item
# lands in exactly one section via _section_of(); the map is the
# presentation contract the shop battery pins (full, disjoint
# coverage of the catalog). Order here is the browsing order.
MENU_SECTIONS = [
    {"id": "bebidas-calientes",
     "title": {"es": "Bebidas calientes", "en": "Hot drinks"},
     "desc": {"es": "Lattes, americano y café filtrado",
              "en": "Lattes, americano & drip coffee"}},
    {"id": "bebidas-frias",
     "title": {"es": "Bebidas frías", "en": "Cold drinks"},
     "desc": {"es": "Lattes helados, licuados y frescos",
              "en": "Iced lattes, licuados & frescos"}},
    {"id": "frappes-granitas",
     "title": {"es": "Frappés y granitas", "en": "Frappés & granitas"},
     "desc": {"es": "Frappés, supremes y granitas",
              "en": "Frappés, supremes & granitas"}},
    {"id": "chai-te",
     "title": {"es": "Chai y té", "en": "Chai & tea"},
     "desc": {"es": "Chai latte, chai frappé y tés",
              "en": "Chai lattes, chai frappé & teas"}},
    {"id": "botellas-bolis",
     "title": {"es": "Botellas y bolis", "en": "Bottles & bolis"},
     "desc": {"es": "Café embotellado y bolis",
              "en": "Bottled coffee & bolis"}},
    {"id": "comida",
     "title": {"es": "Comida", "en": "Food"},
     "desc": {"es": "Baleadas, sándwiches, crepas y bowls",
              "en": "Baleadas, sandwiches, crepes & bowls"}},
    {"id": "panaderia-postres",
     "title": {"es": "Panadería y postres", "en": "Bakery & desserts"},
     "desc": {"es": "Del horno de las 5am y postres",
              "en": "From the 5am bake & desserts"}},
    {"id": "combos",
     "title": {"es": "Combos", "en": "Combos"},
     "desc": {"es": "Los combos numerados de la mañana",
              "en": "The numbered morning combos"}},
]
_SECTION_IDS = [s["id"] for s in MENU_SECTIONS]


def _section_of(item: dict) -> str:
    """The one browsing section an item belongs to. Ordered rules
    over the OS category + item id; flavor family wins over format
    (the chai frappé lives with the chai, not the frappés)."""
    iid = item["id"]
    cat = item["category"]
    if cat == "combos":
        return "combos"
    if iid.startswith("botella-") or iid.startswith("boli-"):
        return "botellas-bolis"
    if cat == "tea_matcha":
        return "chai-te"
    if cat == "supremes_icees":
        if iid.startswith("granita-"):
            return "frappes-granitas"
        if iid.startswith("frappe-") or iid.endswith("-supreme"):
            return "frappes-granitas"
        return "bebidas-frias"  # licuado, frescos, limonada
    if cat == "espresso_bar":
        if iid.startswith("iced-"):
            return "bebidas-frias"
        return "bebidas-calientes"
    if iid == "crepa-dulce":
        return "panaderia-postres"
    if cat in ("grill_toast_crepes", "bowls_salads"):
        return "comida"
    if cat in ("bakery", "reposteria"):
        return "panaderia-postres"
    return "comida"


def section_items(catalog, section_id: str):
    """One section's sellable items, name-sorted. [] for an unknown
    or empty section."""
    if section_id not in _SECTION_IDS:
        return []
    out = [i for i in catalog.items.values()
           if _section_of(i) == section_id]
    return sorted(out, key=lambda i: i["name"])


def _sections_present(catalog):
    """Curated sections holding at least one item, in browse
    order, as (section_dict, items) pairs."""
    out = []
    for s in MENU_SECTIONS:
        items = section_items(catalog, s["id"])
        if items:
            out.append((s, items))
    return out


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


def _pending_size_pick(text: str, group):
    """Size resolution for a conversational ANSWER — a size
    question is already on the table, so a bare number is a
    complete answer ('12' answers '¿Cuál tamaño?'). The usual cues
    first, then the bare-number reading."""
    picked = _size_cue(text, group)
    if picked is not None:
        return picked
    toks = [x for x in _norm(text).split()
            if x not in ("el", "la", "de", "oz")]
    if len(toks) == 1:
        m = re.fullmatch(r"(8|12|16)(?:oz)?", toks[0])
        if m:
            want = int(m.group(1))
            for it in group:
                if _size_of(it) == want:
                    return it
    return None


# ------------------------------------------------------- flavor families

def _name_tokens(item: dict):
    """Ordered match tokens of an item's display name (stopwords
    and size tokens removed) — the ordered shape of the first core
    _core_tokens builds, so families can be read off the name:
    'Latte Dulce de Leche 12oz' -> ['latte', 'dulce', 'leche']."""
    return [t for t in _tokens(item.get("name") or "")
            if t not in _STOPWORDS and t not in _SIZE_TOKENS]


def _family_size_cue(text: str, sizes, toks, qty_pos):
    """The size a family ask cues, or None: an explicit '12oz', a
    grande/chico word, or a bare size number that isn't the token
    already read as the quantity ('un latte de 12' — the 12 is the
    size; '12 lattes' — the 12 is the quantity)."""
    t = _norm(text)
    m = re.search(r"\b(8|12|16)\s*oz\b", t)
    if m and int(m.group(1)) in sizes:
        return int(m.group(1))
    if any(w in t for w in ("grande", "gran", "largo")):
        return sizes[-1]
    if any(w in t for w in ("pequeno", "pequena", "chico", "corto")):
        return sizes[0]
    for i, tk in enumerate(toks):
        if i != qty_pos and tk.isdigit() and int(tk) in sizes:
            return int(tk)
    return None


def _detect_family(catalog, text: str):
    """A drink-family ask: the message names the shared head token
    of a catalog family but no single item ('un latte de 12').
    Returns {"head", "variants", "size", "qty"} or None.

    Data-driven over the catalog: a family is the set of items
    whose display names share a first token and differ in what
    follows ('Latte <Flavor> <Size>'). It only counts when the
    choice is a real flavor x size matrix — >= 3 variants, >= 2
    sizes across the family, at least one variant sold in 2+
    sizes — so single-format families (botellas, bolis, frescos,
    granitas: one size each, and other flows own them) never fire.
    """
    by_head = {}
    for item in catalog.items.values():
        ntoks = _name_tokens(item)
        if len(ntoks) < 2:
            continue
        by_head.setdefault(ntoks[0], {}).setdefault(
            tuple(ntoks[1:]), []).append(item)
    toks = _tokens(text)
    raw = _tokens(text, singular=False)
    for pos, tok in enumerate(toks):
        fam = by_head.get(tok)
        if not fam or len(fam) < 3:
            continue
        sizes = sorted({s for items in fam.values()
                        for s in (_size_of(i) for i in items) if s})
        if len(sizes) < 2:
            continue
        if not any(len({s for s in (_size_of(i) for i in items)
                        if s}) >= 2 for items in fam.values()):
            continue
        qty = 1
        qty_pos = None
        for j in range(pos - 1, max(pos - 3, -1), -1):
            tk = raw[j]
            if tk.isdigit():
                qty = max(1, min(20, int(tk)))
                qty_pos = j
                break
            if tk in NUMBER_WORDS:
                qty = NUMBER_WORDS[tk]
                qty_pos = j
                break
        variants = []
        for key in sorted(fam, key=lambda k: " ".join(k)):
            items = sorted(fam[key],
                           key=lambda i: (_size_of(i) or 0, i["name"]))
            label = re.sub(r"\s+", " ", re.sub(
                r"\s*\d+\s*oz", "", items[0]["name"],
                flags=re.IGNORECASE)).strip()
            variants.append({"tokens": list(key), "label": label,
                             "items": items})
        return {"head": tok, "variants": variants,
                "size": _family_size_cue(text, sizes, toks, qty_pos),
                "qty": qty}
    return None


def _flavor_pending(fam: dict, text: str) -> dict:
    """The cart pending state a flavor question leaves behind —
    same slot the size question uses, kind-tagged so the answer
    turn can tell them apart."""
    return {"kind": "flavor", "head": fam["head"],
            "variants": fam["variants"], "size": fam["size"],
            "qty": fam["qty"], "text": text}


def _flavor_question(variants, size, lang: str) -> str:
    """The ONE question a bare family ask earns. At a cued size it
    lists that size's items with prices; without one it lists the
    variant names (answer with a flavor, then size is asked)."""
    if size:
        lines = []
        for var in variants:
            for it in var["items"]:
                if _size_of(it) == size:
                    lines.append(f"• {it['name']} — "
                                 f"{_fmt(it['price'])}")
                    break
        if lines:
            head = ("¡Claro! ¿De qué sabor lo querés?"
                    if lang != "en" else
                    "Sure! Which flavor would you like?")
            return head + "\n" + "\n".join(lines)
    lines = [f"• {var['label']}" for var in variants]
    head = ("¡Claro! ¿De qué sabor lo querés?"
            if lang != "en" else
            "Sure! Which flavor would you like?")
    return head + "\n" + "\n".join(lines)


def _flavor_pick(pend: dict, text: str):
    """Resolve a flavor-question answer. Returns (item, None) when
    fully resolved, (None, group) when the flavor is chosen but a
    size question remains, (None, None) when no variant is named.
    The longest variant token set wins, so 'caramel helado' picks
    the iced caramel over the hot one."""
    toks = set(_tokens(text))
    best = None
    for var in pend["variants"]:
        vt = set(var["tokens"])
        if vt and vt <= toks \
                and (best is None
                     or len(vt) > len(set(best["tokens"]))):
            best = var
    if best is None:
        return None, None
    items = best["items"]
    if pend.get("size"):
        for it in items:
            if _size_of(it) == pend["size"]:
                return it, None
        return None, items
    picked = _pending_size_pick(text, items)
    if picked is not None:
        return picked, None
    if len(items) == 1:
        return items[0], None
    return None, items


def _answer_flavor_pending(convo, cart, catalog, text: str,
                           lang: str):
    """One answer turn for a pending flavor question. Returns the
    reply, or None when the answer names a different full item
    instead — the pending is cleared and the caller keeps
    processing the message as a fresh turn (the size question's
    own moved-on behavior, mirrored)."""
    pend = cart["pending"]
    pick, group = _flavor_pick(pend, text)
    src = ((pend.get("text") or "") + " " + text).strip()
    if pick is not None:
        cart["pending"] = None
        _add_matches(cart, catalog,
                     [(pick, pend.get("qty") or 1)], src)
        return ("Anotado ✅\n" + _summary(cart)
                + "\n¿Algo más? Escribí 'listo' para confirmar."
                if lang != "en" else
                "Got it ✅\n" + _summary(cart)
                + "\nAnything else? Type 'listo' to confirm.")
    if group is not None:
        cart["pending"] = {"candidates": group,
                           "qty": pend.get("qty") or 1, "text": src}
        opts = "\n".join(f"• {g['name']} — {_fmt(g['price'])}"
                         for g in group)
        return ("¿Cuál tamaño preferís?\n" + opts
                if lang != "en" else
                "Which size would you like?\n" + opts)
    if catalog is not None:
        full, _amb = _find_matches(catalog, text)
        if full:
            cart["pending"] = None
            return None
    return _flavor_question(pend["variants"], pend.get("size"), lang)


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


def _section_title(section: dict, lang: str) -> str:
    return section["title"].get(lang) or section["title"]["es"]


def menu_reply(lang: str = "es", convo=None) -> Optional[WaReply]:
    """The menu as a WaReply (interactive section LIST + numbered
    text fallback) when a catalog is available, else None (the
    intro flow's parked copy takes over — pre-import behavior).

    The body is 3 short lines; the full catalog NEVER appears in
    any single message. When convo is given, the presented section
    order is remembered on it (convo.menu_sections) so a bare
    number — the fallback's own instruction — opens that section.
    """
    catalog = menu_client.get_catalog()
    if catalog is None or not catalog.items:
        return None
    present = _sections_present(catalog)
    if convo is not None:
        convo.menu_sections = [s["id"] for s, _ in present]
    rows = [{
        "id": f"sec:{s['id']}",
        "title": _section_title(s, lang),
        "description": s["desc"].get(lang) or s["desc"]["es"],
    } for s, _ in present]
    sections = [{"title": "Menú" if lang != "en" else "Menu",
                 "rows": rows}]
    if lang == "en":
        body = ("Sure! ☕ Want to see everything with photos and "
                f"prices? Here's the full menu 👉 {STORE_URL}\n"
                "You can order right there or here on WhatsApp — "
                "your pick. And if you already know what you want, "
                "just tell me here 👇\n"
                "Or tap *See the menu* and pick a section.")
        numbered = ["*Rich Aroma — Menu* ☕",
                    "🌐 Full menu with photos and prices: "
                    f"{STORE_URL}",
                    "Reply with the number of the section you "
                    "want to see:"]
        numbered += [f"{n}. {_section_title(s, lang)}"
                     for n, (s, _) in enumerate(present, 1)]
        numbered.append("Or just tell me what you'd like, e.g. "
                        "'a 12oz caramel latte'.")
        button = "See the menu"
    else:
        body = ("¡Claro! ☕ ¿Querés ver todo con fotos y precios? "
                f"Aquí está el menú completo 👉 {STORE_URL}\n"
                "Podés pedir ahí mismo o por WhatsApp, como "
                "prefirás. Y si ya sabés lo que querés, pedímelo "
                "aquí nomás 👇\n"
                "O tocá *Ver el menú* y elegí una sección.")
        numbered = ["*Rich Aroma — Menú* ☕",
                    "🌐 Menú completo, con fotos y precios: "
                    f"{STORE_URL}",
                    "Respondé con el número de la sección que "
                    "querés ver:"]
        numbered += [f"{n}. {_section_title(s, lang)}"
                     for n, (s, _) in enumerate(present, 1)]
        numbered.append("O pedime directo lo que querás, ej: "
                        "'un latte de caramelo 12oz'.")
        button = "Ver el menú"
    return WaReply("list", body, "\n".join(numbered),
                   button_text=button, sections=sections)


def section_reply(catalog, section_id: str,
                  lang: str = "es") -> Optional[str]:
    """ONE section's items as compact lines — nothing else from
    the catalog. None for an unknown/empty section."""
    items = section_items(catalog, section_id)
    if not items:
        return None
    section = next(s for s in MENU_SECTIONS if s["id"] == section_id)
    title = _section_title(section, lang)
    lines = [f"*{title}* ☕"]
    for item in items:
        lines.append(f"• {item['name']} — {_fmt(item['price'])}")
    if lang == "en":
        lines.append("Tell me what you'd like by name, or type "
                     "'menu' for another section.")
    else:
        lines.append("Pedime lo que querás por nombre, o escribí "
                     "'menú' para ver otra sección.")
    return "\n".join(lines)


# ------------------------------------------------------------ prep time

def _now_shop() -> datetime:
    """Now in the shop's timezone — the ONE clock the prep-time
    math reads (the battery stubs this to pin conversations to a
    fixed moment)."""
    return datetime.now(SHOP_TZ)


def _slot_label(dt: datetime) -> str:
    h = dt.hour % 12 or 12
    return f"{h}:{dt.minute:02d} {'AM' if dt.hour < 12 else 'PM'}"


def _prep_slots(now: datetime = None):
    """Today's remaining prep slots as {"iso", "label", "hm"}
    dicts, in shop time. First slot: now + PREP_LEAD_MINUTES,
    rounded UP to the next :00/:30, never before opening. Last
    slot: LAST_SLOT_BEFORE_CLOSE minutes before close. [] when
    no slot remains today — the caller then skips the question
    entirely and the order is simply ASAP (never invent a slot).
    """
    now = now or _now_shop()
    open_h, close_h = SHOP_HOURS[now.weekday()]
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    open_dt = midnight + timedelta(hours=open_h)
    last_dt = midnight + timedelta(hours=close_h) \
        - timedelta(minutes=LAST_SLOT_BEFORE_CLOSE)
    cand = (now + timedelta(minutes=PREP_LEAD_MINUTES)) \
        .replace(second=0, microsecond=0)
    rem = cand.minute % SLOT_STEP_MINUTES
    if rem:
        cand += timedelta(minutes=SLOT_STEP_MINUTES - rem)
    start = max(cand, open_dt)
    out = []
    t = start
    while t <= last_dt:
        out.append({"iso": t.isoformat(), "label": _slot_label(t),
                    "hm": t.strftime("%H:%M")})
        t += timedelta(minutes=SLOT_STEP_MINUTES)
    return out


def _payment_question(cart, lang: str) -> str:
    """The payment-choice question that closes the order —
    reached from 'listo', directly or via the prep-time answer."""
    if lang == "en":
        return ("Your order:\n" + _summary(cart)
                + "\nHow will you pay?\n1️⃣ At pickup (cash or "
                  "card)\n2️⃣ Transfer (the team verifies it)\n"
                  "Reply *1* or *2*.")
    return ("Tu pedido:\n" + _summary(cart)
            + "\n¿Cómo pagás?\n1️⃣ Al recoger (efectivo o "
              "tarjeta)\n2️⃣ Transferencia (el equipo la "
              "verifica)\nRespondé *1* o *2*.")


def _when_question(cart, lang: str) -> WaReply:
    """The prep-time question as a WaReply — the same two
    renderings pattern as the menu: an interactive LIST (🔥 Ahora
    mismo + the next slots) the customer taps, and a numbered
    text fallback. The presented slots ride on the cart
    (when_presented); the FULL day list (when_all) is what typed
    times match against."""
    presented = cart["when_presented"]
    if lang == "en":
        body = ("Your order:\n" + _summary(cart)
                + "\n\nWhen should we prepare it? "
                  "Tap an option 👇")
        lines = ["Your order:", _summary(cart), "",
                 "When should we prepare it?",
                 "Reply with the number:",
                 "1. 🔥 Right away"]
        lines += [f"{n}. 🕐 {s['label']}"
                  for n, s in enumerate(presented, 2)]
        lines.append("Or type the time, e.g. '12:30'.")
        button = "Choose a time"
        asap_title, asap_desc = "🔥 Right away", \
            "We prepare it right away"
        slot_desc = "We prepare it for this time"
        sec_title = "What time?"
    else:
        body = ("Tu pedido:\n" + _summary(cart)
                + "\n\n¿Para cuándo lo preparamos? "
                  "Tocá una opción 👇")
        lines = ["Tu pedido:", _summary(cart), "",
                 "¿Para cuándo lo preparamos?",
                 "Respondé con el número:",
                 "1. 🔥 Ahora mismo"]
        lines += [f"{n}. 🕐 {s['label']}"
                  for n, s in enumerate(presented, 2)]
        lines.append("O escribí la hora, ej: '12:30'.")
        button = "Elegir hora"
        asap_title, asap_desc = "🔥 Ahora mismo", \
            "Lo preparamos de inmediato"
        slot_desc = "Lo preparamos para esta hora"
        sec_title = "¿Para cuándo?"
    rows = [{"id": "time:asap", "title": asap_title,
             "description": asap_desc}]
    rows += [{"id": f"time:{s['hm']}", "title": f"🕐 {s['label']}",
              "description": slot_desc} for s in presented]
    sections = [{"title": sec_title, "rows": rows}]
    return WaReply("list", body, "\n".join(lines),
                   button_text=button, sections=sections)


_TIME_RE = re.compile(
    r"(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?")


def _looks_like_time(text: str) -> bool:
    """Does this message even try to name a time? Guards the
    typed-slot matcher so a stray number (a quantity, a menu
    pick) is never read as a clock time."""
    t = (text or "").lower()
    return bool(re.search(r"\d{1,2}[:.]\d{2}", t)
                or re.search(r"\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)", t)
                or re.search(r"\ba\s+las?\s+\d{1,2}\b", t))


def _typed_slot(cart, text: str):
    """Match a typed time — '12:30', 'a las 12:30', '1 pm',
    '13:00' — against today's FULL slot list on the cart.
    Returns the slot dict, or None when it names no real slot.
    With no am/pm marker both readings are tried (12-hour first,
    then +12): a slot exists on at most one of them in practice.
    """
    m = _TIME_RE.search((text or "").lower())
    if not m:
        return None
    hour = int(m.group(1))
    minute = int(m.group(2) or 0)
    marker = (m.group(3) or "").replace(".", "")
    if marker == "am":
        cands = [(hour % 12, minute)]
    elif marker == "pm":
        cands = [(hour % 12 + 12, minute)]
    elif hour > 12:
        cands = [(hour, minute)]
    else:
        cands = [(hour, minute), (hour + 12, minute)]
    for h, mi in cands:
        hm = f"{h:02d}:{mi:02d}"
        for s in cart.get("when_all") or []:
            if s["hm"] == hm:
                return s
    return None


def _choose_time(cart, slot):
    """Record the prep-time pick (slot None = ASAP) and move on
    to the payment question."""
    if slot is None:
        cart["requested_for"] = None
        cart["requested_for_label"] = None
    else:
        cart["requested_for"] = slot["iso"]
        cart["requested_for_label"] = slot["label"]
    cart["stage"] = "paying"
    for k in ("when_all", "when_presented", "when_attempts"):
        cart.pop(k, None)


def _answer_when(convo, cart, catalog, text: str, lang: str):
    """One answer turn for the prep-time question. Returns the
    reply, or None when the answer names a full item instead —
    the stage reverts to collecting and the caller keeps
    processing the message as a fresh collecting turn (the
    pending questions' moved-on behavior, mirrored)."""
    t = text.lower()
    tn = _norm(text)
    # A list tap arrives as its reply id ("time:asap" /
    # "time:12:30") — read it lightly normalized, like the
    # section taps, because _norm would eat the ':'.
    tap = (text or "").strip().lower()
    tap = "".join(ch for ch in unicodedata.normalize("NFD", tap)
                  if unicodedata.category(ch) != "Mn")
    if tap.startswith("time:"):
        want = tap[len("time:"):].strip()
        if want == "asap":
            _choose_time(cart, None)
            return _payment_question(cart, lang)
        for s in cart.get("when_all") or []:
            if s["hm"] == want:
                _choose_time(cart, s)
                return _payment_question(cart, lang)
        # A tap naming a slot that isn't today's: re-ask below.
    stripped = tn.strip(" .!")
    if stripped in ("cancelar", "cancel", "anular"):
        convo.shop_cart = None
        return ("Pedido cancelado. ¿Querés empezar de nuevo? "
                "Escribí 'menú' para ver las opciones."
                if lang != "en" else
                "Order cancelled. Want to start over? Type 'menu'.")
    if stripped in ("no", "n"):
        cart["stage"] = "collecting"
        for k in ("when_all", "when_presented", "when_attempts"):
            cart.pop(k, None)
        return ("Sin problema, seguimos con tu pedido:\n"
                + _summary(cart)
                + "\nPodés agregar o quitar artículos, o "
                  "'cancelar' para anular todo."
                if lang != "en" else
                "No problem, let's keep editing:\n" + _summary(cart)
                + "\nAdd or remove items, or 'cancelar' to void it.")
    if _is_menu_ask(t) and catalog is not None:
        mr = menu_reply(lang, convo)
        if mr is not None:
            return mr.append("Tu pedido hasta ahora:\n"
                             + _summary(cart))
    if stripped.isdigit():
        # The numbered fallback's own numbering: 1 = ASAP, then
        # the presented slots in order.
        n = int(stripped)
        presented = cart.get("when_presented") or []
        if n == 1:
            _choose_time(cart, None)
            return _payment_question(cart, lang)
        if 2 <= n <= len(presented) + 1:
            _choose_time(cart, presented[n - 2])
            return _payment_question(cart, lang)
    toks = set(tn.split())
    if toks & {"ahora", "ya", "asap"} or "antes posible" in tn \
            or "right away" in t:
        _choose_time(cart, None)
        return _payment_question(cart, lang)
    if _looks_like_time(text):
        slot = _typed_slot(cart, text)
        if slot is not None:
            _choose_time(cart, slot)
            return _payment_question(cart, lang)
    if catalog is not None:
        full, _amb = _find_matches(catalog, text)
        if full:
            cart["stage"] = "collecting"
            for k in ("when_all", "when_presented",
                      "when_attempts"):
                cart.pop(k, None)
            return None
    # No usable answer: re-ask ONCE kindly; a second miss
    # defaults to ASAP rather than trapping the customer inside
    # the question.
    cart["when_attempts"] = (cart.get("when_attempts") or 0) + 1
    if cart["when_attempts"] >= 2:
        _choose_time(cart, None)
        note = ("No encontré esa hora — te lo dejo para "
                "*ahora mismo* 🔥\n"
                if lang != "en" else
                "I couldn't place that time — I'll set it to "
                "*right away* 🔥\n")
        return note + _payment_question(cart, lang)
    return _when_question(cart, lang).prepend(
        "No encontré esa hora 🙏 Probemos de nuevo:"
        if lang != "en" else
        "I couldn't place that time 🙏 Let's try again:")


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
    order = {
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
    # Prep time (2026-10-26): a chosen slot rides the order end to
    # end — kds_push maps it onto the OS ticket, order-service
    # stores it on the row. ASAP keeps both keys OFF the order:
    # the dict is exactly what it was before this feature.
    if cart.get("requested_for"):
        order["requested_for"] = cart["requested_for"]
        order["requested_for_label"] = \
            cart.get("requested_for_label")
    return order


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
    when_line = ""
    if order.get("requested_for"):
        _label = order.get("requested_for_label") or ""
        when_line = (f"\n⏰ We'll prepare it for {_label}."
                     if lang == "en" else
                     f"\n⏰ Te lo preparamos para las {_label}.")
    if lang == "en":
        head = (f"Order confirmed! 🎉\nOrder {order['order_id']} — "
                f"*Total: {total}*\n📍 Pickup at Rich Aroma, "
                "Quimistán.") + when_line
        if payment_method == "transfer":
            return (head + "\n🏦 Pay by transfer — the team will "
                    "share the account details here and verify it; "
                    "we'll message you when your order is ready 😊")
        return (head + "\nYou pay when you pick it up. We'll "
                "message you here when it's ready 😊")
    head = (f"¡Pedido confirmado! 🎉\nPedido {order['order_id']} — "
            f"*Total: {total}*\n📍 Para recoger en Rich Aroma, "
            "Quimistán.") + when_line
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

    # A pending question (flavor first, then size) outranks
    # everything else in the cart.
    if cart.get("pending"):
        if cart["pending"].get("kind") == "flavor":
            _fr = _answer_flavor_pending(convo, cart, catalog,
                                          text, lang)
            if _fr is not None:
                return _fr
            # Moved on to a different full item: the pending is
            # cleared and this message is processed as a fresh
            # turn below.
        else:
            group = cart["pending"]["candidates"]
            picked = _pending_size_pick(text, group)
            if picked is None:
                full, _amb = _find_matches(catalog, text) \
                    if catalog else ([], [])
                if full:
                    cart["pending"] = None  # moved on to a new item
                else:
                    opts = "\n".join(
                        f"• {g['name']} — {_fmt(g['price'])}"
                        for g in group)
                    return ("¿Cuál tamaño preferís?\n" + opts) \
                        if lang != "en" else \
                        ("Which size would you like?\n" + opts)
            if picked is not None:
                qty = cart["pending"]["qty"]
                src = cart["pending"]["text"]
                cart["pending"] = None
                _add_matches(cart, catalog, [(picked, qty)], src)
                return ("Anotado ✅\n" + _summary(cart)
                        + "\n¿Algo más? Escribí 'listo' para "
                          "confirmar."
                        if lang != "en" else
                        "Got it ✅\n" + _summary(cart)
                        + "\nAnything else? Type 'listo' to confirm.")

    if cart["stage"] == "when":
        _wr = _answer_when(convo, cart, catalog, text, lang)
        if _wr is not None:
            return _wr
        # Moved on to a different item: the stage reverted to
        # collecting inside _answer_when and this message is
        # processed as a fresh collecting turn below.

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
        mr = menu_reply(lang, convo)
        if mr is not None:
            return mr.append("Tu pedido hasta ahora:\n"
                             + _summary(cart))
        return ("El menú se está actualizando 🙏\n"
                "Tu pedido hasta ahora:\n" + _summary(cart))
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
    if not matches and catalog is not None \
            and not any(c in tn for c in REMOVE_CUES) \
            and not any(c in t for c in PRICE_CUES):
        # A bare family ask mid-order earns the same ONE flavor
        # question as a fresh one (bot-ux-fix).
        fam = _detect_family(catalog, text)
        if fam is not None:
            cart["pending"] = _flavor_pending(fam, text)
            return _flavor_question(fam["variants"], fam["size"],
                                    lang)
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
        # Prep time (2026-10-26): with slots left today, ask WHEN
        # before asking how they'll pay; with none left, the
        # question is skipped — the order is simply ASAP.
        slots = _prep_slots()
        if slots:
            cart["stage"] = "when"
            cart["when_attempts"] = 0
            cart["when_all"] = slots
            cart["when_presented"] = slots[:PRESENTED_SLOTS]
            return _when_question(cart, lang)
        cart["stage"] = "paying"
        return _payment_question(cart, lang)
    return ("No reconocí ese artículo 🙏 Tu pedido sigue así:\n"
            + _summary(cart)
            + "\nEscribí 'menú' para ver las opciones, o 'listo' "
              "para confirmar."
            if lang != "en" else
            "I didn't recognize that item 🙏 Your order so far:\n"
            + _summary(cart)
            + "\nType 'menu' for the options, or 'listo' to confirm.")


def try_handle(convo, text: str):
    """One shop turn for a LOUNGE conversation, or None when the
    shop has nothing to say (no catalog, or not shop business) and
    the intro flow should answer as it always has. The reply is a
    string, or a WaReply when the turn is the menu presentation."""
    catalog = menu_client.get_catalog()
    lang = convo.lang or "es"

    # Menu browsing: a section tap (the interactive list's reply
    # id) is presentation, never an order answer — handle it before
    # the cart session, so a mid-order peek can't be mistaken for
    # a size or a payment reply. (The id keeps its ':' and '-' —
    # _norm would eat both, so this check normalizes lightly.)
    _tap = (text or "").strip().lower()
    _tap = "".join(ch for ch in unicodedata.normalize("NFD", _tap)
                   if unicodedata.category(ch) != "Mn")
    if catalog is not None and catalog.items \
            and _tap.startswith("sec:"):
        sr = section_reply(catalog, _tap[len("sec:"):].strip(), lang)
        if sr:
            return sr
    tn = _norm(text)

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

    # A bare number with no cart open is the menu fallback's own
    # instruction ("respondé con el número") — it opens that
    # browsing section. (Inside a session a number is a qty/size/
    # payment answer; _handle_session owns those.) Only when the
    # number names no item: a real match always wins.
    _digits = tn.strip(" .!")
    n = int(_digits) if _digits.isdigit() else None
    presented = getattr(convo, "menu_sections", None) or []
    if n is not None and not matches and not ambiguous \
            and 1 <= n <= len(presented):
        sr = section_reply(catalog, presented[n - 1], lang)
        if sr:
            return sr

    if _is_menu_ask(t) and not matches and not ambiguous:
        return menu_reply(lang, convo)

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
        # A bare drink-family ask ("un latte de 12") names no
        # single item — the family is honestly ambiguous, so ask
        # ONE flavor question instead of going silent and dropping
        # the customer into the intro flow's fallback
        # (bot-ux-fix, 2026-10-26). A price question about a
        # family is not an order, though: it stays the intro
        # flow's, exactly as before.
        if not any(c in t for c in PRICE_CUES):
            fam = _detect_family(catalog, text)
            if fam is not None:
                convo.shop_cart = _new_cart()
                convo.shop_cart["pending"] = _flavor_pending(fam,
                                                             text)
                return _flavor_question(fam["variants"],
                                        fam["size"], lang)
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
