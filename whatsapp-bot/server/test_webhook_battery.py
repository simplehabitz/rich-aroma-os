"""
Send-path battery for webhook.py (bot-menu-fix).

The sandbox has no Flask, so a minimal flask stub is installed
before importing webhook — enough for the module to load and for
incoming() to run. The Graph delivery (_deliver_message) is
monkeypatched: payloads are captured, never sent. What is pinned:

  W1  a list WaReply goes out as ONE interactive list payload
      (button + 8 curated section rows),
  W2  when the interactive send FAILS, the same reply is delivered
      as its plain-text fallback (numbered sections + web link,
      zero item lines — never a catalog dump),
  W3  a cta_url WaReply builds the cta_url payload shape,
  W4  a plain string still sends as a plain text payload,
  W5  an inbound interactive list_reply is routed to the engines
      as its id ("sec:<section>"),
  W6  an inbound text message still routes its body (regression),
  W7  POST /account-link (Mi Rich Aroma): no secret configured ->
      403 and nothing sent; wrong bearer -> 403; bad payload ->
      400; good payload -> ONE text with the exact link copy (es,
      and en when lang=en rides the payload).

Run:  python3 server/test_webhook_battery.py
"""

import json
import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# --- minimal flask stub (module load + incoming() only) ---
_flask = types.ModuleType("flask")


class _App:
    def __init__(self, name):
        self.name = name

    def get(self, rule):
        return lambda f: f

    def post(self, rule):
        return lambda f: f

    def run(self, **kw):
        pass


class _Request:
    _json = {}
    headers = {}
    args = {}

    def get_json(self, force=True, silent=True):
        return self._json


_flask.Flask = _App
_flask.request = _Request()
_flask.Response = lambda body="", status=200, mimetype=None: (status, body)
sys.modules["flask"] = _flask

import webhook  # noqa: E402
from wa_reply import WaReply  # noqa: E402
import shop_engine  # noqa: E402

_passed = [0]
_failed = []


def check(cid, cond, why=""):
    if cond:
        _passed[0] += 1
    else:
        _failed.append(cid)
        print(f"FAIL {cid}: {why}")


PID = "1354660681066143"
TO = "50499998888"

SECTIONS = [{"title": "Menú", "rows": [
    {"id": f"sec:{sid}", "title": sid, "description": sid}
    for sid in ("bebidas-calientes", "bebidas-frias",
                "frappes-granitas", "chai-te", "botellas-bolis",
                "comida", "panaderia-postres", "combos")]}]

LIST_REPLY = WaReply(
    "list",
    "¡Claro! ☕ Este es el menú de *Rich Aroma*.\n"
    "Tocá *Ver el menú* y elegí una sección.\n"
    f"🌐 Con fotos: {shop_engine.STORE_URL}",
    "*Rich Aroma — Menú* ☕\n1. Bebidas calientes\n8. Combos\n"
    f"🌐 Con fotos: {shop_engine.STORE_URL}",
    button_text="Ver el menú", sections=SECTIONS)


def capture(fail_interactive=False):
    calls = []

    def fake_deliver(pid, payload):
        calls.append(payload)
        if fail_interactive and payload.get("type") == "interactive":
            raise RuntimeError("simulated Graph rejection")
        return {"ok": True}
    webhook._deliver_message = fake_deliver
    return calls


def w1_list_payload():
    calls = capture()
    webhook.deliver_reply(PID, TO, LIST_REPLY)
    ok = (len(calls) == 1 and calls[0].get("type") == "interactive")
    check("W1a", ok, str(calls)[:200])
    if ok:
        inter = calls[0]["interactive"]
        rows = inter["action"]["sections"][0]["rows"]
        check("W1b", inter["type"] == "list"
              and inter["action"]["button"] == "Ver el menú"
              and len(rows) == 8
              and rows[0]["id"] == "sec:bebidas-calientes",
              str(inter)[:200])


def w2_interactive_failure_falls_back():
    calls = capture(fail_interactive=True)
    webhook.deliver_reply(PID, TO, LIST_REPLY)
    check("W2a", len(calls) == 2
          and calls[0].get("type") == "interactive"
          and calls[1].get("type") == "text",
          f"calls={[c.get('type') for c in calls]}")
    if len(calls) == 2:
        body = calls[1]["text"]["body"]
        check("W2b", body == LIST_REPLY.fallback_text()
              and "1. Bebidas calientes" in body
              and "richaromacoffee.com/order" in body
              and "• " not in body, body[:200])


def w3_cta_payload():
    calls = capture()
    reply = WaReply("cta_url", "Mirá el menú con fotos 📸",
                    "Menú: " + shop_engine.STORE_URL,
                    cta={"display_text": "Ver menú con fotos",
                         "url": shop_engine.STORE_URL})
    webhook.deliver_reply(PID, TO, reply)
    inter = calls[0]["interactive"] if calls else {}
    params = (inter.get("action") or {}).get("parameters") or {}
    check("W3", inter.get("type") == "cta_url"
          and params.get("url") == shop_engine.STORE_URL
          and params.get("display_text") == "Ver menú con fotos",
          str(calls)[:200])


