/**
 * SQLiteStore — 生产级 SQLite 存储实现
 * 特性：
 * 1. 实现 IUnitOfWork 接口
 * 2. 支持列级 AES 加密（敏感字段）
 * 3. 事务支持
 * 4. 比 MemoryStore 更适合生产环境
 *
 * 注意：运行时动态导入 better-sqlite3，避免无 native 模块时崩溃
 */

import 'reflect-metadata';
import { singleton } from 'tsyringe';
import type Database from 'better-sqlite3';
import { Logger } from '../logger/Logger.js';
import { CryptoVault } from '../security/CryptoVault.js';
import { AppConfig } from '../config/AppConfig.js';
import {
  type IUnitOfWork,
  type IStrategyRepository,
  type IUserRepository,
  type ISubscriptionRepository,
  type ISignalRepository,
  type IBillingRepository,
} from '../../core/repository/interfaces.js';
import type { Strategy, User, Subscription, Signal, BillingRecord } from '../../types/index.js';

// 需要加密的敏感列
const ENCRYPTED_COLUMNS: Record<string, string[]> = {
  users: ['wallet_address'],
  billing_records: ['tx_signature'],
};

class SQLiteStrategyRepo implements IStrategyRepository {
  constructor(private db: Database.Database, private vault: CryptoVault) {}

  create(s: Omit<Strategy, 'id' | 'created_at' | 'updated_at'>): Strategy {
    const id = `strat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    const row: Strategy = { ...s, id, created_at: now, updated_at: now };
    this.db.prepare(`INSERT INTO strategies (id,provider_id,name,description,symbol,market_type,pricing_model,price_per_day,price_per_signal,min_bbt_tier,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.id, row.provider_id, row.name ?? null, row.description ?? null, row.symbol, row.market_type, row.pricing_model,
      row.price_per_day ?? null, row.price_per_signal ?? null, row.min_bbt_tier, row.status, row.created_at, row.updated_at
    );
    return row;
  }

  findById(id: string): Strategy | undefined {
    return this.db.prepare('SELECT * FROM strategies WHERE id = ?').get(id) as Strategy | undefined;
  }

  findByProvider(providerId: string): Strategy[] {
    return this.db.prepare('SELECT * FROM strategies WHERE provider_id = ? ORDER BY updated_at DESC').all(providerId) as Strategy[];
  }

  findAll(options?: { status?: string; limit?: number; offset?: number }): Strategy[] {
    let sql = 'SELECT * FROM strategies';
    const params: unknown[] = [];
    if (options?.status) { sql += ' WHERE status = ?'; params.push(options.status); }
    sql += ' ORDER BY updated_at DESC';
    if (options?.limit) { sql += ' LIMIT ?'; params.push(options.limit); }
    if (options?.offset) { sql += ' OFFSET ?'; params.push(options.offset); }
    return this.db.prepare(sql).all(...params) as Strategy[];
  }

  updateStatus(id: string, status: Strategy['status']): void {
    this.db.prepare('UPDATE strategies SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
  }
}

class SQLiteUserRepo implements IUserRepository {
  constructor(private db: Database.Database, private vault: CryptoVault) {}

  private encrypt(value: string): string { return this.vault.encrypt(value); }
  private decrypt(value: string): string { return this.vault.decrypt(value); }

