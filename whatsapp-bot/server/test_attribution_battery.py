"""
Conversation battery for CREADORES signup-word attribution
(intro_engine.py attribution).

Covers the bot half of creator-word capture:
  - a word in the FIRST message (bare token = speculative, explicit
    frame = deliberate) is stashed as pending_word and rides the
    signup as ref_word; the ligada line is appended to the
    signup-completion reply ONLY when the OS confirms a bind —
    unknown words stay silent at capture AND at completion;
  - an explicit word sent with the CONFIRM "sí" binds on that very
    signup;
  - post-signup / lounge attempts go through whatsapp_attribute and
    render the OS verdict (bind / already_attributed — first touch
    speaks first / unknown word, deliberate only; a retired word
    renders as unrecognized; speculative unknowns stay silent);
  - THE PIN: a single-token answer in ASK_NAME ("Capitán") is a
    NAME, never a word — detection never runs in the name step;
  - the original intro battery (23) and missions battery (18) must
    stay green alongside this one (run them separately).

The FakeOS mirrors the OS contract: normalization (UPPERCASE,
diacritics stripped) on both sides, first-touch permanence,
whatsapp_signup answering data["attribution"] (bind result,
already_attributed, or None when the word is unknown/retired —
silently null by design), whatsapp_attribute answering
{ok|reason} with no_customer for unknown phones.

Run:  python3 server/test_attribution_battery.py
"""

import os
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import intro_engine
import os_client


def _norm(word):
    w = (word or "").strip()
    if not w or any(ch.isspace() for ch in w):
        return ""
    w = w.lstrip("@#")
    w = "".join(c for c in unicodedata.normalize("NFD", w)
                if not unicodedata.combining(c)).upper()
    return w if w.isalnum() else ""


class FakeOS:
    """In-memory stand-in for the OS whatsapp_* actions (attribution)."""

    CREATORS = {"CAPITAN": "María la Creadora", "LUNA": "Luna Videos",
                "SOL": "Sol Radio"}

    def __init__(self):
        self.customers = {}     # phone -> {"name":..., "birthday_dm":...}
        self.grants = {}        # phone -> {"status":..., "amount":...}
        self.codes = {}         # normalized code -> {creator_name, is_active}
        self.attribution = {}   # phone -> normalized code
        self.calls = []         # [(action, payload)]
        for code, name in self.CREATORS.items():
            self.codes[code] = {"creator_name": name, "is_active": True}

    def seed(self, phone, name, gift):
        self.customers[phone] = {"name": name, "birthday_dm": ""}
        if gift:
            self.grants[phone] = {"status": gift, "amount": 100}

    def seed_attribution(self, phone, code):
        self.attribution[phone] = _norm(code)

    def seed_inactive(self, code):
        self.codes[_norm(code)]["is_active"] = False

    def _attempt(self, phone, word):
        """OS attribution outcome, first-touch first."""
        if phone in self.attribution:
            bound = self.attribution[phone]
            return {"attributed": False, "reason": "already_attributed",
                    "creator_name": self.codes[bound]["creator_name"]}
        code = _norm(word)
        row = self.codes.get(code) if code else None
        if not row:
            return {"attributed": False, "reason": "unknown_word"}
        if not row["is_active"]:
            return {"attributed": False, "reason": "inactive_code",
                    "creator_name": row["creator_name"]}
        self.attribution[phone] = code
        return {"attributed": True, "creator_name": row["creator_name"]}

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
            created = phone not in self.customers
            if created:
                self.customers[phone] = {
                    "name": payload.get("name", ""),
                    "birthday_dm": payload.get("birthday", "")}
            if phone not in self.grants:
                self.grants[phone] = {"status": "pending", "amount": 100}
            attribution = None
            if payload.get("ref_word"):
                att = self._attempt(phone, payload["ref_word"])
                if att["attributed"] or att["reason"] == "already_attributed":
                    attribution = att
            return 200, {"ok": True, "created": created,
                         "customer": {"name": self.customers[phone]["name"],
                                      "phone": phone},
                         "gift": self.grants[phone],
                         "attribution": attribution}
        if action == "whatsapp_attribute":
            if phone not in self.customers:
                return 200, {"ok": False, "reason": "no_customer"}
            att = self._attempt(phone, payload.get("word", ""))
            return 200, {"ok": bool(att["attributed"]), **att}
        if action == "whatsapp_preventa":
            return 200, {"ok": True, "preorder": dict(payload)}
        if action == "whatsapp_mission_check":
            return 200, {"assignments": []}
        if action == "whatsapp_mission_submit":
            return 200, {"ok": False, "reason": "no_active_mission"}
        return 400, {"error": "unknown action"}


