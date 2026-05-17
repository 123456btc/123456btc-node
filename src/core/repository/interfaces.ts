/**
 * Repository Interfaces — 存储抽象层
 * 所有存储实现必须遵循这些接口，便于切换 SQLite / LevelDB / 内存
 */

import type { Strategy, User, Subscription, Signal, BillingRecord } from '../../types/index.js';

export interface IStrategyRepository {
  create(strategy: Omit<Strategy, 'id' | 'created_at' | 'updated_at'>): Strategy;
  findById(id: string): Strategy | undefined;
  findByProvider(providerId: string): Strategy[];
  findAll(options?: { status?: string; limit?: number; offset?: number }): Strategy[];
  updateStatus(id: string, status: Strategy['status']): void;
}

export interface IUserRepository {
  create(user: Omit<User, 'id' | 'created_at'>): User;
  findById(id: string): User | undefined;
  findByWallet(wallet: string): User | undefined;
  updateBalance(userId: string, balance: number): void;
}

export interface ISubscriptionRepository {
  create(sub: Omit<Subscription, 'id' | 'created_at'>): Subscription;
  findById(id: string): Subscription | undefined;
  findByUserAndStrategy(userId: string, strategyId: string): Subscription | undefined;
  findActiveByStrategy(strategyId: string): Subscription[];
  findActiveByUser(userId: string): (Subscription & { strategy_name?: string; symbol?: string })[];
  findExpiringBefore(timestamp: number): Subscription[];
  updateStatus(id: string, status: Subscription['status']): void;
  updateNextBill(id: string, nextBillAt: number): void;
}

export interface ISignalRepository {
  create(signal: Omit<Signal, 'id' | 'created_at'>): Signal;
  findByStrategyIds(strategyIds: string[], limit: number): Signal[];
  findLatestByStrategy(strategyId: string): Signal | undefined;
}

export interface IBillingRepository {
  create(record: Omit<BillingRecord, 'id' | 'created_at'>): BillingRecord;
  confirmTx(id: string, txSignature: string): void;
  getTotalByStatus(status: string): number;
  getRecent(limit: number): unknown[];
}

export interface IUnitOfWork {
  strategies: IStrategyRepository;
  users: IUserRepository;
  subscriptions: ISubscriptionRepository;
  signals: ISignalRepository;
  billing: IBillingRepository;
  transaction<T>(fn: () => T): T;
  close(): void;
}
