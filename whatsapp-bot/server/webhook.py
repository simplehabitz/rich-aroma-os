"""
WhatsApp Business Platform webhook for AI Front Desk.
- GET /webhook: Meta verification
- POST /webhook: incoming messages -> AI order logic -> reply

Secrets:
- WHATSAPP_VERIFY_TOKEN: env var you choose, entered in Meta dashboard
- API token resolution order:
    1. Secure Vault as custom.whatsapp-business (this workspace, preferred)
    2. WHATSAPP_API_TOKEN env var (deployed host — set by the owner in the
       host dashboard, never committed to the repo)
- GEMINI_API_KEY env var: the bot's Gemini key (server/voice.py —
  voice-note transcription + Capitán Rico's spoken replies; the
  same env the parked hybrid parser was built against)
"""
import os
import sys
import json
import urllib.request

from flask import Flask, request, Response

try:
    from wa_reply import WaReply
except ImportError:  # running as part of the server package
    from server.wa_reply import WaReply

# For Vault-backed API calls (see custom_connector_setup skill)
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
try:
    from dynamic_credentials import add_surrogate_to_request, read_json_response
    HAS_VAULT = True
except ImportError:
    HAS_VAULT = False

    def read_json_response(resp):
        # No vault on this host (the deployed bot): read the
        # response body as plain JSON. This fallback must exist —
        # _deliver_message calls read_json_response(resp)
        # unconditionally, and without the name defined the call
        # dies with a NameError AFTER the Graph POST has already
        # gone out: the customer gets the message, then the log
        # shows "webhook error: name 'read_json_response' is not
        # defined" (live Render log, 2026-10-26).
        return json.loads(resp.read().decode("utf-8") or "{}")

app = Flask(__name__)

VERIFY_TOKEN = os.environ.get("WHATSAPP_VERIFY_TOKEN", "change-me")
GRAPH_HOST = "graph.facebook.com"
GRAPH_VERSION = "v21.0"

# One WhatsApp number -> one business. Add a line per number as businesses onboard.
# default_lang: language used when the customer's language can't be detected
# (per-message detection still lets any customer use either language).
ROUTES = {
    "1354660681066143": {"slug": "rich-aroma-honduras", "default_lang": "es"},  # Rich Aroma coffee shop, Quimistán — +504 9905-4412 (line belongs to the shop; decided 2026-10-20)
    # Cali bottled coffee gets its own US number and its own deployment
    # someday — nothing Cali is reachable from this bot (bot-finalize,
    # 2026-10-26: the Cali order engine was removed, not just unrouted).
}
SHOP_PHONE_NUMBER_ID = "1354660681066143"


def _deliver_message(phone_number_id: str, payload: dict):
    """POST one message payload to the Graph API.

    Token resolution order:
      1. Secure Vault surrogate (custom.whatsapp-business) when available —
         this is the path used inside this workspace.
      2. WHATSAPP_API_TOKEN env var — used on the deployed host, where the
         owner sets it in the host's dashboard (never committed to the repo).
    """
    url = f"https://{GRAPH_HOST}/{GRAPH_VERSION}/{phone_number_id}/messages"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    if HAS_VAULT:
        # Places bearer token from custom.whatsapp-business
        add_surrogate_to_request(
            req, "custom.whatsapp-business", allowed_hosts=[GRAPH_HOST]
        )
    else:
        token = os.environ.get("WHATSAPP_API_TOKEN", "").strip()
        if not token:
            raise RuntimeError(
                "No WhatsApp API token: set WHATSAPP_API_TOKEN env var"
            )
        req.add_header("Authorization", f"Bearer {token}")

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            raise RuntimeError("redirect refused, verify endpoint")

    with urllib.request.build_opener(NoRedirect()).open(req, timeout=30) as resp:
        return read_json_response(resp)


def send_whatsapp_text(phone_number_id: str, to: str, text: str):
    """Send a WhatsApp text message via Graph API."""
    return _deliver_message(phone_number_id, {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "text",
        "text": {"body": text},
    })


