"""
Conversation battery for the SHOP engine (shop_engine.py +
menu_client.py + notify.py) — the bot-finalize build.

The catalog fixture is the REAL reopening menu: the exact 86 rows
of menu-import.sql (ids, names, lempira prices, categories) shaped
like the OS /api/store?action=menu response, plus the modifier
standard's groups (Dulzor · Leche · Extras) attached the way the
standard prescribes. Conversations run through the real
reply_for_intro with the OS mocked, so every case also proves the
intro/missions/attribution seams stay intact with a catalog live.

Covered: menu ask serves an interactive section LIST, never a
text dump (bot-menu-fix: curated sections, section taps, numbered
fallback picks, a per-message item-line cap over a full browse,
and a disjoint/full curation-coverage assertion over the 86
items); item lookup across categories; size-by-name with iced
items distinct from hot; a size
clarification round-trip; Dulzor (default, Poco dulce, Con
Splenda with packet count, Sin azúcar); leche especial delta;
extras; a fixed combo (no builder); a bottle ordered as a regular
menu item (NOT a preventa); multi-item totals equal to the
hand-computed lempira total; a price named by the customer never
changes the charge; unknown items rejected with no cart; cart
remove/cancel; preventa packs still belong to the intro flow;
no-catalog degradation to the parked copy; the full lifecycle —
the placed order reaches a mock /api/orders-v2 with storefront
shape and an honest UNPAID tender, and ready/cancelled
notifications send exactly once, gated by the shared secret.

Run:  python3 server/test_shop_battery.py
"""

import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

os.environ["WHATSAPP_SIGNUP_SECRET"] = "testsecret"

import intro_engine
import kds_push
import menu_client
import notify
import os_client
import shop_engine

# ---------------------------------------------------------------- fixture

