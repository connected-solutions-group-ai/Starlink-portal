'use strict';
/**
 * Map a portal `csg.order.v1` payload to a NetSuite Sales Order REST body.
 *
 * The portal sends each line with `netsuiteSku` (the NetSuite itemid). We resolve those
 * to internal ids via SuiteQL. Recurring (MRR) lines are tagged so the dev team can route
 * them to a billing schedule / subscription item as appropriate — NetSuite treats them as
 * ordinary sales-order lines unless you wire up SuiteBilling.
 */
const { resolveItemId } = require('./netsuite');

async function mapOrderToSalesOrder(payload, opts = {}) {
  const defaultCustomer = opts.defaultCustomerId || process.env.NS_DEFAULT_CUSTOMER_ID || null;

  const resolved = [];
  const unresolved = [];
  for (const li of payload.lineItems || []) {
    const id = await resolveItemId(li.netsuiteSku || li.partNumber);
    if (!id) { unresolved.push({ sku: li.netsuiteSku || li.partNumber, description: li.description }); continue; }
    resolved.push({
      item: { id },
      quantity: li.quantity || 1,
      rate: li.unitPrice,
      // custom flag so downstream automation can split one-time vs recurring
      // (rename to your real custom column, e.g. custcol_csg_billing_type)
      description: `${li.description}${li.type === 'recurring_monthly' ? ' [MRR]' : ''}`,
    });
  }

  const body = {
    // TODO: map payload.account.company -> a real NetSuite customer (create-or-find).
    entity: defaultCustomer ? { id: defaultCustomer } : undefined,
    memo: `CSG Portal ${payload.orderId} — submitted by ${payload.submittedBy && payload.submittedBy.name || 'unknown'} (${payload.submittedBy && payload.submittedBy.role || ''})`,
    // externalId lets you make submission idempotent and reconcile back to the portal order.
    externalId: payload.orderId,
    custbody_csg_pricing_basis: payload.pricingBasis, // rename to your real custom body field or drop
    item: { items: resolved },
  };

  return {
    body,
    unresolved,
    summary: {
      orderId: payload.orderId,
      company: payload.account && payload.account.company,
      lines: resolved.length,
      unresolved: unresolved.length,
      oneTime: payload.totals && payload.totals.oneTime,
      monthlyRecurring: payload.totals && payload.totals.monthlyRecurring,
    },
  };
}

module.exports = { mapOrderToSalesOrder };
