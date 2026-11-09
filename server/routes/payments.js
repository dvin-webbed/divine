const express = require('express');
const { pool, getTransactionsTable } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logEvent } = require('../monitoring');
const {
  validateAmountCents,
  MIN_AMOUNT_CENTS,
  MAX_AMOUNT_CENTS,
  MAX_DEPOSIT_AMOUNT_CENTS,
} = require('../config/limits');
const { getProviderForMethod, getMethodStatus } = require('../payments/provider');
const { getBankDirectoryConfig, searchBanks } = require('../payments/bankDirectory');

const router = express.Router();

const VALID_METHODS = ['ach', 'crypto'];

// Publicly tells the frontend which methods exist and whether they're
// sandbox (no real money moves) or live - so the UI never claims to process
// a real payment when it can't.
router.get('/methods', (req, res) => {
  res.json({
    min_amount_cents: MIN_AMOUNT_CENTS,
    max_amount_cents: MAX_AMOUNT_CENTS,
    max_deposit_amount_cents: MAX_DEPOSIT_AMOUNT_CENTS,
    methods: getMethodStatus(),
    bank_directory: getBankDirectoryConfig(),
    crypto: { asset: 'USDT', network: 'TRC20' },
    crypto_wallets: {
      USDT_TRC20: process.env.CRYPTO_WALLET_USDT_TRC20 || null,
    },
  });
});

router.get('/banks', requireAuth, async (req, res) => {
  try {
    const banks = await searchBanks({
      countryCode: req.query.country_code,
      query: req.query.query,
    });
    res.json({ banks });
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message });
  }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT type, method, amount_cents, status, provider, created_at
      FROM ${getTransactionsTable()} WHERE user_id = ? ORDER BY created_at DESC LIMIT 25`,
      [req.userId]
    );
    res.json({
      transactions: rows.map(r => ({
        type: r.type,
        method: r.method,
        amount: Number(r.amount_cents) / 100,
        status: r.status,
        provider: r.provider,
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong loading your transaction history.' });
  }
});

async function handleFunding(req, res, type) {
  let conn;
  try {
    const { amount, method, bankInstitutionId, walletAddress } = req.body;

    if (!VALID_METHODS.includes(method)) {
      return res.status(400).json({ error: 'Choose a valid payment method.' });
    }

    const amountCents = Math.round(Number(amount) * 100);
    const maximum = type === 'deposit' ? MAX_DEPOSIT_AMOUNT_CENTS : MAX_AMOUNT_CENTS;
    const validationError = validateAmountCents(amountCents, maximum);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    if (method === 'ach' && (!bankInstitutionId || !/^ins_[A-Za-z0-9_-]+$/.test(bankInstitutionId))) {
      return res.status(400).json({ error: 'Search for and select a supported bank.' });
    }
    if (method === 'crypto' && type === 'withdrawal' && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(walletAddress || ''))) {
      return res.status(400).json({ error: 'Enter a valid TRON address for USDT (TRC20).'});
    }
    if (method === 'crypto' && type === 'deposit' && !process.env.CRYPTO_WALLET_USDT_TRC20) {
      return res.status(503).json({ error: 'USDT deposits are unavailable until a TRC20 receiving wallet is configured.' });
    }

    if (type === 'withdrawal') {
      const [[{ total }]] = await pool.query(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM holdings WHERE user_id = ? AND strategy = 'cash'`,
        [req.userId]
      );
      if (amountCents > Number(total)) {
        return res.status(400).json({ error: 'That exceeds your available balance.' });
      }
    }

    let provider;
    try {
      provider = getProviderForMethod(method);
    } catch (err) {
      // A real provider is configured (env vars set) but not implemented yet -
      // fail loudly rather than silently falling back to mock in that case.
      console.error(err);
      return res.status(503).json({ error: 'This payment method is temporarily unavailable.' });
    }

    const result =
      type === 'deposit'
        ? await provider.initiateDeposit({ userId: req.userId, amountCents, method, bankInstitutionId })
        : await provider.initiateWithdrawal({ userId: req.userId, amountCents, method, bankInstitutionId, walletAddress });

    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [txResult] = await conn.query(
      `INSERT INTO ${getTransactionsTable()} (user_id, type, method, amount_cents, status, provider, provider_ref,
         destination_address, destination_institution_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.userId, type, method, amountCents, result.status, provider.name, result.providerRef,
        type === 'withdrawal' && method === 'crypto' ? walletAddress : null,
        method === 'ach' ? bankInstitutionId : null]
    );

    // Only move the cash balance once a transaction is actually completed.
    // A real webhook-driven provider would call this same update from a
    // webhook handler once it confirms settlement, not synchronously here.
    if (result.status === 'completed') {
      const delta = type === 'deposit' ? amountCents : -amountCents;
      const [existingCash] = await conn.query(
        `SELECT id, amount_cents, capital_cents, profit_cents FROM holdings
         WHERE user_id = ? AND strategy = 'cash' LIMIT 1 FOR UPDATE`,
        [req.userId]
      );

      if (existingCash.length) {
        if (type === 'deposit') {
          await conn.query(
            `UPDATE holdings SET amount_cents = amount_cents + ?, capital_cents = capital_cents + ? WHERE id = ?`,
            [amountCents, amountCents, existingCash[0].id]
          );
        } else {
          const capitalDebit = Math.min(amountCents, Number(existingCash[0].capital_cents || 0));
          const profitDebit = amountCents - capitalDebit;
          if (profitDebit > Number(existingCash[0].profit_cents || 0)) {
            throw new Error('Cash balance components do not cover this withdrawal.');
          }
          await conn.query(
            `UPDATE holdings
             SET amount_cents = amount_cents + ?, capital_cents = capital_cents - ?, profit_cents = profit_cents - ?
             WHERE id = ?`,
            [delta, capitalDebit, profitDebit, existingCash[0].id]
          );
        }
      } else {
        await conn.query(
          `INSERT INTO holdings (user_id, strategy, label, amount_cents, target_yield_pct, capital_cents, profit_cents)
           VALUES (?, 'cash', 'Uninvested cash', ?, 0, ?, 0)`,
          [req.userId, amountCents, amountCents]
        );
      }
    }
    await conn.commit();

    await logEvent(`${type}_${result.status}`, { method, amount_cents: amountCents }, req.userId);

    res.status(201).json({
      transaction_id: txResult.insertId,
      status: result.status,
      provider: provider.name,
    });
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback();
      } catch (rollbackErr) {
        console.warn(`${type} rollback failed:`, rollbackErr.message);
      }
    }
    console.error(err);
    res.status(500).json({ error: `Something went wrong processing your ${type}.` });
  } finally {
    if (conn) conn.release();
  }
}

router.post('/deposit', requireAuth, (req, res) => handleFunding(req, res, 'deposit'));
router.post('/withdraw', requireAuth, (req, res) => handleFunding(req, res, 'withdrawal'));

module.exports = router;