ITEMS = [
    ("combo-baleada", "Baleada Combo ①", "Baleada Combo ①", 80, "combos"),
    ("combo-burrito", "Burrito Combo ②", "Burrito Combo ②", 110, "combos"),
    ("combo-capitana", "Capitana Combo ③", "Capitana Combo ③", 140, "combos"),
    ("combo-avocado-toast", "Avocado Toast Combo ④", "Avocado Toast Combo ④", 135, "combos"),
    ("combo-pb-banana-toast", "PB Banana Toast Combo ⑤", "PB Banana Toast Combo ⑤", 120, "combos"),
    ("baleada-sencilla", "Baleada Sencilla", "Baleada Sencilla", 30, "grill_toast_crepes"),
    ("focaccia-masa-madre", "Focaccia de Masa Madre", "Focaccia de Masa Madre", 35, "bakery"),
    ("pan-de-banano", "Pan de Banano sin Huevo", "Pan de Banano sin Huevo", 35, "bakery"),
    ("focaccia-de-canela", "Focaccia de Canela", "Focaccia de Canela", 35, "bakery"),
    ("sandwich-frio-pollo", "Sándwich Frío de Pollo", "Sándwich Frío de Pollo", 140, "grill_toast_crepes"),
    ("copa-de-fruta", "Copa de Fruta", "Copa de Fruta", 70, "bowls_salads"),
    ("lonchera-del-capitan", "La Lonchera del Capitán", "La Lonchera del Capitán", 185, "grill_toast_crepes"),
    ("bowl-yogurt-griego", "Bowl de Yogurt Griego", "Bowl de Yogurt Griego", 125, "bowls_salads"),
    ("batch-coffee-8oz", "Batch Coffee 8oz", "Café Filtrado 8oz", 35, "espresso_bar"),
    ("batch-coffee-12oz", "Batch Coffee 12oz", "Café Filtrado 12oz", 45, "espresso_bar"),
    ("americano-8oz", "Americano 8oz", "Americano 8oz", 45, "espresso_bar"),
    ("americano-12oz", "Americano 12oz", "Americano 12oz", 55, "espresso_bar"),
    ("latte-horchata-8oz", "Latte Horchata 8oz", "Latte Horchata 8oz", 55, "espresso_bar"),
    ("latte-horchata-12oz", "Latte Horchata 12oz", "Latte Horchata 12oz", 70, "espresso_bar"),
    ("latte-dulce-de-leche-8oz", "Latte Dulce de Leche 8oz", "Latte Dulce de Leche 8oz", 55, "espresso_bar"),
    ("latte-dulce-de-leche-12oz", "Latte Dulce de Leche 12oz", "Latte Dulce de Leche 12oz", 70, "espresso_bar"),
    ("latte-french-vanilla-8oz", "Latte French Vanilla 8oz", "Latte French Vanilla 8oz", 55, "espresso_bar"),
    ("latte-french-vanilla-12oz", "Latte French Vanilla 12oz", "Latte French Vanilla 12oz", 70, "espresso_bar"),
    ("latte-caramel-8oz", "Latte Caramel 8oz", "Latte Caramel 8oz", 55, "espresso_bar"),
    ("latte-caramel-12oz", "Latte Caramel 12oz", "Latte Caramel 12oz", 70, "espresso_bar"),
    ("latte-mocha-8oz", "Latte Mocha 8oz", "Latte Mocha 8oz", 55, "espresso_bar"),
    ("latte-mocha-12oz", "Latte Mocha 12oz", "Latte Mocha 12oz", 70, "espresso_bar"),
    ("latte-fresa-8oz", "Latte Fresa 8oz", "Latte Fresa 8oz", 55, "espresso_bar"),
    ("latte-fresa-12oz", "Latte Fresa 12oz", "Latte Fresa 12oz", 70, "espresso_bar"),
    ("latte-coco-8oz", "Latte Coco 8oz", "Latte Coco 8oz", 55, "espresso_bar"),
    ("latte-coco-12oz", "Latte Coco 12oz", "Latte Coco 12oz", 70, "espresso_bar"),
    ("latte-banana-8oz", "Latte Banana 8oz", "Latte Banana 8oz", 55, "espresso_bar"),
    ("latte-banana-12oz", "Latte Banana 12oz", "Latte Banana 12oz", 70, "espresso_bar"),
    ("latte-ube-8oz", "Latte Ube 8oz", "Latte Ube 8oz", 55, "espresso_bar"),
    ("latte-ube-12oz", "Latte Ube 12oz", "Latte Ube 12oz", 70, "espresso_bar"),
    ("latte-tiramisu-8oz", "Latte Tiramisu 8oz", "Latte Tiramisu 8oz", 55, "espresso_bar"),
    ("latte-tiramisu-12oz", "Latte Tiramisu 12oz", "Latte Tiramisu 12oz", 70, "espresso_bar"),
    ("latte-tres-leches-8oz", "Latte Tres Leches 8oz", "Latte Tres Leches 8oz", 55, "espresso_bar"),
    ("latte-tres-leches-12oz", "Latte Tres Leches 12oz", "Latte Tres Leches 12oz", 70, "espresso_bar"),
    ("iced-latte-horchata-16oz", "Iced Latte Horchata 16oz", "Latte Helado Horchata 16oz", 85, "espresso_bar"),
    ("iced-latte-dulce-de-leche-16oz", "Iced Latte Dulce de Leche 16oz", "Latte Helado Dulce de Leche 16oz", 85, "espresso_bar"),
    ("iced-latte-french-vanilla-16oz", "Iced Latte French Vanilla 16oz", "Latte Helado French Vanilla 16oz", 85, "espresso_bar"),
    ("iced-latte-caramel-16oz", "Iced Latte Caramel 16oz", "Latte Helado Caramel 16oz", 85, "espresso_bar"),
    ("iced-latte-mocha-16oz", "Iced Latte Mocha 16oz", "Latte Helado Mocha 16oz", 85, "espresso_bar"),
    ("iced-latte-fresa-16oz", "Iced Latte Fresa 16oz", "Latte Helado Fresa 16oz", 85, "espresso_bar"),
    ("iced-latte-coco-16oz", "Iced Latte Coco 16oz", "Latte Helado Coco 16oz", 85, "espresso_bar"),
    ("iced-latte-banana-16oz", "Iced Latte Banana 16oz", "Latte Helado Banana 16oz", 85, "espresso_bar"),
    ("frappe-de-cafe", "Frappé de Café", "Frappé de Café", 90, "supremes_icees"),
    ("oreo-supreme", "Oreo Supreme", "Oreo Supreme", 110, "supremes_icees"),
    ("strawberry-supreme", "Strawberry Supreme", "Strawberry Supreme", 110, "supremes_icees"),
    ("chai-latte-8oz", "Chai Latte 8oz", "Chai Latte 8oz", 75, "tea_matcha"),
    ("chai-latte-12oz", "Chai Latte 12oz", "Chai Latte 12oz", 90, "tea_matcha"),
    ("chai-iced-latte-16oz", "Chai Iced Latte 16oz", "Chai Helado 16oz", 85, "tea_matcha"),
    ("chai-frappe", "Chai Frappé", "Chai Frappé", 90, "tea_matcha"),
    ("granita-fresa", "Granita de Fresa", "Granita de Fresa", 85, "supremes_icees"),
    ("granita-limon", "Granita de Limón", "Granita de Limón", 85, "supremes_icees"),
    ("granita-fresa-limon", "Granita Fresa-Limón", "Granita Fresa-Limón", 85, "supremes_icees"),
    ("granita-mango", "Granita de Mango", "Granita de Mango", 85, "supremes_icees"),
    ("granita-mangoneada", "Granita Mangoneada", "Granita Mangoneada", 85, "supremes_icees"),
    ("licuado", "Licuado", "Licuado", 60, "supremes_icees"),
    ("fresco-fresa", "Fresco de Fresa", "Fresco de Fresa", 50, "supremes_icees"),
    ("limonada", "Limonada", "Limonada", 50, "supremes_icees"),
    ("fresco-coco", "Fresco de Coco", "Fresco de Coco", 50, "supremes_icees"),
    ("fresco-mango", "Fresco de Mango", "Fresco de Mango", 50, "supremes_icees"),
    ("fresco-maracuya", "Fresco de Maracuyá", "Fresco de Maracuyá", 50, "supremes_icees"),
    ("fresco-pina", "Fresco de Piña", "Fresco de Piña", 50, "supremes_icees"),
    ("te", "Té", "Té", 45, "tea_matcha"),
    ("botella-caramel", "Botella Caramel", "Botella de Caramelo", 100, "espresso_bar"),
    ("botella-dulce-de-leche", "Botella Dulce de Leche", "Botella Dulce de Leche", 100, "espresso_bar"),
    ("botella-mocha", "Botella Mocha", "Botella Mocha", 100, "espresso_bar"),
    ("botella-french-vanilla", "Botella French Vanilla", "Botella Vainilla Francesa", 100, "espresso_bar"),
    ("botella-dirty-chai", "Botella Dirty Chai", "Botella Dirty Chai", 100, "espresso_bar"),
    ("botella-americano", "Botella Americano", "Botella Americano", 100, "espresso_bar"),
    ("botella-de-temporada", "Botella de Temporada", "Botella de Temporada", 100, "espresso_bar"),
    ("boli-maracuya", "Boli de Maracuyá", "Boli de Maracuyá", 35, "supremes_icees"),
    ("boli-coco-fruta", "Boli Coco Fruta", "Boli Coco Fruta", 35, "supremes_icees"),
    ("boli-fresa-fruta", "Boli Fresa Fruta", "Boli Fresa Fruta", 35, "supremes_icees"),
    ("boli-coco-con-leche", "Boli Coco con Leche", "Boli Coco con Leche", 45, "supremes_icees"),
    ("boli-dulce-de-leche", "Boli Dulce de Leche", "Boli Dulce de Leche", 45, "supremes_icees"),
    ("boli-fresa-con-crema", "Boli Fresa con Crema", "Boli Fresa con Crema", 45, "supremes_icees"),
    ("donut-canela", "Donut Cinnamon-Sugar", "Donut de Canela y Azúcar", 30, "bakery"),
    ("donut-rellena-dulce-de-leche", "Donut Rellena de Dulce de Leche", "Donut Rellena de Dulce de Leche", 45, "bakery"),
    ("crepa-dulce", "Crepa Dulce", "Crepa Dulce", 70, "grill_toast_crepes"),
    ("crepa-salada", "Crepa Salada", "Crepa Salada", 90, "grill_toast_crepes"),
    ("flan-clasico", "Flan Clásico", "Flan Clásico", 50, "reposteria"),
    ("cheesecake", "Cheesecake", "Cheesecake", 60, "reposteria"),
]

