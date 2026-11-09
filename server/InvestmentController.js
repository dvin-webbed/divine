'use strict';

const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool, getTransactionsTable } = require('./db');
const { requireAuth } = require('./middleware/auth');
const {
  calculateUserPayout,
  loadInvestmentTiers,
  MAX_MONTHLY_RATE_PERCENT,
  WITHDRAWAL_INTERVALS,
} = require('./UserPayoutEngine');
const { YieldTrackerService } = require('./YieldTrackerService');

const router = express.Router();
const yieldTracker = new YieldTrackerService(pool);

const calculateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payout calculations. Try again shortly.' },
});

function requireArbitrageKey(req, res, next) {
  const configuredKey = process.env.ARBITRAGE_INGEST_KEY || '';
  if (!configuredKey) {
    return res.status(503).json({ error: 'Arbitrage ingestion is not configured.' });
  }

  const providedKey = req.get('x-yield-ingest-key') || '';
  const provided = Buffer.from(providedKey);
  const expected = Buffer.from(configuredKey);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return res.status(401).json({ error: 'Missing or invalid yield ingestion key.' });
  }
  next();
}

router.post('/investments/calculate', calculateLimiter, async (req, res) => {
  try {
    const principal = Number(req.body?.principal);
    const withdrawalInterval = req.body?.withdrawalInterval;
    const tiers = await loadInvestmentTiers(pool);
    const quote = calculateUserPayout(principal, withdrawalInterval, tiers);
    res.json({
      ...quote,
      currency: 'USD',
      disclaimer: 'Illustrative estimate only; returns are not guaranteed.',
    });
  } catch (error) {
    const status = error instanceof TypeError || error instanceof RangeError ? 400 : 500;
    if (status === 500) console.error('Investment quote failed:', error);
    res.status(status).json({
      error: status === 400 ? error.message : 'Unable to calculate an investment estimate.',
    });
  }
});

router.get('/investments/tiers', async (req, res) => {
  try {
    const tiers = await loadInvestmentTiers(pool);
    const normalizedTiers = tiers.map((tier, index) => {
      const quote = calculateUserPayout(tier.minPrincipal, 'monthly', tiers);
      return {
        tierName: quote.tierName,
        minPrincipal: quote.principal,
        maxPrincipal: tiers[index + 1] ? tiers[index + 1].minPrincipal - 0.01 : null,
        monthlyRatePercent: quote.monthlyRatePercentage,
        monthlyProfitAtMinimum: quote.monthlyProfit,
      };
    });
    res.json({
      tiers: normalizedTiers,
      maxMonthlyRatePercent: MAX_MONTHLY_RATE_PERCENT,
      withdrawalIntervals: Object.keys(WITHDRAWAL_INTERVALS),
    });
  } catch (error) {
    console.error('Investment tier listing failed:', error);
    res.status(500).json({ error: 'Investment tiers are temporarily unavailable.' });
  }
});

router.get('/user/dashboard', requireAuth, async (req, res) => {
  try {
    const [[user]] = await pool.query(
      'SELECT id, name, email, goal, horizon, investment_term, created_at FROM users WHERE id = ?',
      [req.userId]
    );
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const [[holding]] = await pool.query(
            `SELECT id, amount_cents, target_yield_pct, payout_frequency, last_payout_at,
              investment_term, maturity_at
       FROM holdings WHERE user_id = ? AND strategy = 'tiered' AND amount_cents > 0
       ORDER BY id DESC LIMIT 1`,
      [req.userId]
    );
    const [[principalTotals]] = await pool.query(
      `SELECT COALESCE(SUM(amount_cents), 0) AS invested_principal_cents
       FROM holdings WHERE user_id = ? AND strategy = 'tiered'`,
      [req.userId]
    );
    const [[cash]] = await pool.query(
      `SELECT capital_cents, profit_cents FROM holdings
       WHERE user_id = ? AND strategy = 'cash' LIMIT 1`,
      [req.userId]
    );
    const [[profitPaid]] = await pool.query(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total_cents
       FROM ${getTransactionsTable()}
       WHERE user_id = ? AND type = 'payout' AND status = 'completed'`,
      [req.userId]
    );
    const [[capitalReturned]] = await pool.query(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total_cents
       FROM ${getTransactionsTable()}
       WHERE user_id = ? AND type = 'maturity_return' AND status = 'completed'`,
      [req.userId]
    );

    const [queueRows] = await pool.query(
      `SELECT amount_cents, withdrawal_interval, due_at, status
       FROM payout_queue WHERE user_id = ? AND status IN ('queued','held')
       ORDER BY due_at ASC LIMIT 1`,
      [req.userId]
    );
    const [[pendingProfitRows]] = await pool.query(
      `SELECT COALESCE(SUM(amount_cents), 0) AS pending_profit_cents
       FROM payout_queue WHERE user_id = ? AND status IN ('queued','held')`,
      [req.userId]
    );

    let investmentProfile = null;
    if (holding) {
      const tiers = await loadInvestmentTiers(pool);
      const quote = calculateUserPayout(
        Number(holding.amount_cents) / 100,
        holding.payout_frequency,
        tiers
      );
      investmentProfile = {
        principal: quote.principal,
        tierName: quote.tierName,
        tierRatePercent: quote.appliedMonthlyRate,
        monthlyProfitEstimate: quote.monthlyProfit,
        withdrawalInterval: quote.interval,
        payoutEstimate: quote.payoutAmount,
        lastPayoutAt: holding.last_payout_at,
        investmentTerm: holding.investment_term || user.investment_term || 'lifetime',
        maturityAt: holding.maturity_at,
      };
    }

    const nextPayout = queueRows[0]
      ? {
        amount: Number(queueRows[0].amount_cents) / 100,
        interval: queueRows[0].withdrawal_interval,
        dueAt: queueRows[0].due_at,
        status: queueRows[0].status,
      }
      : null;

    const yieldTransparency = await yieldTracker.getTransparencyMetrics();
    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        goal: user.goal,
        horizon: user.horizon,
        investmentTerm: user.investment_term || 'lifetime',
        createdAt: user.created_at,
      },
      investmentProfile,
      investmentBalances: {
        initialCapitalAvailable: Number(cash?.capital_cents || 0) / 100,
        investedPrincipal: Number(principalTotals.invested_principal_cents || 0) / 100,
        profitAvailable: Number(cash?.profit_cents || 0) / 100,
        profitPaidToDate: Number(profitPaid.total_cents || 0) / 100,
        profitPending: Number(pendingProfitRows.pending_profit_cents || 0) / 100,
        capitalReturnedToCash: Number(capitalReturned.total_cents || 0) / 100,
      },
      assignedTierRate: investmentProfile?.tierRatePercent ?? null,
      upcomingPayout: nextPayout,
      yieldTransparency,
    });
  } catch (error) {
    console.error('User dashboard load failed:', error);
    res.status(500).json({ error: 'Unable to load the user dashboard.' });
  }
});

router.post('/yields/arbitrage', requireArbitrageKey, async (req, res) => {
  try {
    const result = await yieldTracker.ingestArbitrageTrade(req.body);
    res.status(result.recorded ? 201 : 200).json({
      ...result,
      reservePercent: 10,
    });
  } catch (error) {
    const status = error instanceof TypeError || error instanceof RangeError ? 400 : 500;
    if (status === 500) console.error('Arbitrage yield ingestion failed:', error);
    res.status(status).json({
      error: status === 400 ? error.message : 'Unable to record arbitrage yield.',
    });
  }
});

module.exports = { router, yieldTracker };
