/**
 * MemoryStore — 内存存储实现
 * 用途：
 * 1. 单元测试（无需 SQLite native 依赖）
 * 2. 轻量级节点（Relay / 测试环境）
 * 3. 开发调试
 *
 * 特性：
 * - 完全实现 IUnitOfWork 接口
 * - 数据在内存中，进程退出即丢失
 * - 支持基础查询和事务模拟
 */

import 'reflect-metadata';
import { singleton } from 'tsyringe';
import { Logger } from '../logger/Logger.js';
import {
  type IUnitOfWork,
  type IStrategyRepository,
  type IUserRepository,
  type ISubscriptionRepository,
  type ISignalRepository,
  type IBillingRepository,
} from '../../core/repository/interfaces.js';
import type { Strategy, User, Subscription, Signal, BillingRecord } from '../../types/index.js';
import { CryptoVault } from '../security/CryptoVault.js';

class MemoryStrategyRepo implements IStrategyRepository {
  private data = new Map<string, Strategy>();

  create(s: Omit<Strategy, 'id' | 'created_at' | 'updated_at'>): Strategy {
    const strategy: Strategy = {
      ...s,
      id: `strat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    this.data.set(strategy.id, strategy);
    return strategy;
  }

  findById(id: string): Strategy | undefined {
    return this.data.get(id);
  }

  findByProvider(providerId: string): Strategy[] {
    return Array.from(this.data.values()).filter((s) => s.provider_id === providerId);
  }

  findAll(options?: { status?: string; limit?: number; offset?: number }): Strategy[] {
    let results = Array.from(this.data.values());
    if (options?.status) results = results.filter((s) => s.status === options.status);
    if (options?.offset) results = results.slice(options.offset);
    if (options?.limit) results = results.slice(0, options.limit);
    return results;
  }

  updateStatus(id: string, status: Strategy['status']): void {
    const s = this.data.get(id);
    if (s) {
      s.status = status;
      s.updated_at = Date.now();
    }
  }
}

class MemoryUserRepo implements IUserRepository {
  private data = new Map<string, User>();

  create(u: Omit<User, 'id' | 'created_at'>): User {
    const user: User = {
      ...u,
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      created_at: Date.now(),
    };
    this.data.set(user.id, user);
    return user;
  }

  findById(id: string): User | undefined {
    return this.data.get(id);
  }

  findByWallet(wallet: string): User | undefined {
    return Array.from(this.data.values()).find((u) => u.wallet_address === wallet);
  }

  updateBalance(userId: string, balance: number): void {
    const u = this.data.get(userId);
    if (u) u.chain_bbt_balance = balance;
  }
}

class MemorySubscriptionRepo implements ISubscriptionRepository {
  private data = new Map<string, Subscription>();

  create(sub: Omit<Subscription, 'id' | 'created_at'>): Subscription {
    const subscription: Subscription = {
      ...sub,
      id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      created_at: Date.now(),
    };
    this.data.set(subscription.id, subscription);
    return subscription;
  }

  findById(id: string): Subscription | undefined {
    return this.data.get(id);
  }

  findByUserAndStrategy(userId: string, strategyId: string): Subscription | undefined {
    return Array.from(this.data.values()).find(
      (s) => s.user_id === userId && s.strategy_id === strategyId,
    );
  }

  findActiveByStrategy(strategyId: string): Subscription[] {
    return Array.from(this.data.values()).filter(
      (s) => s.strategy_id === strategyId && s.status === 'active',
    );
  }

  findActiveByUser(userId: string): (Subscription & { strategy_name?: string; symbol?: string })[] {
    return Array.from(this.data.values()).filter(
      (s) => s.user_id === userId && s.status === 'active',
    );
  }

  findExpiringBefore(timestamp: number): Subscription[] {
    return Array.from(this.data.values()).filter(
      (s) => s.status === 'active' && s.next_bill_at !== null && s.next_bill_at <= timestamp,
    );
  }

  updateStatus(id: string, status: Subscription['status']): void {
    const s = this.data.get(id);
    if (s) s.status = status;
  }

  updateNextBill(id: string, nextBillAt: number): void {
    const s = this.data.get(id);
    if (s) s.next_bill_at = nextBillAt;
  }
}

class MemorySignalRepo implements ISignalRepository {
  private data: Signal[] = [];

  create(sig: Omit<Signal, 'id' | 'created_at'>): Signal {
    const signal: Signal = {
      ...sig,
      id: `sig_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      created_at: Date.now(),
    };
    this.data.push(signal);
    return signal;
  }

  findByStrategyIds(strategyIds: string[], limit: number): Signal[] {
    return this.data
      .filter((s) => strategyIds.includes(s.strategy_id))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit);
  }

  findLatestByStrategy(strategyId: string): Signal | undefined {
    return this.data
      .filter((s) => s.strategy_id === strategyId)
      .sort((a, b) => b.created_at - a.created_at)[0];
  }
}

class MemoryBillingRepo implements IBillingRepository {
  private data: BillingRecord[] = [];

  create(record: Omit<BillingRecord, 'id' | 'created_at'>): BillingRecord {
    const br: BillingRecord = {
      ...record,
      id: `bill_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      created_at: Date.now(),
    };
    this.data.push(br);
    return br;
  }

  confirmTx(id: string, txSignature: string): void {
    const r = this.data.find((b) => b.id === id);
    if (r) {
      r.tx_signature = txSignature;
      r.status = 'confirmed';
    }
  }

  getTotalByStatus(status: string): number {
    return this.data
      .filter((b) => b.status === status)
      .reduce((sum, b) => sum + b.amount_bbt, 0);
  }

  getRecent(limit: number): unknown[] {
    return this.data.sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  }
}

@singleton()
export class MemoryStore implements IUnitOfWork {
  strategies: IStrategyRepository;
  users: IUserRepository;
  subscriptions: ISubscriptionRepository;
  signals: ISignalRepository;
  billing: IBillingRepository;

  constructor(logger: Logger, _crypto: CryptoVault) {
    this.strategies = new MemoryStrategyRepo();
    this.users = new MemoryUserRepo();
    this.subscriptions = new MemorySubscriptionRepo();
    this.signals = new MemorySignalRepo();
    this.billing = new MemoryBillingRepo();
    logger.info('MemoryStore initialized');
  }

  transaction<T>(fn: () => T): T {
    // 内存实现简化为直接执行（无真正事务）
    return fn();
  }

  close(): void {
    // 内存存储无需关闭
  }
}
