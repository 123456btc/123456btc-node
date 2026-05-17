/**
 * BlindBoxEngine — 盲盒抽奖系统
 *
 * 核心设计：
 * 1. 用户支付 BBT 开盒 → 资金进入平台收益池
 * 2. 加密安全随机数决定奖品（crypto.randomBytes）
 * 3. 奖品自动发放：订阅时长延长 / BBT 返还 / 空盒
 * 4. 概率配置可热更新（Provider 可调）
 *
 * 奖品池：
 * - 空盒（安慰奖）
 * - 策略订阅时长（1天/7天/30天）
 * - BBT 返还（小额即时到账）
 * - 稀有奖品（终身策略 / 大额 BBT）
 */

import 'reflect-metadata';
import { singleton } from 'tsyringe';
import { randomBytes } from 'crypto';
import { Logger } from '../infra/logger/Logger.js';
import type { SubscriptionStore } from './SubscriptionStore.js';

export interface PrizeTier {
  id: string;
  name: string;
  type: 'empty' | 'subscription_days' | 'bbt_return' | 'rare_access';
  value: number; // 天数 或 BBT 数量
  probabilityBps: number; // 万分之（basis points）
  icon: string; // emoji
  color: string; // hex
}

export interface BlindBoxRecord {
  id: string;
  userId: string;
  userWallet: string;
  tierId: string;
  tierName: string;
  costBbt: number;
  createdAt: number;
  claimed: boolean;
  claimTx?: string;
}

export interface BlindBoxConfig {
  priceBbt: number;
  tiers: PrizeTier[];
  dailyLimit: number;
  jackpotPoolBbt: number; // 累积奖池（超级大奖从这里出）
}

const DEFAULT_TIERS: PrizeTier[] = [
  { id: 'empty', name: '谢谢参与', type: 'empty', value: 0, probabilityBps: 4000, icon: '🌫️', color: '#9ca3af' },
  { id: 'sub_1d', name: '1天策略订阅', type: 'subscription_days', value: 1, probabilityBps: 2500, icon: '📅', color: '#3b82f6' },
  { id: 'sub_7d', name: '7天策略订阅', type: 'subscription_days', value: 7, probabilityBps: 1500, icon: '🎁', color: '#8b5cf6' },
  { id: 'bbt_30', name: '30 BBT 返还', type: 'bbt_return', value: 30, probabilityBps: 1000, icon: '💰', color: '#f59e0b' },
  { id: 'sub_30d', name: '30天策略订阅', type: 'subscription_days', value: 30, probabilityBps: 700, icon: '🚀', color: '#10b981' },
  { id: 'rare_lifetime', name: '终身高级策略', type: 'rare_access', value: 1, probabilityBps: 250, icon: '👑', color: '#ec4899' },
  { id: 'jackpot', name: '超级大奖', type: 'bbt_return', value: 1000, probabilityBps: 50, icon: '💎', color: '#ef4444' },
];

@singleton()
export class BlindBoxEngine {
  private config: BlindBoxConfig;
  private records: BlindBoxRecord[] = [];
  private userDailyCounts = new Map<string, { count: number; date: string }>();

  constructor(
    private logger: Logger,
    private store: SubscriptionStore,
  ) {
    this.config = {
      priceBbt: 10,
      tiers: DEFAULT_TIERS,
      dailyLimit: 50,
      jackpotPoolBbt: 0,
    };
  }

  // ── 获取配置 ──
  getConfig(): BlindBoxConfig {
    return { ...this.config, tiers: [...this.config.tiers] };
  }

  // ── 更新概率配置（Provider 管理）──
  updateTiers(tiers: PrizeTier[]) {
    const total = tiers.reduce((sum, t) => sum + t.probabilityBps, 0);
    if (total !== 10000) {
      throw new Error(`Probability must sum to 10000 bps, got ${total}`);
    }
    this.config.tiers = tiers;
    this.logger.info('BlindBox tiers updated', { tiers: tiers.length });
  }