def send_whatsapp_audio(phone_number_id: str, to: str, media_id: str):
    """Send an uploaded voice note (server/voice.py): an audio
    message with voice:true, so it renders as a voice memo in the
    customer's chat, not an audio-file attachment."""
    return _deliver_message(phone_number_id, {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "audio",
        "audio": {"id": media_id, "voice": True},
    })


def send_whatsapp_interactive(phone_number_id: str, to: str, reply):
    """Send a WaReply (wa_reply.py) as a WhatsApp interactive
    message: an interactive LIST for menu browsing, or a CTA-URL
    button to the photo storefront. Raises on API failure —
    deliver_reply() falls back to the reply's text rendering."""
    if reply.kind == "list":
        interactive = {
            "type": "list",
            "body": {"text": reply.body},
            "action": {"button": reply.button_text,
                       "sections": reply.sections},
        }
    elif reply.kind == "cta_url":
        interactive = {
            "type": "cta_url",
            "body": {"text": reply.body},
            "action": {"name": "cta_url",
                       "parameters": {
                           "display_text": reply.cta["display_text"],
                           "url": reply.cta["url"]}},
        }
    else:
        raise ValueError(f"unsupported WaReply kind: {reply.kind}")
    return _deliver_message(phone_number_id, {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "interactive",
        "interactive": interactive,
    })


def _try_speak(phone_number_id: str, to: str, text: str,
               lang: str = "es"):
    """Mirror rule (server/voice.py): speak a plain-text reply to
    a voice-originated turn. Returns the Graph result when the
    voice note went out; None when the reply must stay text —
    excluded content (URL / bank details / > 400 chars) or ANY
    failure in synth/convert/upload/send. Every gate logs a
    [Voice] line; a reply is never lost to a voice failure."""
    try:
        import voice as voice_mod
    except ImportError:
        from server import voice as voice_mod
    ok, why = voice_mod.speakable(text)
    if not ok:
        print(f"[Voice] reply stays text ({why})", flush=True)
        return None
    try:
        media_id = voice_mod.speak(phone_number_id, text, lang=lang)
        return send_whatsapp_audio(phone_number_id, to, media_id)
    except Exception as e:
        print(f"[Voice] speak failed, text fallback: {e}", flush=True)
        return None


def deliver_reply(phone_number_id: str, to: str, reply,
                  voice: bool = False, lang: str = "es"):
    """Deliver one engine reply. A WaReply goes out as its
    interactive message; ANY failure (API error, a client that
    can't render it) falls back to the reply's plain-text
    rendering — a short numbered section list plus the web link,
    never a catalog dump (bot-menu-fix, 2026-10-26). Plain strings
    send as text, exactly as before.

    voice=True marks a voice-originated turn (the customer sent a
    voice note): a PLAIN string reply may then be spoken instead
    (mirror rule — _try_speak). Interactive replies are never
    spoken; typed turns (voice=False, the default) never are."""
    if isinstance(reply, WaReply):
        try:
            return send_whatsapp_interactive(phone_number_id, to, reply)
        except Exception as e:
            print(f"[webhook] interactive send failed, text "
                  f"fallback: {e}", flush=True)
            return send_whatsapp_text(phone_number_id, to,
                                      reply.fallback_text())
    if voice:
        spoken = _try_speak(phone_number_id, to, reply, lang=lang)
        if spoken is not None:
            return spoken
    return send_whatsapp_text(phone_number_id, to, reply)


