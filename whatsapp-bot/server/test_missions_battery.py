"""
Conversation battery for MISIONES DEL CAPITÁN (intro_engine.py missions).

Covers the bot half of purchase-unlocked UGC challenges:
  - pull-model delivery: an unlocked assignment is announced ONCE,
    appended AFTER the customer's actual question is answered, and
    only when the message arrives with the conversation already in
    the LOUNGE (the turn that first lands a customer in the lounge
    keeps the greeting flow's exact shape — the original intro
    battery's OS-call ledgers stay untouched, 23/23 there);
  - link intake: Instagram/Facebook/TikTok URLs are submitted via
    whatsapp_mission_submit and the OS verdict is rendered in the
    house voice (ok / duplicate / no mission / expired / bad link);
  - status answers from whatsapp_mission_check (pending / approved /
    none), with approved gifts worded as 'anotado', never spendable;
  - signup states are never hijacked by a link;
  - the Cali tenant (order_engine) is untouched.

The FakeOS mirrors the shared contract: whatsapp_mission_check
returns unlocked assignments plus submitted ones with a submission
status; whatsapp_mission_submit answers {ok} or {ok: False, reason}.

Run:  python3 server/test_missions_battery.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import intro_engine
import order_engine
import os_client

BRIEF = ("Sacale una foto a tu botella con el mural del Capitán, "
         "subila a Instagram, etiquetá a @richaromacoffee y mandame "
         "el link. Premio: L.50 de regalo en tu Rico Cash.")
IG_LINK = "https://www.instagram.com/p/Capitan123/"


class FakeOS:
    """In-memory stand-in for the OS whatsapp_* actions (missions)."""

    def __init__(self):
        self.customers = {}       # phone -> {"name":...}
        self.grants = {}          # phone -> {"status":..., "amount":...}
        self.missions = {}        # phone -> [assignment dicts]
        self.top_completions = None  # top-level completions on check
        self.submitted_links = set()
        self.calls = []           # [(action, payload)]

    def seed(self, phone, name, gift):
        self.customers[phone] = {"name": name, "birthday_dm": ""}
        if gift:
            self.grants[phone] = {"status": gift, "amount": 100}

    def seed_mission(self, phone, **kw):
        a = {"assignment_id": "asg-1", "mission_id": "mis-botella",
             "name": "Botella Viajera", "brief": BRIEF,
             "reward_amount": 50, "expires_at": "2026-11-30",
             "status": "unlocked"}
        a.update(kw)
        self.missions.setdefault(phone, []).append(a)
        return a

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
            return 200, {"ok": True, "created": created,
                         "customer": {"name": self.customers[phone]["name"],
                                      "phone": phone},
                         "gift": self.grants[phone]}
        if action == "whatsapp_preventa":
            return 200, {"ok": True, "preorder": dict(payload)}
        if action == "whatsapp_mission_check":
            resp = {"assignments":
                    [dict(a) for a in self.missions.get(phone, [])]}
            if self.top_completions is not None:
                resp["completions"] = self.top_completions
            return 200, resp
        if action == "whatsapp_mission_submit":
            url = payload.get("post_url", "")
            if "badlink" in url:
                return 200, {"ok": False, "reason": "bad_link"}
            if url in self.submitted_links:
                return 200, {"ok": False, "reason": "duplicate_link"}
            active = [a for a in self.missions.get(phone, [])
                      if a.get("status") == "unlocked"
                      and not a.get("submission_status")]
            if not active:
                return 200, {"ok": False, "reason": "no_active_mission"}
            a = active[0]
            if a.get("force_expired"):
                return 200, {"ok": False, "reason": "expired"}
            self.submitted_links.add(url)
            a["status"] = "submitted"
            a["submission_status"] = "pending"
            return 200, {"ok": True, "assignment_id": a["assignment_id"]}
        return 400, {"error": "unknown action"}


CARLOS = {"name": "Carlos Mendoza", "gift": "pending"}

CASES = [
    # ---- delivery (pull model) ----
    ("MD0", "delivery", [], "hola",
     {"seed_customer": CARLOS, "seed_mission": {},
      "reply_contains": "Carlos", "reply_not_contains": "MISIÓN del Capitán",
      "state": "LOUNGE"}),
    ("MD1", "delivery", ["hola"], "buenas",
     {"seed_customer": CARLOS, "seed_mission": {},
      "reply_contains": ["MISIÓN del Capitán", "Sacale una foto"],
      "os_actions_include": ["whatsapp_mission_check"]}),
    ("MD2", "delivery", ["hola", "buenas"], "gracias",
     {"seed_customer": CARLOS, "seed_mission": {},
      "reply_not_contains": "MISIÓN del Capitán"}),
    ("MD3", "delivery", ["hola"], "¿cuánto cuesta la botella?",
     {"seed_customer": CARLOS, "seed_mission": {},
      "reply_contains": ["L.100", "MISIÓN del Capitán"],
      "reply_order": ["L.100 c/u", "MISIÓN del Capitán"]}),
    ("MD4", "delivery", ["hello"], "hi there",
     {"seed_customer": {"name": "John Smith", "gift": "pending"},
      "seed_mission": {},
      "reply_contains": "You have a MISSION from the Captain"}),

    # ---- link intake ----
    ("ML1", "links", ["hola"], IG_LINK,
     {"seed_customer": CARLOS, "seed_mission": {},
      "reply_contains": ["¡Recibido!", "Rico Cash"],
      "submit_url": IG_LINK,
      "os_actions_include": ["whatsapp_mission_submit"]}),
    ("ML2", "links", ["hola", IG_LINK], IG_LINK,
     {"seed_customer": CARLOS, "seed_mission": {},
      "reply_contains": "ya está registrado"}),
    ("ML3", "links", ["hola"], IG_LINK,
     {"seed_customer": CARLOS,
      "reply_contains": "se desbloquean al comprar",
      "reply_not_contains": ["¡Recibido!", "lo pagado con regalo"]}),
    ("ML4", "links", ["hola"], IG_LINK,
     {"seed_customer": CARLOS, "seed_mission": {"force_expired": True},
      "reply_contains": "venció"}),
    ("ML5", "links", ["hola"], "https://www.instagram.com/badlink",
     {"seed_customer": CARLOS, "seed_mission": {},
      "reply_contains": "no lo pude validar"}),

    # ---- status answers ----
    ("MS1", "status", ["hola"], "¿y mi misión?",
     {"seed_customer": CARLOS,
      "seed_mission": {"status": "submitted",
                       "submission_status": "pending"},
      "reply_contains": "en revisión"}),
    ("MS2", "status", ["hola"], "¿y mi regalo de la misión?",
     {"seed_customer": CARLOS,
      "seed_mission": {"status": "approved",
                       "submission_status": "approved"},
      "reply_contains": ["Misión aprobada", "anotado"],
      "reply_not_contains": "ya está en tu Rico Cash"}),
    ("MS3", "status", ["hola"], "¿tengo alguna misión?",
     {"seed_customer": CARLOS,
      "reply_contains": "se desbloquean al comprar",
      "reply_not_contains": ["Misiones cumplidas",
                             "lo pagado con regalo"]}),
    ("MS4", "status", ["hola"], "¿y mi misión?",
     {"seed_customer": CARLOS,
      "seed_mission": {"status": "approved",
                       "submission_status": "approved",
                       "completions": 2},
      "reply_contains": ["Misión aprobada", "Misiones cumplidas: 2 🏅"]}),
    ("MS5", "status", ["hola"], "¿y mi misión?",
     {"seed_customer": CARLOS, "seed_completions": 3,
      "seed_mission": {"status": "submitted",
                       "submission_status": "pending"},
      "reply_contains": ["en revisión", "Misiones cumplidas: 3 🏅"]}),

    # ---- why-Q&A: gift balance never funds an unlock (explainer) ----
    ("MQ1", "why", ["hola"], "¿por qué no tengo misión?",
     {"seed_customer": CARLOS,
      "reply_contains": ["se desbloquean al comprar",
                         "lo pagado con regalo no desbloquea"]}),

    # ---- signup is never hijacked by a link ----
    ("MH1", "hijack", ["hola"], IG_LINK,
     {"reply_contains": "no lo capté", "state": "ASK_NAME",
      "os_actions": ["whatsapp_lookup"]}),
]

_n = [0]


def run_case(case):
    cid, cat, setup, msg, expect = case
    _n[0] += 1
    phone = f"5049911{_n[0]:04d}"
    fake = FakeOS()
    if "seed_customer" in expect:
        seed = expect["seed_customer"]
        fake.seed(phone, seed["name"], seed.get("gift"))
    if "seed_mission" in expect:
        fake.seed_mission(phone, **expect["seed_mission"])
    if "seed_completions" in expect:
        fake.top_completions = expect["seed_completions"]
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
    if "reply_order" in expect:
        a, b = expect["reply_order"]
        ia, ib = reply.find(a), reply.find(b)
        if ia < 0 or ib < 0 or ia > ib:
            ok = False
            why.append(f"reply_order {a!r} !< {b!r}")
    if "state" in expect and convo.state != expect["state"]:
        ok = False
        why.append(f"state {convo.state} != {expect['state']}")
    actions = [a for a, _ in fake.calls]
    if "os_actions" in expect and actions != expect["os_actions"]:
        ok = False
        why.append(f"os_actions {actions} != {expect['os_actions']}")
    for a in expect.get("os_actions_include", []):
        if a not in actions:
            ok = False
            why.append(f"missing OS action {a}")
    if "submit_url" in expect:
        subs = [p for a, p in fake.calls
                if a == "whatsapp_mission_submit"]
        got = subs[-1].get("post_url") if subs else None
        if got != expect["submit_url"]:
            ok = False
            why.append(f"submit_url {got!r} != {expect['submit_url']!r}")
    return ok, why, reply


def cali_smoke():
    """The Cali tenant (order_engine) is a different engine on a
    different slug; the missions change must not leak into it."""
    order_engine._conversations.clear() \
        if hasattr(order_engine, "_conversations") else None
    convo = order_engine.get_conversation("15550001111", "rich-aroma",
                                          "en")
    reply = order_engine.reply_for(convo, "hi")
    ok = ("Rich Aroma Coffee Co." in reply
          and "bottled coffee" in reply
          and "MISIÓN" not in reply and "preventa" not in reply.lower())
    return ok, reply


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
    ok, reply = cali_smoke()
    per_cat.setdefault("cali", [0, 0])
    per_cat["cali"][1] += 1
    if ok:
        per_cat["cali"][0] += 1
    else:
        fails.append("MC1")
        print(f"FAIL MC1 (cali): unexpected Cali reply: {reply[:220]}")
    print("== missions battery ==")
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
