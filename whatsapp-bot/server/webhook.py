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
"""
import os
import sys
import json
import urllib.request

from flask import Flask, request, Response

# For Vault-backed API calls (see custom_connector_setup skill)
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
try:
    from dynamic_credentials import add_surrogate_to_request, read_json_response
    HAS_VAULT = True
except ImportError:
    HAS_VAULT = False

app = Flask(__name__)

VERIFY_TOKEN = os.environ.get("WHATSAPP_VERIFY_TOKEN", "change-me")
GRAPH_HOST = "graph.facebook.com"
GRAPH_VERSION = "v21.0"

# One WhatsApp number -> one business. Add a line per number as businesses onboard.
# default_lang: language used when the customer's language can't be detected
# (per-message detection still lets any customer use either language).
ROUTES = {
    "1354660681066143": {"slug": "rich-aroma-honduras", "default_lang": "es"},  # Rich Aroma coffee shop, Quimistán — +504 9905-4412 (line belongs to the shop; decided 2026-10-20)
    # Cali bottled coffee gets its own US number later — its test on this line was never finished.
}


def send_whatsapp_text(phone_number_id: str, to: str, text: str):
    """Send a WhatsApp text message via Graph API.

    Token resolution order:
      1. Secure Vault surrogate (custom.whatsapp-business) when available —
         this is the path used inside this workspace.
      2. WHATSAPP_API_TOKEN env var — used on the deployed host, where the
         owner sets it in the host's dashboard (never committed to the repo).
    """
    url = f"https://{GRAPH_HOST}/{GRAPH_VERSION}/{phone_number_id}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "text",
        "text": {"body": text},
    }
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
        if HAS_VAULT:
            return read_json_response(resp)
        return json.loads(resp.read().decode("utf-8"))


def handle_order_message(from_number: str, text: str, phone_number_id: str):
    """
    AI order logic for Rich Aroma via order_engine state machine.
    Steps: greet -> collect items -> confirm -> create order -> notify staff.
    """
    try:
        from order_engine import get_conversation, reply_for, reset_conversation, build_order
        from orders import save_order
    except ImportError:
        # Fallback if run as module
        from server.order_engine import get_conversation, reply_for, reset_conversation, build_order
        from server.orders import save_order

    convo = get_conversation(
        from_number,
        ROUTES.get(phone_number_id, {"slug": "rich-aroma-honduras", "default_lang": "es"})["slug"],
        ROUTES.get(phone_number_id, {"slug": "rich-aroma-honduras", "default_lang": "es"})["default_lang"],
    )
    # Hybrid LLM parser (server/hybrid_parse.py + GEMINI_API_KEY env var):
    # Gemini understands the message, the deterministic engine still validates
    # and prices everything. Any failure -> None -> the rule engine below
    # handles it, so this can never make the bot worse, only smarter.
    reply = None
    try:
        from hybrid_parse import try_hybrid_reply
    except ImportError:
        from server.hybrid_parse import try_hybrid_reply
    try:
        reply = try_hybrid_reply(convo, text)
    except Exception as e:  # never let the parser break the webhook
        print(f"[hybrid] fallback to rules: {e}", flush=True)
    if reply is None:
        reply = reply_for(convo, text)
    # Order just confirmed: persist, then fan out to staff/KDS before reset.
    if convo.state == "DONE":
        order = build_order(convo)
        save_order(convo.business_slug, order)
        push_to_kds(order)  # no-op until Rich Aroma OS integration is configured
        reset_conversation(convo)
    return send_whatsapp_text(phone_number_id, from_number, reply)


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
                    if msg.get("type") != "text":
                        continue
                    from_number = msg.get("from")
                    text_body = msg.get("text", {}).get("body", "")
                    if from_number and phone_number_id and text_body:
                        handle_order_message(from_number, text_body, phone_number_id)
    except Exception as e:
        # Log but ack to avoid Meta retries storm; inspect logs
        print(f"webhook error: {e}", flush=True)
    return Response("EVENT_RECEIVED", mimetype="text/plain")



@app.get("/privacy")
def privacy():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "privacy.html")
    with open(path, encoding="utf-8") as f:
        return Response(f.read(), mimetype="text/html")


@app.get("/health")
def health():
    return {"ok": True, "vault": HAS_VAULT}


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port)
