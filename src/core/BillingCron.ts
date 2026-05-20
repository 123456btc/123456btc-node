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
  private intervalMs: number = 60_000;
  private running = false;
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
    this.intervalMs = intervalMs;
    this.scheduleNext();
    console.log(`[BillingCron] started, interval=${intervalMs}ms`);
  }

  private scheduleNext() {
    this.intervalId = setTimeout(async () => {
      if (this.running) return; // 跳过重叠执行
      this.running = true;
      try {
        await this.tick();
      } finally {
        this.running = false;
        this.scheduleNext();
      }
    }, this.intervalMs) as unknown as ReturnType<typeof setInterval>;
  }

  stop() {
    if (this.intervalId) {
      clearTimeout(this.intervalId as unknown as number);
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

        // 到期即停止信号推送（立即过期），用户续费后重新激活
        this.store.updateSubscriptionStatus(sub.id, 'expired');
        console.log(`[BillingCron] Subscription expired, signals stopped: ${sub.id}`);
      }
    }
  }

  // ── 轮询链上收款 ──

  private async pollChainPayments() {
    try {
      const payments = await this.settlement.pollIncomingPayments(this.lastCheckedSignature);
      if (payments.length === 0) return;

      // Reverse to process oldest first (Solana API returns newest-first)
      const ordered = [...payments].reverse();
      let lastSuccessfullyProcessed: string | undefined;

      for (const payment of ordered) {
        try {
          this.processPayment(payment.signature, payment.amount, payment.memo, payment.fromWallet);
          lastSuccessfullyProcessed = payment.signature;
        } catch (e) {
          console.error(`[BillingCron] Failed to process payment ${payment.signature}:`, e);
          break; // Stop; remaining payments will be retried next tick
        }
      }

      // Only advance checkpoint after successful processing
      if (lastSuccessfullyProcessed) {
        this.lastCheckedSignature = lastSuccessfullyProcessed;
      }
    } catch (e) {
      console.error('[BillingCron] pollChainPayments error:', e);
    }
  }

  private processPayment(signature: string, amount: number, memo?: string, fromWallet?: string) {
    console.log(`[BillingCron] Incoming payment: ${amount} BBT, tx=${signature?.slice(0, 8)}..., from=${fromWallet?.slice(0, 8)}..., memo=${memo}`);

    // Idempotency: skip if already processed
    const existingBilling = this.store.getBillingByTxSignature(signature);
    if (existingBilling) {
      console.log(`[BillingCron] Payment already processed: tx=${signature}, billing_id=${existingBilling.id}`);
      return;
    }

    // 1. 尝试从 memo 解析订阅信息
    // Memo 格式: BBT-SUB|{subscription_id}|{strategy_id}|{user_wallet}
    if (memo && memo.startsWith('BBT-SUB|')) {
      const parts = memo.split('|');
      if (parts.length >= 4) {
        const subId = parts[1];
        const strategyId = parts[2];
        const wallet = parts[3];

        // 安全校验：发送方必须与 Memo 中的钱包地址一致
        if (fromWallet && fromWallet !== wallet) {
          console.warn(`[BillingCron] SECURITY: Sender mismatch! tx sender=${fromWallet}, memo wallet=${wallet}. Rejecting.`);
          return;
        }

        const sub = this.store.getSubscriptionById(subId);
        if (sub) {
          // 校验订阅归属：sub 必须属于 memo 中 wallet 对应的用户
          const owner = this.store.getUserByWallet(wallet);
          if (!owner || sub.user_id !== owner.id) {
            console.warn(`[BillingCron] SECURITY: Subscription ${subId} does not belong to wallet ${wallet}. Rejecting.`);
            return;
          }
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

  async chargePerSignal(sub: Subscription, signal: Signal): Promise<boolean> {
    if (sub.billing_model !== 'per_signal_bbt') return true;

    const strategy = this.store.getStrategy(sub.strategy_id);
    if (!strategy || !strategy.price_per_signal) return true;

    const user = this.store.getUser(sub.user_id);
    if (!user) return false;

    // 实时查询链上余额（不依赖缓存）
    const chainBalance = await this.settlement.getWalletBBTBalance(user.wallet_address);
    this.store.updateUserBalance(user.id, chainBalance);

    if (chainBalance < strategy.price_per_signal) {
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
