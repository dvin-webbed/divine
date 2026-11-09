const express = require('express');
const { pool, getTransactionsTable } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { STRATEGIES, PAYOUT_FREQUENCIES, targetYieldForAmount } = require('../portfolio');
const { REFERRAL_COMMISSION_CENTS, REFERRAL_COMMISSION_PCT, ensureReferralCode } = require('../referrals');
const { calculateInvestmentReturns } = require('../investmentReturns');
const { loadInvestmentTiers } = require('../UserPayoutEngine');
const { scheduleNextPayout } = require('../PayoutQueueService');
const { maturityDateForTerm, getMaturityLock } = require('../investmentTerms');

const router = express.Router();

const LIQUIDITY_RULES = {
  '6 months to 1 year': { days: 30, label: 'monthly' },
  '1 to 3 years': { days: 90, label: 'once every 3 months' },
  Lifetime: { days: 365, label: 'once a year' },
};

function liquidityRule(horizon, investmentTerm) {
  if (investmentTerm === 'lifetime') return LIQUIDITY_RULES.Lifetime;
  if (['1', '2', '3', '5', '10'].includes(investmentTerm)) {
    return { days: 90, label: 'once every 3 months after maturity' };
  }
  return LIQUIDITY_RULES[horizon] || LIQUIDITY_RULES['1 to 3 years'];
}

router.get('/', requireAuth, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [holdings] = await conn.query(
      `SELECT strategy, label, amount_cents, target_yield_pct, payout_frequency,
          investment_horizon, investment_term, maturity_at, capital_cents, profit_cents,
          pending_payout_cents, opened_at
       FROM holdings WHERE user_id = ?`,
      [req.userId]
    );
    await conn.commit();

    const totalCents = holdings.reduce((sum, h) => sum + Number(h.amount_cents) + Number(h.pending_payout_cents || 0), 0);
    const visibleHoldings = holdings.filter(h => (
      h.strategy === 'cash'
      || STRATEGIES[h.strategy]
      || Number(h.amount_cents) > 0
      || Number(h.pending_payout_cents || 0) > 0
    ));

    res.json({
      total_balance: totalCents / 100,
      available_cash: Number(holdings.find(h => h.strategy === 'cash')?.amount_cents || 0) / 100,
      available_initial_capital: Number(holdings.find(h => h.strategy === 'cash')?.capital_cents || 0) / 100,
      available_profit: Number(holdings.find(h => h.strategy === 'cash')?.profit_cents || 0) / 100,
      holdings: visibleHoldings.map(h => ({
        strategy: h.strategy,
        label: STRATEGIES[h.strategy]?.label || (h.strategy === 'cash' ? h.label : 'Archived position'),
        archived: h.strategy !== 'cash' && !STRATEGIES[h.strategy],
        balance: (Number(h.amount_cents) + Number(h.pending_payout_cents || 0)) / 100,
        pending_payout: Number(h.pending_payout_cents || 0) / 100,
        target_yield_pct: Number(h.target_yield_pct),
        payout_frequency: h.payout_frequency,
        investment_horizon: h.investment_horizon,
        investment_term: h.investment_term || 'lifetime',
        maturity_at: h.maturity_at,
        matured: h.strategy === 'tiered'
          && Number(h.amount_cents) === 0
          && Boolean(h.maturity_at)
          && new Date(h.maturity_at).getTime() <= Date.now(),
        opened_at: h.opened_at,
      })),
    });
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback();
      } catch (rollbackErr) {
        console.warn('Portfolio rollback failed:', rollbackErr.message);
      }
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong loading your portfolio.' });
  } finally {
    if (conn) conn.release();
  }
});