GROUPS = [
    {"id": "leche", "name": "Leche", "required": True, "max_selections": 1},
    {"id": "dulzor", "name": "Dulzor", "required": True, "max_selections": 1},
    {"id": "extras", "name": "Extras", "required": False, "max_selections": 3},
]
OPTIONS = [
    {"id": "leche-entera", "group_id": "leche", "name": "Entera", "price_adjustment": 0, "is_default": True},
    {"id": "leche-avena", "group_id": "leche", "name": "Avena", "price_adjustment": 15, "is_default": False},
    {"id": "leche-deslactosada", "group_id": "leche", "name": "Deslactosada", "price_adjustment": 15, "is_default": False},
    {"id": "leche-descremada", "group_id": "leche", "name": "Descremada", "price_adjustment": 15, "is_default": False},
    {"id": "dulzor-normal", "group_id": "dulzor", "name": "Normal", "price_adjustment": 0, "is_default": True},
    {"id": "dulzor-poco", "group_id": "dulzor", "name": "Poco dulce", "price_adjustment": 0, "is_default": False},
    {"id": "dulzor-splenda", "group_id": "dulzor", "name": "Con Splenda", "price_adjustment": 0, "is_default": False, "allow_qty": True, "default_qty": 2},
    {"id": "dulzor-sin", "group_id": "dulzor", "name": "Sin azúcar", "price_adjustment": 0, "is_default": False},
    {"id": "extras-huevo", "group_id": "extras", "name": "Huevo extra", "price_adjustment": 10, "is_default": False},
    {"id": "extras-aguacate", "group_id": "extras", "name": "Aguacate", "price_adjustment": 20, "is_default": False},
    {"id": "extras-queso-crema", "group_id": "extras", "name": "Queso crema", "price_adjustment": 25, "is_default": False},
]
LECHE_DULZOR_PREFIXES = ("latte-", "iced-latte-", "chai-")
EXTRAS_ITEMS = {"baleada-sencilla", "sandwich-frio-pollo",
                "crepa-salada", "lonchera-del-capitan",
                "combo-baleada", "combo-burrito", "combo-capitana",
                "combo-avocado-toast", "combo-pb-banana-toast"}


