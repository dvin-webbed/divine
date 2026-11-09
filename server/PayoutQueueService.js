'use strict';

const { pool, getTransactionsTable } = require('./db');
const { calculateUserPayout, getNextPayoutDate, loadInvestmentTiers } = require('./UserPayoutEngine');

function toCents(amount) {
  return Math.round(amount * 100);
}

function getIntervalMs() {
  const configuredInterval = Number(process.env.PAYOUT_WORKER_INTERVAL_MS || 30000);
  return Number.isFinite(configuredInterval) ? Math.max(5000, configuredInterval) : 30000;
}

async function scheduleNextPayout(executor, {
  userId,
  holdingId,
  principal,
  withdrawalInterval,
  tiers,
  maturityAt = null,
  dueFrom = new Date(),
}) {
  const quote = calculateUserPayout(principal, withdrawalInterval, tiers);
  const dueAt = getNextPayoutDate(withdrawalInterval, dueFrom);
  const payoutKey = `${holdingId}:${dueAt.toISOString()}`;

  await executor.query(
    `UPDATE payout_queue SET status = 'cancelled'
     WHERE user_id = ? AND holding_id = ? AND status IN ('queued','held')`,
    [userId, holdingId]
  );
  if (maturityAt && dueAt.getTime() > new Date(maturityAt).getTime()) return null;
  await executor.query(
    `INSERT INTO payout_queue
       (payout_key, user_id, holding_id, withdrawal_interval, amount_cents, due_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [payoutKey, userId, holdingId, withdrawalInterval, toCents(quote.payoutAmount), dueAt]
  );

  return { ...quote, dueAt };
}

async function processOnePayout(database, payoutId) {
  const conn = await database.getConnection();
  try {
    await conn.beginTransaction();
    const [queueRows] = await conn.query(
      `SELECT q.id, q.user_id, q.holding_id, q.withdrawal_interval, q.amount_cents, q.due_at,
              h.amount_cents AS principal_cents, h.maturity_at
       FROM payout_queue q
       JOIN holdings h ON h.id = q.holding_id
       WHERE q.id = ? AND q.status IN ('queued','held') AND q.due_at <= UTC_TIMESTAMP()
       FOR UPDATE`,
      [payoutId]
    );
    if (!queueRows.length) {
      await conn.rollback();
      return 'skipped';
    }

    const payout = queueRows[0];
    const [[reserve]] = await conn.query('SELECT balance_cents FROM reserve_buffer WHERE id = 1 FOR UPDATE');
    const payoutCents = Number(payout.amount_cents);
    if (!reserve || Number(reserve.balance_cents) < payoutCents) {
      await conn.query(
        `UPDATE payout_queue SET status = 'held', last_error = 'Waiting for sufficient reserve funds' WHERE id = ?`,
        [payout.id]
      );
      await conn.commit();
      return 'held';
    }

    await conn.query('UPDATE reserve_buffer SET balance_cents = balance_cents - ? WHERE id = 1', [payoutCents]);
    const [cashRows] = await conn.query(
      "SELECT id FROM holdings WHERE user_id = ? AND strategy = 'cash' LIMIT 1 FOR UPDATE",
      [payout.user_id]
    );
    if (cashRows.length) {
      await conn.query(
        `UPDATE holdings SET amount_cents = amount_cents + ?, profit_cents = profit_cents + ? WHERE id = ?`,
        [payoutCents, payoutCents, cashRows[0].id]
      );
    } else {
      await conn.query(
        `INSERT INTO holdings (user_id, strategy, label, amount_cents, target_yield_pct, capital_cents, profit_cents)
         VALUES (?, 'cash', 'Uninvested cash', ?, 0, 0, ?)`,
        [payout.user_id, payoutCents, payoutCents]
      );
    }
    await conn.query(
      `INSERT INTO ${getTransactionsTable()} (user_id, type, method, amount_cents, status, provider, provider_ref)
       VALUES (?, 'payout', 'internal', ?, 'completed', 'yield-reserve', ?)`,
      [payout.user_id, payoutCents, `payout:${payout.payout_key || payout.id}`]
    );
    await conn.query(
      'UPDATE payout_queue SET status = \'paid\', paid_at = UTC_TIMESTAMP(), last_error = NULL WHERE id = ?',
      [payout.id]
    );

    const principal = Number(payout.principal_cents) / 100;
    if (principal >= 1000) {
      const tiers = await loadInvestmentTiers(conn);
      await scheduleNextPayout(conn, {
        userId: payout.user_id,
        holdingId: payout.holding_id,
        principal,
        withdrawalInterval: payout.withdrawal_interval,
        tiers,
        maturityAt: payout.maturity_at,
      });
    }

    await conn.commit();
    return 'paid';
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function processDuePayouts(database = pool) {
  const [dueRows] = await database.query(
    `SELECT id FROM payout_queue
     WHERE status IN ('queued','held') AND due_at <= UTC_TIMESTAMP()
     ORDER BY due_at ASC LIMIT 50`
  );
  const results = { paid: 0, held: 0, skipped: 0, failed: 0 };
  for (const row of dueRows) {
    try {
      results[await processOnePayout(database, row.id)] += 1;
    } catch (error) {
      results.failed += 1;
      console.error(`Payout queue item ${row.id} failed:`, error.message);
    }
  }
  return results;
}

async function processOneMaturity(database, holdingId) {
  const conn = await database.getConnection();
  try {
    await conn.beginTransaction();
    const [holdingRows] = await conn.query(
      `SELECT id, user_id, amount_cents, maturity_at
       FROM holdings
       WHERE id = ? AND strategy = 'tiered' AND amount_cents > 0
         AND maturity_at IS NOT NULL AND maturity_at <= UTC_TIMESTAMP()
       FOR UPDATE`,
      [holdingId]
    );
    if (!holdingRows.length) {
      await conn.rollback();
      return 'skipped';
    }

    const holding = holdingRows[0];
    const principalCents = Number(holding.amount_cents);
    const [cashRows] = await conn.query(
      "SELECT id FROM holdings WHERE user_id = ? AND strategy = 'cash' LIMIT 1 FOR UPDATE",
      [holding.user_id]
    );
    if (cashRows.length) {
      await conn.query(
        `UPDATE holdings SET amount_cents = amount_cents + ?, capital_cents = capital_cents + ? WHERE id = ?`,
        [principalCents, principalCents, cashRows[0].id]
      );
    } else {
      await conn.query(
        `INSERT INTO holdings (user_id, strategy, label, amount_cents, target_yield_pct, capital_cents, profit_cents)
         VALUES (?, 'cash', 'Uninvested cash', ?, 0, ?, 0)`,
        [holding.user_id, principalCents, principalCents]
      );
    }

    await conn.query(
      `UPDATE holdings SET amount_cents = 0, target_yield_pct = 0
       WHERE id = ? AND amount_cents = ?`,
      [holding.id, principalCents]
    );
    await conn.query(
      `UPDATE payout_queue SET status = 'cancelled', last_error = 'Investment term matured'
       WHERE holding_id = ? AND status IN ('queued','held') AND due_at > ?`,
      [holding.id, holding.maturity_at]
    );
    await conn.query(
      `INSERT INTO ${getTransactionsTable()}
       (user_id, type, method, amount_cents, status, provider, provider_ref)
       VALUES (?, 'maturity_return', 'internal', ?, 'completed', 'internal', ?)`,
      [holding.user_id, principalCents, `maturity:${holding.id}`]
    );
    await conn.commit();
    return 'returned';
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function processDueMaturities(database = pool) {
  const [dueRows] = await database.query(
    `SELECT id FROM holdings
     WHERE strategy = 'tiered' AND amount_cents > 0
       AND maturity_at IS NOT NULL AND maturity_at <= UTC_TIMESTAMP()
     ORDER BY maturity_at ASC LIMIT 50`
  );
  const results = { returned: 0, skipped: 0, failed: 0 };
  for (const row of dueRows) {
    try {
      results[await processOneMaturity(database, row.id)] += 1;
    } catch (error) {
      results.failed += 1;
      console.error(`Maturity settlement for holding ${row.id} failed:`, error.message);
    }
  }
  return results;
}

function startPayoutQueueWorker(database = pool) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processDuePayouts(database);
      await processDueMaturities(database);
    } catch (error) {
      console.error('Payout/maturity worker failed:', error.message);
    } finally {
      running = false;
    }
  }, getIntervalMs());
  timer.unref?.();
  processDuePayouts(database)
    .then(() => processDueMaturities(database))
    .catch(error => console.error('Payout/maturity worker failed:', error.message));
  return () => clearInterval(timer);
}

module.exports = {
  scheduleNextPayout,
  processOnePayout,
  processDuePayouts,
  processOneMaturity,
  processDueMaturities,
  startPayoutQueueWorker,
};
