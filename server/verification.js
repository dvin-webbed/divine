'use strict';

const crypto = require('crypto');
const { parsePhoneNumberFromString } = require('libphonenumber-js');

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function normalizePhone(value, country) {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (!input) return null;
  const phoneNumber = parsePhoneNumberFromString(input, country);
  if (!phoneNumber || !phoneNumber.isValid()) return null;
  return phoneNumber.number;
}

function createVerificationCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function verificationCodeHash(challengeId, code) {
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'dev-secret-change-me')
    .update(`${challengeId}:${code}`)
    .digest('hex');
}

function isVerificationCodeValid(challengeId, code, storedHash) {
  const expected = Buffer.from(verificationCodeHash(challengeId, code), 'hex');
  const actual = Buffer.from(storedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function emailSettingsConfigured() {
  return Boolean(process.env.BREVO_API_KEY && process.env.BREVO_FROM_EMAIL);
}

function isVerificationConfigured() {
  return emailSettingsConfigured();
}

async function sendVerificationCode({ destination, code }) {
  if (!emailSettingsConfigured()) throw new Error('Brevo API verification settings are incomplete.');
  const sender = { email: process.env.BREVO_FROM_EMAIL };
  if (process.env.BREVO_FROM_NAME) sender.name = process.env.BREVO_FROM_NAME;
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender,
      to: [{ email: destination }],
      subject: 'Your Blue Pips verification code',
      textContent: `Your Blue Pips verification code is ${code}. It expires in 15 minutes.`,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const details = (await response.text()).slice(0, 1000);
    throw new Error(`Brevo API request failed (${response.status}): ${details}`);
  }
}

module.exports = {
  createVerificationCode,
  isVerificationCodeValid,
  isVerificationConfigured,
  normalizeEmail,
  normalizePhone,
  sendVerificationCode,
  verificationCodeHash,
};
