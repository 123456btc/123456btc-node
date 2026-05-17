/**
 * BillingCron — 账单定时任务
 * 1. 扫描过期订阅，标记欠费/过期
 * 2. 轮询链上收款，匹配 Memo 确认订阅
 * 3. 按信号计费扣费
 */

import type { SubscriptionStore } from './SubscriptionStore.js';
import type { SettlementEngine } from './SettlementEngine.js';
import type { Signal, Subscription } from '../types/index.js';
import { getCurrentTimestamp } from '../utils/crypto.js';

export class BillingCron {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastCheckedSignature?: string;

  constructor(
    private store: SubscriptionStore,
    private settlement: SettlementEngine,
    private config: { providerWallet: string; providerId: string },
    private onRenewalDue?: (sub: Subscription) => void,
    private onSignalCharge?: (sub: Subscription, signal: Signal) => void,
  ) {}

  start(intervalMs: number = 60_000) {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.tick(), intervalMs);
    console.log(`[BillingCron] started, interval=${intervalMs}ms`);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async tick() {
    const now = getCurrentTimestamp();
    this.checkRenewals(now);
    await this.pollChainPayments();
  }

  // ── 检查日订阅续费 ──

  private checkRenewals(now: number) {
    const expiring = this.store.getExpiringSubscriptions(now);
    for (const sub of expiring) {
      const strategy = this.store.getStrategy(sub.strategy_id);
      if (!strategy || strategy.status !== 'live') {
        this.store.updateSubscriptionStatus(sub.id, 'cancelled');
        continue;
      }

      if (sub.billing_model === 'daily_bbt') {
        this.onRenewalDue?.(sub);

        // 宽限期 24h
        if (now > (sub.next_bill_at ?? 0) + 24 * 60 * 60 * 1000) {
          this.store.updateSubscriptionStatus(sub.id, 'expired');
          console.log(`[BillingCron] Subscription expired: ${sub.id}`);
        }
      }
    }
  }

  // ── 轮询链上收款 ──

  private async pollChainPayments() {
    try {
      const payments = await this.settlement.pollIncomingPayments(this.lastCheckedSignature);
      if (payments.length > 0) {
        this.lastCheckedSignature = payments[0].signature;
      }

      for (const payment of payments) {
        this.processPayment(payment.signature, payment.amount, payment.memo);
      }
    } catch (e) {
      console.error('[BillingCron] pollChainPayments error:', e);
    }
  }

  private processPayment(signature: string, amount: number, memo?: string) {
    console.log(`[BillingCron] Incoming payment: ${amount} BBT, tx=${signature}, memo=${memo}`);

    // 1. 尝试从 memo 解析订阅信息
    // Memo 格式: BBT-SUB|{subscription_id}|{strategy_id}|{user_wallet}
    if (memo && memo.startsWith('BBT-SUB|')) {
      const parts = memo.split('|');
      if (parts.length >= 4) {
        const subId = parts[1];
        const strategyId = parts[2];
        const wallet = parts[3];

        const sub = this.store.getSubscriptionById(subId);
        if (sub) {
          // 确认现有订阅的付款
          this.confirmSubscriptionPayment(sub, signature, amount);
          return;
        }

        // 可能是新订阅：查找用户和策略
        const user = this.store.getUserByWallet(wallet);
        const strategy = this.store.getStrategy(strategyId);
        if (user && strategy && strategy.pricing_model === 'daily_bbt') {
          const expectedAmount = strategy.price_per_day ?? 0;
          if (amount >= expectedAmount * 0.95) { // 允许 5% 滑点
            const newSub = this.store.createSubscription({
              user_id: user.id,
              strategy_id: strategy.id,
              status: 'active',
              billing_model: 'daily_bbt',
              next_bill_at: getCurrentTimestamp() + 24 * 60 * 60 * 1000,
            });
            this.store.createBilling({
              subscription_id: newSub.id,
              user_id: user.id,
              strategy_id: strategy.id,
              type: 'subscription',
              amount_bbt: amount,
              tx_signature: signature,
              status: 'confirmed',
            });
            console.log(`[BillingCron] New subscription confirmed: ${newSub.id}`);
            return;
          }
        }
      }
    }

    // 2. 无法匹配 memo，记录为未匹配收款（Provider 手动处理）
    console.log(`[BillingCron] Unmatched payment: ${amount} BBT, memo=${memo}`);
  }

  private confirmSubscriptionPayment(sub: Subscription, signature: string, amount: number) {
    const strategy = this.store.getStrategy(sub.strategy_id);
    if (!strategy) return;

    const expectedAmount = strategy.price_per_day ?? 0;
    if (amount < expectedAmount * 0.95) {
      console.log(`[BillingCron] Underpayment: expected ${expectedAmount}, got ${amount}`);
      return;
    }

    // 更新订阅到期时间
    const now = getCurrentTimestamp();
    const nextBill = sub.next_bill_at ?? now;
    const newNextBill = nextBill > now ? nextBill + 24 * 60 * 60 * 1000 : now + 24 * 60 * 60 * 1000;

    this.store.updateSubscriptionNextBill(sub.id, newNextBill);
    this.store.updateSubscriptionStatus(sub.id, 'active');
    this.store.createBilling({
      subscription_id: sub.id,
      user_id: sub.user_id,
      strategy_id: sub.strategy_id,
      type: 'renewal',
      amount_bbt: amount,
      tx_signature: signature,
      status: 'confirmed',
    });

    console.log(`[BillingCron] Subscription payment confirmed: ${sub.id}, next_bill=${newNextBill}`);
  }

  // ── 按信号计费 ──

  chargePerSignal(sub: Subscription, signal: Signal): boolean {
    if (sub.billing_model !== 'per_signal_bbt') return true;

    const strategy = this.store.getStrategy(sub.strategy_id);
    if (!strategy || !strategy.price_per_signal) return true;

    const user = this.store.getUser(sub.user_id);
    if (!user) return false;

    // 检查用户链上余额是否充足（本地缓存余额）
    if (user.chain_bbt_balance < strategy.price_per_signal) {
      this.store.createBilling({
        subscription_id: sub.id,
        user_id: sub.user_id,
        strategy_id: sub.strategy_id,
        type: 'signal',
        amount_bbt: strategy.price_per_signal,
        status: 'failed',
      });
      return false;
    }

    const record = this.store.createBilling({
      subscription_id: sub.id,
      user_id: sub.user_id,
      strategy_id: sub.strategy_id,
      type: 'signal',
      amount_bbt: strategy.price_per_signal,
      status: 'pending',
    });

    this.onSignalCharge?.(sub, signal);
    return true;
  }
}