def handle_intro_message(from_number: str, text: str, phone_number_id: str,
                         voice_turn: bool = False):
    """
    Honduras flow (rich-aroma-honduras — the only tenant this bot
    serves): get-to-know-you signup -> account created in the OS ->
    preventa offer -> lounge, where the shop engine
    (server/shop_engine.py) serves the real OS menu (as an
    interactive section list, never a text dump) and takes café
    orders. See server/intro_engine.py.

    voice_turn: this turn arrived as a voice note (its text is a
    transcript). The turn is marked on the conversation and the
    mirror rule applies at delivery — a plain-text reply may be
    spoken back (server/voice.py).
    """
    try:
        from intro_engine import get_intro_conversation, reply_for_intro
        import menu_client
    except ImportError:
        from server.intro_engine import get_intro_conversation, reply_for_intro
        from server import menu_client

    # Best-effort menu refresh (TTL-gated, last-good cache on
    # failure) so the shop engine prices from the live OS catalog.
    menu_client.maybe_refresh()
    convo = get_intro_conversation(from_number)
    convo.last_turn_voice = bool(voice_turn)
    reply = reply_for_intro(convo, text)
    return deliver_reply(phone_number_id, from_number, reply,
                         voice=bool(convo.last_turn_voice),
                         lang=(getattr(convo, "lang", None) or "es"))


def handle_order_message(from_number: str, text: str, phone_number_id: str,
                         voice_turn: bool = False):
    """
    Incoming customer message entry point. This bot serves exactly
    one number — the Quimistán shop's — so every route lands in the
    Honduras flow. (The Cali order engine that used to sit behind
    the other branch was removed in the bot-finalize build.)
    """
    # OWNER'S DOOR (2026-10-29): a sender on the OWNER_WHATSAPP list
    # gets the live-shop interface for data questions (server/
    # owner_door.py, read-only). Anything the door doesn't claim
    # falls through to the customer pipeline untouched — the owner
    # can still order and test like a customer. A door error also
    # falls through: the customer flow is the safe default.
    try:
        try:
            from owner_door import is_owner, reply_for_owner
        except ImportError:
            from server.owner_door import is_owner, reply_for_owner
        if is_owner(from_number):
            owner_reply = reply_for_owner(from_number, text)
            if owner_reply is not None:
                text_out, lang = owner_reply
                return deliver_reply(phone_number_id, from_number,
                                     text_out, voice=bool(voice_turn),
                                     lang=lang)
    except Exception as e:
        print(f"[OwnerDoor] error, falling through to customer "
              f"flow: {e}", flush=True)
    return handle_intro_message(from_number, text, phone_number_id,
                                voice_turn=voice_turn)


def handle_audio_message(from_number: str, media_id: str,
                         phone_number_id: str):
    """
    Incoming voice note: download + transcribe (server/voice.py),
    then the transcript enters the existing pipeline EXACTLY as if
    typed, marked voice-originated so the reply can be spoken back
    (mirror rule). Any failure — download, Gemini, empty/garbled
    transcript — earns ONE retry line as text and no other action:
    an order is never invented from unclear audio.
    """
    try:
        import voice as voice_mod
    except ImportError:
        from server import voice as voice_mod
    transcript = voice_mod.transcribe_media(media_id)
    if not transcript:
        print(f"[Voice] no usable transcript for media {media_id} "
              f"from {from_number} — asking for a repeat", flush=True)
        return send_whatsapp_text(phone_number_id, from_number,
                                  voice_mod.RETRY_TEXT)
    return handle_order_message(from_number, transcript,
                                phone_number_id, voice_turn=True)


def push_to_kds(order: dict):
    """
    Push a confirmed order to the Rich Aroma OS KDS.

    Delegates to server/kds_push.py, configured via env vars:
      KDS_API_URL — OS orders endpoint (e.g. https://rich-aroma-os.vercel.app/api/orders)
      KDS_API_KEY — bearer token, only if the OS requires auth
    No-op until KDS_API_URL is set. Orders are safely persisted by
    save_order() beforehand, so a failed or skipped push loses nothing.
    """
    try:
        from kds_push import push_order
    except ImportError:
        from server.kds_push import push_order
    result = push_order(order)
    if not result["ok"]:
        print(f"[push_to_kds] skipped/failed: {result['error']}", flush=True)
    return result