router.post('/invest', requireAuth, async (req, res) => {
  const {
    strategy = 'tiered',
    amount,
    withdrawal_interval,
    payout_frequency,
  } = req.body;
  const requestedInterval = withdrawal_interval || payout_frequency || 'monthly';
  const selectedInterval = requestedInterval === 'biweekly' ? 'bi-weekly' : requestedInterval;
  const strategyConfig = STRATEGIES[strategy];
  const amountCents = Math.round(Number(amount) * 100);
  if (!strategyConfig) return res.status(400).json({ error: 'Choose a valid strategy.' });
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return res.status(400).json({ error: 'Investment amount must be positive.' });
  }
  if (!PAYOUT_FREQUENCIES.includes(selectedInterval)) {
    return res.status(400).json({ error: 'Choose a valid payout frequency.' });
  }

  let tiers;
  try {
    tiers = await loadInvestmentTiers(pool);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Investment tiers are temporarily unavailable.' });
  }

  let returnEstimate = null;
  if (strategy === 'tiered') {
    try {
      returnEstimate = calculateInvestmentReturns(amountCents / 100, selectedInterval, tiers);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [[user]] = await conn.query('SELECT horizon, investment_term FROM users WHERE id = ?', [req.userId]);
    const investmentHorizon = user?.horizon || 'Less than 3 years';
    const registeredTerm = user?.investment_term || 'lifetime';
    const [cashRows] = await conn.query(
      "SELECT id, amount_cents, capital_cents FROM holdings WHERE user_id = ? AND strategy = 'cash' FOR UPDATE",
      [req.userId]
    );
    const cash = cashRows[0];
    if (!cash || Number(cash.capital_cents || 0) < amountCents) {
      await conn.rollback();
      return res.status(400).json({ error: 'That exceeds your available initial capital balance.' });
    }

    await conn.query(
      `UPDATE holdings SET amount_cents = amount_cents - ?, capital_cents = capital_cents - ? WHERE id = ?`,
      [amountCents, amountCents, cash.id]
    );
    const [existingPositions] = await conn.query(
      `SELECT id, investment_term, maturity_at FROM holdings
       WHERE user_id = ? AND strategy = ? AND amount_cents > 0
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [req.userId, strategy]
    );
    const currentPosition = existingPositions[0];
    const hasExistingPrincipal = Boolean(currentPosition);
    const investmentTerm = hasExistingPrincipal
      ? currentPosition.investment_term || registeredTerm
      : registeredTerm;
    const maturityAt = hasExistingPrincipal
      ? currentPosition.maturity_at
      : maturityDateForTerm(investmentTerm, new Date());
    if (hasExistingPrincipal && maturityAt && Date.now() >= new Date(maturityAt).getTime()) {
      await conn.rollback();
      return res.status(400).json({
        error: 'This investment has reached maturity. Submit a liquidity request before investing additional principal.',
        maturityAt,
      });
    }
    if (strategy === 'tiered') {
      returnEstimate = calculateInvestmentReturns(amountCents / 100, selectedInterval, tiers);
    }
    const [insertResult] = await conn.query(
      `INSERT INTO holdings
       (user_id, strategy, label, amount_cents, target_yield_pct, payout_frequency,
        investment_horizon, investment_term, maturity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.userId, strategy, strategyConfig.label, amountCents,
        targetYieldForAmount(strategy, amountCents, tiers), selectedInterval,
        investmentHorizon, investmentTerm, maturityAt]
    );
    const holdingId = insertResult.insertId;
    const nextPayout = await scheduleNextPayout(conn, {
      userId: req.userId,
      holdingId,
      principal: amountCents / 100,
      withdrawalInterval: selectedInterval,
      tiers,
      maturityAt,
    });
    await conn.query(
      `INSERT INTO ${getTransactionsTable()} (user_id, type, method, amount_cents, status, provider, provider_ref)
       VALUES (?, 'investment', 'internal', ?, 'completed', 'internal', ?)`,
      [req.userId, amountCents, `${strategy}:${selectedInterval}`]
    );

    const [referrals] = await conn.query(
      `SELECT id, referrer_id FROM referrals
       WHERE referred_user_id = ? AND status = 'pending' FOR UPDATE`,
      [req.userId]
    );
    if (referrals.length) {
      const referral = referrals[0];
      const commissionCents = REFERRAL_COMMISSION_CENTS;
      const [referrerCash] = await conn.query(
        "SELECT id FROM holdings WHERE user_id = ? AND strategy = 'cash' FOR UPDATE",
        [referral.referrer_id]
      );
      if (referrerCash.length) {
        await conn.query(
          `UPDATE holdings SET amount_cents = amount_cents + ?, profit_cents = profit_cents + ? WHERE id = ?`,
          [commissionCents, commissionCents, referrerCash[0].id]
        );
      } else {
        await conn.query(
          `INSERT INTO holdings (user_id, strategy, label, amount_cents, target_yield_pct, capital_cents, profit_cents)
           VALUES (?, 'cash', 'Uninvested cash', ?, 0, 0, ?)`,
          [referral.referrer_id, commissionCents]
        );
      }
      await conn.query(
        "UPDATE referrals SET commission_cents = ?, status = 'rewarded', rewarded_at = CURRENT_TIMESTAMP WHERE id = ?",
        [commissionCents, referral.id]
      );
      await conn.query(
        `INSERT INTO ${getTransactionsTable()} (user_id, type, method, amount_cents, status, provider, provider_ref)
         VALUES (?, 'referral_commission', 'referral', ?, 'completed', 'internal', ?)`,
        [referral.referrer_id, commissionCents, `referral:${req.userId}`]
      );
    }
    await conn.commit();
    res.status(201).json({
      message: 'Your cash is now invested.',
      strategy,
      payout_frequency: selectedInterval,
      principal: returnEstimate?.principal,
      appliedMonthlyRate: returnEstimate?.appliedMonthlyRate,
      payoutAmount: returnEstimate?.payoutAmount,
      nextPayoutAt: nextPayout?.dueAt || null,
      investmentTerm,
      maturityAt,
    });
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback();
      } catch (rollbackErr) {
        console.warn('Investment rollback failed:', rollbackErr.message);
      }
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong investing your cash.' });
  } finally {
    if (conn) conn.release();
  }
});

