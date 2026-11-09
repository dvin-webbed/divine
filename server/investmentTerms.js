'use strict';

const INVESTMENT_TERM_YEARS = ['1', '2', '3', '5', '10'];
const LIFETIME_INVESTMENT_TERM = 'lifetime';
const VALID_INVESTMENT_TERMS = [...INVESTMENT_TERM_YEARS, LIFETIME_INVESTMENT_TERM];

function validateInvestmentTerm(term) {
  if (!VALID_INVESTMENT_TERMS.includes(String(term))) {
    throw new RangeError('Choose a valid investment term.');
  }
  return String(term);
}

function maturityDateForTerm(term, startDate = new Date()) {
  const normalizedTerm = validateInvestmentTerm(term);
  if (normalizedTerm === LIFETIME_INVESTMENT_TERM) return null;

  const maturityDate = new Date(startDate);
  if (Number.isNaN(maturityDate.getTime())) {
    throw new TypeError('startDate must be a valid date.');
  }
  maturityDate.setUTCFullYear(maturityDate.getUTCFullYear() + Number(normalizedTerm));
  return maturityDate;
}

function getMaturityLock(maturityAt, now = new Date()) {
  if (!maturityAt) return null;
  const maturityDate = new Date(maturityAt);
  const currentDate = new Date(now);
  if (Number.isNaN(maturityDate.getTime()) || Number.isNaN(currentDate.getTime())) {
    throw new TypeError('maturityAt and now must be valid dates.');
  }

  const remainingDays = Math.ceil((maturityDate.getTime() - currentDate.getTime()) / (24 * 60 * 60 * 1000));
  return remainingDays > 0 ? { maturityAt: maturityDate, remainingDays } : null;
}

module.exports = {
  INVESTMENT_TERM_YEARS,
  LIFETIME_INVESTMENT_TERM,
  VALID_INVESTMENT_TERMS,
  validateInvestmentTerm,
  maturityDateForTerm,
  getMaturityLock,
};
