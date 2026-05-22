/**
 * SubscriptionStore — 本地数据层
 * 管理策略、用户、订阅、信号、账单
 *
 * 模式：
 * - SQLite 模式（生产）：使用 better-sqlite3，持久化存储
 * - sql.js 模式（开发）：better-sqlite3 不可用时 fallback 到 sql.js（纯 JS，跨平台）
 * 绝不使用纯内存模式 — 数据必须持久化
 */

import fs from 'fs';
import path from 'path';
import { generateId, getCurrentTimestamp } from '../utils/crypto.js';
import type { Strategy, User, Subscription, Signal, BillingRecord } from '../types/index.js';
import { SqlJsDatabase } from '../infra/db/SqlJsDatabase.js';

let Database: any;
try {
  Database = require('better-sqlite3');
} catch {
  console.warn('[SubscriptionStore] better-sqlite3 not available, will try sql.js');
}

export class SubscriptionStore {
  private db: any;

  private constructor(db: any) {
    this.db = db;
    this.initTables();
  }

  static async create(dbPath: string = './data/node.db'): Promise<SubscriptionStore> {
    // 1. 优先 better-sqlite3（生产环境）
    if (Database) {
      try {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        const db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
        console.log('[SubscriptionStore] Using better-sqlite3');
        return new SubscriptionStore(db);
      } catch (err) {
        console.warn('[SubscriptionStore] better-sqlite3 init failed:', (err as Error).message);
      }
    }

    // 2. Fallback 到 sql.js（macOS 开发环境）
    try {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = await SqlJsDatabase.open(dbPath);
      console.log('[SubscriptionStore] Using sql.js (WASM SQLite)');
      return new SubscriptionStore(db);
    } catch (err) {
      console.error('[SubscriptionStore] sql.js init also failed:', (err as Error).message);
      throw new Error('No database backend available. Install better-sqlite3 (Linux) or ensure sql.js works (macOS).');
    }
  }

  private initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS strategies (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        creator_wallet TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        description TEXT,
        symbol TEXT NOT NULL,
        market_type TEXT NOT NULL DEFAULT 'crypto',
        pricing_model TEXT NOT NULL DEFAULT 'daily_bbt',
        price_per_day REAL,
        price_per_signal REAL,
        min_bbt_tier INTEGER DEFAULT 0,
        status TEXT DEFAULT 'live',
        created_at INTEGER,
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        wallet_address TEXT UNIQUE NOT NULL,
        display_name TEXT,
        chain_bbt_balance REAL DEFAULT 0,
        status TEXT DEFAULT 'active',
        created_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        billing_model TEXT,
        next_bill_at INTEGER,
        created_at INTEGER,
        expires_at INTEGER,
        UNIQUE(user_id, strategy_id)
      );

      CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        decision TEXT NOT NULL,
        confidence REAL,
        price REAL,
        stop_loss REAL,
        take_profit REAL,
        reasoning TEXT,
        raw_payload TEXT,
        created_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS billing_records (
        id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'subscription',
        amount_bbt REAL NOT NULL,
        status TEXT DEFAULT 'pending',
        tx_signature TEXT UNIQUE,
        created_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_signals_strategy_created ON signals(strategy_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_subs_strategy_status ON subscriptions(strategy_id, status);
      CREATE INDEX IF NOT EXISTS idx_subs_user_status ON subscriptions(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_subs_status_bill ON subscriptions(status, next_bill_at);
      CREATE INDEX IF NOT EXISTS idx_billing_status ON billing_records(status);

      -- 盲盒记录表
      CREATE TABLE IF NOT EXISTS blindbox_records (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        user_wallet TEXT NOT NULL,
        tier_id TEXT NOT NULL,
        tier_name TEXT NOT NULL,
        cost_bbt REAL NOT NULL,
        created_at INTEGER NOT NULL,
        claimed INTEGER NOT NULL DEFAULT 0,
        claim_tx TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_blindbox_user ON blindbox_records(user_id, created_at DESC);

      -- 自动执行交易表
      CREATE TABLE IF NOT EXISTS execution_trades (
        id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        input_mint TEXT NOT NULL,
        output_mint TEXT NOT NULL,
        input_amount REAL NOT NULL,
        output_amount REAL NOT NULL,
        tx_signature TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trades_user ON execution_trades(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_trades_strategy ON execution_trades(strategy_id, created_at DESC);

      -- Provider 质押表
      CREATE TABLE IF NOT EXISTS provider_stakes (
        id TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        amount_bbt REAL NOT NULL,
        status TEXT DEFAULT 'active',
        created_at INTEGER,
        unlock_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_stakes_wallet ON provider_stakes(wallet_address, status);

      -- Agent 注册表
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        reputation_score INTEGER DEFAULT 500,
        successful_trades INTEGER DEFAULT 0,
        total_trades INTEGER DEFAULT 0,
        accurate_signals INTEGER DEFAULT 0,
        total_signals INTEGER DEFAULT 0,
        uptime_hours REAL DEFAULT 0,
        bbt_staked REAL DEFAULT 0,
        bot_nft_mint TEXT,
        metadata TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        last_active_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_agents_wallet ON agents(wallet_address);

      -- 策略-Agent 绑定表
      CREATE TABLE IF NOT EXISTS strategy_agents (
        id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_wallet TEXT NOT NULL,
        agent_type TEXT DEFAULT 'ai_llm',
        execution_mode TEXT DEFAULT 'auto',
        fee_share_bps INTEGER DEFAULT 100,
        status TEXT DEFAULT 'active',
        metadata TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        UNIQUE(strategy_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_strategy_agents_strategy ON strategy_agents(strategy_id);
      CREATE INDEX IF NOT EXISTS idx_strategy_agents_agent ON strategy_agents(agent_id);

      -- Bundle 产品表
      CREATE TABLE IF NOT EXISTS bundle_products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        price_sol REAL,
        price_bbt REAL,
        blindbox_count INTEGER DEFAULT 0,
        bonus_days INTEGER DEFAULT 0,
        nft_tier TEXT,
        strategy_ids TEXT,
        max_supply INTEGER DEFAULT 0,
        sold_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_bundle_products_status ON bundle_products(status);

      -- Bundle 购买记录表
      CREATE TABLE IF NOT EXISTS bundle_purchases (
        id TEXT PRIMARY KEY,
        bundle_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        user_id TEXT NOT NULL,
        payment_method TEXT,
        tx_signature TEXT,
        nft_id TEXT,
        nft_mint TEXT,
        tier TEXT,
        subscription_days INTEGER,
        expires_at INTEGER,
        blindbox_credits INTEGER DEFAULT 0,
        subscription_ids TEXT,
        created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_bundle_purchases_bundle ON bundle_purchases(bundle_id);
      CREATE INDEX IF NOT EXISTS idx_bundle_purchases_wallet ON bundle_purchases(wallet);
    `);

    this.migrateTables();
  }

  private migrateTables() {
    // 创建 schema 版本表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);

    // 获取当前版本
    const current = this.db.prepare('SELECT MAX(version) as version FROM schema_version').get() as { version: number | null };
    const currentVersion = current?.version || 0;

    // 定义迁移列表
    const migrations = [
      {
        version: 1,
        name: 'add_type_column_to_billing_records',
        up: () => {
          try {
            this.db.prepare('SELECT type FROM billing_records LIMIT 1').get();
          } catch {
            this.db.exec("ALTER TABLE billing_records ADD COLUMN type TEXT NOT NULL DEFAULT 'subscription'");
          }
        },
      },
      {
        version: 2,
        name: 'add_tx_signature_unique_index',
        up: () => {
          this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_tx_signature ON billing_records(tx_signature) WHERE tx_signature IS NOT NULL');
        },
      },
      {
        version: 3,
        name: 'add_creator_wallet_to_strategies',
        up: () => {
          try {
            this.db.prepare('SELECT creator_wallet FROM strategies LIMIT 1').get();
          } catch {
            this.db.exec("ALTER TABLE strategies ADD COLUMN creator_wallet TEXT NOT NULL DEFAULT ''");
          }
        },
      },
      {
        version: 4,
        name: 'add_provider_stakes',
        up: () => {
          this.db.exec(`CREATE TABLE IF NOT EXISTS provider_stakes (
            id TEXT PRIMARY KEY,
            wallet_address TEXT NOT NULL,
            amount_bbt REAL NOT NULL,
            status TEXT DEFAULT 'active',
            created_at INTEGER,
            unlock_at INTEGER
          )`);
          this.db.exec('CREATE INDEX IF NOT EXISTS idx_stakes_wallet ON provider_stakes(wallet_address, status)');
        },
      },
      {
        version: 5,
        name: 'add_agents_strategy_agents_bundle_tables',
        up: () => {
          this.db.exec(`CREATE TABLE IF NOT EXISTS agents (
            id TEXT PRIMARY KEY,
            wallet_address TEXT NOT NULL,
            display_name TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            reputation_score INTEGER DEFAULT 500,
            successful_trades INTEGER DEFAULT 0,
            total_trades INTEGER DEFAULT 0,
            accurate_signals INTEGER DEFAULT 0,
            total_signals INTEGER DEFAULT 0,
            uptime_hours REAL DEFAULT 0,
            bbt_staked REAL DEFAULT 0,
            bot_nft_mint TEXT,
            metadata TEXT,
            created_at INTEGER,
            updated_at INTEGER,
            last_active_at INTEGER
          )`);
          this.db.exec('CREATE INDEX IF NOT EXISTS idx_agents_wallet ON agents(wallet_address)');
          this.db.exec(`CREATE TABLE IF NOT EXISTS strategy_agents (
            id TEXT PRIMARY KEY,
            strategy_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            agent_wallet TEXT NOT NULL,
            agent_type TEXT DEFAULT 'ai_llm',
            execution_mode TEXT DEFAULT 'auto',
            fee_share_bps INTEGER DEFAULT 100,
            status TEXT DEFAULT 'active',
            metadata TEXT,
            created_at INTEGER,
            updated_at INTEGER,
            UNIQUE(strategy_id, agent_id)
          )`);
          this.db.exec('CREATE INDEX IF NOT EXISTS idx_strategy_agents_strategy ON strategy_agents(strategy_id)');
          this.db.exec('CREATE INDEX IF NOT EXISTS idx_strategy_agents_agent ON strategy_agents(agent_id)');
          this.db.exec(`CREATE TABLE IF NOT EXISTS bundle_products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            price_sol REAL,
            price_bbt REAL,
            blindbox_count INTEGER DEFAULT 0,
            bonus_days INTEGER DEFAULT 0,
            nft_tier TEXT,
            strategy_ids TEXT,
            max_supply INTEGER DEFAULT 0,
            sold_count INTEGER DEFAULT 0,
            status TEXT DEFAULT 'active',
            created_at INTEGER
          )`);
          this.db.exec('CREATE INDEX IF NOT EXISTS idx_bundle_products_status ON bundle_products(status)');
          this.db.exec(`CREATE TABLE IF NOT EXISTS bundle_purchases (
            id TEXT PRIMARY KEY,
            bundle_id TEXT NOT NULL,
            wallet TEXT NOT NULL,
            user_id TEXT NOT NULL,
            payment_method TEXT,
            tx_signature TEXT,
            nft_id TEXT,
            nft_mint TEXT,
            tier TEXT,
            subscription_days INTEGER,
            expires_at INTEGER,
            blindbox_credits INTEGER DEFAULT 0,
            subscription_ids TEXT,
            created_at INTEGER
          )`);
          this.db.exec('CREATE INDEX IF NOT EXISTS idx_bundle_purchases_bundle ON bundle_purchases(bundle_id)');
          this.db.exec('CREATE INDEX IF NOT EXISTS idx_bundle_purchases_wallet ON bundle_purchases(wallet)');
        },
      },
    ];

    // 按顺序执行未执行的迁移
    for (const migration of migrations) {
      if (migration.version > currentVersion) {
        try {
          migration.up();
          this.db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(migration.version, getCurrentTimestamp());
          console.log(`[SubscriptionStore] Migration v${migration.version} applied: ${migration.name}`);
        } catch (e) {
          console.warn(`[SubscriptionStore] Migration v${migration.version} failed (${migration.name}):`, (e as Error).message);
        }
      }
    }
  }

  // ═══════════════════════════════════════════
  // Strategy
  // ═══════════════════════════════════════════

  createStrategy(strategy: Omit<Strategy, 'id' | 'created_at' | 'updated_at'>): Strategy {
    const id = generateId();
    const now = getCurrentTimestamp();
    const s: Strategy = { ...strategy, id, created_at: now, updated_at: now };

    

    const stmt = this.db.prepare(`
      INSERT INTO strategies (id, provider_id, creator_wallet, name, description, symbol, market_type, pricing_model, price_per_day, price_per_signal, min_bbt_tier, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, s.provider_id, s.creator_wallet || '', s.name, s.description, s.symbol, s.market_type, s.pricing_model, s.price_per_day, s.price_per_signal, s.min_bbt_tier, s.status, now, now);
    return s;
  }

  getStrategy(id: string): Strategy | undefined {
return this.db.prepare('SELECT * FROM strategies WHERE id = ?').get(id);
  }

  listStrategies(providerId?: string): Strategy[] {
    
    if (providerId) {
      return this.db.prepare('SELECT * FROM strategies WHERE provider_id = ? ORDER BY created_at DESC').all(providerId);
    }
    return this.db.prepare('SELECT * FROM strategies ORDER BY created_at DESC').all();
  }

  updateStrategyStatus(id: string, status: Strategy['status']) {
    
    this.db.prepare('UPDATE strategies SET status = ?, updated_at = ? WHERE id = ?').run(status, getCurrentTimestamp(), id);
  }

  // ═══════════════════════════════════════════
  // User
  // ═══════════════════════════════════════════

  createUser(user: Omit<User, 'id' | 'created_at'>): User {
    const id = generateId();
    const now = getCurrentTimestamp();
    const u: User = { ...user, id, created_at: now };

    

    const stmt = this.db.prepare(`
      INSERT INTO users (id, wallet_address, display_name, chain_bbt_balance, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, u.wallet_address, u.display_name, u.chain_bbt_balance, u.status, now);
    return u;
  }

  getUserByWallet(wallet: string): User | undefined {
return this.db.prepare('SELECT * FROM users WHERE wallet_address = ?').get(wallet);
  }

  getUser(id: string): User | undefined {
return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  updateUserBalance(userId: string, balance: number) {
    
    this.db.prepare('UPDATE users SET chain_bbt_balance = ? WHERE id = ?').run(balance, userId);
  }

  // ═══════════════════════════════════════════
  // Subscription
  // ═══════════════════════════════════════════

  createSubscription(sub: Omit<Subscription, 'id' | 'created_at'>): Subscription {
    const id = generateId();
    const now = getCurrentTimestamp();
    const s: Subscription = { ...sub, id, created_at: now };

    

    const stmt = this.db.prepare(`
      INSERT INTO subscriptions (id, user_id, strategy_id, status, billing_model, next_bill_at, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, s.user_id, s.strategy_id, s.status, s.billing_model, s.next_bill_at, now, (s as any).expires_at || null);
    return s;
  }

  getSubscription(userId: string, strategyId: string): Subscription | undefined {
    
    return this.db.prepare('SELECT * FROM subscriptions WHERE user_id = ? AND strategy_id = ?').get(userId, strategyId);
  }

  getSubscriptionById(id: string): Subscription | undefined {
return this.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
  }

  getSubscribersByStrategy(strategyId: string): (Subscription & { wallet_address: string; display_name: string })[] {
    
    return this.db.prepare(`
      SELECT s.*, u.wallet_address, u.display_name
      FROM subscriptions s
      JOIN users u ON s.user_id = u.id
      WHERE s.strategy_id = ?
    `).all(strategyId);
  }

  listAllSubscriptions(): (Subscription & { strategy_name: string; wallet_address: string })[] {
    
    return this.db.prepare(`
      SELECT s.*, st.name as strategy_name, u.wallet_address
      FROM subscriptions s
      JOIN strategies st ON s.strategy_id = st.id
      JOIN users u ON s.user_id = u.id
      ORDER BY s.created_at DESC
    `).all();
  }

  getActiveSubscriptionsByStrategy(strategyId: string): Subscription[] {
    
    return this.db.prepare("SELECT * FROM subscriptions WHERE strategy_id = ? AND status = 'active'").all(strategyId);
  }

  getActiveSubscriptionsByUser(userId: string): Subscription[] {

    return this.db.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'").all(userId);
  }

  getSubscriptionsByUser(userId: string): Subscription[] {
    return this.db.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status IN ('active', 'pending') ORDER BY created_at DESC").all(userId);
  }

  updateSubscriptionStatus(id: string, status: Subscription['status']) {
    
    this.db.prepare('UPDATE subscriptions SET status = ? WHERE id = ?').run(status, id);
  }

  updateSubscriptionNextBill(id: string, nextBillAt: number) {
    
    this.db.prepare('UPDATE subscriptions SET next_bill_at = ? WHERE id = ?').run(nextBillAt, id);
  }

  extendSubscription(id: string, newExpiry: number) {
    
    this.db.prepare('UPDATE subscriptions SET expires_at = ?, status = ? WHERE id = ?').run(newExpiry, 'active', id);
  }

  getExpiringSubscriptions(before: number): Subscription[] {
    
    return this.db.prepare('SELECT * FROM subscriptions WHERE status = ? AND next_bill_at < ?').all('active', before);
  }

  // ═══════════════════════════════════════════
  // Signal
  // ═══════════════════════════════════════════

  createSignal(signal: Omit<Signal, 'id' | 'created_at'>): Signal {
    const id = generateId();
    const now = getCurrentTimestamp();
    const s: Signal = { ...signal, id, created_at: now };

    

    const stmt = this.db.prepare(`
      INSERT INTO signals (id, strategy_id, provider_id, symbol, decision, confidence, price, stop_loss, take_profit, reasoning, raw_payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, s.strategy_id, s.provider_id, s.symbol, s.decision, s.confidence, s.price, s.stop_loss, s.take_profit, s.reasoning, s.raw_payload, now);
    return s;
  }

  listSignals(strategyId?: string, limit: number = 100): Signal[] {
    
    if (strategyId) {
      return this.db.prepare('SELECT * FROM signals WHERE strategy_id = ? ORDER BY created_at DESC LIMIT ?').all(strategyId, limit);
    }
    return this.db.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  getSignalsByStrategyIds(strategyIds: string[], limit: number): Signal[] {
    
    const placeholders = strategyIds.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM signals WHERE strategy_id IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`).all(...strategyIds, limit);
  }

  // ═══════════════════════════════════════════
  // Billing
  // ═══════════════════════════════════════════

  createBilling(record: Omit<BillingRecord, 'id' | 'created_at'>): BillingRecord {
    // Idempotency: if tx_signature already exists, return existing record
    if (record.tx_signature) {
      const existing = this.db.prepare('SELECT * FROM billing_records WHERE tx_signature = ?').get(record.tx_signature);
      if (existing) {
        console.log(`[SubscriptionStore] Billing already exists for tx=${record.tx_signature}, skipping`);
        return existing as BillingRecord;
      }
    }

    const id = generateId();
    const now = getCurrentTimestamp();
    const r: BillingRecord = { ...record, id, created_at: now };

    const stmt = this.db.prepare(`
      INSERT INTO billing_records (id, subscription_id, user_id, strategy_id, type, amount_bbt, status, tx_signature, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, r.subscription_id, r.user_id, r.strategy_id, r.type, r.amount_bbt, r.status, r.tx_signature ?? null, now);
    return r;
  }

  listBillingByUser(userId: string): BillingRecord[] {
    return this.db.prepare('SELECT * FROM billing_records WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  }

  getBillingByTxSignature(txSignature: string): BillingRecord | undefined {
    return this.db.prepare('SELECT * FROM billing_records WHERE tx_signature = ?').get(txSignature);
  }

  getTotalBillingByStatus(status: string): number {
    
    const row = this.db.prepare('SELECT SUM(amount_bbt) as total FROM billing_records WHERE status = ?').get(status);
    return row?.total || 0;
  }

  getActiveSubscriberCount(): number {
    
    const row = this.db.prepare("SELECT COUNT(DISTINCT user_id) as total FROM subscriptions WHERE status = 'active'").get();
    return row?.total || 0;
  }

  getRecentBills(limit: number = 50): unknown[] {
    
    return this.db.prepare(`
      SELECT b.*, s.name as strategy_name, u.wallet_address
      FROM billing_records b
      JOIN strategies s ON b.strategy_id = s.id
      JOIN users u ON b.user_id = u.id
      ORDER BY b.created_at DESC LIMIT ?
    `).all(limit);
  }

  // ═══════════════════════════════════════════
  // BlindBox Records
  // ═══════════════════════════════════════════

  insertBlindBoxRecord(record: { id: string; user_id: string; user_wallet: string; tier_id: string; tier_name: string; cost_bbt: number; created_at: number; claimed: boolean }): void {
    this.db.prepare('INSERT INTO blindbox_records (id, user_id, user_wallet, tier_id, tier_name, cost_bbt, created_at, claimed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.user_id, record.user_wallet, record.tier_id, record.tier_name, record.cost_bbt, record.created_at, record.claimed ? 1 : 0);
  }

  getBlindBoxByUser(userId: string, limit: number = 50): any[] {
    return this.db.prepare('SELECT * FROM blindbox_records WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
  }

  getRecentBlindBox(limit: number = 50): any[] {
    return this.db.prepare('SELECT * FROM blindbox_records ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  updateBlindBoxClaimed(id: string, claimed: boolean, claimTx?: string): void {
    this.db.prepare('UPDATE blindbox_records SET claimed = ?, claim_tx = ? WHERE id = ?').run(claimed ? 1 : 0, claimTx || null, id);
  }

  getBlindBoxDailyCount(userId: string, dateStart: number, dateEnd: number): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM blindbox_records WHERE user_id = ? AND created_at >= ? AND created_at < ?').get(userId, dateStart, dateEnd) as any;
    return row?.cnt || 0;
  }

  // ═══════════════════════════════════════════
  // Execution Trades
  // ═══════════════════════════════════════════

  insertExecutionTrade(trade: { id: string; signal_id: string; strategy_id: string; user_id: string; decision: string; input_mint: string; output_mint: string; input_amount: number; output_amount: number; tx_signature: string; status: string; created_at: number }): void {
    this.db.prepare('INSERT INTO execution_trades (id, signal_id, strategy_id, user_id, decision, input_mint, output_mint, input_amount, output_amount, tx_signature, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(trade.id, trade.signal_id, trade.strategy_id, trade.user_id, trade.decision, trade.input_mint, trade.output_mint, trade.input_amount, trade.output_amount, trade.tx_signature, trade.status, trade.created_at);
  }

  getTradesByUser(userId: string, limit: number = 50, offset: number = 0): any[] {
    return this.db.prepare('SELECT * FROM execution_trades WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(userId, limit, offset);
  }

  getTradesByStrategy(strategyId: string, limit: number = 50): any[] {
    return this.db.prepare('SELECT * FROM execution_trades WHERE strategy_id = ? ORDER BY created_at DESC LIMIT ?').all(strategyId, limit);
  }

  // ═══════════════════════════════════════════
  // Provider Stakes
  // ═══════════════════════════════════════════

  createStake(walletAddress: string, amountBbt: number, lockDays: number = 30): any {
    const id = `stake_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const unlockAt = now + lockDays * 24 * 60 * 60 * 1000;
    this.db.prepare('INSERT INTO provider_stakes (id, wallet_address, amount_bbt, status, created_at, unlock_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, walletAddress, amountBbt, 'active', now, unlockAt);
    return { id, wallet_address: walletAddress, amount_bbt: amountBbt, status: 'active', created_at: now, unlock_at: unlockAt };
  }

  getActiveStake(walletAddress: string): any {
    return this.db.prepare('SELECT * FROM provider_stakes WHERE wallet_address = ? AND status = ? ORDER BY created_at DESC LIMIT 1').get(walletAddress, 'active');
  }

  slashStake(stakeId: string): void {
    this.db.prepare("UPDATE provider_stakes SET status = 'slashed' WHERE id = ?").run(stakeId);
  }

  getTotalStakedBbt(): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(amount_bbt), 0) as total FROM provider_stakes WHERE status = 'active'").get() as any;
    return row?.total || 0;
  }

  // ═══════════════════════════════════════════
  // Agent
  // ═══════════════════════════════════════════

  createAgent(agent: any): any {
    const stmt = this.db.prepare(`
      INSERT INTO agents (id, wallet_address, display_name, status, reputation_score, successful_trades, total_trades, accurate_signals, total_signals, uptime_hours, bbt_staked, bot_nft_mint, metadata, created_at, updated_at, last_active_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      agent.agent_id || agent.id,
      agent.wallet_address,
      agent.display_name,
      agent.status || 'active',
      agent.reputation_score ?? 500,
      agent.successful_trades ?? 0,
      agent.total_trades ?? 0,
      agent.accurate_signals ?? 0,
      agent.total_signals ?? 0,
      agent.uptime_hours ?? 0,
      agent.bbt_staked ?? 0,
      agent.bot_nft_mint || null,
      agent.metadata ? JSON.stringify(agent.metadata) : null,
      agent.created_at || Date.now(),
      agent.updated_at || Date.now(),
      agent.last_active_at || Date.now(),
    );
    return agent;
  }

  getAgent(id: string): any {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
    return row ? this.mapAgentRow(row) : undefined;
  }

  getAgentByWallet(wallet: string): any {
    const row = this.db.prepare('SELECT * FROM agents WHERE wallet_address = ?').get(wallet);
    return row ? this.mapAgentRow(row) : undefined;
  }

  updateAgent(id: string, updates: Record<string, any>): void {
    const allowed = ['display_name', 'status', 'reputation_score', 'successful_trades', 'total_trades', 'accurate_signals', 'total_signals', 'uptime_hours', 'bbt_staked', 'bot_nft_mint', 'metadata', 'last_active_at'];
    const fields: string[] = [];
    const values: any[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (allowed.includes(key)) {
        fields.push(`${key} = ?`);
        values.push(key === 'metadata' && value && typeof value === 'object' ? JSON.stringify(value) : value);
      }
    }
    if (fields.length === 0) return;
    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);
    this.db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  listAgents(status?: string): any[] {
    if (status) {
      return this.db.prepare('SELECT * FROM agents WHERE status = ? ORDER BY reputation_score DESC').all(status).map((r: any) => this.mapAgentRow(r));
    }
    return this.db.prepare('SELECT * FROM agents ORDER BY reputation_score DESC').all().map((r: any) => this.mapAgentRow(r));
  }

  getAgentStatistics(): any {
    const total = this.db.prepare("SELECT COUNT(*) as c FROM agents").get() as any;
    const active = this.db.prepare("SELECT COUNT(*) as c FROM agents WHERE status = 'active'").get() as any;
    const suspended = this.db.prepare("SELECT COUNT(*) as c FROM agents WHERE status = 'suspended'").get() as any;
    const banned = this.db.prepare("SELECT COUNT(*) as c FROM agents WHERE status = 'banned'").get() as any;
    const pending = this.db.prepare("SELECT COUNT(*) as c FROM agents WHERE status = 'pending_verification'").get() as any;
    const withNft = this.db.prepare("SELECT COUNT(*) as c FROM agents WHERE bot_nft_mint IS NOT NULL").get() as any;
    const avgRep = this.db.prepare("SELECT COALESCE(AVG(reputation_score), 0) as c FROM agents").get() as any;
    const totalStaked = this.db.prepare("SELECT COALESCE(SUM(bbt_staked), 0) as c FROM agents").get() as any;
    return {
      total: total?.c || 0,
      active: active?.c || 0,
      suspended: suspended?.c || 0,
      banned: banned?.c || 0,
      pending: pending?.c || 0,
      with_nft: withNft?.c || 0,
      avg_reputation: Math.round(avgRep?.c || 0),
      total_staked: totalStaked?.c || 0,
    };
  }

  private mapAgentRow(row: any): any {
    let metadataUri: string | undefined;
    try {
      const meta = row.metadata ? JSON.parse(row.metadata) : undefined;
      metadataUri = meta?.metadata_uri;
    } catch {}
    return {
      agent_id: row.id,
      wallet_address: row.wallet_address,
      display_name: row.display_name,
      metadata_uri: metadataUri,
      status: row.status,
      reputation_score: row.reputation_score,
      total_trades: row.total_trades,
      successful_trades: row.successful_trades,
      total_signals: row.total_signals,
      accurate_signals: row.accurate_signals,
      uptime_hours: row.uptime_hours,
      bot_nft_mint: row.bot_nft_mint,
      bbt_staked: row.bbt_staked,
      created_at: row.created_at,
      updated_at: row.updated_at || row.last_active_at || row.created_at,
      last_active_at: row.last_active_at,
    };
  }

  // ═══════════════════════════════════════════
  // Strategy-Agent Binding
  // ═══════════════════════════════════════════

  createStrategyAgentBinding(binding: any): any {
    const stmt = this.db.prepare(`
      INSERT INTO strategy_agents (id, strategy_id, agent_id, agent_wallet, agent_type, execution_mode, fee_share_bps, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      binding.id,
      binding.strategy_id,
      binding.agent_id,
      binding.agent_wallet,
      binding.agent_type || 'ai_llm',
      binding.execution_mode || 'auto',
      binding.fee_share_bps ?? 100,
      binding.status || 'active',
      binding.metadata ? JSON.stringify(binding.metadata) : null,
      binding.created_at || Date.now(),
      binding.updated_at || Date.now(),
    );
    return binding;
  }

  getStrategyAgents(strategyId: string): any[] {
    return this.db.prepare("SELECT * FROM strategy_agents WHERE strategy_id = ? AND status = 'active' ORDER BY created_at DESC").all(strategyId).map((r: any) => this.mapBindingRow(r));
  }

  getAgentBinding(agentId: string): any {
    const row = this.db.prepare("SELECT * FROM strategy_agents WHERE agent_id = ?").get(agentId);
    return row ? this.mapBindingRow(row) : undefined;
  }

  removeStrategyAgentBinding(agentId: string): void {
    this.db.prepare("UPDATE strategy_agents SET status = 'revoked', updated_at = ? WHERE agent_id = ?").run(Date.now(), agentId);
  }

  updateStrategyAgentBindingStatus(agentId: string, status: string): void {
    this.db.prepare("UPDATE strategy_agents SET status = ?, updated_at = ? WHERE agent_id = ?").run(status, Date.now(), agentId);
  }

  private mapBindingRow(row: any): any {
    let metadata: Record<string, unknown> = {};
    try {
      if (row.metadata) metadata = JSON.parse(row.metadata);
    } catch {}
    return {
      id: row.id,
      strategy_id: row.strategy_id,
      agent_id: row.agent_id,
      agent_wallet: row.agent_wallet,
      agent_type: row.agent_type,
      execution_mode: row.execution_mode,
      fee_share_bps: row.fee_share_bps,
      status: row.status,
      metadata,
      created_at: row.created_at,
      updated_at: row.updated_at || row.created_at,
    };
  }

  // ═══════════════════════════════════════════
  // Bundle Products & Purchases
  // ═══════════════════════════════════════════

  createBundleProduct(product: any): any {
    const stmt = this.db.prepare(`
      INSERT INTO bundle_products (id, name, description, price_sol, price_bbt, blindbox_count, bonus_days, nft_tier, strategy_ids, max_supply, sold_count, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      product.id,
      product.name,
      product.description || null,
      product.price_sol ?? 0,
      product.price_bbt ?? 0,
      product.blindbox_count ?? 0,
      product.bonus_days ?? 0,
      product.nft_tier || null,
      product.strategy_ids ? JSON.stringify(product.strategy_ids) : null,
      product.max_supply ?? 0,
      product.sold_count ?? 0,
      product.status || 'active',
      product.created_at || Date.now(),
    );
    return product;
  }

  getBundleProducts(): any[] {
    return this.db.prepare("SELECT * FROM bundle_products WHERE status = 'active' ORDER BY created_at DESC").all().map((r: any) => this.mapBundleRow(r));
  }

  getBundleProduct(id: string): any {
    const row = this.db.prepare('SELECT * FROM bundle_products WHERE id = ?').get(id);
    return row ? this.mapBundleRow(row) : undefined;
  }

  updateBundleSoldCount(id: string, soldCount: number): void {
    this.db.prepare('UPDATE bundle_products SET sold_count = ? WHERE id = ?').run(soldCount, id);
  }

  purchaseBundle(record: any): any {
    const stmt = this.db.prepare(`
      INSERT INTO bundle_purchases (id, bundle_id, wallet, user_id, payment_method, tx_signature, nft_id, nft_mint, tier, subscription_days, expires_at, blindbox_credits, subscription_ids, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.id,
      record.bundle_id,
      record.wallet,
      record.user_id,
      record.payment_method || null,
      record.tx_signature || null,
      record.nft_id || null,
      record.nft_mint || null,
      record.tier || null,
      record.subscription_days || null,
      record.expires_at || null,
      record.blindbox_credits ?? 0,
      record.subscription_ids ? JSON.stringify(record.subscription_ids) : null,
      record.created_at || Date.now(),
    );
    return record;
  }

  getBundlePurchases(wallet?: string): any[] {
    if (wallet) {
      return this.db.prepare('SELECT * FROM bundle_purchases WHERE wallet = ? ORDER BY created_at DESC').all(wallet);
    }
    return this.db.prepare('SELECT * FROM bundle_purchases ORDER BY created_at DESC').all();
  }

  getBundlePurchaseByTx(txSignature: string): any {
    return this.db.prepare('SELECT * FROM bundle_purchases WHERE tx_signature = ?').get(txSignature);
  }

  private mapBundleRow(row: any): any {
    let strategyIds: string[] = [];
    try {
      if (row.strategy_ids) strategyIds = JSON.parse(row.strategy_ids);
    } catch {}
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      price_sol: row.price_sol,
      price_bbt: row.price_bbt,
      blindbox_count: row.blindbox_count,
      bonus_days: row.bonus_days,
      nft_tier: row.nft_tier,
      strategy_ids: strategyIds,
      max_supply: row.max_supply,
      sold_count: row.sold_count,
      status: row.status,
      created_at: row.created_at,
    };
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}