  create(u: Omit<User, 'id' | 'created_at'>): User {
    const id = `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    const row: User = { ...u, id, created_at: now };
    const walletEncrypted = this.encrypt(row.wallet_address);
    this.db.prepare('INSERT INTO users (id,wallet_address,display_name,chain_bbt_balance,status,created_at) VALUES (?,?,?,?,?,?)')
      .run(row.id, walletEncrypted, row.display_name ?? null, row.chain_bbt_balance, row.status, row.created_at);
    return row;
  }

  findById(id: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as (User & { wallet_address: string }) | undefined;
    if (row) row.wallet_address = this.decrypt(row.wallet_address);
    return row;
  }

  findByWallet(wallet: string): User | undefined {
    // 由于 wallet 加密，无法直接查询。生产环境应建立 hash 索引。
    // 这里简化为遍历（小数据量可接受，大数据需重构）
    const rows = this.db.prepare('SELECT * FROM users').all() as (User & { wallet_address: string })[];
    for (const row of rows) {
      if (this.decrypt(row.wallet_address) === wallet) {
        row.wallet_address = wallet;
        return row;
      }
    }
    return undefined;
  }

  updateBalance(userId: string, balance: number): void {
    this.db.prepare('UPDATE users SET chain_bbt_balance = ? WHERE id = ?').run(balance, userId);
  }
}

class SQLiteSubscriptionRepo implements ISubscriptionRepository {
  constructor(private db: Database.Database, private vault: CryptoVault) {}

  create(sub: Omit<Subscription, 'id' | 'created_at'>): Subscription {
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    const row: Subscription = { ...sub, id, created_at: now };
    this.db.prepare('INSERT INTO subscriptions (id,user_id,strategy_id,status,billing_model,next_bill_at,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(row.id, row.user_id, row.strategy_id, row.status, row.billing_model, row.next_bill_at ?? null, row.created_at);
    return row;
  }

  findById(id: string): Subscription | undefined {
    return this.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as Subscription | undefined;
  }

  findByUserAndStrategy(userId: string, strategyId: string): Subscription | undefined {
    return this.db.prepare('SELECT * FROM subscriptions WHERE user_id = ? AND strategy_id = ?').get(userId, strategyId) as Subscription | undefined;
  }

  findActiveByStrategy(strategyId: string): Subscription[] {
    return this.db.prepare("SELECT * FROM subscriptions WHERE strategy_id = ? AND status = 'active'").all(strategyId) as Subscription[];
  }

  findActiveByUser(userId: string): (Subscription & { strategy_name?: string; symbol?: string })[] {
    return this.db.prepare(`SELECT s.*, st.name as strategy_name, st.symbol FROM subscriptions s JOIN strategies st ON s.strategy_id = st.id WHERE s.user_id = ? AND s.status = 'active'`).all(userId) as (Subscription & { strategy_name: string; symbol: string })[];
  }

  findExpiringBefore(timestamp: number): Subscription[] {
    return this.db.prepare("SELECT * FROM subscriptions WHERE status = 'active' AND next_bill_at <= ?").all(timestamp) as Subscription[];
  }

  updateStatus(id: string, status: Subscription['status']): void {
    this.db.prepare('UPDATE subscriptions SET status = ? WHERE id = ?').run(status, id);
  }

  updateNextBill(id: string, nextBillAt: number): void {
    this.db.prepare('UPDATE subscriptions SET next_bill_at = ? WHERE id = ?').run(nextBillAt, id);
  }
}

class SQLiteSignalRepo implements ISignalRepository {
  constructor(private db: Database.Database, private vault: CryptoVault) {}

  create(sig: Omit<Signal, 'id' | 'created_at'>): Signal {
    const id = `sig_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    const row: Signal = { ...sig, id, created_at: now };
    this.db.prepare(`INSERT INTO signals (id,strategy_id,provider_id,symbol,decision,confidence,price,stop_loss,take_profit,reasoning,raw_payload,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.id, row.strategy_id, row.provider_id, row.symbol, row.decision,
      row.confidence ?? null, row.price ?? null, row.stop_loss ?? null,
      row.take_profit ?? null, row.reasoning ?? null, row.raw_payload, row.created_at
    );
    return row;
  }

  findByStrategyIds(strategyIds: string[], limit: number): Signal[] {
    if (strategyIds.length === 0) return [];
    const placeholders = strategyIds.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM signals WHERE strategy_id IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`).all(...strategyIds, limit) as Signal[];
  }

  findLatestByStrategy(strategyId: string): Signal | undefined {
    return this.db.prepare('SELECT * FROM signals WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(strategyId) as Signal | undefined;
  }
}

class SQLiteBillingRepo implements IBillingRepository {
  constructor(private db: Database.Database, private vault: CryptoVault) {}

  private encrypt(value: string): string { return this.vault.encrypt(value); }
  private decrypt(value: string): string { return this.vault.decrypt(value); }

