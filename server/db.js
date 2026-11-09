const mysql = require('mysql2/promise');
const { DEFAULT_TIERS } = require('./UserPayoutEngine');

let activeTransactionsTable = 'transactions';

function getTransactionsTable() {
  return activeTransactionsTable;
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'bluepips',
  waitForConnections: true,
  connectionLimit: 10,
});

/**
 * Creates all tables if they don't already exist.
 * Split into two groups, mirroring how real platforms (Fundrise included)
 * separate transactional data from monitoring/analytics data:
 *   - users / holdings                  -> the app itself
 *   - page_views / events               -> site monitoring
 */
async function initSchema() {
  const conn = await pool.getConnection();
  try {
    let transactionsTableUnavailable = false;
    async function updateTransactionsSchema(sql) {
      if (transactionsTableUnavailable) return;
      try {
        await conn.query(sql);
      } catch (err) {
        if (/Tablespace is missing for a table|Table .+transactions.+doesn't exist in engine/i.test(err.message)) {
          transactionsTableUnavailable = true;
          console.warn('Skipping transactions schema migration: its InnoDB tablespace is unavailable.');
          return;
        }
        if (err.code !== 'ER_DUP_FIELDNAME' && err.code !== 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD') throw err;
      }
    }

    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NULL UNIQUE,
        phone VARCHAR(20) NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        goal VARCHAR(100),
        horizon VARCHAR(50),
        investment_term VARCHAR(20) NOT NULL DEFAULT 'lifetime',
        referral_code VARCHAR(20) UNIQUE,
        referred_by_user_id INT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    await conn.query('ALTER TABLE users MODIFY COLUMN email VARCHAR(255) NULL');
    try {
      await conn.query('ALTER TABLE users ADD COLUMN phone VARCHAR(20) NULL UNIQUE');
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }

    await conn.query(`
      CREATE TABLE IF NOT EXISTS pending_registrations (
        id CHAR(36) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NULL,
        phone VARCHAR(20) NULL,
        password_hash VARCHAR(255) NOT NULL,
        goal VARCHAR(100),
        horizon VARCHAR(50),
        investment_term VARCHAR(20) NOT NULL,
        referred_by_user_id INT NULL,
        verification_code_hash CHAR(64) NOT NULL,
        verification_expires_at_ms BIGINT NOT NULL,
        last_sent_at_ms BIGINT NOT NULL,
        verification_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_pending_email (email),
        INDEX idx_pending_phone (phone)
      ) ENGINE=InnoDB
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS holdings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        strategy VARCHAR(30) NOT NULL,
        label VARCHAR(255) NOT NULL,
        amount_cents BIGINT NOT NULL DEFAULT 0,
        target_yield_pct DECIMAL(5,2),
        payout_frequency VARCHAR(20) NOT NULL DEFAULT 'monthly',
        investment_horizon VARCHAR(50),
        investment_term VARCHAR(20) NOT NULL DEFAULT 'lifetime',
        maturity_at DATETIME NULL,
        capital_cents BIGINT NOT NULL DEFAULT 0,
        profit_cents BIGINT NOT NULL DEFAULT 0,
        pending_payout_cents BIGINT NOT NULL DEFAULT 0,
        last_payout_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_accrued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS investment_tiers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tier_key VARCHAR(40) NOT NULL UNIQUE,
        min_principal_cents BIGINT NOT NULL,
        monthly_rate_pct DECIMAL(4,2) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_investment_tiers_active (is_active, min_principal_cents)
      ) ENGINE=InnoDB
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS app_migrations (
        migration_key VARCHAR(100) PRIMARY KEY,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    for (const [index, tier] of DEFAULT_TIERS.entries()) {
      await conn.query(
        `INSERT IGNORE INTO investment_tiers (tier_key, min_principal_cents, monthly_rate_pct)
         VALUES (?, ?, ?)`,
        [`tier_${index + 1}`, Math.round(tier.minPrincipal * 100), tier.monthlyRatePercent]
      );
    }

    const [[tierMigration]] = await conn.query(
      'SELECT migration_key FROM app_migrations WHERE migration_key = ?',
      ['tier_rates_20_25_30']
    );
    if (!tierMigration) {
      await conn.query(
        `UPDATE investment_tiers
         SET monthly_rate_pct = CASE tier_key
           WHEN 'tier_1' THEN 20
           WHEN 'tier_2' THEN 25
           WHEN 'tier_3' THEN 30
           ELSE monthly_rate_pct
         END
         WHERE tier_key IN ('tier_1','tier_2','tier_3')`
      );
      await conn.query('INSERT IGNORE INTO app_migrations (migration_key) VALUES (?)', ['tier_rates_20_25_30']);
    }

    await conn.query(`
      CREATE TABLE IF NOT EXISTS yield_pool (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        source ENUM('defi','arbitrage') NOT NULL,
        source_ref VARCHAR(160) NOT NULL,
        gross_profit_cents BIGINT NOT NULL,
        gas_fee_cents BIGINT NOT NULL DEFAULT 0,
        net_profit_cents BIGINT NOT NULL,
        reserve_cents BIGINT NOT NULL,
        occurred_at DATETIME NOT NULL,
        metadata JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_yield_source_ref (source, source_ref),
        INDEX idx_yield_created_source (created_at, source),
        INDEX idx_yield_occurred (occurred_at)
      ) ENGINE=InnoDB
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS reserve_buffer (
        id TINYINT PRIMARY KEY,
        balance_cents BIGINT NOT NULL DEFAULT 0,
        gross_yield_cents BIGINT NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT chk_reserve_singleton CHECK (id = 1)
      ) ENGINE=InnoDB
    `);
    await conn.query('INSERT IGNORE INTO reserve_buffer (id, balance_cents, gross_yield_cents) VALUES (1, 0, 0)');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS payout_queue (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        payout_key VARCHAR(160) NOT NULL UNIQUE,
        user_id INT NOT NULL,
        holding_id INT NOT NULL,
        withdrawal_interval ENUM('bi-weekly','monthly','quarterly','bi-annually','annually') NOT NULL,
        amount_cents BIGINT NOT NULL,
        due_at DATETIME NOT NULL,
        status ENUM('queued','held','paid','cancelled') NOT NULL DEFAULT 'queued',
        paid_at DATETIME NULL,
        last_error VARCHAR(255) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (holding_id) REFERENCES holdings(id) ON DELETE CASCADE,
        INDEX idx_payout_due (status, due_at),
        INDEX idx_payout_user_due (user_id, due_at)
      ) ENGINE=InnoDB
    `);
    await conn.query(
      `ALTER TABLE payout_queue MODIFY COLUMN withdrawal_interval
       ENUM('bi-weekly','monthly','quarterly','bi-annually','annually') NOT NULL`
    );

    await conn.query(`
      CREATE TABLE IF NOT EXISTS yield_tracker_state (
        state_key VARCHAR(80) PRIMARY KEY,
        state_value VARCHAR(255) NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        type ENUM('deposit','withdrawal','investment','referral_commission','payout','maturity_return') NOT NULL,
        method VARCHAR(30) NOT NULL,           -- 'ach' | 'crypto' | 'mock'
        amount_cents BIGINT NOT NULL,
        status ENUM('pending','completed','failed') NOT NULL DEFAULT 'pending',
        provider VARCHAR(30) NOT NULL,          -- 'mock' | 'plaid' | 'coinbase_commerce' | 'stripe'
        provider_ref VARCHAR(255),              -- external transaction/charge ID once real providers are wired in
        destination_address VARCHAR(255) NULL,
        destination_institution_id VARCHAR(100) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_transactions_user (user_id)
      ) ENGINE=InnoDB
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS liquidity_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        strategy VARCHAR(30) NOT NULL,
        amount_cents BIGINT NOT NULL,
        status ENUM('requested','approved','paid','rejected') NOT NULL DEFAULT 'requested',
        requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_liquidity_user (user_id)
      ) ENGINE=InnoDB
    `);

    // Keep existing installations compatible as the portfolio model evolves.
    try {
      await conn.query("ALTER TABLE holdings ADD COLUMN payout_frequency VARCHAR(20) NOT NULL DEFAULT 'monthly'");
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
    try {
      await conn.query('ALTER TABLE holdings ADD COLUMN last_accrued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP');
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
    try {
      await conn.query('ALTER TABLE holdings ADD COLUMN investment_horizon VARCHAR(50) NULL');
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
    try {
      await conn.query("ALTER TABLE users ADD COLUMN investment_term VARCHAR(20) NOT NULL DEFAULT 'lifetime'");
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
    try {
      await conn.query("ALTER TABLE holdings ADD COLUMN investment_term VARCHAR(20) NOT NULL DEFAULT 'lifetime'");
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
    try {
      await conn.query('ALTER TABLE holdings ADD COLUMN maturity_at DATETIME NULL');
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
    try {
      await conn.query('ALTER TABLE holdings ADD COLUMN capital_cents BIGINT NOT NULL DEFAULT 0');
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
    try {
      await conn.query('ALTER TABLE holdings ADD COLUMN profit_cents BIGINT NOT NULL DEFAULT 0');
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
    const [[cashBalanceMigration]] = await conn.query(
      'SELECT migration_key FROM app_migrations WHERE migration_key = ?',
      ['cash_balance_components_v1']
    );
    if (!cashBalanceMigration) {
      await conn.query(
        `UPDATE holdings SET capital_cents = amount_cents, profit_cents = 0
         WHERE strategy = 'cash' AND capital_cents = 0 AND profit_cents = 0 AND amount_cents > 0`
      );
      await conn.query('INSERT IGNORE INTO app_migrations (migration_key) VALUES (?)', ['cash_balance_components_v1']);
    }
    try {
      await conn.query('ALTER TABLE holdings ADD COLUMN pending_payout_cents BIGINT NOT NULL DEFAULT 0');
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
    try {
      await conn.query('ALTER TABLE holdings ADD COLUMN last_payout_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP');
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
    try {
      await conn.query('ALTER TABLE users ADD COLUMN referral_code VARCHAR(20) UNIQUE');
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
    try {
      await conn.query('ALTER TABLE users ADD COLUMN referred_by_user_id INT NULL');
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
    await updateTransactionsSchema("ALTER TABLE transactions MODIFY COLUMN type ENUM('deposit','withdrawal','investment','referral_commission','payout','maturity_return') NOT NULL");
    await updateTransactionsSchema('ALTER TABLE transactions ADD COLUMN destination_address VARCHAR(255) NULL');
    await updateTransactionsSchema('ALTER TABLE transactions ADD COLUMN destination_institution_id VARCHAR(100) NULL');
    if (transactionsTableUnavailable) {
      activeTransactionsTable = 'transactions_recovery';
      await conn.query(`
        CREATE TABLE IF NOT EXISTS transactions_recovery (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          type ENUM('deposit','withdrawal','investment','referral_commission','payout','maturity_return') NOT NULL,
          method VARCHAR(30) NOT NULL,
          amount_cents BIGINT NOT NULL,
          status ENUM('pending','completed','failed') NOT NULL DEFAULT 'pending',
          provider VARCHAR(30) NOT NULL,
          provider_ref VARCHAR(255),
          destination_address VARCHAR(255) NULL,
          destination_institution_id VARCHAR(100) NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_transactions_recovery_user (user_id)
        ) ENGINE=InnoDB
      `);
      await conn.query(
        "ALTER TABLE transactions_recovery MODIFY COLUMN type ENUM('deposit','withdrawal','investment','referral_commission','payout','maturity_return') NOT NULL"
      );
      console.warn('Using transactions_recovery; previous transaction history remains in the original unavailable tablespace.');
    } else {
      activeTransactionsTable = 'transactions';
    }
    await conn.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id INT AUTO_INCREMENT PRIMARY KEY,
        referrer_id INT NOT NULL,
        referred_user_id INT NOT NULL UNIQUE,
        commission_cents BIGINT NOT NULL DEFAULT 0,
        status ENUM('pending','rewarded') NOT NULL DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        rewarded_at DATETIME NULL,
        FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (referred_user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_referrals_referrer (referrer_id)
      ) ENGINE=InnoDB
    `);

    // ---- Monitoring / analytics tables ----
    await conn.query(`
      CREATE TABLE IF NOT EXISTS page_views (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        path VARCHAR(255) NOT NULL,
        referrer VARCHAR(500),
        user_agent VARCHAR(500),
        ip_hash CHAR(16),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_pageviews_path (path),
        INDEX idx_pageviews_created (created_at)
      ) ENGINE=InnoDB
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        event_name VARCHAR(100) NOT NULL,
        meta JSON,
        user_id INT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_events_name (event_name),
        INDEX idx_events_created (created_at)
      ) ENGINE=InnoDB
    `);
  } finally {
    conn.release();
  }
}

module.exports = { pool, initSchema, getTransactionsTable };
