# Blue Pips Investment

Full site: static front end + Node/Express API + MySQL, with the infrastructure needed to actually put it on the internet — not just run it on your laptop.

## Project layout

```
blue-pips-app/
├─ public/                 ← the entire front end (19 pages)
│  ├─ index.html, strategies.html, how-it-works.html, returns.html, payouts.html
│  ├─ get-started.html, login.html, dashboard.html
│  ├─ about.html, contact.html, help.html, press.html, careers.html, glossary.html
│  ├─ terms.html, privacy.html, disclosures.html
│  ├─ 404.html, admin.html (internal monitoring, not linked from nav)
│  ├─ robots.txt, sitemap.xml
│  └─ assets/ (style.css, script.js, logo-mark.svg, logo-horizontal.svg)
├─ server/
│  ├─ server.js            ← Express app: security middleware, routes, graceful shutdown
│  ├─ db.js                ← MySQL pool + schema
│  ├─ monitoring.js         ← page-view logging + event logger
│  ├─ seed.js                ← seeds demo performance numbers
│  ├─ middleware/auth.js     ← JWT verification
│  ├─ UserPayoutEngine.js    ← configurable monthly payout tiers
│  ├─ YieldTrackerService.js ← DeFi event polling + arbitrage ingestion
│  ├─ PayoutQueueService.js ← reserve-backed scheduled payouts
│  ├─ InvestmentController.js ← v1 quote, dashboard, and yield APIs
│  └─ routes/                ← auth.js, portfolio.js, admin.js, payments.js
├─ deploy/
│  └─ nginx.conf            ← reverse proxy + TLS termination config
├─ .github/workflows/ci.yml ← install, syntax-check, smoke-test on every push
├─ Dockerfile                ← multi-stage, non-root, health-checked
├─ docker-compose.yml        ← local dev: MySQL only
├─ docker-compose.prod.yml   ← production: app + MySQL + Nginx, one command
├─ ecosystem.config.js       ← PM2 config, for VM deployment without Docker
├─ .env.example
└─ package.json
```

---

## Part 1 — Run it locally in VS Code

```bash
docker compose up -d        # starts MySQL
npm install
cp .env.example .env        # then set JWT_SECRET, ADMIN_KEY, IP_SALT to your own values
npm run seed                 # creates schema + default investment tiers
npm run dev
```

Open `http://localhost:4000`. Front end and API are both served from this one address. Press **F5** in VS Code to run it under the debugger (`.vscode/launch.json` is included).

### Registration verification

Registration uses an email address. A six-digit verification code is sent by SMTP, and the account is created and signed in only after the code is verified. Existing accounts can continue to sign in with their phone number.

Configure SMTP in `.env` using `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. Email registration remains unavailable until these settings are supplied. Codes expire after 15 minutes, can be resent after 60 seconds, and are limited to five verification attempts.

**Monitoring:** `http://localhost:4000/admin.html`, unlocked with the `ADMIN_KEY` from your `.env`. Shows page views, top pages, signups, and events — see the code comments in `server/routes/admin.js` for what it deliberately does and doesn't protect against (it's a shared-secret key, not a real login — fine for solo dev, not for production, see the security checklist below).

---

## Part 2 — Every link, checked

Every clickable element across all 19 pages was audited. There are no dead `href="#"` links left anywhere on the site. Specifically:

- All primary nav, footer, and CTA links point to a real page or a real in-page anchor (`strategies.html#tiered-income`, `help.html#articles`, etc.) — verified programmatically, not just by eye.
- New pages were added for everything the original design only gestured at: **About, Contact, Help Center, Press, Careers, Glossary, Terms, Privacy, Disclosures.**
- Social icons (LinkedIn/Instagram/X) don't have real accounts behind them yet, so rather than link to nowhere, they're now inert labels with a "Coming soon" tooltip — swap in real profile URLs the moment those accounts exist.
- Login/logout state is consistent site-wide: the nav shows "Log in" until a JWT exists in `localStorage`, then swaps to "Dashboard" automatically (see the bottom of `script.js`).
- Unknown URLs now return a real, styled `404.html` with an actual `404` HTTP status — not a silently-served homepage pretending to be an error page (bad for SEO and confusing for users).

---

## Part 3 — What "ready for live deployment" actually required

You were right that a prototype and a deployable site need different things under the hood. Here's everything added, and why each piece matters:

