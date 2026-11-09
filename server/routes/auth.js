const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');
const { logEvent } = require('../monitoring');
const { makeReferralCode } = require('../referrals');
const { validateInvestmentTerm } = require('../investmentTerms');
const {
  createVerificationCode,
  isVerificationCodeValid,
  isVerificationConfigured,
  normalizeEmail,
  normalizePhone,
  sendVerificationCode,
  verificationCodeHash,
} = require('../verification');

const router = express.Router();
const VERIFICATION_TTL_MS = 15 * 60 * 1000;
const RESEND_WAIT_MS = 60 * 1000;
const MAX_VERIFICATION_ATTEMPTS = 5;

function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '7d' });
}

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    goal: row.goal,
    horizon: row.horizon,
    investment_term: row.investment_term || 'lifetime',
  };
}

function isDuplicateEntry(error) {
  return error.code === 'ER_DUP_ENTRY';
}

router.post('/signup', async (req, res) => {
  let pendingId;
  try {
    const { name, password, goal, horizon, referral_code } = req.body;
    const email = normalizeEmail(req.body.contact);
    let investmentTerm;

    try {
      investmentTerm = validateInvestmentTerm(req.body.investment_term);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    if (req.body.channel !== 'email' || typeof name !== 'string' || !name.trim() || !email || typeof password !== 'string') {
      return res.status(400).json({ error: 'Name, a valid email address, and password are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    if (!isVerificationConfigured()) {
      return res.status(503).json({
        error: 'Email verification is not configured. Please contact support.',
      });
    }

    const [existingRows] = await pool.query(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );
    if (existingRows.length) {
      return res.status(409).json({ error: 'An account with that email address already exists.' });
    }

    let referrerId = null;
    if (referral_code) {
      const [referrers] = await pool.query(
        'SELECT id FROM users WHERE referral_code = ?',
        [String(referral_code).toUpperCase()]
      );
      if (!referrers.length) return res.status(400).json({ error: 'That referral code is not valid.' });
      referrerId = referrers[0].id;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const code = createVerificationCode();
    pendingId = crypto.randomUUID();
    await pool.query(
      'DELETE FROM pending_registrations WHERE verification_expires_at_ms < ?',
      [Date.now()]
    );
    await pool.query(
      'DELETE FROM pending_registrations WHERE email = ?',
      [email]
    );
    await pool.query(
      `INSERT INTO pending_registrations
       (id, name, email, phone, password_hash, goal, horizon, investment_term,
        referred_by_user_id, verification_code_hash, verification_expires_at_ms, last_sent_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pendingId,
        name.trim(),
        email,
        null,
        passwordHash,
        goal || null,
        horizon || null,
        investmentTerm,
        referrerId,
        verificationCodeHash(pendingId, code),
        Date.now() + VERIFICATION_TTL_MS,
        Date.now(),
      ]
    );

    try {
      await sendVerificationCode({ destination: email, code });
    } catch (error) {
      console.error('Registration verification delivery failed:', error.message);
      await pool.query('DELETE FROM pending_registrations WHERE id = ?', [pendingId]);
      pendingId = null;
      return res.status(502).json({
        error: 'We could not send your verification code. Please check the email provider settings and try again.',
      });
    }

    res.status(202).json({
      challengeId: pendingId,
      channel: 'email',
      message: 'A verification code was sent to your email.',
    });
  } catch (error) {
    console.error(error);
    if (pendingId) await pool.query('DELETE FROM pending_registrations WHERE id = ?', [pendingId]);
    res.status(500).json({ error: 'Something went wrong starting your registration.' });
  }
});

router.post('/signup/resend', async (req, res) => {
  try {
    const { challengeId } = req.body;
    if (typeof challengeId !== 'string') {
      return res.status(400).json({ error: 'A valid verification request is required.' });
    }

    const [rows] = await pool.query(
      'SELECT * FROM pending_registrations WHERE id = ?',
      [challengeId]
    );
    const pending = rows[0];
    if (!pending) return res.status(404).json({ error: 'This registration has expired. Please start again.' });

    if (!pending.email) {
      await pool.query('DELETE FROM pending_registrations WHERE id = ?', [challengeId]);
      return res.status(400).json({ error: 'Phone verification is no longer supported. Please start again.' });
    }
    if (!isVerificationConfigured()) {
      return res.status(503).json({ error: 'Verification delivery is not configured. Please contact support.' });
    }

    const waitMs = RESEND_WAIT_MS - (Date.now() - Number(pending.last_sent_at_ms));
    if (waitMs > 0) {
      return res.status(429).json({ error: 'Please wait a minute before requesting another code.' });
    }

    const code = createVerificationCode();
    await sendVerificationCode({ destination: pending.email, code });
    await pool.query(
      `UPDATE pending_registrations
       SET verification_code_hash = ?, verification_expires_at_ms = ?, last_sent_at_ms = ?, verification_attempts = 0
       WHERE id = ?`,
      [verificationCodeHash(challengeId, code), Date.now() + VERIFICATION_TTL_MS, Date.now(), challengeId]
    );

    res.json({ message: 'A new verification code was sent to your email.' });
  } catch (error) {
    console.error('Registration verification resend failed:', error.message);
    res.status(502).json({
      error: 'We could not send your verification code. Please check the email provider settings and try again.',
    });
  }
});

router.post('/signup/verify', async (req, res) => {
  const { challengeId, code } = req.body;
  if (typeof challengeId !== 'string' || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Enter the six-digit verification code.' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.query(
      'SELECT * FROM pending_registrations WHERE id = ? FOR UPDATE',
      [challengeId]
    );
    const pending = rows[0];
    if (!pending) {
      await connection.rollback();
      return res.status(400).json({ error: 'This registration has expired. Please start again.' });
    }
    if (!pending.email) {
      await connection.query('DELETE FROM pending_registrations WHERE id = ?', [challengeId]);
      await connection.commit();
      return res.status(400).json({ error: 'Phone verification is no longer supported. Please start again.' });
    }
    if (Number(pending.verification_expires_at_ms) < Date.now()) {
      await connection.query('DELETE FROM pending_registrations WHERE id = ?', [challengeId]);
      await connection.commit();
      return res.status(400).json({ error: 'This code has expired. Please start your registration again.' });
    }
    if (Number(pending.verification_attempts) >= MAX_VERIFICATION_ATTEMPTS) {
      await connection.query('DELETE FROM pending_registrations WHERE id = ?', [challengeId]);
      await connection.commit();
      return res.status(429).json({ error: 'Too many incorrect codes. Please start your registration again.' });
    }
    if (!isVerificationCodeValid(challengeId, code, pending.verification_code_hash)) {
      const attempts = Number(pending.verification_attempts) + 1;
      if (attempts >= MAX_VERIFICATION_ATTEMPTS) {
        await connection.query('DELETE FROM pending_registrations WHERE id = ?', [challengeId]);
        await connection.commit();
        return res.status(429).json({ error: 'Too many incorrect codes. Please start your registration again.' });
      }
      await connection.query(
        'UPDATE pending_registrations SET verification_attempts = ? WHERE id = ?',
        [attempts, challengeId]
      );
      await connection.commit();
      return res.status(400).json({ error: `That code is incorrect. ${MAX_VERIFICATION_ATTEMPTS - attempts} attempts remaining.` });
    }

    const [result] = await connection.query(
      `INSERT INTO users
       (name, email, phone, password_hash, goal, horizon, investment_term, referral_code, referred_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pending.name,
        pending.email,
        pending.phone,
        pending.password_hash,
        pending.goal,
        pending.horizon,
        pending.investment_term,
        makeReferralCode(),
        pending.referred_by_user_id,
      ]
    );

    await connection.query(
      `INSERT INTO holdings (user_id, strategy, label, amount_cents, target_yield_pct)
       VALUES (?, 'tiered', 'Tiered Income', 0, 0)`,
      [result.insertId]
    );
    if (pending.referred_by_user_id) {
      await connection.query(
        'INSERT INTO referrals (referrer_id, referred_user_id) VALUES (?, ?)',
        [pending.referred_by_user_id, result.insertId]
      );
    }
    await connection.query('DELETE FROM pending_registrations WHERE id = ?', [challengeId]);
    await connection.commit();

    const [userRows] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
    const user = userRows[0];
    const token = signToken(user.id);
    await logEvent('signup', { user_id: user.id, goal: user.goal }, user.id);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (error) {
    if (connection) await connection.rollback();
    if (isDuplicateEntry(error)) {
      return res.status(409).json({ error: 'An account with that email address already exists.' });
    }
    console.error(error);
    res.status(500).json({ error: 'Something went wrong verifying your registration.' });
  } finally {
    connection?.release();
  }
});

router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (typeof identifier !== 'string' || !identifier.trim() || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Email or phone number and password are required.' });
    }

    const isEmail = identifier.includes('@');
    const contact = isEmail ? normalizeEmail(identifier) : normalizePhone(identifier);
    const column = isEmail ? 'email' : 'phone';
    const [rows] = contact
      ? await pool.query(`SELECT * FROM users WHERE ${column} = ?`, [contact])
      : [[]];
    const user = rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      if (contact) {
        const [pendingRows] = await pool.query(
          `SELECT password_hash FROM pending_registrations WHERE ${column} = ?`,
          [contact]
        );
        if (pendingRows[0] && await bcrypt.compare(password, pendingRows[0].password_hash)) {
          return res.status(403).json({ error: 'Please verify your email or phone number before signing in.' });
        }
      }
      return res.status(401).json({ error: 'Incorrect email/phone number or password.' });
    }

    const token = signToken(user.id);
    await logEvent('login', {}, user.id);
    res.json({ token, user: publicUser(user) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong logging you in.' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.userId]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ user: publicUser(user) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong loading your profile.' });
  }
});

module.exports = router;
