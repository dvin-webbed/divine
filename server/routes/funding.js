const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const cryptoWallets = {
  USDT: process.env.CRYPTO_WALLET_USDT || 'TQ9R9D8Kk2M4uNh7mV9b4gFxP7pL2ywC3x',
  USDC: process.env.CRYPTO_WALLET_USDC || '0x0000000000000000000000000000000000000000',
  BTC: process.env.CRYPTO_WALLET_BTC || '1395rEaDA8v5nFQosZk4JJQjwMumUhprKW',
  ETH: process.env.CRYPTO_WALLET_ETH || '0x0000000000000000000000000000000000000000',
  SOL: process.env.CRYPTO_WALLET_SOL || 'So11111111111111111111111111111111111111112',
};

const whatsappNumber = process.env.WHATSAPP_NUMBER || '+2348000000000';
const whatsappMessage = process.env.WHATSAPP_MESSAGE || 'Hello Blue Pips, I want to fund my account.';

function toCents(amount) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error('Amount must be a positive number.');
  }
  return Math.round(numeric * 100);
}

function whatsappHref() {
  const text = encodeURIComponent(whatsappMessage);
  return `https://wa.me/${whatsappNumber.replace(/\D/g, '')}?text=${text}`;
}

router.get('/methods', requireAuth, (req, res) => {
  res.json({
    methods: [
      { id: 'crypto', label: 'Crypto wallet', description: 'USDT, USDC, BTC, ETH, SOL' },
      { id: 'whatsapp', label: 'WhatsApp support', description: 'Contact customer care for alternative payment routes' },
    ],
    crypto_wallets: cryptoWallets,
    whatsapp: {
      number: whatsappNumber,
      message: whatsappMessage,
      link: whatsappHref(),
    },
  });
});

router.post('/request', requireAuth, (req, res) => {
  const { amount, currency = 'USD', method, wallet, network, notes } = req.body;

  if (!amount) {
    return res.status(400).json({ error: 'Amount is required.' });
  }

  if (!method || !['crypto', 'whatsapp'].includes(method)) {
    return res.status(400).json({ error: 'Payment method must be either crypto or whatsapp.' });
  }

  try {
    const amount_cents = toCents(amount);

    const insert = db.prepare(`
      INSERT INTO payment_requests (user_id, amount_cents, currency, method, wallet, network, notes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `);

    const result = insert.run(
      req.userId,
      amount_cents,
      String(currency).toUpperCase(),
      method,
      wallet || null,
      network || null,
      notes || null,
    );

    const request = db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(result.lastInsertRowid);

    if (method === 'whatsapp') {
      return res.status(201).json({
        message: 'Your funding request is ready. Please contact customer care on WhatsApp to complete payment.',
        whatsapp: {
          number: whatsappNumber,
          message: whatsappMessage,
          link: whatsappHref(),
        },
        request: {
          id: request.id,
          amount: request.amount_cents / 100,
          currency: request.currency,
          method: request.method,
          status: request.status,
        },
      });
    }

    return res.status(201).json({
      message: 'Your funding request has been logged. Send the funds to the wallet below and share the transaction hash.',
      request: {
        id: request.id,
        amount: request.amount_cents / 100,
        currency: request.currency,
        method: request.method,
        status: request.status,
      },
      crypto_wallets: cryptoWallets,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

module.exports = router;