def fixture_payload():
    items = [{"id": i, "name": n, "name_es": es, "price": p,
              "category": c, "available": True}
             for (i, n, es, p, c) in ITEMS]
    links = []
    for (i, _n, _es, _p, _c) in ITEMS:
        if i.startswith(LECHE_DULZOR_PREFIXES) or i in (
                "frappe-de-cafe", "oreo-supreme", "strawberry-supreme"):
            links.append({"item_id": i, "group_id": "leche"})
            links.append({"item_id": i, "group_id": "dulzor"})
        if i == "licuado":
            links.append({"item_id": i, "group_id": "dulzor"})
        if i in EXTRAS_ITEMS:
            links.append({"item_id": i, "group_id": "extras"})
    return {"items": items, "modGroups": GROUPS, "modOptions": OPTIONS,
            "itemModGroups": links}


class FakeOS:
    """Intro/missions-shaped OS fake (missions empty by default)."""

    def __init__(self):
        self.customers = {}
        self.grants = {}   # never written — see seed()
        self.calls = []

    def seed(self, phone, name="Carlos Mendoza", gift=None):
        # `gift` accepted for legacy compat and IGNORED: the
        # welcome gift was retired (bot-menu-fix, 2026-10-26) — a
        # seeded customer is just a customer, and signup below
        # mirrors the patched OS (account created, NO grant).
        self.customers[phone] = {"name": name, "birthday_dm": ""}

    def __call__(self, action, payload):
        self.calls.append((action, dict(payload)))
        phone = payload.get("phone", "")
        if action == "whatsapp_lookup":
            if phone in self.customers:
                return 200, {"found": True,
                             "customer": {"name": self.customers[phone]["name"],
                                          "phone": phone},
                             "gift": self.grants.get(phone)}
            return 200, {"found": False}
        if action == "whatsapp_signup":
            self.customers.setdefault(
                phone, {"name": payload.get("name", ""), "birthday_dm": ""})
            return 200, {"ok": True, "grantCreated": False,
                         "customer": {"name": self.customers[phone]["name"],
                                      "phone": phone},
                         "gift": None}
        if action == "whatsapp_preventa":
            return 200, {"ok": True, "preorder": dict(payload)}
        if action == "whatsapp_mission_check":
            return 200, {"assignments": []}
        if action == "whatsapp_mission_submit":
            return 200, {"ok": False, "reason": "no_active_mission"}
        if action == "whatsapp_attribute":
            return 200, {"attributed": False, "reason": "unknown_word"}
        return 400, {"error": "unknown action"}


# ---------------------------------------------------------------- framework

_ORIGINAL_PUSH = kds_push.push_order  # captured before any Rig patches it

_passed = [0]
_failed = []


def check(cid, cond, why=""):
    if cond:
        _passed[0] += 1
    else:
        _failed.append(cid)
        print(f"FAIL {cid}: {why}")


class Rig:
    """One scripted customer with capture points wired."""

    _seq = [0]

    def __init__(self, with_catalog=True):
        Rig._seq[0] += 1
        self.phone = f"5049922{Rig._seq[0]:04d}"
        self.fake = FakeOS()
        self.fake.seed(self.phone)
        os_client.set_transport(self.fake)
        intro_engine._intro_conversations.clear()
        self.saved = []
        self.pushed = []
        intro_engine.save_order = lambda slug, rec: self.saved.append(rec)
        shop_engine.save_order = lambda slug, rec: self.saved.append(rec)
        self._real_push = _ORIGINAL_PUSH
        shop_engine.kds_push.push_order = self._capture_push
        if with_catalog:
            menu_client.set_catalog(
                menu_client.build_catalog(fixture_payload()))
        else:
            menu_client.clear()
        self.convo = intro_engine.get_intro_conversation(self.phone)
        self.replies = []       # plain-text renderings (fallback text
                               # for a WaReply) — what assertions read
        self.raw_replies = []  # the replies exactly as returned
        self.last_raw = None

    def _capture_push(self, order):
        self.pushed.append(order)
        return {"ok": True, "status": 200, "error": None}

    def say(self, text):
        reply = intro_engine.reply_for_intro(self.convo, text)
        self.raw_replies.append(reply)
        self.last_raw = reply
        text_reply = reply if isinstance(reply, str) \
            else reply.fallback_text()
        self.replies.append(text_reply)
        return text_reply

    def to_lounge(self):
        return self.say("hola")

    def restore(self):
        shop_engine.kds_push.push_order = self._real_push


