# Sellable AI Front Desk — Architecture

## Vision
One AI front desk that businesses can buy: answers customers, takes orders, books, and hands off to staff. Start with WhatsApp (Rich Aroma Coffee Shop), then add SMS/text, voice calls, Instagram DM, TikTok.

## Multi-tenant principles
- One codebase, many businesses. No forks per client.
- Each business is a folder: `businesses/<slug>/`
  - `config.yaml` — name, phone IDs, hours, timezone, currency, order types, policies (no secrets)
  - `MENU.md` or `catalog.json` — items, variants, prices
  - `prompts.md` — tone, greetings, FAQs (optional override)
- Secrets per business in Secure Vault: `custom.<slug>-whatsapp`, etc. Never in files.
- Webhook routes by Phone Number ID → business slug. One webhook serves all.
- Each WhatsApp number carries a default language (US number → English, Honduras number → Spanish); per-message detection still lets any customer use either language, and conversations are isolated per business.

## Components (v1 WhatsApp)
1. **Channel adapters** (`server/adapters/`)
   - `whatsapp.py` — Meta Graph API send/receive, webhook verification
   - Future: `sms.py`, `voice.py`, `instagram.py`, `tiktok.py` — same interface: `send_text(to, body)`, `on_incoming(payload)`
2. **Router** (`server/router.py`)
   - Maps incoming `phone_number_id` → business config
   - Loads business menu + prompts
3. **AI order engine** (`server/order_engine.py`)
   - State machine per conversation: GREET → COLLECT_ITEMS → CONFIRM → PAYMENT → FULFILLMENT → DONE
   - Uses menu to validate items, sizes, extras; asks clarifying questions
   - Produces structured `Order` JSON: items, quantities, modifiers, total, customer name, order type
4. **Order store** (`server/orders/`)
   - v1: JSONL file per business. v2: SQLite/Postgres when selling.
   - Order states: draft, confirmed, sent_to_staff, completed, cancelled
5. **Staff notifications** (`server/notify.py`)
   - v1: WhatsApp message to staff number + email
   - Configurable per business

## Onboarding a new business (sellable flow)
1. Create `businesses/<slug>/` from template
2. Fill menu + hours + policies with owner (15-min intake)
3. Connect their WhatsApp Business number (Meta OAuth / token via Vault)
4. Set webhook URL in Meta dashboard to `https://<host>/webhook`
5. Test: send "hola" → order → staff gets order
6. Go live

## What changes per channel
- WhatsApp: template messages for proactive outreach; free-form for replies (24h window)
- SMS: shorter messages, no rich media
- Voice: speech-to-text → same order engine → text-to-speech
- Instagram/TikTok DM: same engine, adapter handles platform payloads

## KDS (Rich Aroma OS)

- The user runs their own "Rich Aroma OS" and wants confirmed WhatsApp orders to appear on its KDS (kitchen display).
- Every confirmed order is persisted as structured JSON via `server/orders.py` (`orders/<slug>.jsonl`) and passed to `push_to_kds(order)` in `server/webhook.py`.
- `push_to_kds` delegates to `server/kds_push.py`: maps the order dict to a ticket payload and POSTs it to `KDS_API_URL` (bearer token via `KDS_API_KEY`), with 3 retries and `KDS_DRY_RUN=1` for testing. No-op until `KDS_API_URL` is set; a failed push never loses an order (it's persisted first).
- Pending from the user: does Rich Aroma OS expose an HTTP API for incoming orders (the public `/api/orders` errors on GET — may expect POST+auth)? What auth and what ticket fields does the KDS expect?
- Public OS at rich-aroma-os.vercel.app (Supabase backend, admin dashboard with Recent Orders). Fallback if no API: Poll — the OS/KDS polls `orders/<slug>.jsonl` or a small `/orders?status=new` endpoint on the webhook server. Best when the OS runs on a local network the webhook can't reach.

## Non-goals for v1
- No payment processing inside chat (confirm payment method, pay on pickup/transfer)
- No complex POS integration (export orders as structured data first)

## Next steps
- [ ] Finalize Rich Aroma menu → implement order engine
- [ ] Deploy webhook with public URL
- [ ] End-to-end test with real WhatsApp number
- [ ] Package onboarding template for 2nd business