### Security middleware (`server/server.js`)
- **Helmet** — sets security headers (CSP, no-sniff, frame protection, etc.) automatically.
- **express-rate-limit** — `/api/auth/*` is capped at 20 requests per 15 minutes per IP; investment quote requests have their own limit.
- **CORS locked to a real origin** — controlled by `ALLOWED_ORIGIN` in `.env`. Leave it as `*` locally; set it to your real domain in production so only your own front end can call the API from a browser.
- **`trust proxy` set to `1`** — required once you're behind Nginx/a load balancer, so the app sees the real client IP (used for both the rate limiter and the hashed IP in `page_views`) instead of the proxy's address.
- **Request body size capped** at 100kb — a cheap guard against oversized payloads.

### Observability
- **Morgan** request logging (concise in dev, Apache-style `combined` format in production — the format most log aggregators expect).
- **`/api/health`** now actually checks the database connection (`SELECT 1`), not just that the process is alive — this is what a load balancer or container orchestrator should point its health check at. The Dockerfile's `HEALTHCHECK` uses it.
- **Centralized error handler** at the bottom of `server.js` catches anything thrown or rejected in a route and returns a generic message in production (so stack traces never leak to users) while still logging the real error server-side.
- **Graceful shutdown** — on `SIGTERM`/`SIGINT` (what Docker and most orchestrators send on deploy/restart), the server stops accepting new connections, finishes in-flight requests, closes the MySQL pool cleanly, then exits. Without this, a deploy can drop active requests or leave the pool in a bad state.

### SEO & crawlability
- `robots.txt` and `sitemap.xml` in `public/` — update the placeholder domain (`bluepips.example`) to your real one in both files, plus in `deploy/nginx.conf`, once you have it.
- Meta descriptions on every page; `noindex` on `dashboard.html` and `admin.html` since those are private, not marketing pages.
- Static assets are long-cached (`Cache-Control`), HTML is short-cached — so content updates show up promptly but images/CSS/JS don't get re-downloaded needlessly.

### Privacy / compliance basics
- A dismissible cookie/analytics notice now appears site-wide (`script.js`), since the site does log first-party page views — linked to `privacy.html`, which is honest in its placeholder text about exactly what the prototype currently collects.
- `terms.html`, `privacy.html`, and `disclosures.html` are real pages now, but explicitly marked as **placeholders that must be replaced by counsel-reviewed language before any real account is opened.** I wrote them to say plainly what's placeholder and what a real version needs to cover, rather than inventing convincing-sounding legal text that isn't actually valid.

### Deployment infrastructure
- **`Dockerfile`** — multi-stage build (smaller final image), runs as a non-root user, has a built-in health check.
- **`docker-compose.prod.yml`** — the full stack (app + MySQL + Nginx) as one command. MySQL isn't exposed to the host at all in this file — only the app container can reach it, which is the right default for anything holding real user data.
- **`deploy/nginx.conf`** — reverse proxy in front of the app: TLS termination, HTTP→HTTPS redirect, gzip, long-cache headers for `/assets/`, and the `X-Forwarded-*` headers the app needs to see real client IPs through the proxy.
- **`ecosystem.config.js`** — a PM2 config, for if you'd rather deploy to a plain VM than containers. Runs the app in cluster mode across all CPU cores with automatic restart on crash.

  ⚠️ **One real limitation to know about:** the rate limiter's counters live in each process's memory. In PM2 cluster mode (multiple processes) or if you ever run more than one container, each instance rate-limits independently — so the *effective* limit is roughly (your configured limit) × (number of instances), not a strict global cap. Fine for a first launch; if it matters later, swap `express-rate-limit`'s store for a Redis-backed one (`rate-limit-redis`).

- **`.github/workflows/ci.yml`** — on every push: installs dependencies, syntax-checks every server file, spins up a real MySQL service container, seeds it, starts the server, and hits `/api/health`. This is a smoke test, not a full test suite — it catches "the app doesn't even boot" before that reaches production, which is most of what breaks a first deploy.

---

## Deploying for real: the actual steps

