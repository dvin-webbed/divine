'use strict';

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { parsePhoneNumberFromString } = require('libphonenumber-js');

let emailTransport;

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
  const hasAuthUser = Boolean(process.env.SMTP_USER);
  const hasAuthPassword = Boolean(process.env.SMTP_PASSWORD);
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM) && hasAuthUser === hasAuthPassword;
}

function isVerificationConfigured() {
  return emailSettingsConfigured();
}

async function sendVerificationCode({ destination, code }) {
  if (!emailSettingsConfigured()) throw new Error('SMTP verification settings are incomplete.');
  if (!emailTransport) {
    const port = Number(process.env.SMTP_PORT) || 587;
    const auth = process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined;
    emailTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      ...(auth ? { auth } : {}),
    });
  }
  await emailTransport.sendMail({
    from: process.env.SMTP_FROM,
    to: destination,
    subject: 'Your Blue Pips verification code',
    text: `Your Blue Pips verification code is ${code}. It expires in 15 minutes.`,
  });
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
