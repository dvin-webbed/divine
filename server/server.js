require('dotenv').config();
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { pool, initSchema } = require('./db');
const { pageViewLogger } = require('./monitoring');

const authRoutes = require('./routes/auth');
const portfolioRoutes = require('./routes/portfolio');
const adminRoutes = require('./routes/admin');
const paymentsRoutes = require('./routes/payments');
const { router: investmentV1Routes, yieldTracker } = require('./InvestmentController');
const { startPayoutQueueWorker } = require('./PayoutQueueService');

const app = express();
const PORT = process.env.PORT || 4000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

// Required when running behind a reverse proxy / load balancer (Nginx, ALB, etc.)
// so req.ip reflects the real client address (used for IP hashing + rate limiting)
// rather than the proxy's address. Harmless in local dev.
app.set('trust proxy', 1);

// ---- Security & performance middleware ----
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Google Fonts + inline styles used across the site
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https://images.unsplash.com'],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
      },
    },
    // Disabled because it can break the Google Fonts stylesheet cross-origin load
    // on some browsers; re-evaluate if you add more third-party assets.
    crossOriginEmbedderPolicy: false,
  })
);
app.use(compression());
app.use(morgan(IS_PROD ? 'combined' : 'dev'));

const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));

app.use(express.json({ limit: '100kb' }));

// Logs a row to page_views for every page load, before static files are served.
app.use(pageViewLogger);

// ---- Rate limiting on the endpoints most likely to be abused ----
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});
const paymentsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment requests. Please try again later.' },
});
const bankSearchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many bank searches. Please try again later.' },
});

// ---- API ----
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/v1', investmentV1Routes);
app.use('/api/admin', adminRoutes);
app.use('/api/payments', (req, res, next) => {
  // Dashboard reads should not consume the limit intended to protect money-moving actions.
  if (req.method === 'POST') return paymentsLimiter(req, res, next);
  if (req.method === 'GET' && req.path === '/banks') return bankSearchLimiter(req, res, next);
  next();
}, paymentsRoutes);

// Used by load balancers / container orchestrators for health checks.
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'blue-pips-api', db: 'mysql', env: NODE_ENV });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'Database unreachable.' });
  }
});

// Unmatched API routes get a real JSON 404, not the HTML fallback below.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// ---- Static frontend ----
const publicDir = path.join(__dirname, '..', 'public');
app.use(
  express.static(publicDir, {
    maxAge: IS_PROD ? '1d' : 0,
    setHeaders: (res, filePath) => {
      // Long-cache immutable assets, short-cache HTML so content updates show up promptly
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

// Any other path (not a real file, not under /api) is a genuine 404.
app.use((req, res) => {
  res.status(404).sendFile(path.join(publicDir, '404.html'));
});

// ---- Centralized error handler (catches anything thrown/rejected in routes) ----
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    error: IS_PROD ? 'Something went wrong.' : err.message,
  });
});

let server;
let stopPayoutQueueWorker;

async function start() {
  try {
    await initSchema();
    console.log('MySQL schema ready \u2714');
    stopPayoutQueueWorker = startPayoutQueueWorker(pool);
    yieldTracker.startPolling();
  } catch (err) {
    console.error('Failed to connect to MySQL. Check your .env DB_* values and that MySQL is running.');
    console.error(err.message);
    process.exit(1);
  }

  server = app.listen(PORT, () => {
    console.log(`Blue Pips app running \u2192 http://localhost:${PORT} [${NODE_ENV}]`);
    console.log(`Admin monitoring \u2192 http://localhost:${PORT}/admin.html`);
  });
}

// ---- Graceful shutdown: finish in-flight requests, close DB pool, then exit ----
async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down gracefully...`);
  stopPayoutQueueWorker?.();
  yieldTracker.stopPolling();
  if (server) {
    server.close(async () => {
      try {
        await pool.end();
        console.log('MySQL pool closed. Bye.');
        process.exit(0);
      } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
      }
    });
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
