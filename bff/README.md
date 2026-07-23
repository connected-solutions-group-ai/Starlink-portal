# CSG Sales Portal — NetSuite BFF

A small **Backend-for-Frontend** that connects the single-file portal (`../index.html`) to
**NetSuite** using **REST Web Services + SuiteQL** over **OAuth 2.0 machine-to-machine
(client credentials)**. The browser posts an order; this server holds the credentials, gets a
token, and writes to NetSuite. **No NetSuite secret ever reaches the browser.**

```
Browser (index.html)  ──POST /api/orders──►  BFF (this)  ──OAuth2 M2M──►  NetSuite REST/SuiteQL
   csg.order.v1 JSON                          maps payload                 Sales Order record
```

---

## 1. Prerequisites in NetSuite (one-time, done by an admin)

1. **Enable features** — Setup ▸ Company ▸ Enable Features ▸ SuiteCloud:
   *REST Web Services*, *SuiteQL* (under SuiteAnalytics), and *OAuth 2.0*.
2. **Create an Integration record** — Setup ▸ Integration ▸ Manage Integrations ▸ New.
   Enable **OAuth 2.0**, check **Client Credentials (machine to machine) grant**, and the
   **REST Web Services** scope. Save the **Client ID / Consumer Key**.
3. **Generate a key pair** (do this locally, keep the private key secret):
   ```bash
   openssl genrsa -out secrets/private_key.pem 2048
   openssl req -new -x509 -key secrets/private_key.pem -out secrets/public_cert.pem -days 730 -subj "/CN=csg-bff"
   ```
   For `PS256`/`RS256` a 2048-bit RSA key is fine. For `ES256` generate an EC key instead.
4. **Map the certificate** — Setup ▸ Integration ▸ **OAuth 2.0 Client Credentials (M2M) Setup**.
   Pick the integration + an **entity (employee)** + a **role** that can create Sales Orders and
   run SuiteQL, upload `public_cert.pem`, and copy the **Certificate ID** it returns (this is the
   JWT `kid`).
5. Give that role permissions: **Transactions ▸ Sales Order (Create)**, **SuiteAnalytics
   Workbook / SuiteQL**, and **Lists ▸ Items (View)**.

## 2. Configure

```bash
cp .env.example .env
# fill in NS_ACCOUNT_ID, NS_CLIENT_ID, NS_CERTIFICATE_ID, NS_PRIVATE_KEY_PATH
mkdir -p secrets   # put private_key.pem here; add secrets/ and .env to .gitignore
```

## 3. Run

```bash
npm install
npm start
# → http://localhost:8787/index.html   (portal served from the same origin)
# → http://localhost:8787/health
```

`DRY_RUN=true` (the default) maps every order and returns the **exact NetSuite body without
writing**. Confirm it in NetSuite's REST API browser, then set `DRY_RUN=false` to go live.

---

## 4. Endpoints

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET`  | `/health` | Liveness + which env vars are missing (no secrets returned) |
| `GET`  | `/api/items?sku=CSG-STA` | SuiteQL item + base price lookup |
| `GET`  | `/api/orders` | Recent Sales Orders via SuiteQL |
| `POST` | `/api/orders` | Map a `csg.order.v1` payload → Sales Order (guarded by `DRY_RUN`) |
| `POST` | `/api/field-services/bookings` | Create a Bolt Squad dispatch booking (+ `.ics`) |
| `POST` | `/api/field-services/ics` | Return a downloadable `.ics` for a booking payload |
| `POST` | `/api/docusign/envelopes` | Send a SOW / agreement for signature (template or generated) |
| `GET`  | `/api/docusign/envelopes/:id` | Envelope status |
| `POST` | `/api/site-photos/request` | Email the customer a site-photo upload link |
| `POST` | `/api/site-photos/:token` | Receive a site-photo submission callback |
| `GET`  | `/api/weather?address=&date=` | Install-day forecast + roof-work risk (Open-Meteo, keyless) |
| `POST` | `/api/reminders/schedule` | Register the automated reminder schedule for an order |
| `POST` | `/api/installs/:id/complete` | Post-install speed test + proof; close the job |

The portal's **Review ▸ Submit** posts to `/api/orders` (endpoint is configurable in the portal;
default `/api/orders`). Example:

```bash
curl -s localhost:8787/api/orders -H 'content-type: application/json' \
  -d '{"schema":"csg.order.v1","orderId":"CSG-TEST","pricingBasis":"MSRP_DIRECT",
       "submittedBy":{"name":"Joe","role":"agent"},
       "account":{"company":"Acme"},
       "lineItems":[{"description":"Starlink Mini Kit","netsuiteSku":"1220137311-1006","type":"one_time","quantity":1,"unitPrice":249}],
       "totals":{"oneTime":249,"monthlyRecurring":0}}' | jq