def mod_of(order, line_idx, group):
    for m in order["items"][line_idx].get("mods", []):
        if m["group"] == group:
            return m
    return None


# ---------------------------------------------------------------- scenarios

def _item_lines(text):
    return [ln for ln in text.split("\n") if ln.startswith("• ")]


EXPECTED_SECTIONS = ["bebidas-calientes", "bebidas-frias",
                     "frappes-granitas", "chai-te", "botellas-bolis",
                     "comida", "panaderia-postres", "combos"]


def s_menu():
    """Fix 1 (bot-menu-fix): a menu ask is an interactive section
    LIST — never a text dump. Browsing is taps/numbers over curated
    sections; ordering by name works throughout."""
    from wa_reply import WaReply
    rig = Rig()
    rig.to_lounge()
    r = rig.say("¿me pasás el menú?")
    raw = rig.last_raw
    check("MENU1", isinstance(raw, WaReply) and raw.kind == "list",
          f"menu ask returned {type(raw).__name__}")
    if isinstance(raw, WaReply):
        check("MENU2", raw.body.count("\n") <= 2
              and "richaromacoffee.com/order" in raw.body,
              f"body not short / no storefront link: {raw.body[:160]}")
        check("MENU3", raw.button_text == "Ver el menú",
              str(raw.button_text))
        rows = raw.sections[0]["rows"] if raw.sections else []
        check("MENU4", [row["id"] for row in rows]
              == [f"sec:{s}" for s in EXPECTED_SECTIONS],
              str([row["id"] for row in rows]))
        titles = [row["title"] for row in rows]
        check("MENU5", "Bebidas calientes" in titles
              and "Combos" in titles, str(titles))
    # The text fallback: numbered sections + web link, ZERO items.
    check("MENU6", "1. Bebidas calientes" in r and "8. Combos" in r
          and "richaromacoffee.com/order" in r, r[:200])
    check("MENU7", not _item_lines(r), "fallback listed items")
    check("MENU8", "$" not in r and "USD" not in r, "USD leak in menu")
    check("MENU9", rig.convo.shop_cart is None, "browsing opened a cart")
    check("MENU10", rig.convo.menu_sections == EXPECTED_SECTIONS,
          str(rig.convo.menu_sections))

    # Section tap: ONLY that section, compact lines, web line.
    r = rig.say("sec:bebidas-calientes")
    lines = _item_lines(r)
    check("SEC1", "Latte Caramel 12oz" in r and "L.70" in r, r[:200])
    check("SEC2", "Baleada Sencilla" not in r
          and "Botella de Caramelo" not in r, "other sections leaked")
    check("SEC3", len(lines) == 26 and len(lines) <= 30,
          f"calientes lines={len(lines)}")
    check("SEC4", "richaromacoffee.com/order" in r, "no web line")
    r = rig.say("sec:combos")
    check("SEC5", "Capitana Combo ③" in r and "Latte" not in r,
          r[:200])
    check("SEC6", len(_item_lines(r)) == 5, "combos line count")

    # Numbered fallback picks open the same sections.
    rig.say("menú")
    r = rig.say("8")
    check("NUM1", "Capitana Combo ③" in r, r[:160])
    r = rig.say("1")
    check("NUM2", "Latte Caramel 12oz" in r, r[:160])

    # Full scripted browse: NO single message anywhere carries the
    # whole catalog (per-message item-line cap), and the union of
    # the eight sections is the whole 86-item catalog.
    seen = set()
    for sid in EXPECTED_SECTIONS:
        r = rig.say(f"sec:{sid}")
        seen |= {ln[2:].rsplit(" — ", 1)[0] for ln in _item_lines(r)}
    worst = max((len(_item_lines(x)) for x in rig.replies), default=0)
    check("CAP1", worst <= 30, f"a message carried {worst} item lines")
    # The catalog's display names (name_es wins — Spanish-first).
    all_names = {i["name"]
                 for i in menu_client.get_catalog().items.values()}
    check("CAP2", seen == all_names,
          f"browse union {len(seen)} != catalog {len(all_names)}")

    # Curation coverage, straight from the engine: the eight
    # sections partition the catalog — full and disjoint.
    catalog = menu_client.get_catalog()
    by_section = {sid: shop_engine.section_items(catalog, sid)
                  for sid in EXPECTED_SECTIONS}
    flat = [i["id"] for items in by_section.values() for i in items]
    check("COV1", all(by_section[s] for s in EXPECTED_SECTIONS)
          and len(flat) == len(set(flat)) == len(ITEMS),
          f"sections={[len(v) for v in by_section.values()]}")

    # Ordering by name still works right after browsing.
    r = rig.say("quiero un latte de caramelo 12oz")
    check("ORD0", "Total: L.70" in r, r[:200])
    rig.restore()

    # A menu ask as the FIRST message (registered): the greeting
    # rides the interactive reply's body, sections intact.
    rig = Rig()
    r = rig.say("¿me pasás el menú?")
    raw = rig.last_raw
    check("MENU11", isinstance(raw, WaReply)
          and raw.body.startswith("¡Hola de nuevo, Carlos!")
          and "richaromacoffee.com/order" in raw.body,
          f"first-message menu: {type(raw).__name__}")
    check("MENU12", "Carlos" in r and "1. Bebidas calientes" in r,
          r[:200])
    rig.restore()


