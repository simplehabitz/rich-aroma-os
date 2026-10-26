"""
KDS push for Rich Aroma OS.

Takes the structured order dict from order_engine.build_order() and POSTs it
to the Rich Aroma OS orders API, which the KDS (kitchen.html) picks up on its
regular poll of /api/orders?restaurantId=....

Env vars (nothing secret is committed):

    KDS_API_URL        e.g. https://rich-aroma-os.vercel.app/api/orders-v2
    KDS_API_KEY        bearer token (optional; the OS orders API is public)
    KDS_RESTAURANT_ID  restaurant id the KDS watches (default "rich-aroma";
                       confirm with the owner which id the bottled KDS uses)
    KDS_TIMEOUT        seconds per attempt (default 15)
    KDS_DRY_RUN        "1" to skip the HTTP call and just build/log the ticket

push_order(order) -> dict: {"ok": bool, "status": int|None, "error": str|None}
Orders are always persisted by save_order() before this runs, so a failed push
never loses an order — it's queued for retry via orders/<slug>.jsonl.
"""

import json
import os
import time
import urllib.request
import urllib.error

KDS_API_URL = os.environ.get("KDS_API_URL", "").strip()
KDS_API_KEY = os.environ.get("KDS_API_KEY", "").strip()
KDS_RESTAURANT_ID = os.environ.get("KDS_RESTAURANT_ID", "rich-aroma").strip()
KDS_TIMEOUT = float(os.environ.get("KDS_TIMEOUT", "15"))
KDS_DRY_RUN = os.environ.get("KDS_DRY_RUN") == "1"


def build_ticket(order: dict) -> dict:
    """Map the front-desk order dict to the OS /api/orders-v2 payload.

    Shop orders (shop_engine) arrive storefront-shaped already:
    each item carries the real menu item id and its POS modifier
    snapshot (mods). Those pass through untouched so the OS prices
    and routes them exactly like a /order sale — the item id is
    what the OS looks the menu row (and its category/station) up
    by. Legacy Cali-era dicts (type drink/bundle) keep the old
    synthetic mapping for any queued records.
    """
    items = []
    for it in order.get("items", []):
        qty = it.get("qty", it.get("quantity", 1))
        price = float(it.get("unit_price") or it.get("price") or 0)
        if it.get("id"):
            ticket_item = {"id": it["id"], "name": it.get("name", ""),
                           "price": price, "qty": qty}
            if it.get("mods") is not None:
                ticket_item["mods"] = it["mods"]
            items.append(ticket_item)
            continue
        if it.get("type") == "bundle":
            milk = it.get("milk", "whole")
            item_id = f"wa-bundle-3-{milk}"
            name = f"Bundle of 3 ({milk} milk): " + ", ".join(
                f.title() for f in it.get("flavors", []))
        else:
            milk = it.get("milk", "whole")
            item_id = f"wa-{it.get('name', 'item').replace(' ', '-')}-{milk}"
            name = it.get("name", "item").title()
            if it.get("name") != "classic black americano":
                name += f" ({milk} milk)"
        items.append({"id": item_id, "name": name, "price": price, "qty": qty})

    break_room = order.get("break_room") or ""
    if order.get("delivery_location"):
        notes = (f"WhatsApp order {order.get('order_id')} — "
                 f"{order.get('delivery_location')}")
        if break_room:
            notes += f", break room: {break_room}"
    else:
        notes = (f"WhatsApp order {order.get('order_id')} — "
                 "para recoger en tienda")

    total = float(order.get("total") or 0)
    ticket = {
        "items": items,
        "customerPhone": order.get("customer_phone"),
        "guestPhone": order.get("customer_phone"),
        "customerName": order.get("customer_name") or "WhatsApp customer",
        "notes": notes,
        "fulfillment": order.get("fulfillment", "pickup"),
        "restaurantId": KDS_RESTAURANT_ID,
        # Honest tender, in the OS's own vocabulary: 'cash' is born
        # 'pending' (pay at pickup); 'transfer' is born
        # 'awaiting_transfer_approval' (staff verification queue).
        # A bot order is NEVER born paid.
        "paymentMethod": order.get("payment_method") or "cash",
        "subtotal": total,
        "total": total,
        "source": order.get("channel", "whatsapp"),
    }
    # Prep time (2026-10-26): a chosen slot rides to the OS under
    # the same names end to end — the ticket's
    # requestedFor/requestedForLabel become the order row's
    # requested_for / requested_for_label. ASAP orders carry
    # neither key: the ticket is exactly what it was before.
    if order.get("requested_for"):
        ticket["requestedFor"] = order["requested_for"]
        ticket["requestedForLabel"] = \
            order.get("requested_for_label")
    return ticket


def push_order(order: dict, url: str = None, api_key: str = None) -> dict:
    """
    POST one confirmed order to the KDS. Returns outcome dict.
    Raises nothing; every failure is captured in the result.
    """
    target = (url or KDS_API_URL).strip()
    if not target:
        return {"ok": False, "status": None, "error": "KDS_API_URL not configured"}

    ticket = build_ticket(order)
    body = json.dumps(ticket).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    key = api_key if api_key is not None else KDS_API_KEY
    if key:
        headers["Authorization"] = f"Bearer {key}"

    if KDS_DRY_RUN:
        print(f"[kds_push] DRY RUN — would POST {target}:", flush=True)
        print(json.dumps(ticket, indent=2), flush=True)
        return {"ok": True, "status": None, "error": None}

    last_error = None
    for attempt in (1, 2, 3):
        try:
            req = urllib.request.Request(
                target, data=body, headers=headers, method="POST"
            )
            with urllib.request.urlopen(req, timeout=KDS_TIMEOUT) as resp:
                return {"ok": True, "status": resp.status, "error": None}
        except urllib.error.HTTPError as e:
            last_error = f"HTTP {e.code}"
            break  # server rejected the payload — retrying won't help
        except Exception as e:
            last_error = f"{type(e).__name__}: {e}"
            time.sleep(2 * attempt)  # transient — back off and retry
    return {"ok": False, "status": None, "error": last_error}
