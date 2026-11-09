const BANK_COUNTRIES = [
  { code: 'US', name: 'United States' },
  { code: 'CA', name: 'Canada' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'IE', name: 'Ireland' },
  { code: 'FR', name: 'France' },
  { code: 'ES', name: 'Spain' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'DE', name: 'Germany' },
  { code: 'IT', name: 'Italy' },
  { code: 'PL', name: 'Poland' },
  { code: 'DK', name: 'Denmark' },
  { code: 'NO', name: 'Norway' },
  { code: 'SE', name: 'Sweden' },
  { code: 'EE', name: 'Estonia' },
  { code: 'LT', name: 'Lithuania' },
  { code: 'LV', name: 'Latvia' },
  { code: 'PT', name: 'Portugal' },
  { code: 'BE', name: 'Belgium' },
  { code: 'AT', name: 'Austria' },
  { code: 'FI', name: 'Finland' },
];

const PLAID_BASE_URLS = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com',
};
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 250;
const institutionCache = new Map();

class BankDirectoryError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.status = status;
  }
}

function getBankDirectoryConfig() {
  const environment = process.env.PLAID_ENV || 'sandbox';
  return {
    provider: 'plaid',
    configured: Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET),
    environment: PLAID_BASE_URLS[environment] ? environment : null,
    countries: BANK_COUNTRIES,
  };
}

async function searchBanks({ countryCode, query, fetchImpl = globalThis.fetch }) {
  const normalizedCountry = String(countryCode || '').trim().toUpperCase();
  const normalizedQuery = String(query || '').trim().replace(/\s+/g, ' ');
  if (!BANK_COUNTRIES.some(country => country.code === normalizedCountry)) {
    throw new BankDirectoryError('Bank search is not available for that country.', 400);
  }
  if (normalizedQuery.length < 2 || normalizedQuery.length > 100) {
    throw new BankDirectoryError('Enter between 2 and 100 characters to search.', 400);
  }

  const environment = process.env.PLAID_ENV || 'sandbox';
  const baseUrl = PLAID_BASE_URLS[environment];
  if (!baseUrl) {
    throw new BankDirectoryError('The bank directory provider environment is invalid.');
  }
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    throw new BankDirectoryError('Bank directory search is not configured.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new BankDirectoryError('Bank directory search is unavailable in this runtime.');
  }

  const cacheKey = `${environment}:${normalizedCountry}:${normalizedQuery.toLowerCase()}`;
  const cached = institutionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.banks;
  if (cached) institutionCache.delete(cacheKey);

  let response;
  try {
    response = await fetchImpl(`${baseUrl}/institutions/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        query: normalizedQuery,
        country_codes: [normalizedCountry],
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new BankDirectoryError('Bank directory provider could not be reached.', 502);
  }

  if (!response.ok) {
    throw new BankDirectoryError('Bank directory provider could not complete the search.', 502);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new BankDirectoryError('Bank directory provider returned an invalid response.', 502);
  }

  if (!Array.isArray(payload.institutions)) {
    throw new BankDirectoryError('Bank directory provider returned an invalid response.', 502);
  }

  const banks = payload.institutions
    .filter(institution =>
      typeof institution.institution_id === 'string' &&
      /^ins_[A-Za-z0-9_-]+$/.test(institution.institution_id) &&
      typeof institution.name === 'string' &&
      institution.name.trim() &&
      Array.isArray(institution.country_codes) &&
      institution.country_codes.includes(normalizedCountry) &&
      institution.connection_availability !== 'NOT_SUPPORTED'
    )
    .map(institution => ({
      id: institution.institution_id,
      name: institution.name.trim(),
      country_code: normalizedCountry,
    }));

  if (institutionCache.size >= MAX_CACHE_ENTRIES) {
    institutionCache.delete(institutionCache.keys().next().value);
  }
  institutionCache.set(cacheKey, { banks, expiresAt: Date.now() + CACHE_TTL_MS });
  return banks;
}

module.exports = { BANK_COUNTRIES, BankDirectoryError, getBankDirectoryConfig, searchBanks };