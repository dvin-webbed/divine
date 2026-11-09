'use strict';

const { Interface, JsonRpcProvider, formatUnits, isAddress } = require('ethers');
const { pool } = require('./db');

const RESERVE_PERCENT = 10;
const TARGET_SOURCE_SPLIT = { defi: 60, arbitrage: 40 };
const DEFAULT_EVENT_ABI = 'event YieldGenerated(uint256 grossYield)';
const DEFAULT_EVENT_NAME = 'YieldGenerated';
const CURSOR_KEY = 'defi_last_scanned_block';

function toCents(amount, label, { allowZero = true, allowNegative = false } = {}) {
  if (!Number.isFinite(amount)
    || (!allowNegative && amount < 0)
    || (!allowZero && amount === 0)) {
    throw new TypeError(`${label} must be a finite ${allowNegative ? 'non-zero' : allowZero ? 'non-negative' : 'positive'} amount.`);
  }
  return Math.round(amount * 100);
}

function parsePositiveEnv(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function getIntervalMs(name) {
  const configuredInterval = Number(process.env[name] || 30000);
  return Number.isFinite(configuredInterval) ? Math.max(5000, configuredInterval) : 30000;
}

function getDeFiConfig() {
  const startBlock = parseIntegerEnv('DEFI_START_BLOCK', null);
  const config = {
    rpcUrl: process.env.DEFI_RPC_URL,
    contractAddress: process.env.DEFI_CONTRACT_ADDRESS,
    eventAbi: process.env.DEFI_YIELD_EVENT_ABI || DEFAULT_EVENT_ABI,
    eventName: process.env.DEFI_YIELD_EVENT_NAME || DEFAULT_EVENT_NAME,
    eventField: process.env.DEFI_YIELD_EVENT_FIELD || 'grossYield',
    startBlock,
    confirmations: parseIntegerEnv('DEFI_CONFIRMATIONS', 3),
    maxBlockRange: parseIntegerEnv('DEFI_MAX_BLOCK_RANGE', 2000),
    tokenDecimals: parseIntegerEnv('DEFI_YIELD_TOKEN_DECIMALS', 6),
    tokenUsdPrice: parsePositiveEnv('DEFI_YIELD_TOKEN_USD_PRICE'),
    gasTokenUsdPrice: parsePositiveEnv('DEFI_GAS_TOKEN_USD_PRICE'),
  };

  const configured = Boolean(
    config.rpcUrl
      && config.contractAddress
      && isAddress(config.contractAddress)
      && Number.isInteger(config.startBlock)
      && config.startBlock >= 0
      && Number.isInteger(config.confirmations)
      && Number.isInteger(config.maxBlockRange)
      && config.maxBlockRange > 0
      && Number.isInteger(config.tokenDecimals)
      && config.tokenDecimals >= 0
      && config.tokenDecimals <= 36
      && config.tokenUsdPrice
      && config.gasTokenUsdPrice
  );

  return { ...config, configured };
}

class YieldTrackerService {
  constructor(database = pool) {
    this.database = database;
    this.config = getDeFiConfig();
    this.provider = this.config.configured ? new JsonRpcProvider(this.config.rpcUrl) : null;
    this.pollTimer = null;
    this.pollInProgress = false;
    this.eventInterface = null;
    this.eventTopic = null;

    if (this.config.configured) {
      this.eventInterface = new Interface([this.config.eventAbi]);
      const event = this.eventInterface.getEvent(this.config.eventName);
      if (!event) throw new Error(`Configured DeFi event ${this.config.eventName} was not found in its ABI.`);
      this.eventTopic = event.topicHash;
    }
  }

  async recordInflow({ source, sourceRef, grossProfit, gasFee = 0, occurredAt = new Date(), metadata = null }) {
    if (!['defi', 'arbitrage'].includes(source)) {
      throw new RangeError('Yield source must be defi or arbitrage.');
    }
    if (typeof sourceRef !== 'string' || sourceRef.length < 1 || sourceRef.length > 160) {
      throw new TypeError('sourceRef must be a string between 1 and 160 characters.');
    }

    const grossCents = toCents(grossProfit, 'grossProfit', {
      allowZero: false,
      allowNegative: source === 'arbitrage',
    });
    const gasFeeCents = toCents(gasFee, 'gasFee');
    const netCents = grossCents - gasFeeCents;
    const positiveGrossCents = Math.max(0, grossCents);
    const reserveCents = Math.min(
      Math.max(0, netCents),
      Math.round(positiveGrossCents * RESERVE_PERCENT / 100)
    );
    const timestamp = new Date(occurredAt);
    if (Number.isNaN(timestamp.getTime())) throw new TypeError('occurredAt must be a valid date.');

    const conn = await this.database.getConnection();
    try {
      await conn.beginTransaction();
      const [insertResult] = await conn.query(
        `INSERT IGNORE INTO yield_pool
           (source, source_ref, gross_profit_cents, gas_fee_cents, net_profit_cents,
            reserve_cents, occurred_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [source, sourceRef, grossCents, gasFeeCents, netCents, reserveCents, timestamp, metadata ? JSON.stringify(metadata) : null]
      );

      const recorded = insertResult.affectedRows === 1;
      if (recorded) {
        await conn.query(
          `UPDATE reserve_buffer
           SET balance_cents = balance_cents + ?, gross_yield_cents = gross_yield_cents + ?
           WHERE id = 1`,
          [reserveCents, positiveGrossCents]
        );
      }

      await conn.commit();
      return {
        recorded,
        source,
        grossProfit: grossCents / 100,
        gasFee: gasFeeCents / 100,
        netProfit: netCents / 100,
        reserveAllocation: recorded ? reserveCents / 100 : 0,
      };
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async ingestArbitrageTrade(trade) {
    if (!trade || typeof trade !== 'object') throw new TypeError('A trade log is required.');
    const { tradeId, grossProfit, gasFee, netProfit, timestamp } = trade;
    if (typeof tradeId !== 'string' || tradeId.trim().length < 1 || tradeId.length > 160) {
      throw new TypeError('tradeId must be a string between 1 and 160 characters.');
    }

    const grossCents = toCents(Number(grossProfit), 'grossProfit', {
      allowZero: false,
      allowNegative: true,
    });
    const gasCents = toCents(Number(gasFee), 'gasFee');
    const netValue = Number(netProfit);
    if (!Number.isFinite(netValue)) throw new TypeError('netProfit must be a finite amount.');
    const suppliedNetCents = Math.round(netValue * 100);
    if (Math.abs(suppliedNetCents - (grossCents - gasCents)) > 1) {
      throw new RangeError('netProfit must equal grossProfit minus gasFee, to the nearest cent.');
    }

    return this.recordInflow({
      source: 'arbitrage',
      sourceRef: tradeId,
      grossProfit: grossCents / 100,
      gasFee: gasCents / 100,
      occurredAt: timestamp,
      metadata: { tradeId },
    });
  }

  async pollDeFiOnce() {
    if (!this.config.configured || !this.provider) {
      return { enabled: false, reason: 'DeFi source is not fully configured.' };
    }
    if (this.pollInProgress) return { enabled: true, skipped: true };
    this.pollInProgress = true;

    try {
      const [[cursorRow]] = await this.database.query(
        'SELECT state_value FROM yield_tracker_state WHERE state_key = ?',
        [CURSOR_KEY]
      );
      const lastScannedBlock = cursorRow ? Number(cursorRow.state_value) : this.config.startBlock - 1;
      const latestBlock = await this.provider.getBlockNumber();
      const safeBlock = latestBlock - this.config.confirmations;
      if (safeBlock <= lastScannedBlock) return { enabled: true, scannedThrough: lastScannedBlock, records: 0 };

      let scannedThrough = lastScannedBlock;
      let records = 0;
      while (scannedThrough < safeBlock) {
        const fromBlock = Math.max(this.config.startBlock, scannedThrough + 1);
        const toBlock = Math.min(safeBlock, fromBlock + this.config.maxBlockRange - 1);
        const logs = await this.provider.getLogs({
          address: this.config.contractAddress,
          fromBlock,
          toBlock,
          topics: [this.eventTopic],
        });
        const grouped = new Map();
        for (const log of logs) {
          const parsed = this.eventInterface.parseLog(log);
          const rawYield = parsed?.args?.[this.config.eventField] ?? parsed?.args?.[0];
          if (rawYield === undefined) throw new Error('Configured yield event has no gross-yield argument.');
          const grossProfit = Number(formatUnits(rawYield, this.config.tokenDecimals)) * this.config.tokenUsdPrice;
          const group = grouped.get(log.transactionHash) || { grossProfit: 0, logCount: 0, blockNumber: log.blockNumber };
          group.grossProfit += grossProfit;
          group.logCount += 1;
          grouped.set(log.transactionHash, group);
        }

        for (const [transactionHash, eventGroup] of grouped) {
          const receipt = await this.provider.getTransactionReceipt(transactionHash);
          if (!receipt) throw new Error(`Receipt unavailable for DeFi transaction ${transactionHash}.`);
          const effectiveGasPrice = receipt.gasPrice || 0n;
          const gasCostNative = Number(formatUnits(receipt.gasUsed * effectiveGasPrice, 18));
          const gasFee = gasCostNative * this.config.gasTokenUsdPrice;
          const block = await this.provider.getBlock(eventGroup.blockNumber);
          const outcome = await this.recordInflow({
            source: 'defi',
            sourceRef: transactionHash,
            grossProfit: eventGroup.grossProfit,
            gasFee,
            occurredAt: new Date(Number(block.timestamp) * 1000),
            metadata: { transactionHash, eventCount: eventGroup.logCount, blockNumber: eventGroup.blockNumber },
          });
          if (outcome.recorded) records += 1;
        }

        scannedThrough = toBlock;
        await this.database.query(
          `INSERT INTO yield_tracker_state (state_key, state_value) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE state_value = VALUES(state_value)`,
          [CURSOR_KEY, String(scannedThrough)]
        );
      }

      return { enabled: true, scannedThrough, records };
    } finally {
      this.pollInProgress = false;
    }
  }

  startPolling() {
    if (!this.config.configured || this.pollTimer) return false;
    const intervalMs = getIntervalMs('YIELD_POLL_INTERVAL_MS');
    this.pollTimer = setInterval(() => {
      this.pollDeFiOnce().catch(error => console.error('DeFi yield poll failed:', error.message));
    }, intervalMs);
    this.pollTimer.unref?.();
    this.pollDeFiOnce().catch(error => console.error('DeFi yield poll failed:', error.message));
    return true;
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.provider?.destroy();
  }

  async getTransparencyMetrics() {
    const [sourceRows] = await this.database.query(
      `SELECT source, SUM(GREATEST(gross_profit_cents, 0)) AS gross_cents,
              SUM(gas_fee_cents) AS gas_cents, SUM(net_profit_cents) AS net_cents,
              COUNT(*) AS event_count, MAX(occurred_at) AS last_event_at
       FROM yield_pool
       WHERE occurred_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR
       GROUP BY source`
    );
     const [recentRows] = await this.database.query(
      `SELECT source, source_ref, occurred_at FROM yield_pool
       WHERE occurred_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR
       ORDER BY occurred_at DESC, id DESC LIMIT 100`
     );
    const [[reserve]] = await this.database.query(
      'SELECT balance_cents, gross_yield_cents, updated_at FROM reserve_buffer WHERE id = 1'
    );
    const observed = {
      defi: { gross: 0, gas: 0, net: 0, eventCount: 0, lastEventAt: null, lastProofRef: null },
      arbitrage: { gross: 0, gas: 0, net: 0, eventCount: 0, lastEventAt: null, lastProofRef: null },
    };

    for (const row of sourceRows) {
      observed[row.source] = {
        gross: Number(row.gross_cents) / 100,
        gas: Number(row.gas_cents) / 100,
        net: Number(row.net_cents) / 100,
        eventCount: Number(row.event_count),
        lastEventAt: row.last_event_at,
        lastProofRef: null,
      };
    }
    for (const row of recentRows) {
      if (!observed[row.source].lastProofRef) observed[row.source].lastProofRef = row.source_ref;
    }

    const totalGross = observed.defi.gross + observed.arbitrage.gross;
    return {
      window: '24h',
      status: totalGross > 0 ? 'reporting' : this.config.configured ? 'awaiting-yield-events' : 'defi-source-not-configured',
      targetSplit: TARGET_SOURCE_SPLIT,
      observedSplit: totalGross > 0
        ? {
          defi: Number((observed.defi.gross / totalGross * 100).toFixed(2)),
          arbitrage: Number((observed.arbitrage.gross / totalGross * 100).toFixed(2)),
        }
        : null,
      sources: observed,
      reserveBuffer: {
        balance: Number(reserve?.balance_cents || 0) / 100,
        grossYieldRecorded: Number(reserve?.gross_yield_cents || 0) / 100,
        updatedAt: reserve?.updated_at || null,
      },
      defiProvider: {
        configured: this.config.configured,
        lastScannedBlock: this.config.configured ? await this.getLastScannedBlock() : null,
      },
    };
  }

  async getLastScannedBlock() {
    const [[row]] = await this.database.query(
      'SELECT state_value FROM yield_tracker_state WHERE state_key = ?',
      [CURSOR_KEY]
    );
    return row ? Number(row.state_value) : null;
  }
}

module.exports = { YieldTrackerService, TARGET_SOURCE_SPLIT, RESERVE_PERCENT, getDeFiConfig };
