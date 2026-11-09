// Single source of truth for funding limits. Deliberately fixed for every
// user, every time - no per-user overrides, no "special case" reduced minimums.
// If the business ever wants a genuinely different tier (e.g. a lower minimum
// for a retirement-account product), that should be a named, published product
// rule applied equally to everyone who qualifies for it - not something decided
// per conversation with an individual customer.

const MIN_AMOUNT_CENTS = 100000;   // $1,000
const MAX_AMOUNT_CENTS = 10000000; // $100,000 withdrawal maximum
const MAX_DEPOSIT_AMOUNT_CENTS = 10000000; // $100,000 deposit maximum

function centsToDollars(cents) {
  return (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

function validateAmountCents(amountCents, maximum = MAX_AMOUNT_CENTS) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return 'Enter a valid amount.';
  }
  if (amountCents < MIN_AMOUNT_CENTS) {
    return `The minimum amount is ${centsToDollars(MIN_AMOUNT_CENTS)}.`;
  }
  if (amountCents > maximum) {
    return `The maximum amount is ${centsToDollars(maximum)}.`;
  }
  return null;
}

module.exports = {
  MIN_AMOUNT_CENTS,
  MAX_AMOUNT_CENTS,
  MAX_DEPOSIT_AMOUNT_CENTS,
  validateAmountCents,
  centsToDollars,
};
