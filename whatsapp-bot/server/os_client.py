"""
Server-to-server client for the Rich Aroma OS (api/store.js).

Used by the Honduras intro flow (intro_engine.py) to:
  - look up a customer by phone            (action=whatsapp_lookup)
  - create their account + record the     (action=whatsapp_signup)
    PENDING L.100 welcome gift
  - record a preventa (preorder) intent   (action=whatsapp_preventa)

Auth follows the kds_push.py pattern: a bearer token over HTTPS. Here the
token is a shared secret the owner sets as WHATSAPP_SIGNUP_SECRET in BOTH
places (Render env for this bot, Vercel env for the OS). The OS fails
closed when its copy is unset, and nothing here ever sends a customer PIN
or payment credential — the OS action is the only writer and it never
credits rico_balance (the gift stays a pending grant row for the loyalty
build to mint).

Env vars (nothing secret is committed):
    OS_STORE_URL            e.g. https://www.richaromacoffee.com/api/store
                            (default: that URL)
    WHATSAPP_SIGNUP_SECRET  shared secret, must match the OS env var
    OS_TIMEOUT              seconds per attempt (default 15)
    OS_DRY_RUN              "1" to skip HTTP and return synthetic OKs

Every function returns a dict and raises nothing:
    {"ok": bool, "status": int|None, "error": str|None, "data": dict|None}
Callers persist locally (orders/*.jsonl) when ok is False, mirroring the
"orders are persisted before the push" rule in kds_push.py.
"""

import json
import os
import time
import urllib.request
import urllib.error

OS_STORE_URL = os.environ.get(
    "OS_STORE_URL", "https://www.richaromacoffee.com/api/store").strip()
OS_TIMEOUT = float(os.environ.get("OS_TIMEOUT", "15"))
OS_DRY_RUN = os.environ.get("OS_DRY_RUN") == "1"

_test_transport = None  # set_transport() overrides HTTP in tests


def set_transport(fn):
    """Inject a fake transport (action, payload) -> (status, dict)."""
    global _test_transport
    _test_transport = fn


def _secret() -> str:
    return os.environ.get("WHATSAPP_SIGNUP_SECRET", "").strip()


def _post(action: str, payload: dict) -> dict:
    if _test_transport is not None:
        try:
            status, data = _test_transport(action, payload)
            return {"ok": 200 <= status < 300, "status": status,
                    "error": None if 200 <= status < 300 else f"HTTP {status}",
                    "data": data}
        except Exception as e:
            return {"ok": False, "status": None,
                    "error": f"{type(e).__name__}: {e}", "data": None}

    if OS_DRY_RUN:
        print(f"[os_client] DRY RUN — would POST {action}: "
              f"{json.dumps(payload, ensure_ascii=False)}", flush=True)
        return {"ok": True, "status": None, "error": None,
                "data": {"dry_run": True}}

    secret = _secret()
    if not secret:
        return {"ok": False, "status": None,
                "error": "WHATSAPP_SIGNUP_SECRET not configured", "data": None}

    url = f"{OS_STORE_URL}?action={action}"
    body = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json",
               "Authorization": f"Bearer {secret}"}
    last_error = None
    for attempt in (1, 2):
        try:
            req = urllib.request.Request(url, data=body, headers=headers,
                                         method="POST")
            with urllib.request.urlopen(req, timeout=OS_TIMEOUT) as resp:
                data = json.loads(resp.read().decode("utf-8") or "{}")
                return {"ok": True, "status": resp.status, "error": None,
                        "data": data}
        except urllib.error.HTTPError as e:
            # Server answered and rejected — retrying won't change it.
            detail = ""
            try:
                detail = e.read().decode("utf-8")[:200]
            except Exception:
                pass
            return {"ok": False, "status": e.code,
                    "error": f"HTTP {e.code} {detail}".strip(), "data": None}
        except Exception as e:
            last_error = f"{type(e).__name__}: {e}"
            if attempt == 1:
                time.sleep(2)  # one retry for transient network trouble
    return {"ok": False, "status": None, "error": last_error, "data": None}


def lookup_customer(phone: str) -> dict:
    """Read-only: does this phone already have an account (and a gift)?"""
    return _post("whatsapp_lookup", {"phone": phone})


def signup_customer(phone: str, name: str, birthday_dm: str = "") -> dict:
    """Get-or-create the account + the pending L.100 welcome gift.

    Idempotent on the OS side (phone is UNIQUE; one welcome grant per
    customer, enforced by a DB unique index). Safe to retry.
    """
    payload = {"phone": phone, "name": name}
    if birthday_dm:
        payload["birthday"] = birthday_dm
    return _post("whatsapp_signup", payload)


def record_preventa(phone: str, packs: int = 0, bottles: int = 0,
                    boxes: int = 0) -> dict:
    """Append one preventa intent row. NOT idempotent — call once, and on
    failure keep the local record instead of retrying blindly."""
    return _post("whatsapp_preventa", {
        "phone": phone, "packs": int(packs or 0),
        "bottles": int(bottles or 0), "boxes": int(boxes or 0),
    })