```

---

## 5. Order mapping (`lib/mapOrder.js`)

- Each portal line carries `netsuiteSku` (the NetSuite **itemid**). We resolve it to an internal
  id via SuiteQL (`SELECT id FROM item WHERE itemid = ...`) and build the Sales Order `item.items[]`.
- `externalId` is set to the portal `orderId` so submissions are **idempotent** and reconcilable.
- **One-time vs recurring:** recurring (MRR) lines are tagged `[MRR]`. Route them to **SuiteBilling**
  (subscription lines / billing schedules) per your setup — replace the `custbody_csg_pricing_basis`
  and description tags with your real custom fields/columns.
- **Customer:** currently attaches `NS_DEFAULT_CUSTOMER_ID`. Replace with a real
  *find-or-create customer* from `payload.account` (company, contact, email, address).

## 6. SuiteQL examples

```sql
-- Item + price by SKU
SELECT id, itemid, displayname, itemtype, baseprice FROM item WHERE itemid = '1220137311-1006';

-- Recent sales orders
SELECT id, tranid, entity, trandate, status, foreigntotal
FROM transaction WHERE type = 'SalesOrd' ORDER BY trandate DESC FETCH FIRST 25 ROWS ONLY;

-- Find-or-create customer support: look up by name/email
SELECT id, entityid, companyname, email FROM customer WHERE email = 'buyer@acme.com';
```

Call SuiteQL with header `Prefer: transient` (the client does this for you).

---

## 7. Microsoft 365 SSO (internal tool sign-in)

The portal's login screen has a **Sign in with Microsoft 365** button. For production, wire it to
**Azure AD (Entra ID) + MSAL** and have this BFF validate the token:

1. Register an app in **Entra ID** (SPA platform); note the **tenant id** + **client id**.
2. In the portal, add **MSAL.js**, call `loginPopup({ scopes: ['User.Read'] })`, and send the
   resulting **ID token** to the BFF as `Authorization: Bearer <id_token>`.
3. In the BFF, add middleware that validates the JWT against
   `https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys` (audience = your client id,
   issuer = your tenant), then maps the user's Entra group/role → portal role (admin/supervisor/agent).

This is intentionally kept separate from the **NetSuite** M2M auth above: M365 authenticates the
**person**; NetSuite M2M authenticates the **service**. A stub middleware location is marked in
`server.js` comments; drop your validator there and gate `/api/*`.

## 8. DocuSign (SOW & agreements)

Uses **JWT Grant** so the server can send envelopes without a user clicking — matching the
portal's "Send for signature" button and the board's Schedule/SOW modal.

1. **Create an integration** in DocuSign Admin ▸ Apps and Keys ▸ *Add App / Integration Key*.
   Add an **RSA keypair** (store the private key at `DS_PRIVATE_KEY_PATH`).
2. Grant **one-time consent** (JWT impersonation) by opening once in a browser:
   `https://account-d.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=<DS_INTEGRATION_KEY>&redirect_uri=<your_redirect>`
   (use `account.docusign.com` in production). Until you do, the token call returns
   `consent_required` — the BFF surfaces that verbatim.
3. Fill `DS_INTEGRATION_KEY`, `DS_USER_ID` (the API user to impersonate), `DS_ACCOUNT_ID`,
   and `DS_TEMPLATE_SOW / _BIGLEAF / _MSA` (from DocuSign ▸ Templates).
4. **Two modes** (portal exposes both):
   - `mode:"template"` → composite templates from your `DS_TEMPLATE_*` ids with the signer prefilled.
   - `mode:"generate"` → the portal/BFF builds the SOW PDF from the order and sends it with an
     anchor-string sign tab (`/sig/`). Plug your PDF generator into `lib/docusign.js` (`pdfBase64`).

## 9. Field service dispatch (Bolt Squad)

`lib/fieldservice.js` creates a booking, POSTs it to `FS_WEBHOOK_URL` (Zapier/Make, an internal
endpoint, or a Teams/Slack Incoming Webhook), and returns an `.ics` for calendars. It's vendor-neutral
by design — to move to **ServiceTitan / Salesforce FSL / Housecall Pro**, replace `postToDispatch()`
with that FSM's job/appointment create call; the routes and portal don't change.

## 10. Google Maps (site view)

The portal shows a **satellite view of the site address** in the Install step and the board's
Schedule modal. It uses a **keyless** `maps.google.com/...&t=k&output=embed` iframe out of the box
(fine for a prototype). For production/ToS, set `GMAPS_KEY` at the top of `index.html`'s script to use
the official **Maps Embed API** (`maptype=satellite`). Address → map is live from the Step 1 site address.

## 11. Security notes

- Keep `.env`, `secrets/`, and any `*.pem` out of git.
- Run behind HTTPS in production; set `ALLOW_ORIGIN` to the portal's real origin (never `*`).
- Rotate the certificate before `-days` expires; NetSuite lets you map more than one.
- Log the `externalId`/`orderId` on every write for reconciliation; rely on it to avoid duplicates.