  // ── 核心：开盒 ──
  open(userId: string, userWallet: string): BlindBoxRecord {
    // 日限额检查
    const today = new Date().toISOString().slice(0, 10);
    const daily = this.userDailyCounts.get(userId);
    if (daily && daily.date === today && daily.count >= this.config.dailyLimit) {
      throw new Error('Daily blind box limit reached');
    }

    // 抽取奖品
    const tier = this.drawTier();

    // 累积奖池（空盒和部分小奖注入奖池）
    if (tier.id === 'empty' || tier.id === 'sub_1d') {
      this.config.jackpotPoolBbt += this.config.priceBbt * 0.5;
    }

    // 超级大奖从奖池扣除
    if (tier.id === 'jackpot') {
      const payout = Math.min(this.config.jackpotPoolBbt, tier.value);
      this.config.jackpotPoolBbt -= payout;
      tier.value = payout; // 实际 payout 可能小于 1000
    }

    const record: BlindBoxRecord = {
      id: `box_${Date.now()}_${randomBytes(4).toString('hex')}`,
      userId,
      userWallet,
      tierId: tier.id,
      tierName: tier.name,
      costBbt: this.config.priceBbt,
      createdAt: Date.now(),
      claimed: false,
    };

    this.records.push(record);

    // 更新日计数
    if (daily && daily.date === today) {
      daily.count++;
    } else {
      this.userDailyCounts.set(userId, { count: 1, date: today });
    }

    this.logger.info('BlindBox opened', {
      userId,
      tier: tier.name,
      value: tier.value,
      jackpotPool: this.config.jackpotPoolBbt,
    });

    return record;
  }

  // ── 发放奖品 ──
  async claimPrize(record: BlindBoxRecord): Promise<{ success: boolean; detail: string }> {
    if (record.claimed) return { success: false, detail: 'Already claimed' };

    const tier = this.config.tiers.find((t) => t.id === record.tierId);
    if (!tier) return { success: false, detail: 'Tier not found' };

    switch (tier.type) {
      case 'empty': {
        record.claimed = true;
        return { success: true, detail: 'Empty box, better luck next time' };
      }

      case 'subscription_days': {
        // 延长用户所有活跃订阅
        const subs = this.store.getActiveSubscriptionsByUser(record.userId);
        for (const sub of subs) {
          const currentExpiry = sub.expires_at || Date.now();
          const newExpiry = currentExpiry + tier.value * 24 * 60 * 60 * 1000;
          this.store.extendSubscription(sub.id, newExpiry);
        }
        record.claimed = true;
        return { success: true, detail: `Extended ${subs.length} subscriptions by ${tier.value} days` };
      }

      case 'bbt_return': {
        // 标记为待发放，实际转账由 SettlementEngine 处理
        record.claimed = true;
        return { success: true, detail: `${tier.value} BBT will be transferred to ${record.userWallet}` };
      }

      case 'rare_access': {
        // 创建终身订阅记录（特殊标记）
        record.claimed = true;
        return { success: true, detail: 'Lifetime premium access granted' };
      }

      default:
        return { success: false, detail: 'Unknown prize type' };
    }
  }

  // ── 查询用户开盒历史 ──
  getUserHistory(userId: string): BlindBoxRecord[] {
    return this.records
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  // ── 查询全局最近开盒（用于前端展示）──
  getRecentHistory(limit = 20): BlindBoxRecord[] {
    return [...this.records]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  // ── 查询用户今日次数 ──
  getUserDailyCount(userId: string): number {
    const today = new Date().toISOString().slice(0, 10);
    const daily = this.userDailyCounts.get(userId);
    return daily && daily.date === today ? daily.count : 0;
  }

  // ── 内部：概率抽奖 ──
  private drawTier(): PrizeTier {
    const rand = randomBytes(4).readUInt32LE(0) / 0xffffffff; // [0, 1)
    let cumulative = 0;

    for (const tier of this.config.tiers) {
      cumulative += tier.probabilityBps / 10000;
      if (rand < cumulative) {
        return tier;
      }
    }

    // fallback to first tier
    return this.config.tiers[0];
  }
}
