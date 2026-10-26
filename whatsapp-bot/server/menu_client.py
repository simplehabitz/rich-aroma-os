"""
Menu client for the Rich Aroma OS — the bot's ONLY source of menu truth.

The bot sells exactly what the OS menu holds: the same catalog the
storefront (/order), the POS and the KDS read, fetched from the OS
store API:

    GET {OS_MENU_URL}?action=menu&restaurantId=rich-aroma

(the endpoint the /order page itself uses; public, no secret needed).
The response carries items (id, name, name_es, price, category,
available), modifier groups, modifier options and the item->group
map — the bot normalizes it once into a Catalog and prices ONLY from
there. There is no local menu table and no fallback menu: if the
fetch fails the bot serves the last-good cached catalog, and with no
cache at all the shop engine stays silent and the intro flow's
existing "menu is being updated" copy + preventa take over. Prices
are NEVER invented and NEVER taken from the customer's message.

Env vars (nothing secret is committed):
    OS_MENU_URL           menu endpoint (default: the live store API)
    MENU_CACHE_TTL        seconds between refreshes (default 300)
    MENU_FETCH_TIMEOUT    seconds per fetch attempt (default 8)

Tests inject a transport via set_transport(fn) — fn(url) ->
(status, dict) — mirroring os_client.set_transport, or install a
catalog directly with set_catalog(build_catalog(payload)).
"""

import json
import os
import time
import urllib.request
import urllib.error

OS_MENU_URL = os.environ.get(
    "OS_MENU_URL",
    "https://www.richaromacoffee.com/api/store"
    "?action=menu&restaurantId=rich-aroma").strip()
MENU_TTL = float(os.environ.get("MENU_CACHE_TTL", "300"))
FETCH_TIMEOUT = float(os.environ.get("MENU_FETCH_TIMEOUT", "8"))

_test_transport = None  # set_transport() overrides HTTP in tests
_catalog = None         # last-good Catalog (module-level, like the OS copy)
_fetched_at = 0.0


def set_transport(fn):
    """Inject a fake transport (url) -> (status, dict)."""
    global _test_transport
    _test_transport = fn


def set_catalog(catalog):
    """Install a catalog directly (tests / fixture loading)."""
    global _catalog, _fetched_at
    _catalog = catalog
    _fetched_at = time.time()


def clear():
    global _catalog, _fetched_at
    _catalog = None
    _fetched_at = 0.0


def get_catalog():
    """The last-good catalog, or None. Never fetches (see refresh)."""
    return _catalog


class Catalog:
    """Normalized OS menu: sellable items + their modifier groups.

    items:   id -> {"id", "name", "price", "category"}
             (display name is name_es when the OS provides one;
             rows that are unavailable or carry no positive price
             are NOT sellable and never enter the catalog)
    groups:  group_id -> {"id", "name", "required", "max_selections"}
    options: group_id -> [ {"id", "name", "price_adjustment",
                            "is_default", "allow_qty", "default_qty"} ]
    item_groups: item_id -> [group_id, ...] in OS order
    skipped: count of menu rows dropped as unsellable (for the note)
    """

    def __init__(self):
        self.items = {}
        self.groups = {}
        self.options = {}
        self.item_groups = {}
        self.skipped = 0

    def groups_for(self, item_id):
        out = []
        for gid in self.item_groups.get(item_id, []):
            g = self.groups.get(gid)
            if g:
                out.append((g, self.options.get(gid, [])))
        return out


def _num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def build_catalog(payload: dict) -> Catalog:
    """Normalize one OS /api/store?action=menu response."""
    cat = Catalog()
    if not isinstance(payload, dict):
        cat.skipped = -1
        return cat
    for g in payload.get("modGroups") or []:
        gid = g.get("id")
        if not gid:
            continue
        cat.groups[gid] = {
            "id": gid,
            "name": g.get("name") or gid,
            "required": bool(g.get("required")),
            "max_selections": int(g.get("max_selections") or 1),
        }
        cat.options.setdefault(gid, [])
    for o in payload.get("modOptions") or []:
        gid = o.get("group_id")
        if gid not in cat.groups or not o.get("id"):
            continue
        cat.options[gid].append({
            "id": o.get("id"),
            "name": o.get("name") or "",
            "price_adjustment": _num(o.get("price_adjustment")),
            "is_default": bool(o.get("is_default")),
            "allow_qty": bool(o.get("allow_qty")),
            "default_qty": int(o.get("default_qty") or 1),
        })
    for gid in cat.options:
        # Stable order: default first, then by name (matches how the
        # OS orders options and how the POS lists them).
        cat.options[gid].sort(
            key=lambda o: (not o["is_default"], o["name"].lower()))
    linked = {}
    for m in payload.get("itemModGroups") or []:
        iid, gid = m.get("item_id"), m.get("group_id")
        if iid and gid in cat.groups:
            linked.setdefault(iid, []).append(gid)
    for row in payload.get("items") or []:
        iid = row.get("id")
        price = _num(row.get("price"))
        if not iid or row.get("available") is False or price <= 0:
            cat.skipped += 1
            continue
        display = row.get("name_es") or row.get("name") or iid
        cat.items[iid] = {
            "id": iid,
            "name": display,
            # The other spelling (EN name when the display is ES) —
            # the shop matcher indexes both.
            "_name_alt": row.get("name") if row.get("name") != display
            else "",
            "price": price,
            "category": (row.get("category") or "otros").lower(),
        }
        if iid in linked:
            cat.item_groups[iid] = linked[iid]
    return cat


def _fetch_payload():
    """One GET of the OS menu. Returns (status, dict) or raises."""
    if _test_transport is not None:
        return _test_transport(OS_MENU_URL)
    req = urllib.request.Request(OS_MENU_URL, method="GET")
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8") or "{}")


def refresh(force: bool = False) -> bool:
    """Fetch + swap the catalog. On ANY failure the last-good catalog
    is kept untouched. Returns True when a fresh catalog landed."""
    global _catalog, _fetched_at
    if not force and _catalog is not None \
            and (time.time() - _fetched_at) < MENU_TTL:
        return False
    try:
        status, payload = _fetch_payload()
        if not (200 <= status < 300) or not isinstance(payload, dict):
            return False
        fresh = build_catalog(payload)
        if not fresh.items:
            # An empty menu is a data state (import not run yet), not
            # a catalog to sell from — keep the last-good one if any,
            # and stay unsellable otherwise.
            _fetched_at = time.time()
            return False
        _catalog = fresh
        _fetched_at = time.time()
        return True
    except Exception as e:
        print(f"[menu_client] refresh failed: {e}", flush=True)
        return False


def maybe_refresh():
    """TTL-gated refresh for the webhook path. Never raises."""
    try:
        if _catalog is None or (time.time() - _fetched_at) >= MENU_TTL:
            refresh(force=True)
    except Exception:
        pass
