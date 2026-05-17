import { describe, it, expect, beforeEach } from 'vitest';
import { SignalService } from '../../src/core/service/SignalService.js';
import { MemoryStore } from '../../src/infra/db/MemoryStore.js';
import { Logger } from '../../src/infra/logger/Logger.js';
import { CryptoVault } from '../../src/infra/security/CryptoVault.js';
import { AppConfig } from '../../src/infra/config/AppConfig.js';
import type { Strategy } from '../../src/types/index.js';

function createMockConfig(): AppConfig {
  return {
    get: (k: string) => {
      if (k === 'log_level') return 'silent';
      if (k === 'provider_id') return 'test';
      return undefined;
    },
    isProduction: () => false,
  } as unknown as AppConfig;
}

describe('SignalService', () => {
  let service: SignalService;
  let store: MemoryStore;
  let providerId: string;
  let strategyId: string;

  beforeEach(() => {
    const config = createMockConfig();
    const logger = new Logger(config);
    const crypto = new CryptoVault(logger);
    crypto.initMasterKey('test-key');

    store = new MemoryStore(logger, crypto);
    service = new SignalService(store, logger);

    providerId = 'prov_test_001';
    const strategy = store.strategies.create({
      provider_id: providerId,
      name: 'Test Strategy',
      symbol: 'BTCUSDT',
      pricing_model: 'daily_bbt',
      price_per_day: 100,
      min_bbt_tier: 0,
      status: 'live',
    });
    strategyId = strategy.id;
  });

  it('should reject non-object input', async () => {
    const result = await service.ingest('not-an-object', providerId);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('must be an object');
  });

  it('should reject missing strategy_id', async () => {
    const result = await service.ingest({ symbol: 'BTC', decision: 'long' }, providerId);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Missing strategy_id');
  });

  it('should reject unknown strategy', async () => {
    const result = await service.ingest(
      { schema: 'ises.strategy_signal.v1', source: { strategy_id: 'unknown' }, scope: { symbol: 'BTC' }, decision: { action: 'long' }, market_context: { price: '1', data_quality: 'ok' } },
      providerId,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Strategy not found');
  });

  it('should reject strategy from different provider', async () => {
    const otherStrategy = store.strategies.create({
      provider_id: 'other_provider',
      name: 'Other',
      symbol: 'ETH',
      pricing_model: 'free',
      min_bbt_tier: 0,
      status: 'live',
    });

    const result = await service.ingest(
      { schema: 'ises.strategy_signal.v1', source: { strategy_id: otherStrategy.id }, scope: { symbol: 'ETH' }, decision: { action: 'long' }, market_context: { price: '1', data_quality: 'ok' } },
      providerId,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('does not belong to provider');
  });

  it('should reject non-live strategy', async () => {
    store.strategies.updateStatus(strategyId, 'paused');
    const result = await service.ingest(
      { schema: 'ises.strategy_signal.v1', source: { strategy_id: strategyId }, scope: { symbol: 'BTC' }, decision: { action: 'long' }, market_context: { price: '1', data_quality: 'ok' } },
      providerId,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not live');
  });

  it('should successfully ingest valid ISES signal', async () => {
    const result = await service.ingest(
      {
        schema: 'ises.strategy_signal.v1',
        signal_id: 'sig_001',
        created_at_ms: Date.now(),
        source: {
          system: 'test',
          strategy_id: strategyId,
          strategy_name: 'Test Strategy',
        },
        scope: {
          symbol: 'BTCUSDT',
          market_type: 'crypto',
        },
        decision: {
          action: 'enter',
          side: 'long',
          confidence: 0.85,
        },
        market_context: {
          price: '65000',
          data_quality: 'ok',
        },
        levels: {
          stop_loss: '63000',
          take_profit: '70000',
        },
        rationale: {
          summary: 'Bullish test',
        },
      },
      providerId,
    );

    expect(result.ok).toBe(true);
    expect(result.signal).toBeDefined();
    expect(result.signal?.strategy_id).toBe(strategyId);
    expect(result.signal?.symbol).toBe('BTCUSDT');
    expect(result.signal?.decision).toBe('enter');
    expect(result.signal?.confidence).toBe(0.85);
    expect(result.signal?.price).toBe(65000);
    expect(result.signal?.stop_loss).toBe(63000);
    expect(result.signal?.take_profit).toBe(70000);
  });

  it('should successfully ingest minimal valid signal', async () => {
    const result = await service.ingest(
      {
        strategy_id: strategyId,
        symbol: 'BTCUSDT',
        decision: 'long',
        price: 65000,
        confidence: 0.9,
      },
      providerId,
    );

    expect(result.ok).toBe(true);
    expect(result.signal?.strategy_id).toBe(strategyId);
  });

  it('should persist signal to store', async () => {
    await service.ingest(
      { strategy_id: strategyId, symbol: 'BTC', decision: 'long', price: 1, market_context: { price: '1', data_quality: 'ok' } },
      providerId,
    );

    const signals = store.signals.findByStrategyIds([strategyId], 10);
    expect(signals).toHaveLength(1);
    expect(signals[0].provider_id).toBe(providerId);
  });
});