def s_single_cash():
    rig = Rig()
    rig.to_lounge()
    r = rig.say("quiero un latte de caramelo 12oz")
    check("ORD1a", "Total: L.70" in r, r[:200])
    r = rig.say("listo")
    check("ORD1b", "¿Cómo pagás?" in r, r[:200])
    r = rig.say("1")
    check("ORD1c", "Pedido confirmado" in r and "Pagás al recoger" in r,
          r[:220])
    check("ORD1d", len(rig.pushed) == 1, f"pushed={len(rig.pushed)}")
    if rig.pushed:
        o = rig.pushed[0]
        check("ORD1e", o["total"] == 170 - 100 and o["total"] == 70,
              f"total={o['total']}")
        check("ORD1f", o["payment_method"] == "cash", o["payment_method"])
        check("ORD1g", o["items"][0]["id"] == "latte-caramel-12oz",
              o["items"][0]["id"])
        d = mod_of(o, 0, "Dulzor")
        l = mod_of(o, 0, "Leche")
        check("ORD1h", d and d["name"] == "Normal"
              and set(d) >= {"id", "group_id", "group", "name",
                             "price_adjustment"},
              f"dulzor={d}")
        check("ORD1i", l and l["name"] == "Entera", f"leche={l}")
    check("ORD1j", rig.convo.shop_cart is None, "cart not cleared")
    rig.restore()


def s_size_clarify():
    rig = Rig()
    rig.to_lounge()
    r = rig.say("quiero un latte de caramelo")
    check("SIZE1", "¿Cuál tamaño" in r and "8oz" in r and "12oz" in r,
          r[:200])
    r = rig.say("12oz")
    check("SIZE2", "Total: L.70" in r, r[:200])
    rig.restore()


def s_iced_distinct():
    rig = Rig()
    rig.to_lounge()
    r = rig.say("quiero un latte helado de caramelo")
    check("ICE1", "Total: L.85" in r, r[:200])
    ids = [l["id"] for l in rig.convo.shop_cart["items"]]
    check("ICE2", ids == ["iced-latte-caramel-16oz"], str(ids))
    rig.restore()


def s_dulzor_variants():
    rig = Rig()
    rig.to_lounge()
    rig.say("un latte mocha 12oz poco dulce")
    line = rig.convo.shop_cart["items"][0]
    d = next(m for m in line["mods"] if m["group"] == "Dulzor")
    check("DUL1", d["name"] == "Poco dulce", str(d))
    rig.say("cancelar")

    rig.say("un latte mocha 12oz con splenda")
    line = rig.convo.shop_cart["items"][0]
    d = next(m for m in line["mods"] if m["group"] == "Dulzor")
    check("DUL2", d["name"] == "Con Splenda" and d.get("qty") == 2,
          str(d))
    rig.say("cancelar")

    rig.say("un latte mocha 12oz con 3 sobres de splenda")
    line = rig.convo.shop_cart["items"][0]
    d = next(m for m in line["mods"] if m["group"] == "Dulzor")
    check("DUL3", d.get("qty") == 3, str(d))
    rig.say("cancelar")

    rig.say("un latte mocha 12oz sin azúcar")
    line = rig.convo.shop_cart["items"][0]
    d = next(m for m in line["mods"] if m["group"] == "Dulzor")
    check("DUL4", d["name"] == "Sin azúcar", str(d))
    check("DUL5", line["unit_price"] == 70, str(line["unit_price"]))
    rig.restore()


def s_leche_delta():
    rig = Rig()
    rig.to_lounge()
    r = rig.say("un latte french vanilla 12oz de avena")
    check("LEC1", "Total: L.85" in r, r[:200])
    line = rig.convo.shop_cart["items"][0]
    l = next(m for m in line["mods"] if m["group"] == "Leche")
    check("LEC2", l["name"] == "Avena" and l["price_adjustment"] == 15,
          str(l))
    rig.restore()


