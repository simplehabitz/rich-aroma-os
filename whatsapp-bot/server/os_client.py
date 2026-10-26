"""
Server-to-server client for the Rich Aroma OS (api/store.js).

Used by the Honduras intro flow (intro_engine.py) to:
  - look up a customer by phone            (action=whatsapp_lookup)
  - create their account                  (action=whatsapp_signup)
  - record a preventa (preorder) intent   (action=whatsapp_preventa)
  - read a customer's Capitan missions    (action=whatsapp_mission_check)
  - submit a UGC post link for a mission  (action=whatsapp_mission_submit)
  - bind a creator's signup word to an    (action=whatsapp_attribute,
    existing account                         or ref_word on signup)

Auth follows the kds_push.py pattern: a bearer token over HTTPS. Here the
token is a shared secret the owner sets as WHATSAPP_SIGNUP_SECRET in BOTH
places (Render env for this bot, Vercel env for the OS). The OS fails
closed when its copy is unset, and nothing here ever sends a customer PIN
or payment credential. (The L.100 welcome gift this flow used to record
was retired by owner decision, 2026-10-26 — signup mints nothing now,
and the OS gates the mint off too; mission rewards still land as
pending grants via the missions actions, which are untouched.)

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
    """Read-only: does this phone already have an account?"""
    return _post("whatsapp_lookup", {"phone": phone})


def signup_customer(phone: str, name: str, birthday_dm: str = "",
                    ref_word: str = "") -> dict:
    """Get-or-create the account.

    Idempotent on the OS side (phone is UNIQUE). Safe to retry.
    No grant is created: the L.100 welcome gift was retired by
    owner decision (2026-10-26) and the OS gates it off too.

    ref_word (Creadores): a creator's signup word the customer arrived
    with. The OS attempts first-touch attribution after the
    get-or-create and reports the outcome in data["attribution"]
    ({attributed: True, creator_name} on a bind, an already_attributed
    result, or None when the word was unknown/retired — a failed
    attribution never fails the signup). Only sent when non-empty, so
    wordless signups stay byte-identical to before.
    """
    payload = {"phone": phone, "name": name}
    if birthday_dm:
        payload["birthday"] = birthday_dm
    if ref_word:
        payload["ref_word"] = ref_word
    return _post("whatsapp_signup", payload)


def record_preventa(phone: str, packs: int = 0, bottles: int = 0,
                    boxes: int = 0) -> dict:
    """Append one preventa intent row. NOT idempotent — call once, and on
    failure keep the local record instead of retrying blindly."""
    return _post("whatsapp_preventa", {
        "phone": phone, "packs": int(packs or 0),
        "bottles": int(bottles or 0), "boxes": int(boxes or 0),
    })


def mission_check(phone: str) -> dict:
    """Read-only: this customer's mission assignments — unlocked and
    unexpired ones, plus submitted ones carrying their submission
    status (pending/approved) for '¿y mi misión?' answers."""
    return _post("whatsapp_mission_check", {"phone": phone})


def mission_submit(phone: str, post_url: str) -> dict:
    """Submit a UGC post link against the customer's active mission.

    The OS is the validator: it answers in the data payload either
    {"ok": True} or {"ok": False, "reason": ...} with reason one of
    no_active_mission | bad_link | duplicate_link | expired. The bot
    only renders the verdict in the house voice — it never approves
    or mints anything itself."""
    return _post("whatsapp_mission_submit",
                 {"phone": phone, "post_url": post_url})


def attribute_word(phone: str, word: str) -> dict:
    """Bind a creator's signup word to an EXISTING account (Creadores).

    The OS owns the rules (normalization, first-touch permanence) and
    answers in the data payload: {"ok": True, "attributed": True,
    "creator_name": ...} on a bind, or {"ok": False, "reason": ...}
    with reason one of already_attributed | unknown_word |
    inactive_code | no_customer. The bot only renders the verdict."""
    return _post("whatsapp_attribute", {"phone": phone, "word": word})
