'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_TIERS,
  calculateUserPayout,
  getNextPayoutDate,
  loadInvestmentTiers,
} = require('./UserPayoutEngine');
const { calculatePayout } = require('./IllustrativePayoutCalculator');
const { YieldTrackerService } = require('./YieldTrackerService');
const { scheduleNextPayout, processOnePayout, processOneMaturity } = require('./PayoutQueueService');
const { maturityDateForTerm, getMaturityLock } = require('./investmentTerms');
const { REFERRAL_COMMISSION_CENTS } = require('./referrals');
const {
  createVerificationCode,
  isVerificationCodeValid,
  normalizeEmail,
  normalizePhone,
  verificationCodeHash,
} = require('./verification');

function makeYieldDatabase() {
  const state = { seen: new Set(), reserveCents: 0, grossCents: 0 };
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params) {
      if (sql.includes('INSERT IGNORE INTO yield_pool')) {
        const key = `${params[0]}:${params[1]}`;
        if (state.seen.has(key)) return [{ affectedRows: 0 }, []];
        state.seen.add(key);
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes('UPDATE reserve_buffer')) {
        state.reserveCents += Number(params[0]);
        state.grossCents += Number(params[1]);
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected test SQL: ${sql}`);
    },
  };
  return { state, database: { getConnection: async () => connection } };
}

test('referral rewards pay a fixed $300 bonus on first investment', () => {
  assert.equal(REFERRAL_COMMISSION_CENTS, 30000);
});

test('email registration normalizes email while phone normalization remains available for sign-in', () => {
  assert.equal(normalizeEmail(' User@Example.COM '), 'user@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizePhone('020 7946 0018', 'GB'), '+442079460018');
  assert.equal(normalizePhone('+442079460018'), '+442079460018');
  assert.equal(normalizePhone('not-a-number', 'GB'), null);
});

test('signup verification codes are six digits and bound to their challenge', () => {
  const code = createVerificationCode();
  assert.match(code, /^\d{6}$/);
  assert.notEqual(verificationCodeHash('challenge-a', code), verificationCodeHash('challenge-b', code));
  assert.equal(isVerificationCodeValid('challenge-a', code, verificationCodeHash('challenge-a', code)), true);
  assert.equal(isVerificationCodeValid('challenge-a', '000000', verificationCodeHash('challenge-a', code)), false);
});

test('tier thresholds and payout intervals use the configured 30% ceiling', () => {
  assert.equal(calculateUserPayout(1000, 'monthly').payoutAmount, 200);
  assert.equal(calculateUserPayout(1000, 'bi-weekly').payoutAmount, 100);
  assert.equal(calculateUserPayout(5000, 'bi-weekly').payoutAmount, 625);
  assert.equal(calculateUserPayout(10000, 'monthly').payoutAmount, 3000);
  assert.equal(calculateUserPayout(1000, 'quarterly').payoutAmount, 600);
  assert.equal(calculateUserPayout(1000, 'bi-annually').payoutAmount, 1200);
  assert.equal(calculateUserPayout(1000, 'annually').payoutAmount, 2400);
  assert.deepEqual(
    Object.keys(calculateUserPayout(1000, 'bi-weekly')),
    ['principal', 'tierName', 'monthlyRatePercentage', 'effectiveIntervalPercentage', 'withdrawalInterval',
      'appliedMonthlyRate', 'monthlyProfit', 'payoutAmount', 'interval', 'intervalDays']
  );
  assert.equal(calculateUserPayout(1000, 'bi-weekly').tierName, 'Tier 1');
  assert.equal(calculateUserPayout(1000, 'bi-weekly').effectiveIntervalPercentage, 10);
  assert.equal(calculateUserPayout(10000, 'annually').effectiveIntervalPercentage, 360);
  assert.throws(() => calculateUserPayout(999, 'monthly'), RangeError);
  assert.throws(() => calculateUserPayout(1000.001, 'monthly'), TypeError);
  assert.throws(() => calculateUserPayout(10000, 'weekly'), RangeError);
  assert.throws(() => calculateUserPayout(10000, 'monthly', [
    { tierName: 'Too high', minPrincipal: 10000, monthlyRatePercent: 30.01 },
  ]), RangeError);
});

test('calculatePayout returns the requested illustrative result structure', () => {
  assert.deepEqual(calculatePayout(1000, 'bi-weekly'), {
    principal: 1000,
    tierName: 'Tier 1',
    monthlyRatePercentage: 20,
    effectiveIntervalPercentage: 10,
    payoutAmount: 100,
    withdrawalInterval: 'bi-weekly',
  });
  assert.equal(calculatePayout(1000, 'monthly').payoutAmount, 200);
  assert.equal(calculatePayout(5000, 'bi-weekly').payoutAmount, 625);
  assert.equal(calculatePayout(10000, 'annually').effectiveIntervalPercentage, 360);
});

test('tier settings can be loaded from the investment_tiers table', async () => {
  const database = {
    async query() {
      return [[{ min_principal_cents: '100000', monthly_rate_pct: '6.5' }], []];
    },
  };
  const tiers = await loadInvestmentTiers(database);
  assert.equal(calculateUserPayout(1000, 'monthly', tiers).payoutAmount, 65);
});

test('payout dates use 14 days and 30 days', () => {
  const start = new Date('2026-01-01T00:00:00.000Z');
  assert.equal(getNextPayoutDate('bi-weekly', start).toISOString(), '2026-01-15T00:00:00.000Z');
  assert.equal(getNextPayoutDate('monthly', start).toISOString(), '2026-01-31T00:00:00.000Z');
});

test('registered investment terms produce an exact maturity date', () => {
  const started = new Date('2026-01-15T12:00:00.000Z');
  assert.equal(maturityDateForTerm('3', started).toISOString(), '2029-01-15T12:00:00.000Z');
  assert.equal(maturityDateForTerm('lifetime', started), null);
  assert.throws(() => maturityDateForTerm('4', started), RangeError);
  assert.throws(() => maturityDateForTerm(undefined, started), RangeError);
});

test('principal liquidity stays locked until the registered term matures', () => {
  const maturityAt = new Date('2027-01-15T00:00:00.000Z');
  const beforeMaturity = getMaturityLock(maturityAt, new Date('2026-10-05T00:00:00.000Z'));
  assert.equal(beforeMaturity.remainingDays, 102);
  assert.equal(getMaturityLock(maturityAt, new Date('2027-01-15T00:00:00.000Z')), null);
});

test('yield inflows reserve 10% of gross once per source reference', async () => {
  const { database, state } = makeYieldDatabase();
  const tracker = new YieldTrackerService(database);
  const first = await tracker.recordInflow({
    source: 'defi',
    sourceRef: '0xabc:0',
    grossProfit: 100,
    gasFee: 5,
    occurredAt: '2026-01-01T00:00:00.000Z',
  });
  const duplicate = await tracker.recordInflow({
    source: 'defi',
    sourceRef: '0xabc:0',
    grossProfit: 100,
    gasFee: 5,
    occurredAt: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(first.netProfit, 95);
  assert.equal(first.reserveAllocation, 10);
  assert.equal(duplicate.recorded, false);
  assert.equal(duplicate.reserveAllocation, 0);
  assert.equal(state.reserveCents, 1000);
  assert.equal(state.grossCents, 10000);
});

test('arbitrage ingestion verifies net profit before recording', async () => {
  const { database, state } = makeYieldDatabase();
  const tracker = new YieldTrackerService(database);
  const trade = {
    tradeId: 'arb-42',
    grossProfit: 25,
    gasFee: 2.5,
    netProfit: 22.5,
    timestamp: '2026-01-01T00:00:00.000Z',
  };

  const result = await tracker.ingestArbitrageTrade(trade);
  assert.equal(result.netProfit, 22.5);
  assert.equal(result.reserveAllocation, 2.5);
  assert.equal(state.reserveCents, 250);
  await assert.rejects(
    tracker.ingestArbitrageTrade({ ...trade, tradeId: 'arb-bad', netProfit: 30 }),
    RangeError
  );
});

test('arbitrage losses remain visible when gas exceeds gross profit', async () => {
  const { database, state } = makeYieldDatabase();
  const tracker = new YieldTrackerService(database);
  const result = await tracker.ingestArbitrageTrade({
    tradeId: 'arb-loss',
    grossProfit: 5,
    gasFee: 6,
    netProfit: -1,
    timestamp: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(result.netProfit, -1);
  assert.equal(result.reserveAllocation, 0);
  assert.equal(state.reserveCents, 0);
});

test('payout queue schedules a fixed interval amount', async () => {
  const statements = [];
  const executor = {
    async query(sql, params) {
      statements.push({ sql, params });
      return [{ affectedRows: 1 }, []];
    },
  };
  const result = await scheduleNextPayout(executor, {
    userId: 9,
    holdingId: 12,
    principal: 5000,
    withdrawalInterval: 'bi-weekly',
    tiers: DEFAULT_TIERS,
    dueFrom: new Date('2026-01-01T00:00:00.000Z'),
  });

  assert.equal(result.payoutAmount, 625);
  assert.equal(result.dueAt.toISOString(), '2026-01-15T00:00:00.000Z');
  assert.equal(statements.length, 2);
  assert.match(statements[1].sql, /INSERT INTO payout_queue/);
});

test('paid investment payout increases profit cash, not initial capital', async () => {
  const state = {
    reserveCents: 20000,
    cashCents: 0,
    capitalCents: 0,
    profitCents: 0,
    payoutStatus: 'queued',
  };
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params) {
      if (sql.includes('SELECT q.id, q.user_id')) {
        return state.payoutStatus === 'queued'
          ? [[{
            id: 3,
            user_id: 9,
            holding_id: 12,
            withdrawal_interval: 'bi-weekly',
            amount_cents: 10000,
            due_at: new Date('2026-01-15T00:00:00.000Z'),
            principal_cents: 100000,
            maturity_at: new Date('2026-01-01T00:00:00.000Z'),
          }], []]
          : [[], []];
      }
      if (sql.includes('SELECT balance_cents FROM reserve_buffer')) return [[{ balance_cents: state.reserveCents }], []];
      if (sql.includes('UPDATE reserve_buffer SET balance_cents')) {
        state.reserveCents -= Number(params[0]);
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes("strategy = 'cash'")) return [[{ id: 22 }], []];
      if (sql.includes('SET amount_cents = amount_cents + ?, profit_cents = profit_cents + ?')) {
        state.cashCents += Number(params[0]);
        state.profitCents += Number(params[1]);
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes("VALUES (?, 'payout'")) return [{ affectedRows: 1 }, []];
      if (sql.includes("SET status = 'paid'")) {
        state.payoutStatus = 'paid';
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes("UPDATE payout_queue SET status = 'cancelled'")) return [{ affectedRows: 1 }, []];
      if (sql.includes('SELECT tier_key, min_principal_cents, monthly_rate_pct')) {
        return [[{ tier_key: 'tier_1', min_principal_cents: 100000, monthly_rate_pct: 20 }], []];
      }
      throw new Error(`Unexpected payout SQL: ${sql}`);
    },
  };
  const database = {
    getConnection: async () => connection,
    query: connection.query,
  };

  assert.equal(await processOnePayout(database, 3), 'paid');
  assert.equal(state.cashCents, 10000);
  assert.equal(state.capitalCents, 0);
  assert.equal(state.profitCents, 10000);
  assert.equal(state.reserveCents, 10000);
});

test('payout queue does not schedule payouts after investment maturity', async () => {
  const statements = [];
  const executor = {
    async query(sql, params) {
      statements.push({ sql, params });
      return [{ affectedRows: 1 }, []];
    },
  };
  const result = await scheduleNextPayout(executor, {
    userId: 9,
    holdingId: 12,
    principal: 1000,
    withdrawalInterval: 'monthly',
    tiers: DEFAULT_TIERS,
    dueFrom: new Date('2026-01-01T00:00:00.000Z'),
    maturityAt: new Date('2026-01-20T00:00:00.000Z'),
  });

  assert.equal(result, null);
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /UPDATE payout_queue SET status = 'cancelled'/);
});

test('maturity returns principal to capital cash once without changing profit', async () => {
  const state = { principalCents: 100000, capitalCents: 5000, profitCents: 12500, returns: 0 };
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params) {
      if (sql.includes('SELECT id, user_id, amount_cents, maturity_at')) {
        return state.principalCents > 0
          ? [[{ id: 12, user_id: 9, amount_cents: state.principalCents, maturity_at: new Date('2026-01-01T00:00:00.000Z') }], []]
          : [[], []];
      }
      if (sql.includes("strategy = 'cash'")) return [[{ id: 22 }], []];
      if (sql.includes('SET amount_cents = amount_cents + ?, capital_cents = capital_cents + ?')) {
        state.capitalCents += Number(params[1]);
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes('SET amount_cents = 0, target_yield_pct = 0')) {
        state.principalCents = 0;
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes("SET status = 'cancelled'")) return [{ affectedRows: 1 }, []];
      if (sql.includes("VALUES (?, 'maturity_return'")) {
        state.returns += 1;
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected maturity SQL: ${sql}`);
    },
  };
  const database = { getConnection: async () => connection };

  assert.equal(await processOneMaturity(database, 12), 'returned');
  assert.equal(state.principalCents, 0);
  assert.equal(state.capitalCents, 105000);
  assert.equal(state.profitCents, 12500);
  assert.equal(state.returns, 1);
  assert.equal(await processOneMaturity(database, 12), 'skipped');
  assert.equal(state.returns, 1);
});
