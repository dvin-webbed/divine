const mysql = require('mysql2/promise');

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
 *   - users / leads / holdings          -> the app itself
 *   - page_views / events               -> site monitoring
 */
async function initSchema() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        goal VARCHAR(100),
        horizon VARCHAR(50),
        referral_code VARCHAR(20) UNIQUE,
        referred_by_user_id INT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        source VARCHAR(100) DEFAULT 'homepage_hero',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_leads_created (created_at)
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
        last_accrued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS performance_yearly (
        id INT AUTO_INCREMENT PRIMARY KEY,
        period_label VARCHAR(20) NOT NULL,
        return_pct DECIMAL(5,2) NOT NULL,
        sort_order INT NOT NULL
      ) ENGINE=InnoDB
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS performance_by_strategy (
        id INT AUTO_INCREMENT PRIMARY KEY,
        strategy VARCHAR(30) NOT NULL,
        label VARCHAR(255) NOT NULL,
        return_pct DECIMAL(5,2) NOT NULL
      ) ENGINE=InnoDB
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        type ENUM('deposit','withdrawal','investment','referral_commission') NOT NULL,
        method VARCHAR(30) NOT NULL,           -- 'ach' | 'crypto' | 'mock'
        amount_cents BIGINT NOT NULL,
        status ENUM('pending','completed','failed') NOT NULL DEFAULT 'pending',
        provider VARCHAR(30) NOT NULL,          -- 'mock' | 'plaid' | 'coinbase_commerce' | 'stripe'
        provider_ref VARCHAR(255),              -- external transaction/charge ID once real providers are wired in
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_transactions_user (user_id)
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
      await conn.query('ALTER TABLE users ADD COLUMN referral_code VARCHAR(20) UNIQUE');
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
    try {
      await conn.query('ALTER TABLE users ADD COLUMN referred_by_user_id INT NULL');
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
    try {
      await conn.query("ALTER TABLE transactions MODIFY COLUMN type ENUM('deposit','withdrawal','investment','referral_commission','payout') NOT NULL");
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME' && err.code !== 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD') throw err;
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

module.exports = { pool, initSchema };
