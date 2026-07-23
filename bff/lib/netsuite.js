'use strict';
/**
 * NetSuite client — OAuth 2.0 machine-to-machine (client credentials with a signed JWT
 * client assertion), plus thin wrappers over the SuiteQL and Record REST APIs.
 *
 * Auth flow (no user interaction, server-to-server):
 *   1. Build a short-lived JWT signed with your PRIVATE key (public cert is uploaded to NetSuite).
 *   2. Exchange it at the token endpoint for a bearer access token (cached until ~expiry).
 *   3. Call REST Web Services / SuiteQL with `Authorization: Bearer <token>`.
 *
 * Docs: NetSuite REST Web Services + "OAuth 2.0 Client Credentials (M2M) Setup".
 */
const fs = require('fs');
const jwt = require('jsonwebtoken');

const ACCOUNT = (process.env.NS_ACCOUNT_ID || '').trim();
const CLIENT_ID = process.env.NS_CLIENT_ID;
const CERT_ID = process.env.NS_CERTIFICATE_ID;
const ALG = process.env.NS_JWT_ALG || 'PS256';
const SCOPE = process.env.NS_SCOPE || 'rest_webservices';

// Account id in host form: dashes stay, but the REST host uses the account id lowercased.
const HOST = `https://${ACCOUNT.toLowerCase()}.suitetalk.api.netsuite.com`;
const TOKEN_URL = `${HOST}/services/rest/auth/oauth2/v1/token`;
const REST_RECORD = `${HOST}/services/rest/record/v1`;
const SUITEQL_URL = `${HOST}/services/rest/query/v1/suiteql`;

function privateKey() {
  if (process.env.NS_PRIVATE_KEY) return process.env.NS_PRIVATE_KEY.replace(/\\n/g, '\n');
  const p = process.env.NS_PRIVATE_KEY_PATH;
  if (!p) throw new Error('Set NS_PRIVATE_KEY_PATH or NS_PRIVATE_KEY');
  return fs.readFileSync(p, 'utf8');
}

let _cache = { token: null, exp: 0 };

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_cache.token && now < _cache.exp - 60) return _cache.token; // reuse until ~1 min before expiry

  const assertion = jwt.sign(
    { iss: CLIENT_ID, scope: SCOPE.split(/[ ,]+/), aud: TOKEN_URL, iat: now, exp: now + 3000 },
    privateKey(),
    { algorithm: ALG, header: { alg: ALG, typ: 'JWT', kid: CERT_ID } }
  );

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`NetSuite token error ${res.status}: ${JSON.stringify(json)}`);
  _cache = { token: json.access_token, exp: now + (json.expires_in || 3600) };
  return _cache.token;
}

async function authed(url, opts = {}) {
  const token = await getToken();
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`NetSuite ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    err.status = res.status; err.body = data; throw err;
  }
  // REST record create returns the new record location in a header, not the body.
  return { data, location: res.headers.get('location') };
}

/** Run a SuiteQL query. Returns the `items` array. */
async function suiteql(q) {
  const { data } = await authed(SUITEQL_URL, {
    method: 'POST',
    headers: { Prefer: 'transient' },
    body: JSON.stringify({ q }),
  });
  return (data && data.items) || [];
}

/** Create any record type, e.g. createRecord('salesOrder', body). Returns the new internal id. */
async function createRecord(type, body) {
  const { location } = await authed(`${REST_RECORD}/${type}`, { method: 'POST', body: JSON.stringify(body) });
  const id = location ? location.split('/').pop() : null;
  return { id, location };
}

/** Resolve a NetSuite item internal id from an itemid / name. Cached in-process. */
const _itemCache = new Map();
async function resolveItemId(itemid) {
  if (!itemid) return null;
  if (_itemCache.has(itemid)) return _itemCache.get(itemid);
  const safe = String(itemid).replace(/'/g, "''");
  const rows = await suiteql(`SELECT id FROM item WHERE itemid = '${safe}' FETCH FIRST 1 ROWS ONLY`);
  const id = rows[0] ? rows[0].id : null;
  _itemCache.set(itemid, id);
  return id;
}

module.exports = { getToken, suiteql, createRecord, resolveItemId, HOST, DRY_RUN: String(process.env.DRY_RUN) === 'true' };
