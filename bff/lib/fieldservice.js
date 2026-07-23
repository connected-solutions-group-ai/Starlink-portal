'use strict';
/**
 * Internal Bolt Squad field-service dispatch.
 *
 * Keeps you off any single FSM vendor: a booking is created, POSTed to a configurable
 * dispatch webhook (FS_WEBHOOK_URL — e.g. a Zapier/Make hook, an internal endpoint, or a
 * Teams/Slack Incoming Webhook), and an .ics calendar invite is generated so the tech and
 * customer can add it to their calendar. Swap `postToDispatch` for a real FSM API
 * (ServiceTitan / Salesforce FSL / Housecall Pro) later without touching the routes.
 */
const crypto = require('crypto');

function ref() {
  return 'BS-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function icsEscape(s) { return String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n'); }

function buildICS(b) {
  const date = (b.date || '').replace(/-/g, '');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CSG//Bolt Squad//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${b.ref}@csg`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${date}`,
    `DTEND;VALUE=DATE:${date}`,
    `SUMMARY:${icsEscape('CSG Install — ' + (b.company || 'Customer'))}`,
    `LOCATION:${icsEscape(b.site || '')}`,
    `DESCRIPTION:${icsEscape([b.window, b.dispatch, b.lift && ('Lift: ' + b.lift), 'Scope: ' + (b.scope || ''), b.contact && ('Contact: ' + b.contact + ' ' + (b.phone || '')), b.notes].filter(Boolean).join('\n'))}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

async function postToDispatch(booking) {
  const url = process.env.FS_WEBHOOK_URL;
  if (!url) return { delivered: false, reason: 'FS_WEBHOOK_URL not set (booking recorded, not dispatched)' };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(booking) });
    return { delivered: res.ok, status: res.status };
  } catch (e) {
    return { delivered: false, reason: e.message };
  }
}

async function createBooking(input) {
  const booking = {
    ref: ref(),
    company: input.company,
    orderId: input.orderId || null,
    date: input.date,
    window: input.window,
    dispatch: input.dispatch,
    lift: input.lift || 'None',
    scope: input.scope || '',
    site: input.site || '',
    contact: input.contact || '',
    phone: input.phone || '',
    notes: input.notes || '',
    createdAt: new Date().toISOString(),
  };
  const dispatch = await postToDispatch(booking);
  return { booking, dispatch, ics: buildICS(booking) };
}

module.exports = { createBooking, buildICS };