  create(record: Omit<BillingRecord, 'id' | 'created_at'>): BillingRecord {
    const id = `bill_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    const row: BillingRecord = { ...record, id, created_at: now };
    const txSigEncrypted = row.tx_signature ? this.encrypt(row.tx_signature) : null;
    this.db.prepare('INSERT INTO billing_records (id,user_id,strategy_id,type,amount_bbt,tx_signature,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(row.id, row.user_id, row.strategy_id, row.type, row.amount_bbt, txSigEncrypted, row.status, row.created_at);
    return row;
  }

  confirmTx(id: string, txSignature: string): void {
    const encrypted = this.encrypt(txSignature);
    this.db.prepare('UPDATE billing_records SET tx_signature = ?, status = ? WHERE id = ?').run(encrypted, 'confirmed', id);
  }

  getTotalByStatus(status: string): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(amount_bbt), 0) as total FROM billing_records WHERE status = ?').get(status) as { total: number } | undefined;
    return row?.total ?? 0;
  }

  getRecent(limit: number): unknown[] {
    return this.db.prepare(`SELECT br.*, u.wallet_address, st.name as strategy_name FROM billing_records br JOIN users u ON br.user_id = u.id JOIN strategies st ON br.strategy_id = st.id ORDER BY br.created_at DESC LIMIT ?`).all(limit);
  }
}

@singleton()
export class SQLiteStore implements IUnitOfWork {
  strategies: IStrategyRepository;
  users: IUserRepository;
  subscriptions: ISubscriptionRepository;
  signals: ISignalRepository;
  billing: IBillingRepository;
  private db: Database.Database;

  constructor(
    private config: AppConfig,
    private logger: Logger,
    private vault: CryptoVault,
  ) {
    // 动态导入 better-sqlite3，避免无 native 依赖时崩溃
    const DatabaseConstructor = require('better-sqlite3');
    const dbPath = config.get('db_path');
    this.db = new DatabaseConstructor(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();

    this.strategies = new SQLiteStrategyRepo(this.db, vault);
    this.users = new SQLiteUserRepo(this.db, vault);
    this.subscriptions = new SQLiteSubscriptionRepo(this.db, vault);
    this.signals = new SQLiteSignalRepo(this.db, vault);
    this.billing = new SQLiteBillingRepo(this.db, vault);

    logger.info('SQLiteStore initialized', { dbPath, encrypted: true });
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS strategies (
        id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
        symbol TEXT NOT NULL, market_type TEXT NOT NULL DEFAULT 'crypto', pricing_model TEXT NOT NULL DEFAULT 'daily_bbt',
        price_per_day REAL, price_per_signal REAL, min_bbt_tier INTEGER DEFAULT 0,
        status TEXT DEFAULT 'live', created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, wallet_address TEXT NOT NULL, display_name TEXT,
        chain_bbt_balance REAL DEFAULT 0, status TEXT DEFAULT 'active', created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, strategy_id TEXT NOT NULL,
        status TEXT DEFAULT 'active', billing_model TEXT, next_bill_at INTEGER, created_at INTEGER,
        UNIQUE(user_id, strategy_id)
      );
      CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, provider_id TEXT NOT NULL, symbol TEXT NOT NULL,
        decision TEXT NOT NULL, confidence REAL, price REAL, stop_loss REAL, take_profit REAL,
        reasoning TEXT, raw_payload TEXT, created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS billing_records (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, strategy_id TEXT NOT NULL,
        type TEXT NOT NULL, amount_bbt REAL NOT NULL, tx_signature TEXT,
        status TEXT DEFAULT 'pending', created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_signals_strategy ON signals(strategy_id);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_strategy ON subscriptions(strategy_id);
      CREATE INDEX IF NOT EXISTS idx_billing_user ON billing_records(user_id);
    `);
  }

  transaction<T>(fn: () => T): T {
    const begin = this.db.prepare('BEGIN');
    const commit = this.db.prepare('COMMIT');
    const rollback = this.db.prepare('ROLLBACK');
    try {
      begin.run();
      const result = fn();
      commit.run();
      return result;
    } catch (e) {
      rollback.run();
      throw e;
    }
  }

  emergencyWipe(): void {
    this.logger.warn('SQLiteStore emergency wipe initiated');
    this.db.exec(`
      DROP TABLE IF EXISTS strategies;
      DROP TABLE IF EXISTS users;
      DROP TABLE IF EXISTS subscriptions;
      DROP TABLE IF EXISTS signals;
      DROP TABLE IF EXISTS billing_records;
    `);
    this.vault.emergencyWipe();
  }

  close(): void {
    this.db.close();
  }
}
