# Rich Aroma OS — Page Map (canonical)

**One front door: `/os`** — enter your staff PIN and you get only the tools for your role.
Everything below is launched from there. If a page is not on this list, it is not part of daily operations.

## The front door

| URL | What it is | Who uses it |
|---|---|---|
| `/os` | **OS Hub / Control Center** — PIN login, role-based launcher | Everyone on staff |

## Control (owner / admin — reached from /os)

| URL | What it is |
|---|---|
| `/owner` | Owner dashboard — sales by tender, top products, expenses, weekly profit, closeouts |
| `/admin` | Back office — employees & PINs, menu & modifiers, inventory & recipes, marketing, QuimiEats leads |
| `/partner-os` | Business settings — bank details, shop hours, payment methods (the same settings the storefront, POS and QuimiEats read) |
| `/quimieats-admin` | QuimiEats platform console — all partner businesses, commissions, marketplace |
| `/members` | Member directory (Rico Cash customers) |
| `/staff` | Staff lookup utility |

## Operation (working screens — launched from /os, kept full-screen on purpose)

| URL | What it is |
|---|---|
| `/pos-v2` | Quimistán cashier register (POS) |
| `/kitchen` | Kitchen display (KDS) — orders: new → preparing → ready |
| `/alerts` | Live order-alert sound screen |
| `/driver-portal` | Delivery driver portal |
| `/timeclock` | Staff clock-in / clock-out |
| `/cali/admin` | Cali bottles — orders, payment verification, production, delivery routes |
| `/cali/pos` | Cali pop-up mobile POS |

## Customer-facing (public)

| URL | What it is |
|---|---|
| `/` (richaromacoffee.com) | Cali bottled-coffee storefront |
| `/order` | Quimistán café — menu, member account, Rico Cash wallet, reservations, tracking |
| `/cali` | Cali bottle storefront |
| `/cali/pay` | Cali order & payment page |
| `/kaiser` | Kaiser route landing (Cali) |
| `/dashboard` | Customer account — wallet, stamps, membership |
| `/profile` | Customer profile page (linked from the account page) |
| `/membership` | VIP membership page |
| `/privacy` | Privacy policy (also served to Meta from the WhatsApp bot) |
| `quimieats.com` (`/quimieats.html`) | QuimiEats marketplace — Rich Aroma is one listing |
| `/claim` | QuimiEats gift-claim page |
| `/socios` | "Sell on QuimiEats" partner recruiting |
| `/onboarding` | New QuimiEats business setup |
| `/driver-signup` | QuimiEats driver registration |
| `/terraza` + `/terraza-admin` + `/terraza-scanner` + `/torneo` | Terraza Deportiva — field rentals, reservations admin, check-in scanner, tournament page |
| `/team` | Public team page |

## Parked pages

Everything else that used to live in `public/` (games, prototypes, duplicate dashboards,
older POS/KDS variants, one-off tools — 61 files) was moved to `parked-pages/` by the
pages-park patch. Parked = not on the website, code untouched, restorable in minutes:

```
git mv parked-pages/<file>.html public/<file>.html   # restore one page
```

To restore a page fully, also re-add any route for it that the park patch removed from
`vercel.json` (check `git log -p -- vercel.json`).

## Vendor consoles (not part of this app — secrets live here, never in a page)

- **Supabase** — the database (tables, SQL, storage)
- **Vercel** — hosting, deployments, environment variables (master PINs, tokens)
- **Render** — the WhatsApp bot service
- **Meta** — the WhatsApp number, app and webhook

_Last updated: 2026-10-22 — control-center consolidation._
