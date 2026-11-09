const crypto = require('crypto');
const { pool } = require('./db');

const IP_SALT = process.env.IP_SALT || 'dev-salt-change-me';

// IPs are hashed, never stored raw - enough to dedupe/rate-limit without keeping PII.
function hashIp(ip) {
  return crypto.createHash('sha256').update(String(ip) + IP_SALT).digest('hex').slice(0, 16);
}

// Logs one row per page load. Mounted as middleware in server.js, ahead of express.static.
function pageViewLogger(req, res, next) {
  const isPageRequest =
    req.method === 'GET' && (req.path === '/' || req.path.endsWith('.html'));

  if (isPageRequest) {
    const path = req.path === '/' ? '/index.html' : req.path;
    pool
      .query(
        'INSERT INTO page_views (path, referrer, user_agent, ip_hash) VALUES (?, ?, ?, ?)',
        [path, req.get('referer') || null, req.get('user-agent') || null, hashIp(req.ip)]
      )
      .catch(err => console.warn('page_views insert failed:', err.message));
  }

  next();
}

// Fire-and-forget event logging, used from route handlers (signup, login, lead capture, etc).
async function logEvent(eventName, meta = {}, userId = null) {
  try {
    await pool.query('INSERT INTO events (event_name, meta, user_id) VALUES (?, ?, ?)', [
      eventName,
      JSON.stringify(meta),
      userId,
    ]);
  } catch (err) {
    console.warn('events insert failed:', err.message);
  }
}

module.exports = { pageViewLogger, logEvent, hashIp };