router.post('/liquidity', requireAuth, async (req, res) => {
  const { strategy } = req.body;

  if (!STRATEGIES[strategy]) {
    return res.status(400).json({ error: 'Choose a valid invested strategy.' });
  }

  try {
    const [holdings] = await pool.query(
      `SELECT SUM(h.amount_cents) AS amount_cents, MIN(h.opened_at) AS opened_at,
              MAX(h.investment_horizon) AS investment_horizon,
              MAX(h.investment_term) AS investment_term, MAX(h.maturity_at) AS maturity_at,
              u.horizon
       FROM holdings h JOIN users u ON u.id = h.user_id
       WHERE h.user_id = ? AND h.strategy = ?
       GROUP BY u.horizon`,
      [req.userId, strategy]
    );
    if (!holdings.length || Number(holdings[0].amount_cents) <= 0) {
      return res.status(400).json({ error: 'You do not have an active position in that strategy.' });
    }

    const maturityLock = getMaturityLock(holdings[0].maturity_at);
    if (maturityLock) {
      return res.status(400).json({
        error: `This investment is locked until ${maturityLock.maturityAt.toISOString().slice(0, 10)}. Approximately ${maturityLock.remainingDays} days remain in its term.`,
        ...maturityLock,
      });
    }

    const horizon = holdings[0].investment_horizon || holdings[0].horizon || '1 to 3 years';
    const rule = liquidityRule(horizon, holdings[0].investment_term);
    const [recentRequests] = await pool.query(
      `SELECT requested_at FROM liquidity_requests
       WHERE user_id = ? AND strategy = ? AND status IN ('requested', 'approved', 'paid')
       ORDER BY requested_at DESC LIMIT 1`,
      [req.userId, strategy]
    );
    const lastRequestAt = recentRequests[0]?.requested_at;
    const referenceDate = lastRequestAt || holdings[0].opened_at;
    const elapsedDays = (Date.now() - new Date(referenceDate).getTime()) / (24 * 60 * 60 * 1000);
    if (elapsedDays < rule.days) {
      const remainingDays = Math.ceil(rule.days - elapsedDays);
      return res.status(400).json({
        error: `Liquidity is available ${rule.label}. Please wait approximately ${remainingDays} more days.`,
      });
    }

    const [pending] = await pool.query(
      `SELECT id FROM liquidity_requests WHERE user_id = ? AND strategy = ? AND status = 'requested' LIMIT 1`,
      [req.userId, strategy]
    );
    if (pending.length) {
      return res.status(409).json({ error: 'You already have a liquidity request pending for this strategy.' });
    }

    await pool.query(
      `INSERT INTO liquidity_requests (user_id, strategy, amount_cents) VALUES (?, ?, ?)`,
      [req.userId, strategy, holdings[0].amount_cents]
    );
    res.status(201).json({
      message: `Liquidity request submitted for review. This ${horizon} investment allows requests ${rule.label}.`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong submitting your liquidity request.' });
  }
});

router.get('/referrals', requireAuth, async (req, res) => {
  try {
    const code = await ensureReferralCode(pool, req.userId);
    const [rows] = await pool.query(
      `SELECT r.status, r.commission_cents, r.created_at, r.rewarded_at, u.name
       FROM referrals r JOIN users u ON u.id = r.referred_user_id
       WHERE r.referrer_id = ? ORDER BY r.created_at DESC`,
      [req.userId]
    );
    const totalCommissionCents = rows.reduce((sum, row) => sum + Number(row.commission_cents), 0);
    res.json({
      code,
      link: `${req.protocol}://${req.get('host')}/get-started.html?ref=${encodeURIComponent(code)}`,
      commission_rate_pct: REFERRAL_COMMISSION_PCT,
      commission_amount_usd: REFERRAL_COMMISSION_CENTS / 100,
      total_commission: totalCommissionCents / 100,
      referrals: rows.map(row => ({
        name: row.name,
        status: row.status,
        commission: Number(row.commission_cents) / 100,
        created_at: row.created_at,
        rewarded_at: row.rewarded_at,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong loading your referrals.' });
  }
});

module.exports = router;
