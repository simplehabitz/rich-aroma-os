"""
Conversation battery for the Honduras INTRO flow (intro_engine.py).

Scripted Spanish (and one English) conversations run against the rule
engine with the OS client mocked by an in-memory fake that mirrors the
real whatsapp_* actions' semantics: phone-keyed get-or-create, ONE
pending welcome grant per customer, server-computed preventa totals.

Case: (id, category, setup_messages, message, expect)
expect keys:
  reply_contains     substring (or list) expected in the final reply
  reply_not_contains substring that must NOT appear in the final reply
  state              expected intro state after the message
  name               expected convo.name (accents must survive)
  os_actions         exact ordered list of OS actions called (whole case)
  os_actions_include actions that must appear among the calls
  signup_name        name in the whatsapp_signup payload
  signup_birthday    birthday in the payload (absent when skipped -> None)
  preventa           (packs, bottles, boxes) of the last preventa call
  no_pin_anywhere    True -> no reply in the case may ask for a PIN /
                     contraseña, and no OS payload may carry one
  seed_customer      {"name": ..., "gift": "pending"|None} pre-registered
                     in the fake OS for this case's phone

Run:  python3 server/test_intro_battery.py
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import intro_engine
import os_client


class FakeOS:
    """In-memory stand-in for the OS whatsapp_* actions."""

    def __init__(self):
        self.customers = {}   # phone -> {"name":..., "birthday_dm":...}
        self.grants = {}      # phone -> {"status":..., "amount":...}
        self.preorders = []   # recorded whatsapp_preventa payloads
        self.calls = []       # [(action, payload)]

    def seed(self, phone, name, gift):
        self.customers[phone] = {"name": name, "birthday_dm": ""}
        if gift:
            self.grants[phone] = {"status": gift, "amount": 100}

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
            grant_created = phone not in self.grants
            if grant_created:
                self.grants[phone] = {"status": "pending", "amount": 100}
            return 200, {"ok": True, "created": created,
                         "grantCreated": grant_created,
                         "customer": {"name": self.customers[phone]["name"],
                                      "phone": phone},
                         "gift": self.grants[phone]}
        if action == "whatsapp_preventa":
            if phone not in self.customers:
                return 404, {"error": "Cliente no registrado"}
            total = (payload.get("packs", 0) * 350
                     + payload.get("bottles", 0) * 100
                     + payload.get("boxes", 0) * 1400)
            row = {**payload, "quoted_total": total}
            self.preorders.append(row)
            return 200, {"ok": True, "preorder": row}
        return 400, {"error": "unknown action"}


SIGNUP = ["hola", "María José", "saltar", "sí"]  # lands in PREVENTA

CASES = [
    # ---- happy path ----
    ("H1", "happy", ["hola", "María José", "15/03"], "sí",
     {"reply_contains": "L.100 de regalo", "state": "PREVENTA",
      "os_actions": ["whatsapp_lookup", "whatsapp_signup"],
      "signup_name": "María José", "signup_birthday": "15/03",
      "no_pin_anywhere": True}),
    ("H2", "happy", SIGNUP, "1 paquete",
     {"reply_contains": "L.350", "state": "LOUNGE", "preventa": (1, 0, 0)}),
    ("H3", "happy", SIGNUP, "quiero una caja",
     {"reply_contains": "L.1400", "preventa": (0, 0, 1)}),

    # ---- names & birthdays ----
    ("A1", "names", ["hola"], "María José Hernández",
     {"name": "María José Hernández", "state": "ASK_BIRTHDAY",
      "reply_contains": "María"}),
    ("A2", "names", ["hola", "Juan Pérez"], "saltar",
     {"reply_contains": "(sin cumpleaños)", "state": "CONFIRM"}),
    ("A3", "names", ["hola", "Pedro", "saltar", "Pedro Pablo"], "sí",
     {"signup_name": "Pedro Pablo", "state": "PREVENTA"}),
    ("A4", "names", ["hola", "Ana Lucía", "15/03"], "mejor el 20 de mayo",
     {"reply_contains": "20 de mayo", "state": "CONFIRM"}),
    ("B1", "names", ["hola", "Luis"], "32/13",
     {"reply_contains": "No pude leer", "state": "ASK_BIRTHDAY"}),
    ("B2", "names", ["hola", "Luis"], "5 de diciembre",
     {"reply_contains": "5 de diciembre", "state": "CONFIRM"}),

    # ---- returning users ----
    ("R1", "returning", [], "hola",
     {"seed_customer": {"name": "Carlos Mendoza", "gift": "pending"},
      "reply_contains": ["Carlos", "anotado"], "state": "LOUNGE",
      "os_actions": ["whatsapp_lookup"]}),
    ("R2", "returning", [], "quiero 2 paquetes",
     {"seed_customer": {"name": "Carlos Mendoza", "gift": "pending"},
      "reply_contains": "L.700", "preventa": (2, 0, 0)}),
    ("R3", "returning", [], "hola",
     {"seed_customer": {"name": "Lucía Paz", "gift": None},
      "reply_contains": "¿Te lo anoto?", "state": "RETURNING_NO_GIFT"}),
    ("R4", "returning", ["hola"], "sí",
     {"seed_customer": {"name": "Lucía Paz", "gift": None},
      "reply_contains": "quedó anotado", "state": "PREVENTA",
      "os_actions_include": ["whatsapp_signup"]}),

    # ---- menu & prices (parked, kindly) ----
    ("M1", "menu", [], "¿me pasás el menú?",
     {"reply_contains": ["menú completo llega", "¿Cómo te llamás?"],
      "state": "ASK_NAME"}),
    ("M2", "menu", ["hola"], "menu",
     {"seed_customer": {"name": "Carlos Mendoza", "gift": "pending"},
      "reply_contains": "7 de noviembre", "state": "LOUNGE"}),
    ("P1", "prices", [], "¿cuánto cuesta la botella?",
     {"reply_contains": ["L.100", "L.350"], "state": "ASK_NAME"}),
    ("P2", "prices", SIGNUP, "quiero 2 paquetes y 1 botella",
     {"reply_contains": "L.800", "preventa": (2, 1, 0)}),

    # ---- english ----
    ("E1", "english", ["hello", "John Smith", "skip"], "yes",
     {"reply_contains": "L.100 of Rico Cash", "state": "PREVENTA",
      "signup_name": "John Smith", "signup_birthday": None}),
    ("E2", "english", [], "hello",
     {"reply_contains": "November 7", "state": "ASK_NAME"}),

    # ---- gibberish -> re-ask -> handoff ----
    ("G1", "gibberish", ["hola"], "asdf qwer",
     {"reply_contains": "no lo capté", "state": "ASK_NAME"}),
    ("G2", "gibberish", ["hola", "asdf qwer"], "zxcvbn",
     {"reply_contains": "el equipo", "state": "HANDOFF"}),

    # ---- off-ramps & safety ----
    ("N1", "offramps", SIGNUP, "no por ahora",
     {"state": "LOUNGE", "reply_contains": "7 de noviembre",
      "os_actions": ["whatsapp_lookup", "whatsapp_signup"]}),
    ("S1", "safety", SIGNUP, "¿necesitan mi PIN de Rico Cash?",
     {"state": "PREVENTA", "reply_contains": "nunca",
      "no_pin_anywhere": True}),
]

_n = [0]


def run_case(case):
    cid, cat, setup, msg, expect = case
    _n[0] += 1
    phone = f"5049900{_n[0]:04d}"
    fake = FakeOS()
    if "seed_customer" in expect:
        seed = expect["seed_customer"]
        fake.seed(phone, seed["name"], seed.get("gift"))
    os_client.set_transport(fake)
    saved = []
    intro_engine.save_order = lambda slug, rec: saved.append(rec)
    intro_engine._intro_conversations.clear()

    convo = intro_engine.get_intro_conversation(phone)
    replies = []
    for m in setup:
        replies.append(intro_engine.reply_for_intro(convo, m))
    reply = intro_engine.reply_for_intro(convo, msg)
    replies.append(reply)

    ok = True
    why = []
    rc = expect.get("reply_contains")
    if rc:
        for needle in ([rc] if isinstance(rc, str) else rc):
            if needle not in reply:
                ok = False
                why.append(f"reply lacks {needle!r}")
    if "reply_not_contains" in expect and expect["reply_not_contains"] in reply:
        ok = False
        why.append("reply contains forbidden text")
    if "state" in expect and convo.state != expect["state"]:
        ok = False
        why.append(f"state {convo.state} != {expect['state']}")
    if "name" in expect and convo.name != expect["name"]:
        ok = False
        why.append(f"name {convo.name!r} != {expect['name']!r}")
    actions = [a for a, _ in fake.calls]
    if "os_actions" in expect and actions != expect["os_actions"]:
        ok = False
        why.append(f"os_actions {actions} != {expect['os_actions']}")
    for a in expect.get("os_actions_include", []):
        if a not in actions:
            ok = False
            why.append(f"missing OS action {a}")
    signups = [p for a, p in fake.calls if a == "whatsapp_signup"]
    if "signup_name" in expect:
        if not signups or signups[-1].get("name") != expect["signup_name"]:
            ok = False
            why.append(f"signup_name {signups[-1].get('name') if signups else None!r}")
    if "signup_birthday" in expect:
        got = signups[-1].get("birthday") if signups else "NO-CALL"
        if got != expect["signup_birthday"]:
            ok = False
            why.append(f"signup_birthday {got!r} != {expect['signup_birthday']!r}")
    if "preventa" in expect:
        prev = [p for a, p in fake.calls if a == "whatsapp_preventa"]
        got = None
        if prev:
            p = prev[-1]
            got = (p.get("packs", 0), p.get("bottles", 0), p.get("boxes", 0))
        if got != expect["preventa"]:
            ok = False
            why.append(f"preventa {got} != {expect['preventa']}")
    if expect.get("no_pin_anywhere"):
        # The bot may MENTION the PIN only to say it never asks for one
        # (the anti-phishing reassurance). What is forbidden is a
        # REQUEST: a question or instruction asking the customer for a
        # PIN / password / card data.
        request_re = re.compile(
            r"(?i)(cu[áa]l es|dame|pasame|ingres[áa]|escrib[ií]|"
            r"decime|necesito|necesitamos|mandame|env[ií]ame)"
            r"[^.\n]{0,30}\b(pin|contraseña|password|clave)\b")
        for r in replies:
            if request_re.search(r):
                ok = False
                why.append("a reply REQUESTS a credential")
        for _, payload in fake.calls:
            if any("pin" in k.lower() or "password" in k.lower()
                   for k in payload):
                ok = False
                why.append("an OS payload carries a credential field")
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
    print("== intro battery ==")
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