def s_extras():
    rig = Rig()
    rig.to_lounge()
    r = rig.say("una baleada sencilla con huevo extra y aguacate")
    check("EXT1", "Total: L.60" in r, r[:200])
    names = [m["name"] for m in rig.convo.shop_cart["items"][0]["mods"]]
    check("EXT2", "Huevo extra" in names and "Aguacate" in names,
          str(names))
    rig.restore()


def s_combo_fixed():
    rig = Rig()
    rig.to_lounge()
    r = rig.say("quiero el combo capitana")
    check("COM1", "Total: L.140" in r, r[:200])
    ids = [l["id"] for l in rig.convo.shop_cart["items"]]
    check("COM2", ids == ["combo-capitana"], str(ids))
    rig.restore()


def s_multi_transfer():
    rig = Rig()
    rig.to_lounge()
    r = rig.say("quiero 2 latte de caramelo 12oz y una baleada sencilla")
    check("MUL1", "Total: L.170" in r, r[:240])  # 2*70 + 30, by hand
    rig.say("listo")
    r = rig.say("2")
    check("MUL2", "Pedido confirmado" in r and "transferencia" in r,
          r[:220])
    if rig.pushed:
        o = rig.pushed[0]
        check("MUL3", o["payment_method"] == "transfer"
              and o["total"] == 170, f"{o['payment_method']}/{o['total']}")
    rig.restore()


def s_unknown():
    rig = Rig()
    rig.to_lounge()
    r = rig.say("quiero una pizza hawaiana")
    check("UNK1", rig.convo.shop_cart is None, "cart created for pizza")
    check("UNK2", "apartar botellas en preventa" in r, r[:200])
    rig.restore()


def s_price_lock():
    rig = Rig()
    rig.to_lounge()
    r = rig.say("quiero un latte de caramelo 12oz, te pago L.5")
    check("PRC1", "Total: L.70" in r, r[:240])
    line = rig.convo.shop_cart["items"][0]
    check("PRC2", line["unit_price"] == 70, str(line["unit_price"]))
    rig.restore()


def s_bottle_as_menu_item():
    rig = Rig()
    rig.to_lounge()
    r = rig.say("quiero una botella de caramelo")
    check("BOT1", "Total: L.100" in r, r[:200])
    ids = [l["id"] for l in rig.convo.shop_cart["items"]]
    check("BOT2", ids == ["botella-caramel"], str(ids))
    prev = [a for a, _ in rig.fake.calls if a == "whatsapp_preventa"]
    check("BOT3", not prev, "bottle leaked into preventa")
    rig.restore()


def s_remove_cancel():
    rig = Rig()
    rig.to_lounge()
    rig.say("quiero un latte de caramelo 12oz y una baleada sencilla")
    r = rig.say("quita la baleada")
    check("REM1", "Total: L.70" in r, r[:240])
    r = rig.say("cancelar")
    check("REM2", rig.convo.shop_cart is None, "cart survived cancel")
    check("REM3", not rig.pushed, "cancelled order was pushed")
    rig.restore()


def s_preventa_still_wins():
    rig = Rig()
    rig.to_lounge()
    r = rig.say("quiero 2 paquetes")
    prev = [p for a, p in rig.fake.calls if a == "whatsapp_preventa"]
    check("PRE1", bool(prev) and prev[-1].get("packs") == 2,
          str(rig.fake.calls))
    check("PRE2", rig.convo.shop_cart is None, "packs opened a cart")
    check("PRE3", "L.700" in r, r[:200])
    rig.restore()


def s_no_catalog_fallback():
    rig = Rig(with_catalog=False)
    rig.to_lounge()
    r = rig.say("menú")
    check("NOC1", "7 de noviembre" in r, r[:200])
    r = rig.say("quiero un latte de caramelo 12oz")
    check("NOC2", rig.convo.shop_cart is None, "cart without catalog")
    rig.restore()


def s_ticket_lifecycle():
    """The placed order hits a mock /api/orders-v2 (real kds_push,
    stubbed HTTP) storefront-shaped and UNPAID."""
    rig = Rig()
    rig.to_lounge()
    rig.say("quiero un latte de caramelo 12oz con splenda")
    rig.say("listo")
    captured = {}

    class _Resp(io.BytesIO):
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _Resp(b"{}")

    real_urlopen = kds_push.urllib.request.urlopen
    real_url = kds_push.KDS_API_URL
    kds_push.urllib.request.urlopen = fake_urlopen
    kds_push.KDS_API_URL = "https://os.test/api/orders-v2"
    shop_engine.kds_push.push_order = rig._real_push
    try:
        r = rig.say("2")
    finally:
        kds_push.urllib.request.urlopen = real_urlopen
        kds_push.KDS_API_URL = real_url
    check("LIF1", "Pedido confirmado" in r, r[:200])
    body = captured.get("body") or {}
    check("LIF2", captured.get("url", "").endswith("/api/orders-v2"),
          captured.get("url", ""))
    check("LIF3", body.get("paymentMethod") == "transfer",
          str(body.get("paymentMethod")))
    check("LIF4", "paid" not in json.dumps(body), "order claims paid")
    items = body.get("items") or []
    check("LIF5", items and items[0]["id"] == "latte-caramel-12oz",
          str(items)[:160])
    mods = (items[0].get("mods") if items else []) or []
    d = next((m for m in mods if m.get("group") == "Dulzor"), None)
    check("LIF6", d and d["name"] == "Con Splenda" and d.get("qty") == 2,
          str(d))
    check("LIF7", body.get("total") == 70 and body.get("source") == "whatsapp",
          f"{body.get('total')}/{body.get('source')}")
    check("LIF8", body.get("fulfillment") == "pickup",
          str(body.get("fulfillment")))
    rig.restore()