@app.get("/webhook")
def verify():
    mode = request.args.get("hub.mode")
    token = request.args.get("hub.verify_token")
    challenge = request.args.get("hub.challenge")
    if mode == "subscribe" and token == VERIFY_TOKEN and challenge:
        return Response(challenge, mimetype="text/plain")
    return Response("verification failed", status=403)


@app.post("/webhook")
def incoming():
    data = request.get_json(force=True, silent=True) or {}
    # Meta nests messages under entry[].changes[].value.messages[]
    try:
        for entry in data.get("entry", []):
            for change in entry.get("changes", []):
                value = change.get("value", {})
                metadata = value.get("metadata", {})
                phone_number_id = metadata.get("phone_number_id")
                for msg in value.get("messages", []):
                    msg_type = msg.get("type")
                    if msg_type == "text":
                        text_body = msg.get("text", {}).get("body", "")
                    elif msg_type == "interactive":
                        # A tap on an interactive list/button row
                        # arrives as its reply id (menu sections:
                        # "sec:<id>") — the engines read it exactly
                        # like typed text.
                        inter = msg.get("interactive", {})
                        rep = (inter.get("list_reply")
                               or inter.get("button_reply") or {})
                        text_body = rep.get("id", "")
                    elif msg_type == "audio":
                        # A voice note (or any audio message): the
                        # media id is the whole payload — download,
                        # transcribe, and the transcript runs the
                        # same pipeline as typed text, marked
                        # voice-originated (mirror rule, voice.py).
                        media_id = (msg.get("audio") or {}).get("id", "")
                        from_number = msg.get("from")
                        if from_number and phone_number_id and media_id:
                            handle_audio_message(from_number, media_id,
                                                 phone_number_id)
                        continue
                    else:
                        continue
                    from_number = msg.get("from")
                    if from_number and phone_number_id and text_body:
                        handle_order_message(from_number, text_body, phone_number_id)
    except Exception as e:
        # Log but ack to avoid Meta retries storm; inspect logs
        print(f"webhook error: {e}", flush=True)
    return Response("EVENT_RECEIVED", mimetype="text/plain")


@app.post("/order-notify")
def order_notify():
    """
    OS -> bot order-status notifications (ready / cancelled).

    Called by the store.js hook when a WhatsApp-originated order
    transitions; authenticated with the shared
    WHATSAPP_SIGNUP_SECRET (Bearer, constant-time, fail-closed —
    see server/notify.py). The bot formats and sends the customer's
    WhatsApp message via its normal Meta send path, once per
    (order, status).
    """
    try:
        import notify
    except ImportError:
        from server import notify

    payload = request.get_json(force=True, silent=True) or {}

    def _send(to: str, text: str):
        return send_whatsapp_text(SHOP_PHONE_NUMBER_ID, to, text)

    code, body = notify.process(
        payload, request.headers.get("Authorization", ""), _send)
    return Response(json.dumps(body), status=code,
                    mimetype="application/json")


@app.post("/account-link")
def account_link():
    """
    OS -> bot account access link delivery (Mi Rich Aroma).

    api/account.js mints a single-use login token (15 minutes,
    hash-only storage) and POSTs {phone, url} here, authenticated
    with the shared WHATSAPP_SIGNUP_SECRET (Bearer, constant-time,
    fail-closed — see server/account_link.py). The bot texts the
    link to the number on file; that delivery is the proof of
    possession — the phone number IS the account, no passwords.
    """
    try:
        import account_link as account_link_mod
    except ImportError:
        from server import account_link as account_link_mod

    payload = request.get_json(force=True, silent=True) or {}

    def _send(to: str, text: str):
        return send_whatsapp_text(SHOP_PHONE_NUMBER_ID, to, text)

    code, body = account_link_mod.process(
        payload, request.headers.get("Authorization", ""), _send)
    return Response(json.dumps(body), status=code,
                    mimetype="application/json")


@app.get("/health")
def health():
    return {"ok": True, "vault": HAS_VAULT}


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port)
