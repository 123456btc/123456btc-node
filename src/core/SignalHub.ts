/**
 * SignalHub — 信号广播中心
 * 接收 Provider 信号，持久化，向在线订阅用户广播
 */

import type { WebSocket } from 'ws';
import type { SubscriptionStore } from './SubscriptionStore.js';
import type { AuthManager } from './AuthManager.js';
import type { Signal, IsesStrategySignalLite } from '../types/index.js';
import { getCurrentTimestamp } from '../utils/crypto.js';
import type { AutoExecutionEngine } from './AutoExecutionEngine.js';

interface ClientMeta {
  wallet: string;
  userId: string;
  subscribedStrategies: Set<string>;
  authenticated: boolean;
}

export class SignalHub {
  private clients = new Map<WebSocket, ClientMeta>();
  private autoExecution?: AutoExecutionEngine;

  constructor(
    private store: SubscriptionStore,
    private auth: AuthManager,
  ) {}

  // ── 注入自动执行引擎（可选）──
  setAutoExecution(engine: AutoExecutionEngine) {
    this.autoExecution = engine;
  }

  // ── Provider 推送信号入口 ──

  async ingestSignal(raw: unknown, providerId: string): Promise<{ ok: boolean; signal?: Signal; error?: string; dispatched: number }> {
    // 1. 基础校验
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'Signal must be an object', dispatched: 0 };
    }

    const body = raw as Record<string, unknown>;

    // 2. 支持 ISES v1 简化映射
    const ises = body.schema === 'ises.strategy_signal.v1'
      ? body as IsesStrategySignalLite
      : null;

    const strategyId = ises?.source?.strategy_id ?? (body.strategy_id as string);
    const symbol = ises?.scope?.symbol ?? (body.symbol as string);
    const decision = ises?.decision?.action ?? (body.decision as string);

    if (!strategyId || !symbol || !decision) {
      return { ok: false, error: 'Missing strategy_id, symbol or decision', dispatched: 0 };
    }

    // 3. 验证策略归属
    const strategy = this.store.getStrategy(strategyId);
    if (!strategy) {
      return { ok: false, error: 'Strategy not found', dispatched: 0 };
    }
    if (strategy.provider_id !== providerId) {
      return { ok: false, error: 'Strategy does not belong to provider', dispatched: 0 };
    }
    if (strategy.status !== 'live') {
      return { ok: false, error: 'Strategy is not live', dispatched: 0 };
    }

    // 4. 构造 Signal
    const signal: Omit<Signal, 'id' | 'created_at'> = {
      strategy_id: strategyId,
      provider_id: providerId,
      symbol,
      decision,
      confidence: ises?.decision?.confidence ?? (body.confidence as number) ?? 0,
      price: parseFloat(ises?.market_context?.price ?? (body.price as string) ?? '0') || undefined,
      stop_loss: parseFloat(ises?.levels?.stop_loss ?? (body.stop_loss as string) ?? '0') || undefined,
      take_profit: parseFloat(ises?.levels?.take_profit ?? (body.take_profit as string) ?? '0') || undefined,
      reasoning: ises?.rationale?.summary ?? (body.reasoning as string) ?? '',
      raw_payload: JSON.stringify(body),
    };

    const saved = this.store.createSignal(signal);

    // 5. 广播
    const dispatched = this.broadcast(saved);

    // 6. 自动执行（异步，不阻塞广播）
    if (this.autoExecution) {
      // 目标 token：从 symbol 映射到 mint（简化映射，生产环境需配置）
      const symbolToMint: Record<string, string> = {
        BTCUSDT: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJz', // wrapped BTC on Solana (example)
        ETHUSDT: '7vfCXTUXx5WJV5JNPkdiLf3uJijaxS8VWfs6L6Lcd9Jr', // wrapped ETH (example)
        SOLUSDT: 'So11111111111111111111111111111111111111112', // native SOL
      };
      const targetMint = symbolToMint[saved.symbol];
      if (targetMint) {
        this.autoExecution.executeSignal(saved, targetMint).catch(() => {});
      }
    }

    return { ok: true, signal: saved, dispatched };
  }

  // ── 从 P2P 网络接收信号后本地广播（不持久化） ──

  rebroadcastSignal(signal: Signal): number {
    const msg = JSON.stringify({ type: 'signal', payload: signal });
    let count = 0;

    for (const [ws, meta] of this.clients) {
      if (!meta.authenticated) continue;
      if (!meta.subscribedStrategies.has(signal.strategy_id)) continue;
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(msg);
        count++;
      }
    }

    return count;
  }

  // ── WebSocket 广播 ──

  private broadcast(signal: Signal): number {
    const msg = JSON.stringify({ type: 'signal', payload: signal });
    let count = 0;

    for (const [ws, meta] of this.clients) {
      if (!meta.authenticated) continue;
      if (!meta.subscribedStrategies.has(signal.strategy_id)) continue;
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(msg);
        count++;
      }
    }

    return count;
  }

  // ── WebSocket 客户端管理 ──

  registerClient(ws: WebSocket) {
    this.clients.set(ws, {
      wallet: '',
      userId: '',
      subscribedStrategies: new Set(),
      authenticated: false,
    });
  }

  removeClient(ws: WebSocket) {
    this.clients.delete(ws);
  }

  async authenticateClient(ws: WebSocket, wallet: string, signature: string, timestamp: number): Promise<string | null> {
    const result = this.auth.verifyWalletSignature(wallet, signature, timestamp);
    if (!result.valid) {
      return result.error ?? 'Auth failed';
    }

    // 获取或创建用户
    let user = this.store.getUserByWallet(wallet);
    if (!user) {
      user = this.store.createUser({
        wallet_address: wallet,
        display_name: wallet.slice(0, 8) + '...',
        chain_bbt_balance: 0,
        status: 'active',
      });
    }

    const meta = this.clients.get(ws);
    if (!meta) return 'Client not registered';

    meta.wallet = wallet;
    meta.userId = user.id;
    meta.authenticated = true;

    // 自动恢复用户的活跃订阅
    const subs = this.store.getActiveSubscriptionsByUser(user.id);
    for (const sub of subs) {
      meta.subscribedStrategies.add(sub.strategy_id);
    }

    // 推送可用策略列表
    const strategies = this.store.listStrategies().filter((s) => s.status === 'live');
    const availableStrategies = strategies.map((s) => ({
      id: s.id,
      name: s.name,
      symbol: s.symbol,
      pricing_model: s.pricing_model,
      price_per_day: s.price_per_day,
      price_per_signal: s.price_per_signal,
      subscribed: meta.subscribedStrategies.has(s.id),
    }));

    ws.send(JSON.stringify({
      type: 'auth_success',
      wallet,
      strategies: availableStrategies,
    }));

    return null;
  }

  subscribeClient(ws: WebSocket, strategyId: string): string | null {
    const meta = this.clients.get(ws);
    if (!meta || !meta.authenticated) return 'Not authenticated';

    const strategy = this.store.getStrategy(strategyId);
    if (!strategy) return 'Strategy not found';

    // 检查是否有活跃订阅
    const sub = this.store.getSubscription(meta.userId, strategyId);
    if (!sub || sub.status !== 'active') {
      return 'Not subscribed to this strategy';
    }

    meta.subscribedStrategies.add(strategyId);
    return null;
  }

  unsubscribeClient(ws: WebSocket, strategyId: string) {
    const meta = this.clients.get(ws);
    if (meta) {
      meta.subscribedStrategies.delete(strategyId);
    }
  }

  getClientMeta(ws: WebSocket): ClientMeta | undefined {
    return this.clients.get(ws);
  }

  pingClients() {
    const msg = JSON.stringify({ type: 'ping', timestamp: getCurrentTimestamp() });
    for (const [ws, meta] of this.clients) {
      if (meta.authenticated && ws.readyState === 1) {
        ws.send(msg);
      }
    }
  }
}
