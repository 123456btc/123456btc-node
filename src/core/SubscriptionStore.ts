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
        amount_bbt REAL NOT NULL,
        status TEXT DEFAULT 'pending',
        tx_signature TEXT,
        created_at INTEGER
      );
    `);
  }

  // ═══════════════════════════════════════════
  // Strategy
  // ═══════════════════════════════════════════

  createStrategy(strategy: Omit<Strategy, 'id' | 'created_at' | 'updated_at'>): Strategy {
    const id = generateId();
    const now = getCurrentTimestamp();
    const s: Strategy = { ...strategy, id, created_at: now, updated_at: now };

    

    const stmt = this.db.prepare(`
      INSERT INTO strategies (id, provider_id, name, description, symbol, market_type, pricing_model, price_per_day, price_per_signal, min_bbt_tier, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, s.provider_id, s.name, s.description, s.symbol, s.market_type, s.pricing_model, s.price_per_day, s.price_per_signal, s.min_bbt_tier, s.status, now, now);
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
    const id = generateId();
    const now = getCurrentTimestamp();
    const r: BillingRecord = { ...record, id, created_at: now };

    

    const stmt = this.db.prepare(`
      INSERT INTO billing_records (id, subscription_id, user_id, strategy_id, amount_bbt, status, tx_signature, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, r.subscription_id, r.user_id, r.strategy_id, r.amount_bbt, r.status, r.tx_signature, now);
    return r;
  }

  listBillingByUser(userId: string): BillingRecord[] {
    
    return this.db.prepare('SELECT * FROM billing_records WHERE user_id = ? ORDER BY created_at DESC').all(userId);
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

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}
