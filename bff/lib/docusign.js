'use strict';
/**
 * DocuSign eSignature — JWT Grant (service integration, no user click) + envelope creation.
 *
 *   1. Sign a JWT with your integration's RSA private key (impersonating an API user).
 *   2. Exchange it for an access token at account.docusign.com / account-d.docusign.com (demo).
 *   3. Create an envelope from a TEMPLATE (templateId + prefilled tabs) or from a GENERATED
 *      document (base64 PDF), then send it for signature.
 *
 * Env: DS_INTEGRATION_KEY, DS_USER_ID, DS_ACCOUNT_ID, DS_BASE_URI, DS_OAUTH_BASE,
 *      DS_PRIVATE_KEY_PATH / DS_PRIVATE_KEY, and DS_TEMPLATE_SOW / DS_TEMPLATE_BIGLEAF / DS_TEMPLATE_MSA.
 */
const fs = require('fs');
const jwt = require('jsonwebtoken');

const OAUTH_BASE = process.env.DS_OAUTH_BASE || 'https://account-d.docusign.com'; // account.docusign.com in prod
const BASE_URI = process.env.DS_BASE_URI || 'https://demo.docusign.net/restapi';   // from userinfo in prod
const ACCOUNT_ID = process.env.DS_ACCOUNT_ID;

const TEMPLATES = {
  sow: process.env.DS_TEMPLATE_SOW,
  bigleaf: process.env.DS_TEMPLATE_BIGLEAF,
  msa: process.env.DS_TEMPLATE_MSA,
};
const DOC_NAMES = { sow: 'Statement of Work', bigleaf: 'Bigleaf Service Agreement', msa: 'Master Service Agreement' };

function privateKey() {
  if (process.env.DS_PRIVATE_KEY) return process.env.DS_PRIVATE_KEY.replace(/\\n/g, '\n');
  if (!process.env.DS_PRIVATE_KEY_PATH) throw new Error('Set DS_PRIVATE_KEY_PATH or DS_PRIVATE_KEY');
  return fs.readFileSync(process.env.DS_PRIVATE_KEY_PATH, 'utf8');
}

let _cache = { token: null, exp: 0 };
async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_cache.token && now < _cache.exp - 60) return _cache.token;

  const assertion = jwt.sign(
    { iss: process.env.DS_INTEGRATION_KEY, sub: process.env.DS_USER_ID, aud: OAUTH_BASE.replace(/^https?:\/\//, ''),
      iat: now, exp: now + 3600, scope: 'signature impersonation' },
    privateKey(),
    { algorithm: 'RS256' }
  );

  const res = await fetch(`${OAUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const json = await res.json();
  // First-ever call for a user returns consent_required — open the consent URL once (see README).
  if (!res.ok) throw new Error(`DocuSign token error ${res.status}: ${JSON.stringify(json)}`);
  _cache = { token: json.access_token, exp: now + (json.expires_in || 3600) };
  return _cache.token;
}

async function dsFetch(path, opts = {}) {
  const token = await getToken();
  const res = await fetch(`${BASE_URI}/v2.1/accounts/${ACCOUNT_ID}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`DocuSign ${res.status}: ${JSON.stringify(json)}`); e.status = res.status; throw e; }
  return json;
}

/**
 * Build + send an envelope.
 * @param {object} p { company, signerName, signerEmail, mode:'template'|'generate', documents:['sow',...], pdfBase64? }
 */
async function sendEnvelope(p) {
  const recipientId = '1';
  const signer = { name: p.signerName, email: p.signerEmail, recipientId, routingOrder: '1', clientUserId: undefined };

  let envelope;
  if (p.mode === 'template') {
    // One composite template group per requested doc that has a configured templateId.
    const groups = (p.documents || []).map((docId, idx) => {
      const templateId = TEMPLATES[docId];
      if (!templateId) throw new Error(`No DS template configured for '${docId}' (set DS_TEMPLATE_${docId.toUpperCase()})`);
      return {
        serverTemplates: [{ sequence: String(idx + 1), templateId }],
        inlineTemplates: [{ sequence: String(idx + 1), recipients: { signers: [{ ...signer, roleName: 'Signer' }] } }],
      };
    });
    envelope = { emailSubject: `CSG — documents for ${p.company}`, status: 'sent', compositeTemplates: groups };
  } else {
    // Generated document path: caller supplies a base64 PDF (built server-side from the order).
    if (!p.pdfBase64) throw new Error('mode=generate requires pdfBase64');
    envelope = {
      emailSubject: `CSG — Statement of Work for ${p.company}`,
      status: 'sent',
      documents: [{ documentBase64: p.pdfBase64, name: 'CSG SOW', fileExtension: 'pdf', documentId: '1' }],
      recipients: { signers: [{ ...signer, tabs: { signHereTabs: [{ anchorString: '/sig/', anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '0' }] } }] },
    };
  }

  const result = await dsFetch('/envelopes', { method: 'POST', body: JSON.stringify(envelope) });
  return { envelopeId: result.envelopeId, status: result.status, documents: p.documents, names: (p.documents || []).map((d) => DOC_NAMES[d]) };
}

async function getEnvelope(envelopeId) {
  return dsFetch(`/envelopes/${envelopeId}`);
}

module.exports = { getToken, sendEnvelope, getEnvelope, TEMPLATES };
