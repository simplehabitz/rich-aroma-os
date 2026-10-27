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
  W8  voice-in: an inbound audio message is transcribed (Graph +
      Gemini mocked at the voice module's seams) and the
      transcript is routed to the engines marked voice-originated.
  W9  voice-in failure: no usable transcript -> exactly ONE text
      with the retry line, and the engines never see the turn.
  W10 mirror: a plain string reply on a voice turn leaves as ONE
      audio payload (voice:true, the uploaded media id).
  W11 voice-in end-to-end: audio -> "quiero un latte" -> the real
      shop engine answers -> the answer leaves as a voice note
      whose spoken text is the shop's summary.
  W12 bank details on a voice turn stay TEXT (never spoken).
  W13 an interactive list reply on a voice turn stays interactive.
  W14 TTS failure -> the reply still goes out, as text.
  W15 exclusions: a URL reply and a >400-char reply stay text on
      voice turns; a typed turn never speaks.
  W16 the mood clock: pinned Tegucigalpa times map to the
      audition's despertando / mediodia / fiesta, Sunday close
      included.

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
import intro_engine  # noqa: E402
import menu_client  # noqa: E402
import os_client  # noqa: E402
import voice  # noqa: E402

# W5/W6 replace webhook.handle_order_message with a capture stub;
# the voice cases that need the REAL handler restore it from here.
_REAL_HANDLE_ORDER = webhook.handle_order_message

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


# ------------------------------------------------------------- voice

VOICE_TO = "50411112222"

_VOICE_MENU = {
    "items": [{"id": "latte-12oz", "name": "Latte 12oz",
               "name_es": "Latte 12oz", "price": 70,
               "category": "espresso_bar", "available": True}],
    "modGroups": [], "modOptions": [], "itemModGroups": []}

_BANK_BLOCK = ("💳 Transferí a la cuenta de tu banco "
               "(mismo banco = al instante):\n"
               "1️⃣ *BanPais* — cuenta 200012345678 "
               "a nombre de Rich Aroma S de RL")


def _voice_fake_os(action, payload):
    """Minimal OS for the end-to-end voice case: every action is
    benign; missions find nothing to deliver."""
    if action == "whatsapp_lookup":
        return 200, {"found": True,
                     "customer": {"name": "Test"}, "gift": None}
    if action == "whatsapp_mission_check":
        return 200, {"ok": True, "assignments": []}
    return 200, {"ok": True}


def _audio_payload(media_id="MEDIA_IN_1", frm=TO):
    return _incoming_payload({
        "type": "audio", "from": frm,
        "audio": {"id": media_id, "voice": True,
                  "mime_type": "audio/ogg"}})


def w8_voice_in_routes_transcript():
    calls = capture()
    routed = []
    orig_t = voice.transcribe_media
    voice.transcribe_media = lambda mid: "quiero un latte"
    webhook.handle_order_message = \
        lambda frm, text, pid, voice_turn=False: \
        routed.append((frm, text, pid, voice_turn))
    try:
        _flask.request._json = _audio_payload()
        webhook.incoming()
    finally:
        voice.transcribe_media = orig_t
        webhook.handle_order_message = _REAL_HANDLE_ORDER
    check("W8", routed == [(TO, "quiero un latte", PID, True)]
          and len(calls) == 0, f"routed={routed} calls={len(calls)}")


def w9_voice_in_failure_asks_repeat():
    calls = capture()
    routed = []
    orig_t = voice.transcribe_media
    voice.transcribe_media = lambda mid: None
    webhook.handle_order_message = \
        lambda *a, **k: routed.append((a, k))
    try:
        _flask.request._json = _audio_payload()
        webhook.incoming()
    finally:
        voice.transcribe_media = orig_t
        webhook.handle_order_message = _REAL_HANDLE_ORDER
    check("W9", routed == [] and len(calls) == 1
          and calls[0].get("type") == "text"
          and calls[0].get("to") == TO
          and calls[0]["text"]["body"] == voice.RETRY_TEXT,
          f"routed={routed} calls={str(calls)[:200]}")


def w10_mirror_plain_reply_goes_audio():
    calls = capture()
    spoken = []
    orig_s = voice.speak
    voice.speak = lambda pid, text: (spoken.append(text),
                                     "MEDIA_OUT_9")[1]
    try:
        webhook.deliver_reply(PID, TO, "Anotado ✅", voice=True)
    finally:
        voice.speak = orig_s
    check("W10", spoken == ["Anotado ✅"] and len(calls) == 1
          and calls[0].get("type") == "audio"
          and calls[0].get("audio") == {"id": "MEDIA_OUT_9",
                                        "voice": True},
          f"spoken={spoken} calls={str(calls)[:200]}")


def w11_voice_order_end_to_end():
    calls = capture()
    spoken = []
    orig_t, orig_s = voice.transcribe_media, voice.speak
    voice.transcribe_media = lambda mid: "quiero un latte"

    def fake_speak(pid, text):
        spoken.append(text)
        return "MEDIA_OUT_1"
    voice.speak = fake_speak
    os_client.set_transport(_voice_fake_os)
    menu_client.set_catalog(menu_client.build_catalog(_VOICE_MENU))
    convo = intro_engine.get_intro_conversation(VOICE_TO)
    convo.state = "LOUNGE"
    convo.registered = True
    convo.name = "Test"
    convo.lang = "es"
    webhook.handle_order_message = _REAL_HANDLE_ORDER
    try:
        _flask.request._json = _audio_payload("MEDIA_IN_2", VOICE_TO)
        webhook.incoming()
    finally:
        voice.transcribe_media = orig_t
        voice.speak = orig_s
        os_client.set_transport(None)
        menu_client.clear()
        intro_engine.reset_intro_conversation(convo)
    check("W11a", len(calls) == 1 and calls[0].get("type") == "audio"
          and calls[0].get("to") == VOICE_TO
          and calls[0].get("audio") == {"id": "MEDIA_OUT_1",
                                        "voice": True},
          f"calls={str(calls)[:220]}")
    check("W11b", len(spoken) == 1 and "Latte" in spoken[0],
          f"spoken={spoken}")


def _speak_spy():
    seen = []
    orig = voice.speak
    voice.speak = lambda pid, text: (seen.append(text),
                                     "MEDIA_X")[1]
    return seen, orig


def w12_bank_reply_stays_text():
    calls = capture()
    seen, orig = _speak_spy()
    try:
        webhook.deliver_reply(PID, TO, _BANK_BLOCK, voice=True)
    finally:
        voice.speak = orig
    check("W12", seen == [] and len(calls) == 1
          and calls[0].get("type") == "text"
          and calls[0]["text"]["body"] == _BANK_BLOCK,
          f"seen={seen} calls={str(calls)[:200]}")


def w13_list_reply_stays_interactive():
    calls = capture()
    seen, orig = _speak_spy()
    try:
        webhook.deliver_reply(PID, TO, LIST_REPLY, voice=True)
    finally:
        voice.speak = orig
    check("W13", seen == [] and len(calls) == 1
          and calls[0].get("type") == "interactive",
          f"seen={seen} calls={str(calls)[:200]}")


def w14_tts_failure_falls_back_to_text():
    calls = capture()
    orig = voice.speak

    def boom(pid, text):
        raise RuntimeError("simulated TTS outage")
    voice.speak = boom
    try:
        webhook.deliver_reply(PID, TO, "¡Hola! ☕", voice=True)
    finally:
        voice.speak = orig
    check("W14", len(calls) == 1 and calls[0].get("type") == "text"
          and calls[0]["text"]["body"] == "¡Hola! ☕",
          f"calls={str(calls)[:200]}")


def w15_exclusions_and_typed_turns():
    calls = capture()
    seen, orig = _speak_spy()
    try:
        webhook.deliver_reply(
            PID, TO,
            "Tu cuenta 👉 https://www.richaromacoffee.com/cuenta"
            "?t=tok123", voice=True)
        webhook.deliver_reply(PID, TO, "x" * 401, voice=True)
        webhook.deliver_reply(PID, TO, "Anotado ✅", voice=False)
    finally:
        voice.speak = orig
    types = [c.get("type") for c in calls]
    check("W15", seen == [] and types == ["text", "text", "text"],
          f"seen={seen} types={types}")


def w16_mood_clock():
    from datetime import datetime
    mon = lambda h, mi=0: datetime(2026, 10, 26, h, mi)  # a Monday
    sun = lambda h, mi=0: datetime(2026, 11, 1, h, mi)   # a Sunday
    got = [voice.mood_for(mon(7, 30)), voice.mood_for(mon(8, 59)),
           voice.mood_for(mon(12, 0)), voice.mood_for(mon(19, 0)),
           voice.mood_for(sun(17, 30)), voice.mood_for(sun(18, 0))]
    check("W16", got == ["despertando", "despertando", "mediodia",
                         "fiesta", "mediodia", "fiesta"], str(got))


def main():
    for fn in (w1_list_payload, w2_interactive_failure_falls_back,
               w3_cta_payload, w4_plain_string, w5_inbound_list_reply,
               w6_inbound_text, w7_account_link,
               w8_voice_in_routes_transcript,
               w9_voice_in_failure_asks_repeat,
               w10_mirror_plain_reply_goes_audio,
               w11_voice_order_end_to_end,
               w12_bank_reply_stays_text,
               w13_list_reply_stays_interactive,
               w14_tts_failure_falls_back_to_text,
               w15_exclusions_and_typed_turns,
               w16_mood_clock):
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