1. **Get a domain and point DNS at your server.** An `A` record for your domain → your server's IP address. (Nothing in this repo does DNS for you — that's at your registrar.)
2. **Provision a server.** Any VM with Docker installed works (DigitalOcean, a plain EC2 instance, Linode, etc.) — you don't need anything exotic to start.
3. **Copy the project to the server**, create `.env` from `.env.example` with real production values (long random `JWT_SECRET`/`ADMIN_KEY`/`IP_SALT`, your real `DB_PASSWORD`/`DB_ROOT_PASSWORD`, `ALLOWED_ORIGIN` set to your real domain, `NODE_ENV=production`).
4. **Get a TLS certificate** with Certbot before starting Nginx for real traffic:
   ```bash
   docker compose -f docker-compose.prod.yml up -d nginx
   docker compose -f docker-compose.prod.yml run --rm certbot certonly \
     --webroot -w /var/www/certbot -d bluepips.example -d www.bluepips.example
   ```
   Then update `deploy/nginx.conf` with your real domain (it's a placeholder right now) and restart Nginx. Renewal: re-run the same `certbot certonly` command via a monthly cron job — certificates expire every 90 days.
5. **Bring up the full stack:**
   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   ```
6. **Seed the database once** (`docker compose -f docker-compose.prod.yml exec app npm run seed`), then verify `https://yourdomain.com/api/health` returns `{"ok":true}`.

## Before you take real money or real user data — a short checklist

This app is now *deployable*, which is different from *ready to handle real investor funds*. In rough priority order:

1. Replace `terms.html`, `privacy.html`, and `disclosures.html` with counsel-reviewed language — the current text says outright that it's a placeholder.
2. Swap the homegrown JWT auth for a managed identity provider (Auth0, as Fundrise itself uses) before real accounts exist — see the earlier research notes on Fundrise's stack for why.
3. Add real bank linking via Plaid before any funding flow claims to move money.
4. Add error tracking (Sentry or similar) — right now errors only go to server logs.
5. Add stronger signup abuse controls before opening account creation to public traffic.
6. Replace the shared-secret `admin.html`/`ADMIN_KEY` with a real authenticated admin role.
7. Set up automated MySQL backups (`mysqldump` on a cron, shipped somewhere off the same box) — nothing in this repo backs up your data automatically yet.

## Where the data lives

MySQL, in the `bluepips` database. Locally, it's a Docker volume (`docker compose down -v` wipes it — recreate with `docker compose up -d` + `npm run seed`). In production, back it up before you ever consider it durable.

---

## Payments & funding

### Current state: fully functional, sandbox only

The deposit/withdraw flow on `dashboard.html` works end to end — amount validation, a transaction ledger, balance updates — but runs against a **mock provider** (`server/payments/provider.js`) until real payment credentials are configured. No real money moves yet. This isn't a stopgap hack; it's the same shape a real integration will have, just pointed at a fake backend for now.

**Why sandbox-first is the right call, not just the cheap one:** every legitimate payment provider — Plaid (bank/ACH), Coinbase Commerce (crypto), Stripe (cards) — gives you a free test/sandbox environment with no business verification and no fees. Fees and KYB (know-your-business) checks only apply once you request production/live access. So there's no reason to wait on a business bank account to build and demo the whole flow.

### Fixed limits, no exceptions

`server/config/limits.js` is the single source of truth: **$1,000 minimum, $100,000 maximum withdrawal, and $100,000 maximum deposit**, enforced server-side (not just in the UI, which can always be bypassed). There's deliberately no code path that lowers the minimum for a specific user — if you ever want a genuinely different tier, that should be a named rule that applies to everyone who qualifies, added explicitly to `limits.js`.

### How a deposit/withdrawal actually flows right now

1. Frontend calls `GET /api/payments/methods` to show real limits and whether each method is `sandbox` or `live`.
2. User submits an amount + method (`ach` or `crypto`) from the dashboard.
3. `POST /api/payments/deposit` (or `/withdraw`) validates the amount against the fixed limits, checks withdrawal requests against the actual balance, then calls `getProviderForMethod(method)` — which returns the mock provider unless real credentials are set in `.env`.
4. The result is written to the `transactions` table (status `pending`/`completed`/`failed`, plus a `provider_ref` for whatever the real provider's transaction ID would be), and — only once `completed` — the user's `cash` holding balance is updated.

### Going live: what to actually do, in order

1. **Register a business entity** (LLC or corp) — every real provider requires this before production access, and you'll want it anyway before handling real user funds.
2. **Open a business bank account** — needed for Plaid's ACH transfers to land somewhere, and for Stripe/Coinbase Commerce payouts.
3. **Build against sandbox now, for free:**
   - Plaid: sign up at plaid.com, use **Sandbox** credentials immediately — no business verification required at this stage.
   - Coinbase Commerce: create a free merchant account, sandbox/test charges work immediately.
4. **Implement the real provider files** — `server/payments/provider.js` already has the exact interface (`initiateDeposit`/`initiateWithdrawal`) and comments showing where `plaidProvider.js` and `coinbaseCommerceProvider.js` slot in. This is intentionally the *only* file that needs new code — routes, the database schema, and the frontend don't change.
5. **Apply for production access** once you're ready for real money — Plaid's is a short self-serve application for standard volume, not a large upfront cost; Coinbase Commerce has no application at all, just flip from test to live API keys. Fees at that point are per-transaction (Plaid charges per API call/transfer, Coinbase Commerce takes roughly 1% per crypto payment) — not large fixed costs to unlock the feature.
6. **Switch on webhooks** — real providers confirm settlement asynchronously (a bank transfer takes 1–3 days, a crypto payment needs confirmations). The `status: 'completed'` logic in `routes/payments.js` currently fires synchronously for the mock provider; a real integration needs a webhook endpoint that flips `pending` → `completed` (or `failed`) when the provider actually confirms it, and only updates the cash balance at that point.
7. **Set the env vars** (`PLAID_CLIENT_ID`, `PLAID_SECRET`, `COINBASE_COMMERCE_API_KEY`) in production — `getProviderForMethod` already checks for these and will use the real provider automatically once they exist and the provider file is implemented.

### Bank directory coverage

The dashboard searches Plaid's live `/institutions/search` endpoint; it does not keep a static or purportedly exhaustive bank list. Set `PLAID_CLIENT_ID`, `PLAID_SECRET`, and `PLAID_ENV` (`sandbox`, `development`, or `production`). Plaid's documented institution search supports the US, Canada, and selected European countries listed by the API. Access to additional countries in production may require approval from Plaid. Plaid does not list Asian countries in this endpoint's supported-country set, so the app reports only the provider's available markets rather than inventing coverage. Searching an institution is not the same as linking a bank account; Plaid Link and a live payment integration are still required before real transfers.

Nothing about steps 1–3 costs anything or requires a bank account you don't have yet — that's exactly what sandbox mode is for.

---

## Tiered payouts and yield transparency

`npm run seed` creates the MySQL schema and seeds `investment_tiers` with $1,000/20%, $5,000/25%, and $10,000/30% monthly thresholds. Rates are capped at 30% by `UserPayoutEngine.js`; bi-weekly, monthly, quarterly, bi-annual, and annual payouts use 0.5×, 1×, 3×, 6×, and 12× the monthly estimate. Signup records a 1/2/3/5/10-year or lifetime term; the maturity clock starts when the first principal is invested, early liquidity is blocked, and payout scheduling ends at maturity. `users` is the User model; the supporting tables are `investment_tiers`, `yield_pool`, `reserve_buffer`, `payout_queue`, and `yield_tracker_state`.

The API is mounted under `/api/v1`:

- `POST /api/v1/investments/calculate` accepts `{ "principal": 5000, "withdrawalInterval": "monthly" }` and returns the configured tier, monthly estimate, payout amount, and interval.
- `GET /api/v1/user/dashboard` requires the existing JWT and returns the account profile, active tier, next queued payout, target 60/40 source mix, observed 24-hour mix, source totals, and reserve balance.
- `POST /api/v1/yields/arbitrage` requires `x-yield-ingest-key: $ARBITRAGE_INGEST_KEY` and accepts `{ "tradeId", "grossProfit", "gasFee", "netProfit", "timestamp" }` in USD. The service verifies net profit, deduplicates `tradeId`, and allocates 10% of gross profit to the reserve.

The ethers v6 watcher polls a configured contract event every 30 seconds. Set `DEFI_RPC_URL`, `DEFI_CONTRACT_ADDRESS`, `DEFI_START_BLOCK`, `DEFI_YIELD_TOKEN_USD_PRICE`, and `DEFI_GAS_TOKEN_USD_PRICE`; the event ABI/name/field, token decimals, confirmations, and scan range are also configurable in `.env.example`. The event must report gross yield denominated in the configured token, and the gas-token USD price is used to convert receipt gas cost. Without complete configuration, DeFi polling remains disabled and the dashboard says so. The 60/40 values are the target source mix; observed percentages are calculated from recorded gross inflows and are not fabricated to match the target.

`PayoutQueueService.js` releases due user payouts from `reserve_buffer`; an item remains held if the reserve cannot cover it. The 10% gross allocation is capped by positive net proceeds, so gas-heavy/loss-making activity cannot create fictional reserve liquidity. Therefore a calculated return is an estimate, not a guarantee or evidence that a yield source is configured. Connect and verify the actual chain contract, bot, custody, pricing, and legal arrangements before using this prototype with real funds.