def s_notify():
    sends = []
    notify.reset()
    send = lambda p, t: sends.append((p, t))
    code, body = notify.process(
        {"order_number": 23879, "status": "ready",
         "phone": "50499998888"},
        "Bearer testsecret", send)
    check("NTF1", code == 200 and len(sends) == 1, f"{code}/{len(sends)}")
    check("NTF2", sends and "está listo" in sends[0][1]
          and "#23879" in sends[0][1], sends[0][1] if sends else "")
    code, body = notify.process(
        {"order_number": 23879, "status": "ready",
         "phone": "50499998888"},
        "Bearer testsecret", send)
    check("NTF3", code == 200 and body.get("deduped") is True
          and len(sends) == 1, f"{code}/{body}/{len(sends)}")
    code, _ = notify.process(
        {"order_number": 23880, "status": "cancelled",
         "phone": "50499998888", "reason": "sin focaccia hoy"},
        "Bearer testsecret", send)
    check("NTF4", code == 200 and len(sends) == 2
          and "cancelado" in sends[1][1]
          and "escribinos" in sends[1][1], sends[1][1] if len(sends) > 1 else "")
    code, _ = notify.process(
        {"order_number": 23881, "status": "ready",
         "phone": "50499998888"},
        "Bearer wrongsecret", send)
    check("NTF5", code == 403 and len(sends) == 2, f"{code}")
    code, _ = notify.process(
        {"order_number": 23881, "status": "preparing",
         "phone": "50499998888"},
        "Bearer testsecret", send)
    check("NTF6", code == 400 and len(sends) == 2, f"{code}")
    saved = os.environ.pop("WHATSAPP_SIGNUP_SECRET")
    code, _ = notify.process(
        {"order_number": 23881, "status": "ready",
         "phone": "50499998888"},
        "Bearer testsecret", send)
    check("NTF7", code == 403 and len(sends) == 2,
          "fail-open when secret unset")
    os.environ["WHATSAPP_SIGNUP_SECRET"] = saved


FORBIDDEN = ["$", "USD", "Kaiser", "whole milk", "oat milk",
             "Bundle of", "Pumpkin", "Biscoff", "Classic Black",
             "break room"]


def s_sweep_no_cali():
    rig = Rig()
    rig.to_lounge()
    rig.say("menú")
    rig.say("quiero un latte de caramelo 12oz")
    rig.say("quiero una baleada sencilla")
    rig.say("listo")
    rig.say("1")
    rig.say("gracias")
    blob = "\n".join(rig.replies)
    bad = [f for f in FORBIDDEN if f.lower() in blob.lower()]
    check("SWP1", not bad, f"forbidden in replies: {bad}")
    check("SWP2", "L." in blob, "no lempira totals in conversation")
    rig.restore()


def main():
    scenarios = [
        ("menu", s_menu), ("single", s_single_cash),
        ("size", s_size_clarify), ("iced", s_iced_distinct),
        ("dulzor", s_dulzor_variants), ("leche", s_leche_delta),
        ("extras", s_extras), ("combo", s_combo_fixed),
        ("multi", s_multi_transfer), ("unknown", s_unknown),
        ("pricelock", s_price_lock), ("bottle", s_bottle_as_menu_item),
        ("remove", s_remove_cancel), ("preventa", s_preventa_still_wins),
        ("nocatalog", s_no_catalog_fallback),
        ("lifecycle", s_ticket_lifecycle), ("notify", s_notify),
        ("sweep", s_sweep_no_cali),
    ]
    for name, fn in scenarios:
        try:
            fn()
        except Exception as e:
            _failed.append(name)
            print(f"FAIL {name}: exception {type(e).__name__}: {e}")
    total = _passed[0] + len(_failed)
    print("== shop battery ==")
    print(f"  TOTAL      {_passed[0]}/{total}")
    print(f"  failed ids: {', '.join(_failed) if _failed else 'none'}")
    return 0 if not _failed else 1


if __name__ == "__main__":
    sys.exit(main())