CARLOS = {"name": "Carlos Mendoza", "gift": "pending"}

CASES = [
    # ---- word at first contact, new customer (speculative) ----
    ("W1", "capture", [], "CAPITAN",
     {"reply_contains": "¿Cómo te llamás?", "reply_not_contains": "ligada",
      "state": "ASK_NAME", "pending_word": "CAPITAN",
      "os_actions": ["whatsapp_lookup"]}),
    ("W2", "capture", ["CAPITAN", "María José", "saltar"], "sí",
     {"reply_contains": "ligada a la palabra de María la Creadora",
      "state": "PREVENTA", "signup_ref_word": "CAPITAN",
      "attributed_to": "CAPITAN", "pending_word": ""}),

    # ---- explicit word mid-flow: rides the CONFIRM "sí" ----
    ("W3", "capture", ["hola", "María José", "saltar"], "sí palabra LUNA",
     {"reply_contains": "ligada a la palabra de Luna Videos",
      "state": "PREVENTA", "signup_ref_word": "LUNA",
      "attributed_to": "LUNA"}),

    # ---- speculative junk word: silent at capture AND completion ----
    ("W4", "capture", ["TROMPO", "Ana", "saltar"], "sí",
     {"reply_contains": "¡Listo", "reply_not_contains": "ligada",
      "signup_ref_word": "TROMPO", "attributed_to": None}),

    # ---- registered customer: word at first contact binds at once ----
    ("W5", "post", [], "CAPITAN",
     {"seed_customer": CARLOS,
      "reply_contains": ["Carlos", "ligada a la palabra de"],
      "attributed_to": "CAPITAN",
      "os_actions": ["whatsapp_lookup", "whatsapp_attribute"]}),

    # ---- lounge attempts ----
    ("W6", "post", ["hola"], "palabra CAPITAN",
     {"seed_customer": CARLOS,
      "reply_contains": "ligada a la palabra de María la Creadora",
      "attributed_to": "CAPITAN",
      "os_actions_include": ["whatsapp_attribute"]}),
    ("W7", "post", ["hola"], "luna",
     {"seed_customer": CARLOS,
      "reply_contains": "ligada a la palabra de Luna Videos",
      "attributed_to": "LUNA"}),
    ("W8", "post", ["hola"], "palabra LUNA",
     {"seed_customer": CARLOS, "seed_attribution": "CAPITAN",
      "reply_contains": ["Ya tenés una palabra ligada",
                         "María la Creadora"],
      "attributed_to": "CAPITAN"}),
    ("W9", "post", ["hola"], "palabra INVENTADA",
     {"seed_customer": CARLOS, "reply_contains": "No reconozco esa palabra",
      "attributed_to": None}),
    ("W10", "post", ["hola"], "TROMPO",
     {"seed_customer": CARLOS,
      "reply_contains": "preventa",
      "reply_not_contains": ["No reconozco", "ligada"],
      "attributed_to": None,
      "os_actions_include": ["whatsapp_attribute"]}),
    ("W11", "post", ["hola"], "palabra SOL",
     {"seed_customer": CARLOS, "seed_inactive": "SOL",
      "reply_contains": "No reconozco esa palabra",
      "attributed_to": None}),

    # ---- THE PIN: a name answer is never a word ----
    ("W12", "pin", ["hola"], "Capitán",
     {"reply_contains": "Mucho gusto", "state": "ASK_BIRTHDAY",
      "name": "Capitán", "pending_word": "",
      "os_actions": ["whatsapp_lookup"]}),
]

