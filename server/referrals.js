const crypto = require('crypto');

const REFERRAL_COMMISSION_CENTS = 30000;
const REFERRAL_COMMISSION_PCT = 0;

function makeReferralCode() {
  return `BP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

async function ensureReferralCode(executor, userId) {
  const [rows] = await executor.query('SELECT referral_code FROM users WHERE id = ?', [userId]);
  if (!rows.length) return null;
  if (rows[0].referral_code) return rows[0].referral_code;

  let code;
  do {
    code = makeReferralCode();
    const [matches] = await executor.query('SELECT id FROM users WHERE referral_code = ?', [code]);
    if (!matches.length) break;
  } while (true);

  await executor.query('UPDATE users SET referral_code = ? WHERE id = ?', [code, userId]);
  return code;
}

module.exports = {
  REFERRAL_COMMISSION_CENTS,
  REFERRAL_COMMISSION_PCT,
  ensureReferralCode,
  makeReferralCode,
};