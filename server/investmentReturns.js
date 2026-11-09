const assert = require('node:assert/strict');
const { DEFAULT_TIERS, calculateUserPayout } = require('./UserPayoutEngine');

function calculateInvestmentReturns(principal, withdrawalInterval, tiers = DEFAULT_TIERS) {
  const quote = calculateUserPayout(principal, withdrawalInterval, tiers);
  return {
    principal: quote.principal,
    appliedMonthlyRate: quote.appliedMonthlyRate,
    payoutAmount: quote.payoutAmount,
    interval: quote.interval,
  };
}

module.exports = {
  calculateInvestmentReturns,
  DEFAULT_TIERS,
};

if (require.main === module) {
  const biWeeklyExample = calculateInvestmentReturns(1000, 'bi-weekly');
  const monthlyExample = calculateInvestmentReturns(5000, 'monthly');
  const topTierExample = calculateInvestmentReturns(10000, 'monthly');

  assert.deepEqual(biWeeklyExample, {
    principal: 1000,
    appliedMonthlyRate: 20,
    payoutAmount: 100,
    interval: 'bi-weekly',
  });
  assert.deepEqual(monthlyExample, {
    principal: 5000,
    appliedMonthlyRate: 25,
    payoutAmount: 1250,
    interval: 'monthly',
  });
  assert.equal(topTierExample.appliedMonthlyRate, 30);
  assert.equal(topTierExample.payoutAmount, 3000);

  console.log('Investment return examples passed:');
  console.log(biWeeklyExample);
  console.log(monthlyExample);
}
