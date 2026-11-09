const assert = require('node:assert/strict');

const MAX_MONTHLY_RATE_PERCENT = 30;
const DEFAULT_TIERS = [
  { tierName: 'Tier 1', minPrincipal: 1000, monthlyRatePercent: 20 },
  { tierName: 'Tier 2', minPrincipal: 5000, monthlyRatePercent: 25 },
  { tierName: 'Tier 3', minPrincipal: 10000, monthlyRatePercent: 30 },
];
const WITHDRAWAL_INTERVALS = {
  'bi-weekly': { profitMultiplier: 0.5, days: 14 },
  monthly: { profitMultiplier: 1, days: 30 },
  quarterly: { profitMultiplier: 3, days: 90 },
  'bi-annually': { profitMultiplier: 6, days: 180 },
  annually: { profitMultiplier: 12, days: 365 },
};

function validateTiers(tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new TypeError('tiers must be a non-empty array.');
  }

  for (const tier of tiers) {
    if (typeof tier.tierName !== 'string' || !tier.tierName.trim()) {
      throw new TypeError('Each tier must have a tierName.');
    }
    if (!Number.isFinite(tier.minPrincipal) || tier.minPrincipal <= 0) {
      throw new TypeError('Each tier must have a positive finite minPrincipal.');
    }
    if (!Number.isFinite(tier.monthlyRatePercent)
      || tier.monthlyRatePercent <= 0
      || tier.monthlyRatePercent > MAX_MONTHLY_RATE_PERCENT) {
      throw new RangeError(`Monthly rates must be greater than 0 and no more than ${MAX_MONTHLY_RATE_PERCENT}%.`);
    }
  }
}

async function loadInvestmentTiers(database) {
  const [rows] = await database.query(
    `SELECT tier_key, min_principal_cents, monthly_rate_pct
     FROM investment_tiers WHERE is_active = TRUE ORDER BY min_principal_cents ASC`
  );
  if (!rows.length) return DEFAULT_TIERS;
  return rows.map(row => ({
    tierName: String(row.tier_key).replace(/^tier_(\d+)$/, 'Tier $1'),
    minPrincipal: Number(row.min_principal_cents) / 100,
    monthlyRatePercent: Number(row.monthly_rate_pct),
  }));
}

function calculateUserPayout(principal, withdrawalInterval, tiers = DEFAULT_TIERS) {
  if (!Number.isFinite(principal) || principal <= 0) {
    throw new TypeError('principal must be a positive finite number.');
  }
  const principalCents = Math.round(principal * 100);
  if (!Number.isSafeInteger(principalCents) || Math.abs(principal - principalCents / 100) > 1e-8) {
    throw new TypeError('principal must be a currency amount with no more than two decimal places.');
  }
  principal = principalCents / 100;

  const interval = WITHDRAWAL_INTERVALS[withdrawalInterval];
  if (!interval) {
    throw new RangeError(`Unsupported withdrawal interval: ${withdrawalInterval}`);
  }

  validateTiers(tiers);
  const matchingTier = tiers
    .filter(tier => principal >= tier.minPrincipal)
    .sort((first, second) => second.minPrincipal - first.minPrincipal)[0];

  if (!matchingTier) {
    throw new RangeError('principal does not meet the minimum investment tier.');
  }

  const monthlyProfit = Math.round((principal * matchingTier.monthlyRatePercent + Number.EPSILON) * 100) / 10000;
  const payoutAmount = Math.round((monthlyProfit * interval.profitMultiplier + Number.EPSILON) * 100) / 100;

  return {
    principal,
    tierName: matchingTier.tierName,
    monthlyRatePercentage: matchingTier.monthlyRatePercent,
    effectiveIntervalPercentage: matchingTier.monthlyRatePercent * interval.profitMultiplier,
    withdrawalInterval,
    appliedMonthlyRate: matchingTier.monthlyRatePercent,
    monthlyProfit: Number(monthlyProfit.toFixed(2)),
    payoutAmount: Number(payoutAmount.toFixed(2)),
    interval: withdrawalInterval,
    intervalDays: interval.days,
  };
}

function getNextPayoutDate(withdrawalInterval, fromDate = new Date()) {
  const interval = WITHDRAWAL_INTERVALS[withdrawalInterval];
  if (!interval) {
    throw new RangeError(`Unsupported withdrawal interval: ${withdrawalInterval}`);
  }

  const nextDate = new Date(fromDate);
  if (Number.isNaN(nextDate.getTime())) throw new TypeError('fromDate must be a valid date.');
  nextDate.setUTCDate(nextDate.getUTCDate() + interval.days);
  return nextDate;
}

module.exports = {
  DEFAULT_TIERS,
  MAX_MONTHLY_RATE_PERCENT,
  WITHDRAWAL_INTERVALS,
  calculateUserPayout,
  getNextPayoutDate,
  loadInvestmentTiers,
};

if (require.main === module) {
  const biWeekly = calculateUserPayout(1000, 'bi-weekly');
  const monthly = calculateUserPayout(5000, 'monthly');
  assert.equal(biWeekly.payoutAmount, 100);
  assert.equal(monthly.payoutAmount, 1250);
  assert.equal(calculateUserPayout(10000, 'monthly').appliedMonthlyRate, 30);
  assert.throws(() => calculateUserPayout(10000, 'monthly', [
    { tierName: 'Too high', minPrincipal: 10000, monthlyRatePercent: 30.01 },
  ]), RangeError);
  console.log('User payout engine checks passed.');
}
