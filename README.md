# CSG Starlink Sales Portal

Internal ordering, quoting, and install-fulfillment portal for **Connected Solutions Group** —
Starlink, Bigleaf SD-WAN, SureConnect FWA, managed services, and Bolt Squad professional install.

The portal is a **single self-contained `index.html`** (no build step). The `bff/` folder is a
Node/Express **Backend-for-Frontend** that connects it to NetSuite, DocuSign, field-service
dispatch, weather, and reminders. The browser never holds any third-party secret.

---

## What's inside

| | |
| --- | --- |
| `index.html` | The whole portal — open it in a browser, or serve it from the BFF. |
| `bff/` | Node/Express BFF (NetSuite + DocuSign + field service + weather + reminders). See `bff/README.md`. |

## Portal features

- **Login + roles** — Admin / Supervisor / Agent, with a Microsoft 365 SSO button (wired for the BFF). Margin, approvals, and status changes are role-gated.
- **Dashboard** — KPI tiles (open quotes, expiring ≤3 days, accepted, win rate, pipeline MRR, in-fulfillment), quotes-by-status, expiring watchlist, and pipeline.
- **New Order** — Starlink + optional Bigleaf / SureConnect / managed / warranty + full Bolt Squad install catalog, with CSG + NetSuite SKUs, MSRP/MRC, dealer cost & margin view, and one-time vs recurring totals.
- **Payment terms** — Credit Card, ACH, Bill My Account (approved customers only), and BOBO (CSG or Verizon bill).
- **Quotes** — full lifecycle (Draft → Sent → Viewed → Accepted / Declined / Expired) with **15-day validity**, countdown, a branded customer-facing quote, and accept → converts to a fulfillment order.
- **Install scheduling & site survey** — satellite map with exact mount pin, Starlink placement guidance, readiness meter, auto truck-kit manifest, Bolt Squad booking (+ .ics), DocuSign (templates or generated), install-day **weather** with roof-risk flag, and automated **reminders**.
- **Site photos** — a shareable link customers open on their phone to submit install-location photos (incl. Starlink obstruction screenshot).
- **Order board** — Monday.com-style pipeline with drag/advance, status/overdue pills, tech **ETA**, reschedule, and post-install **completion proof** (speed test + as-built + certificate).
- **Tech / Customer views** — per-order preview toggling the technician's job card and the customer's live status tracker.
- **Theming** — dark by default (CSG black/red/white) with a light mode; Inter type; glassy header.

## Configuration (swap-in slots in `index.html`)

- `LOGO_SRC` / `LOGO_SRC_LOGIN` — paste the real CSG logo (data URI or URL) near the top of the `<script>`.
- `GMAPS_KEY` — optional Google Maps Embed API key (defaults to a keyless satellite embed).
- The portal posts orders to the BFF at `/api/orders` (configurable in the Review screen).

## Run

**Portal only:** open `index.html` in a browser (Chrome/Safari/Edge). Everything works client-side and persists to that browser via `localStorage`.

**With the BFF (recommended):**
```bash
cd bff
cp .env.example .env      # fill in NetSuite / DocuSign creds
npm install
npm start                 # → http://localhost:8787/index.html
```
See **`bff/README.md`** for the full NetSuite (OAuth 2.0 M2M), DocuSign (JWT), field-service, weather, and reminders setup.

## Notes

- Demo data is seeded so the app is usable immediately; it persists per-browser via `localStorage`.
- No secrets belong in this repo — `.env`, `secrets/`, and `*.pem` are git-ignored.
