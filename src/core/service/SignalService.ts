/**
 * SignalService — 信号业务服务（重构后的核心逻辑）
 * 职责：
 * 1. 接收并校验信号
 * 2. 持久化信号
 * 3. 触发计费
 * 4. 广播信号（本地WS + P2P网络）
 *
 * 依赖注入：通过构造函数接收 repository 和 logger，便于测试
 */

import 'reflect-metadata';
import { injectable, inject } from 'tsyringe';
import { Logger } from '../../infra/logger/Logger.js';
import type { IUnitOfWork } from '../repository/interfaces.js';
import type { Signal } from '../../types/index.js';

export interface IngestResult {
  ok: boolean;
  signal?: Signal;
  error?: string;
  dispatched: number;
}

@injectable()
export class SignalService {
  constructor(
    @inject('IUnitOfWork') private store: IUnitOfWork,
    @inject(Logger) private logger: Logger,
  ) {}

  async ingest(raw: unknown, providerId: string): Promise<IngestResult> {
    this.logger.debug('SignalService.ingest', { providerId });

    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'Signal must be an object', dispatched: 0 };
    }

    const body = raw as Record<string, unknown>;

    // 支持 ISES v1 简化映射
    const ises = body.schema === 'ises.strategy_signal.v1' ? body : null;
    const strategyId = (ises?.source as Record<string, unknown>)?.strategy_id as string ?? (body.strategy_id as string);
    const symbol = (ises?.scope as Record<string, unknown>)?.symbol as string ?? (body.symbol as string);
    const decision = (ises?.decision as Record<string, unknown>)?.action as string ?? (body.decision as string);

    if (!strategyId || !symbol || !decision) {
      return { ok: false, error: 'Missing strategy_id, symbol or decision', dispatched: 0 };
    }

    // 验证策略归属
    const strategy = this.store.strategies.findById(strategyId);
    if (!strategy) {
      return { ok: false, error: 'Strategy not found', dispatched: 0 };
    }
    if (strategy.provider_id !== providerId) {
      return { ok: false, error: 'Strategy does not belong to provider', dispatched: 0 };
    }
    if (strategy.status !== 'live') {
      return { ok: false, error: 'Strategy is not live', dispatched: 0 };
    }

    const signal = this.store.signals.create({
      strategy_id: strategyId,
      provider_id: providerId,
      symbol,
      decision,
      confidence: (ises?.decision as Record<string, unknown>)?.confidence as number ?? (body.confidence as number) ?? 0,
      price: parseFloat((ises?.market_context as Record<string, unknown>)?.price as string ?? (body.price as string) ?? '0') || undefined,
      stop_loss: parseFloat(((ises?.levels as Record<string, unknown>)?.stop_loss as string) ?? (body.stop_loss as string) ?? '0') || undefined,
      take_profit: parseFloat(((ises?.levels as Record<string, unknown>)?.take_profit as string) ?? (body.take_profit as string) ?? '0') || undefined,
      reasoning: (ises?.rationale as Record<string, unknown>)?.summary as string ?? (body.reasoning as string) ?? '',
      raw_payload: JSON.stringify(body),
    });

    this.logger.info('Signal ingested', { signalId: signal.id, strategyId, symbol, decision });

    return { ok: true, signal, dispatched: 0 };
  }
}
