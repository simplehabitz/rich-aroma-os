# WhatsApp AI Front Desk

Sellable AI front desk for businesses. Starting with WhatsApp, designed to expand to text, call, Instagram, and TikTok.

## First client: Rich Aroma Coffee Shop
- WhatsApp Business Account ID: 1753012639334167 (non-secret identifier)
- Phone Number ID: 1354660681066143 (non-secret identifier)
- Phone: +504 9905-4412

## Architecture (v1)
- `server/webhook.py` — Flask webhook for Meta WhatsApp Business Platform
  - GET /webhook — verification (hub.mode, hub.verify_token, hub.challenge)
  - POST /webhook — receives incoming messages, routes to AI order logic
- `rich-aroma/` — per-business config and menu
- Credential stored in Secure Vault as `custom.whatsapp-business` (never in files)

## Status
- [ ] Credential stored in vault
- [ ] Webhook deployed with public URL
- [ ] Menu + order flow defined
- [ ] AI order logic implemented
- [ ] End-to-end test

## Multi-business plan (sellable)
Each business gets:
- `businesses/<slug>/config.yaml` — IDs, phone, hours, policies (no secrets)
- `businesses/<slug>/MENU.md` — menu + prices
- Shared webhook routes by Phone Number ID → business config
- Shared AI order flow with per-business customization
