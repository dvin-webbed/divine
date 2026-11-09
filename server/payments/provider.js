/**
 * Payment provider interface.
 *
 * Every provider (mock or real) implements the same two methods:
 *   initiateDeposit({ userId, amountCents })    -> { status, providerRef }
 *   initiateWithdrawal({ userId, amountCents }) -> { status, providerRef }
 *
 * This is the seam where real integrations plug in later, without touching
 * routes/payments.js or the frontend at all - only this file changes.
 *
 * ---- What a real provider would look like ----
 *
 * ACH via Plaid (bank transfers):
 *   - Sandbox is free, no business bank account or KYB needed to start building.
 *   - Flow: Plaid Link (frontend widget) -> public_token -> exchange for
 *     access_token server-side -> Plaid Transfer API to move money via ACH.
 *   - Going live requires: a registered business, Plaid's "Production" access
 *     (a short application, not a large upfront fee), and a business bank
 *     account to receive/send funds through.
 *   - Docs: https://plaid.com/docs/transfer/
 *
 * Crypto via Coinbase Commerce:
 *   - Free to create a merchant account; no monthly fee, ~1% fee per
 *     transaction taken automatically - nothing to pay upfront.
 *   - Flow: create a "charge" server-side -> redirect the user to Coinbase's
 *     hosted payment page -> Coinbase sends a signed webhook back on
 *     confirmation, which is what should actually mark a deposit "completed".
 *   - Docs: https://docs.cloud.coinbase.com/commerce/docs
 *
 * Cards via Stripe (if you ever want a card option too):
 *   - Free to create an account; test mode needs no business verification.
 *   - Live mode charges a per-transaction fee (no large upfront cost either).
 *
 * None of these require money up front to build against - only to go live.
 */

const MockProvider = {
  name: 'mock',

  async initiateDeposit({ userId, amountCents, method }) {
    // Simulates an instantly-settled deposit for local development/demo use.
    // A real provider would return 'pending' here and a webhook/callback
    // would later flip the transaction to 'completed' (see routes/payments.js).
    return {
      status: 'completed',
      providerRef: `mock_dep_${Date.now()}_${userId}`,
    };
  },

  async initiateWithdrawal({ userId, amountCents, method }) {
    return {
      status: 'completed',
      providerRef: `mock_wd_${Date.now()}_${userId}`,
    };
  },
};

/**
 * Picks a provider per payment method based on environment configuration.
 * Everything defaults to the mock provider until real credentials are set,
 * so the app is fully demoable without any payment gateway account at all.
 */
function getProviderForMethod(method) {
  if (method === 'ach' && process.env.PLAID_CLIENT_ID) {
    // return require('./plaidProvider'); // implement when ready to go live
    throw new Error('Plaid is configured but plaidProvider.js has not been implemented yet.');
  }
  if (method === 'crypto' && process.env.COINBASE_COMMERCE_API_KEY) {
    // return require('./coinbaseCommerceProvider'); // implement when ready to go live
    throw new Error('Coinbase Commerce is configured but coinbaseCommerceProvider.js has not been implemented yet.');
  }
  return MockProvider;
}

/** Which methods are "live" (real money) vs mock, for the frontend to display honestly. */
function getMethodStatus() {
  return {
    ach: process.env.PLAID_CLIENT_ID ? 'unavailable' : 'sandbox',
    crypto: process.env.COINBASE_COMMERCE_API_KEY ? 'unavailable' : 'sandbox',
  };
}

module.exports = { getProviderForMethod, getMethodStatus, MockProvider };
