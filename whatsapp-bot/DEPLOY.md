# Deploying the WhatsApp webhook — checklist

The order engine is tested and the menu is wired. These are the steps to put
the webhook on a public URL and run a live test order.

Deploy direction (approved 2026-10-17): the bot lives in `whatsapp-bot/`
inside the Rich Aroma OS repo (monorepo), deployed as a **separate Render
Docker web service** with Root Directory = `whatsapp-bot`. It does NOT go
inside the Vercel deploy (Python vs Node, and conversation state is
in-memory).

## 1. Merge the bot folder into the OS repo
"Merge" just means: copy the folder in. Nothing in the OS repo gets
overwritten — `whatsapp-bot/` is a brand-new folder next to everything else.

```bash
git clone https://github.com/simplehabitz/rich-aroma-os.git
cd rich-aroma-os
cp -r ~/workspace/whatsapp-front-desk whatsapp-bot
git add whatsapp-bot
git commit -m "Add WhatsApp order-taker bot (whatsapp-bot/)"
git push
```

What lands in `whatsapp-bot/`: `server/` (webhook, order engine, KDS push),
`Dockerfile`, `render.yaml`, `rich-aroma/` (menu + config),
`rich-aroma-honduras/` (placeholder config), `orders/`, plus the docs.

## 2. Deploy on Render (free tier is fine for v1)
1. Render dashboard → **New → Web Service** → select the `rich-aroma-os`
   repo.
2. Set **Root Directory** to `whatsapp-bot` and **Environment** to Docker.
   Render builds `whatsapp-bot/Dockerfile` and runs its health check on
   `/health`.
3. Set these env vars in the Render dashboard:
   - `WHATSAPP_VERIFY_TOKEN` — make up a random string, e.g.
     `openssl rand -hex 16`. You'll need the same string in step 3.
   - `WHATSAPP_API_TOKEN` — generate a **fresh** token in the Meta Developers
     dashboard (this also retires the copy that was pasted in chat earlier).
   - `KDS_API_URL` — `https://rich-aroma-os.vercel.app/api/orders-v2`
     (the OS orders endpoint).
   - `KDS_RESTAURANT_ID` — `rich-aroma` (the default the bottled KDS
     watches; confirmed correct 2026-10-17).
   - `KDS_API_KEY` — not needed; the OS orders API is public, and orders are
     persisted locally first, so nothing is lost while the OS backend is down.
4. Wait for the deploy to go green (health check hits `/health`).

Note: `whatsapp-bot/render.yaml` is kept as a reference for a standalone
Blueprint deploy; with the monorepo you deploy via the dashboard as above,
not via Blueprint.

## 3. Register the webhook with Meta
1. Meta Developers dashboard → your app → WhatsApp → **Configuration**.
2. Callback URL: `https://<your-render-service>.onrender.com/webhook`
3. Verify token: the exact string from step 2.
4. Click **Verify and save**, then under Webhook fields subscribe to
   **messages**.

## 4. Live test
1. From your phone, send a WhatsApp message to **+504 9905-4412**,
   e.g. `2 caramel lattes oat`.
2. Walk through the confirm step; after confirmation the bot asks for the
   Kaiser Baldwin Park department break room.
3. Check Render logs for `200 EVENT_RECEIVED`, and the persisted order at
   `orders/rich-aroma.jsonl` (via Render shell or logs).

## Notes
- On Render's free tier the local disk is ephemeral: `orders/*.jsonl` works for
  testing, but move to a database or disk before real volume.
- The Honduras shop (`rich-aroma-honduras/`) gets its own config + deploy
  later — same pattern, separate service or a routing layer.
- Still owed by the owner before full go-live: real hours + prep time
  (see `owner-message.md`), and the bundle-size call (5-packs vs 3-packs).
- The OS backend (Supabase) must be restored before the KDS push has anywhere
  to land — that step comes first.
