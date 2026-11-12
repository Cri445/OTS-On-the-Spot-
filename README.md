# OTS — On the Spot

Find something happening near you, party up with friends and get in — or put your own plans on the map and fill the room.

A host who is short on people (a party, a tennis court with a free slot, a table with empty chairs) pins the activity on the map and sets a price to join. Guests browse the map, filter by mood, pay and get a ticket. OTS earns a small listing fee from the host and 5% of every ticket.

## Run it

You need [Node.js](https://nodejs.org) 22.13 or newer.

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. The map starts with sample activities, and the log-in page has a **Log in as Demo** button (`demo@ots.app` / `demo1234`, already ID-verified).

To see both sides of a booking, host an activity in one browser and join it from a private window with a second account. On your own activity's door list, **Add sample guests** makes a few demo guests buy tickets.

| Command | What it does |
| --- | --- |
| `npm run dev` | Web app on :5173 and API on :3001, both reloading on change |
| `npm test` | API test suite (fees, commission, ID rules, refunds, groups …) |
| `npm run typecheck` | Type-check the web app and the server |
| `npm run build` then `npm start` | Production build, served by one process on :3001 |

## What's in it

**For guests**

- A map of activities with price pins coloured by vibe — **calm** (bowling, board games), **lively** (parties, karaoke), **active** (tennis, football).
- Filters that combine: vibe, category, tags, when, price, ID-verified only, and "room for my group of N".
- Join in two taps: pick a payment method, get a ticket with a QR code and a door code.
- **Party up**: start a group, share the invite link, and get in together. Either the whole group gets a spot or nobody is charged. The leader can pay for everyone, or everyone pays their own share while the spots are held for 10 minutes.
- Full refund if you cancel more than 2 hours before the start, or if the host cancels.

**For hosts**

- Post an activity: title, category, vibe, tags, time, a pin on the map (address search or click), number of spots, and price (or free).
- Choose who can join: **Open**, or **ID-verified only** — then every guest has scanned their ID and you see their legal name on the door list.
- Keep a home address private: the map shows the rough area, and guests get the exact address once they've joined.
- Door list with check-in (tap a name, type the ticket code, or scan the ticket's QR with your phone camera) and a CSV download of who was there.
- Wallet: earnings are pending until the activity ends, then can be paid out.

**For the platform**

- `/admin` shows OTS revenue: listing fees plus commission. Visible to the e-mails in `ADMIN_EMAILS`.

## How the money works

| | Default | Setting |
| --- | --- | --- |
| Listing fee, standard pin | $1 | `LISTING_FEE_STANDARD_CENTS` |
| Listing fee, featured (highlighted pin, first in the list) | $2 | `LISTING_FEE_FEATURED_CENTS` |
| OTS cut of each ticket | 5% | `COMMISSION_BPS` |

A guest pays the price the host set. The host receives the price minus 5%; OTS keeps the 5%. Example: a $12.50 ticket pays the host $11.87 and OTS $0.63. Free activities cost guests nothing and earn no commission — the host still pays the listing fee.

Every movement is written to a ledger (`ledger` table), so host balances and platform revenue are always the sum of their entries.

## Demo mode — what is simulated

The app runs in demo mode (`DEMO_MODE=true`, the default). **No real money moves and no identity documents are checked.**

| Area | In demo mode | To go live |
| --- | --- | --- |
| Payments | Two fake cards: one always approves, one always declines | Implement `PaymentProvider` in `server/payments.ts` (e.g. Stripe PaymentIntents with manual capture) |
| Host payouts | Recorded in the ledger only | Transfer funds in `requestPayout` (e.g. Stripe Connect) |
| ID verification | Accepts the name and date of birth typed in; the photo never leaves the browser | Implement `IdentityProvider` in `server/identity.ts` (e.g. Stripe Identity, Onfido, Veriff) |

Before taking real payments you will also want e-mail verification and password reset, terms of service and a privacy policy, and a way for members to report an activity.

## Configuration

Copy `.env.example` to `.env`. Everything is optional; the file lists the defaults. The most useful ones:

- `MAP_CENTER_LAT`, `MAP_CENTER_LNG`, `MAP_ZOOM` — where the map opens (and where sample activities are placed).
- `CURRENCY` — ISO code used for all prices.
- `ADMIN_EMAILS` — who can open `/admin`.
- `TILE_URL` — map tiles. The default is OpenStreetMap's public tile server, which is fine for development but [not meant for heavy production use](https://operations.osmfoundation.org/policies/tiles/); switch to a tile provider before launch.
- `GEOCODER_URL` — address search on the host form (OpenStreetMap Nominatim by default; set it empty to turn search off).

## Deploying

```bash
npm run build
NODE_ENV=production npm start
```

One Node process serves both the API and the built web app on `PORT`. Data lives in a single SQLite file (`DATABASE_PATH`, default `data/ots.db`) — put it on a persistent disk and back it up. Behind a reverse proxy or on a platform like Render or Fly, set `TRUST_PROXY=1` and serve over HTTPS.

## Project layout

```
shared/    Types, categories/vibes/tags and money maths used by both sides
server/    Express API + SQLite (Node's built-in driver)
  activities.ts   listing, filtering, creating, editing
  booking.ts      joining, tickets, refunds
  groups.ts       party up: holds, split payments, all-or-nothing confirmation
  hosting.ts      door list, check-in, wallet, payouts, admin figures
  payments.ts     payment provider interface + demo provider
  identity.ts     ID verification interface + demo provider
  demo.ts         sample activities and guests
  test/           API tests
src/       React web app (Vite)
  pages/          one file per screen
  components/     map, cards, checkout sheet, ID verification
```