def w4_plain_string():
    calls = capture()
    webhook.deliver_reply(PID, TO, "¡Hola! ☕")
    check("W4", len(calls) == 1 and calls[0].get("type") == "text"
          and calls[0]["text"]["body"] == "¡Hola! ☕", str(calls)[:160])


def _incoming_payload(msg):
    return {"entry": [{"changes": [{"value": {
        "metadata": {"phone_number_id": PID},
        "messages": [msg]}}]}]}


def w5_inbound_list_reply():
    routed = []
    webhook.handle_order_message = \
        lambda frm, text, pid: routed.append((frm, text, pid))
    _flask.request._json = _incoming_payload({
        "type": "interactive", "from": TO,
        "interactive": {"type": "list_reply",
                        "list_reply": {"id": "sec:combos",
                                       "title": "Combos"}}})
    webhook.incoming()
    check("W5", routed == [(TO, "sec:combos", PID)], str(routed))


def w6_inbound_text():
    routed = []
    webhook.handle_order_message = \
        lambda frm, text, pid: routed.append((frm, text, pid))
    _flask.request._json = _incoming_payload({
        "type": "text", "from": TO, "text": {"body": "hola"}})
    webhook.incoming()
    check("W6", routed == [(TO, "hola", PID)], str(routed))


LINK_URL = "https://www.richaromacoffee.com/cuenta?t=tok123"
ES_COPY = ("Tu cuenta *Rich Aroma* 👉 " + LINK_URL + "\n"
           "El link vence en 15 minutos. Tu cuenta es tu "
           "número — sin contraseñas 🔐")
EN_COPY = ("Your *Rich Aroma* account 👉 " + LINK_URL + "\n"
           "The link expires in 15 minutes. Your account is "
           "your number — no passwords 🔐")


def _account_link_call(payload, auth=None):
    _flask.request._json = payload
    _flask.request.headers = \
        ({"Authorization": auth} if auth is not None else {})
    status, body = webhook.account_link()
    return status, json.loads(body)


def w7_account_link():
    calls = capture()
    # W7a: no secret configured on the bot -> fail-closed 403.
    os.environ.pop("WHATSAPP_SIGNUP_SECRET", None)
    status, _ = _account_link_call(
        {"phone": TO, "url": LINK_URL}, "Bearer whatever")
    check("W7a", status == 403 and len(calls) == 0,
          f"status={status} calls={len(calls)}")
    os.environ["WHATSAPP_SIGNUP_SECRET"] = "battery-secret"
    # W7b: wrong bearer -> 403, nothing sent.
    status, _ = _account_link_call(
        {"phone": TO, "url": LINK_URL}, "Bearer wrong")
    check("W7b", status == 403 and len(calls) == 0,
          f"status={status} calls={len(calls)}")
    # W7c: bad payloads -> 400, nothing sent.
    status, _ = _account_link_call({}, "Bearer battery-secret")
    s2, _ = _account_link_call({"phone": TO}, "Bearer battery-secret")
    check("W7c", status == 400 and s2 == 400 and len(calls) == 0,
          f"status={status}/{s2} calls={len(calls)}")
    # W7d: good payload -> one text, exact es copy, shop number id.
    status, body = _account_link_call(
        {"phone": "+504 9999-8888", "url": LINK_URL},
        "Bearer battery-secret")
    check("W7d", status == 200 and body.get("ok") is True
          and len(calls) == 1 and calls[0].get("type") == "text"
          and calls[0].get("to") == TO
          and calls[0]["text"]["body"] == ES_COPY,
          f"status={status} calls={str(calls)[:220]}")
    # W7e: lang=en -> exact en copy.
    calls2 = capture()
    status, _ = _account_link_call(
        {"phone": TO, "url": LINK_URL, "lang": "en"},
        "Bearer battery-secret")
    check("W7e", status == 200 and len(calls2) == 1
          and calls2[0]["text"]["body"] == EN_COPY,
          f"status={status} calls={str(calls2)[:220]}")
    os.environ.pop("WHATSAPP_SIGNUP_SECRET", None)


def main():
    for fn in (w1_list_payload, w2_interactive_failure_falls_back,
               w3_cta_payload, w4_plain_string, w5_inbound_list_reply,
               w6_inbound_text, w7_account_link):
        try:
            fn()
        except Exception as e:
            _failed.append(fn.__name__)
            print(f"FAIL {fn.__name__}: exception "
                  f"{type(e).__name__}: {e}")
    total = _passed[0] + len(_failed)
    print("== webhook battery ==")
    print(f"  TOTAL      {_passed[0]}/{total}")
    print(f"  failed ids: {', '.join(_failed) if _failed else 'none'}")
    return 0 if not _failed else 1


if __name__ == "__main__":
    sys.exit(main())
