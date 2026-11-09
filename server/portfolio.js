const STRATEGIES = {
  tiered: { label: 'Tiered Income' },
};

const PAYOUT_FREQUENCIES = ['bi-weekly', 'monthly', 'quarterly', 'bi-annually', 'annually'];
const { calculateInvestmentReturns } = require('./investmentReturns');

function targetYieldForAmount(strategy, amountCents, tiers) {
  if (strategy !== 'tiered' || amountCents <= 0) return 0;
  return calculateInvestmentReturns(amountCents / 100, 'monthly', tiers).appliedMonthlyRate;
}

module.exports = { STRATEGIES, PAYOUT_FREQUENCIES, targetYieldForAmount };