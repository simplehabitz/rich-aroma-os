# AI Front Desk — Client Intake (15 minutes)

Use this for every business you onboard, Rich Aroma first. Fill it in with the
owner however is easiest: a photo of the printed menu, a doc, a voice note, or
plain text answers. Nothing here is secret — secrets (API tokens) go through
the Secure Vault connector, never in this file or in chat.

## 1. Business identity
- Business name:
- Short slug (folder name, e.g. `rich-aroma`):
- Timezone:
- Currency:
- Main customer language (e.g. Spanish):

## 2. WhatsApp connection
- WhatsApp Business Account ID:
- Phone Number ID:
- Display number:
- Vault credential name (e.g. `custom.<slug>-whatsapp`):

## 3. Menu
Send it in any format. For each item I need:
- Name, sizes (if any), and price per size in local currency
- Modifiers/extras with prices (extra shot, oat milk, whipped cream…)
- Anything frequently out of stock, or seasonal items

## 4. Order flow
- [ ] Pickup only / Delivery only / Both
- Delivery zones and fee (if delivery):
- Payment methods (cash on pickup, bank transfer, card on pickup…):
- Opening hours per day:
- Typical prep time per order:

## 5. Staff notifications
When a customer confirms an order, how should staff find out?
- [ ] WhatsApp message to this number:
- [ ] Email to:
- [ ] Something else:

## 6. Tone & FAQs
- Greeting style (warm / quick / formal):
- Top 3–5 questions customers always ask (with answers):

## 7. Go-live checklist
- [ ] Menu + flow filled in above
- [ ] WhatsApp number connected via Vault, number shows VERIFIED
- [ ] Webhook deployed at a public URL (`/webhook`)
- [ ] Webhook URL + verify token set in Meta Developers dashboard
- [ ] Test: send "hola" → place an order → staff receives it
- [ ] Staff knows how to mark orders done / handle cancellations
