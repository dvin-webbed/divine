'use strict';

const DEFAULT_ILLUSTRATIVE_TIERS = [
  { tierName: 'Tier 1', minPrincipal: 1000, maxPrincipal: 4999.99, monthlyRatePercentage: 20 },
  { tierName: 'Tier 2', minPrincipal: 5000, maxPrincipal: 9999.99, monthlyRatePercentage: 25 },
  { tierName: 'Tier 3', minPrincipal: 10000, maxPrincipal: null, monthlyRatePercentage: 30 },
];

const INTERVAL_MULTIPLIERS = {
  'bi-weekly': 0.5,
  monthly: 1,
  quarterly: 3,
  'bi-annually': 6,
  annually: 12,
};

function validateTiers(tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new TypeError('tiers must be a non-empty array.');
  }

  const seenThresholds = new Set();
  for (const tier of tiers) {
    if (typeof tier.tierName !== 'string' || !tier.tierName.trim()) {
      throw new TypeError('Each tier must have a tierName.');
    }
    if (!Number.isFinite(tier.minPrincipal) || tier.minPrincipal <= 0) {
      throw new TypeError('Each tier must have a positive finite minPrincipal.');
    }
    if (!Number.isFinite(tier.monthlyRatePercentage) || tier.monthlyRatePercentage <= 0) {
      throw new RangeError('Each tier must have a positive finite monthlyRatePercentage.');
    }
    if (seenThresholds.has(tier.minPrincipal)) {
      throw new RangeError('Tier minimum principal values must be unique.');
    }
    seenThresholds.add(tier.minPrincipal);
  }
}

function calculatePayout(principalAmount, withdrawalInterval, tiers = DEFAULT_ILLUSTRATIVE_TIERS) {
  if (!Number.isFinite(principalAmount) || principalAmount <= 0) {
    throw new TypeError('principalAmount must be a positive finite number.');
  }

  const intervalMultiplier = INTERVAL_MULTIPLIERS[withdrawalInterval];
  if (intervalMultiplier === undefined) {
    throw new RangeError(`Unsupported withdrawal interval: ${withdrawalInterval}`);
  }

  validateTiers(tiers);
  const matchingTier = tiers
    .filter(tier => principalAmount >= tier.minPrincipal)
    .sort((first, second) => second.minPrincipal - first.minPrincipal)[0];

  if (!matchingTier) {
    throw new RangeError('principalAmount does not meet the minimum investment tier.');
  }

  const monthlyRate = matchingTier.monthlyRatePercentage;
  const effectiveIntervalPercentage = monthlyRate * intervalMultiplier;
  const payoutAmount = Math.round(
    (principalAmount * effectiveIntervalPercentage / 100 + Number.EPSILON) * 100
  ) / 100;

  return {
    principal: principalAmount,
    tierName: matchingTier.tierName,
    monthlyRatePercentage: monthlyRate,
    effectiveIntervalPercentage,
    payoutAmount,
    withdrawalInterval,
  };
}

module.exports = {
  DEFAULT_ILLUSTRATIVE_TIERS,
  INTERVAL_MULTIPLIERS,
  calculatePayout,
};
