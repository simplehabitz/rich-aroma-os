"""
Order persistence for the AI front desk.

Every confirmed order is appended as one JSON line per business.
The KDS integration (Rich Aroma OS) reads from here or receives
the dict returned by save_order() for push delivery.
"""
import json
import os
from datetime import datetime, timezone

ORDERS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "orders")


def save_order(business_slug: str, order: dict) -> dict:
    """Append order to <business_slug>.jsonl. Returns the stored record."""
    os.makedirs(ORDERS_DIR, exist_ok=True)
    record = {"received_at": datetime.now(timezone.utc).isoformat(), **order}
    path = os.path.join(ORDERS_DIR, f"{business_slug}.jsonl")
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")
    return record


def read_orders(business_slug: str, status: str = "new"):
    """Read back orders, optionally filtered by status. Poll-friendly for KDS."""
    path = os.path.join(ORDERS_DIR, f"{business_slug}.jsonl")
    if not os.path.exists(path):
        return []
    out = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if status is None or rec.get("status") == status:
                out.append(rec)
    return out
