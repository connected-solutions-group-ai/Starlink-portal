'use strict';
/**
 * CSG Sales Portal — Backend-for-Frontend (BFF)
 *
 * The browser posts a `csg.order.v1` payload here; this server holds the NetSuite
 * credentials, gets an OAuth 2.0 M2M token, and writes to NetSuite via REST + SuiteQL.
 * Secrets never reach the browser.
 *
 *   GET  /health              liveness + config sanity (no secrets)
 *   GET  /api/items?sku=...   SuiteQL item/price lookup (demo of read path)
 *   GET  /api/orders          recent sales orders via SuiteQL (demo of read path)
 *   POST /api/orders          map a portal order -> NetSuite Sales Order (DRY_RUN-guarded)
 *
 * Also serves the portal's index.html from the parent folder so the whole thing runs
 * from one origin (no CORS headaches) during development.
 */
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const ns = require('./lib/netsuite');
const { mapOrderToSalesOrder } = require('./lib/mapOrder');
const docusign = require('./lib/docusign');
const fieldservice = require('./lib/fieldservice');
const weather = require('./lib/weather');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: process.env.ALLOW_ORIGIN || '*' }));

// Serve the single-file portal (index.html lives one directory up from /bff).
app.use(express.static(path.join(__dirname, '..')));

const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, code, msg, extra) => res.status(code).json({ ok: false, error: msg, ...extra });

app.get('/health', (req, res) => {
  const missing = ['NS_ACCOUNT_ID', 'NS_CLIENT_ID', 'NS_CERTIFICATE_ID']
    .filter((k) => !process.env[k]);
  res.json({
    ok: missing.length === 0,
    service: 'csg-sales-portal-bff',
    dryRun: ns.DRY_RUN,
    netsuiteHost: ns.HOST,
    missingEnv: missing,
    time: new Date().toISOString(),
  });
});

// --- READ: item + price lookup (SuiteQL) ---------------------------------
app.get('/api/items', async (req, res) => {
  try {
    const sku = (req.query.sku || '').toString().replace(/'/g, "''");
    const where = sku ? `WHERE itemid LIKE '%${sku}%'` : '';
    const rows = await ns.suiteql(
      `SELECT id, itemid, displayname, itemtype, baseprice FROM item ${where} FETCH FIRST 25 ROWS ONLY`
    );
    ok(res, { count: rows.length, items: rows });
  } catch (e) {
    fail(res, e.status || 500, e.message, { body: e.body });
  }
});

// --- READ: recent orders (SuiteQL) ---------------------------------------
app.get('/api/orders', async (req, res) => {
  try {
    const rows = await ns.suiteql(
      `SELECT id, tranid, entity, trandate, status, foreigntotal
         FROM transaction
        WHERE type = 'SalesOrd'
        ORDER BY trandate DESC
        FETCH FIRST 25 ROWS ONLY`
    );
    ok(res, { count: rows.length, orders: rows });
  } catch (e) {
    fail(res, e.status || 500, e.message, { body: e.body });
  }
});

// --- WRITE: create a Sales Order from a portal payload -------------------
app.post('/api/orders', async (req, res) => {
  const payload = req.body;
  if (!payload || payload.schema !== 'csg.order.v1') {
    return fail(res, 400, 'Expected a csg.order.v1 payload');
  }
  if (!payload.lineItems || !payload.lineItems.length) {
    return fail(res, 400, 'Order has no line items');
  }
  try {
    const mapped = await mapOrderToSalesOrder(payload, { defaultCustomerId: process.env.NS_DEFAULT_CUSTOMER_ID });

    if (ns.DRY_RUN) {
      return ok(res, {
        dryRun: true,
        message: 'DRY_RUN is on — nothing written. Review the mapped body, then set DRY_RUN=false.',
        summary: mapped.summary,
        unresolvedSkus: mapped.unresolved,
        netsuiteBody: mapped.body,
      });
    }

    if (mapped.unresolved.length) {
      return fail(res, 422, 'Some SKUs could not be resolved to NetSuite items', { unresolvedSkus: mapped.unresolved });
    }

    const created = await ns.createRecord('salesOrder', mapped.body);
    ok(res, { netsuiteId: created.id, location: created.location, summary: mapped.summary });
  } catch (e) {
    fail(res, e.status || 500, e.message, { body: e.body });
  }
});

// --- FIELD SERVICE: book a Bolt Squad dispatch --------------------------
app.post('/api/field-services/bookings', async (req, res) => {
  const b = req.body || {};
  if (!b.company || !b.date) return fail(res, 400, 'company and date are required');
  try {
    const result = await fieldservice.createBooking(b);
    ok(res, result); // { booking, dispatch, ics }
  } catch (e) {
    fail(res, 500, e.message);
  }
});

// Download the .ics for a booking payload (handy for calendar buttons)
app.post('/api/field-services/ics', (req, res) => {
  const b = req.body || {};
  b.ref = b.ref || 'CSG-' + Date.now();
  res.set('Content-Type', 'text/calendar').set('Content-Disposition', `attachment; filename="${b.ref}.ics"`);
  res.send(fieldservice.buildICS(b));
});

// --- DOCUSIGN: send an envelope (template or generated) ------------------
app.post('/api/docusign/envelopes', async (req, res) => {
  const p = req.body || {};
  if (!p.company || !p.documents || !p.documents.length) return fail(res, 400, 'company and documents[] are required');
  if (p.mode === 'template' && !p.signerEmail) return fail(res, 400, 'signerEmail required to send');
  try {
    const result = await docusign.sendEnvelope(p);
    ok(res, result); // { envelopeId, status, documents, names }
  } catch (e) {
    // Surface DocuSign consent_required clearly (first-run) — see README §7.
    fail(res, e.status || 500, e.message);
  }
});

app.get('/api/docusign/envelopes/:id', async (req, res) => {
  try { ok(res, await docusign.getEnvelope(req.params.id)); }
  catch (e) { fail(res, e.status || 500, e.message); }
});

// --- SITE PHOTOS: email the request link + receive submission callback --
app.post('/api/site-photos/request', (req, res) => {
  // TODO: email req.body.link to req.body.email via SendGrid/SES; record the request.
  ok(res, { sent: true, to: req.body.email || null, token: req.body.token, link: req.body.link });
});
app.post('/api/site-photos/:token', (req, res) => {
  // TODO: persist submission metadata; store the images in S3/Blob from the upload page.
  ok(res, { received: true, token: req.params.token, count: (req.body && req.body.count) || 0 });
});

// --- WEATHER: forecast + roof-work risk for an install day ---------------
app.get('/api/weather', async (req, res) => {
  try { ok(res, await weather.forecast(req.query.address, req.query.date)); }
  catch (e) { fail(res, 400, e.message); }
});

// --- REMINDERS: register the automated reminder schedule for an order -----
app.post('/api/reminders/schedule', (req, res) => {
  // TODO: enqueue each reminder (Email/SMS via SendGrid/Twilio) at its `when`.
  const items = (req.body && req.body.reminderSchedule) || [];
  ok(res, { scheduled: items.length, orderId: req.body && req.body.orderId, items });
});

// --- INSTALL COMPLETION: speed test + proof, close the job ----------------
app.post('/api/installs/:id/complete', (req, res) => {
  // TODO: attach speed test + as-built to the NetSuite record; close the FSM job.
  ok(res, { completed: true, orderId: req.params.id, speed: req.body && req.body.speed });
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`CSG BFF listening on http://localhost:${PORT}  (DRY_RUN=${ns.DRY_RUN})`);
  console.log(`Portal:  http://localhost:${PORT}/index.html`);
});