_n = [0]


def run_case(case):
    cid, cat, setup, msg, expect = case
    _n[0] += 1
    phone = f"5049922{_n[0]:04d}"
    fake = FakeOS()
    if "seed_customer" in expect:
        seed = expect["seed_customer"]
        fake.seed(phone, seed["name"], seed.get("gift"))
    if "seed_attribution" in expect:
        fake.seed_attribution(phone, expect["seed_attribution"])
    if "seed_inactive" in expect:
        fake.seed_inactive(expect["seed_inactive"])
    os_client.set_transport(fake)
    saved = []
    intro_engine.save_order = lambda slug, rec: saved.append(rec)
    intro_engine._intro_conversations.clear()

    convo = intro_engine.get_intro_conversation(phone)
    for m in setup:
        intro_engine.reply_for_intro(convo, m)
    reply = intro_engine.reply_for_intro(convo, msg)

    ok = True
    why = []
    rc = expect.get("reply_contains")
    if rc:
        for needle in ([rc] if isinstance(rc, str) else rc):
            if needle not in reply:
                ok = False
                why.append(f"reply lacks {needle!r}")
    rnc = expect.get("reply_not_contains")
    if rnc:
        for needle in ([rnc] if isinstance(rnc, str) else rnc):
            if needle in reply:
                ok = False
                why.append(f"reply contains forbidden {needle!r}")
    if "state" in expect and convo.state != expect["state"]:
        ok = False
        why.append(f"state {convo.state} != {expect['state']}")
    if "name" in expect and convo.name != expect["name"]:
        ok = False
        why.append(f"name {convo.name!r} != {expect['name']!r}")
    if "pending_word" in expect and convo.pending_word != expect["pending_word"]:
        ok = False
        why.append(f"pending_word {convo.pending_word!r} "
                   f"!= {expect['pending_word']!r}")
    actions = [a for a, _ in fake.calls]
    if "os_actions" in expect and actions != expect["os_actions"]:
        ok = False
        why.append(f"os_actions {actions} != {expect['os_actions']}")
    for a in expect.get("os_actions_include", []):
        if a not in actions:
            ok = False
            why.append(f"missing OS action {a}")
    if "signup_ref_word" in expect:
        signups = [p for a, p in fake.calls if a == "whatsapp_signup"]
        got = signups[-1].get("ref_word") if signups else "NO-CALL"
        if got != expect["signup_ref_word"]:
            ok = False
            why.append(f"signup_ref_word {got!r} "
                       f"!= {expect['signup_ref_word']!r}")
    if "attributed_to" in expect:
        got = fake.attribution.get(phone)
        if got != expect["attributed_to"]:
            ok = False
            why.append(f"attributed_to {got!r} "
                       f"!= {expect['attributed_to']!r}")
    return ok, why, reply


def main():
    per_cat = {}
    fails = []
    for case in CASES:
        ok, why, reply = run_case(case)
        cat = case[1]
        per_cat.setdefault(cat, [0, 0])
        per_cat[cat][1] += 1
        if ok:
            per_cat[cat][0] += 1
        else:
            fails.append(case[0])
            print(f"FAIL {case[0]} ({cat}): {'; '.join(why)}")
            print(f"  last reply: {reply[:220]}")
    print("== attribution battery ==")
    grand = [0, 0]
    for cat in sorted(per_cat):
        p, t = per_cat[cat]
        grand[0] += p
        grand[1] += t
        print(f"  {cat:10s} {p}/{t}")
    print(f"  TOTAL      {grand[0]}/{grand[1]}")
    print(f"  failed ids: {', '.join(fails) if fails else 'none'}")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
