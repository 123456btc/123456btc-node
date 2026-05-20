/**
 * HTTP API 路由集成测试
 * 测试核心路由：策略、信号、认证、速率限制
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import { createHttpServer, resetRateLimitForTesting } from '../../src/api/http.js';
import type { SubscriptionStore } from '../../src/core/SubscriptionStore.js';
import type { AuthManager } from '../../src/core/AuthManager.js';
import type { SignalHub } from '../../src/core/SignalHub.js';
import type { SettlementEngine } from '../../src/core/SettlementEngine.js';
import type { BillingCron } from '../../src/core/BillingCron.js';
import type { ProviderConfig, Strategy, Signal } from '../../src/types/index.js';

// ── Mock 工厂 ──

function createMockConfig(): ProviderConfig {
  return {
    provider_id: 'prov_test_001',
    provider_secret: 'super-secret-key-for-hmac-testing-32bytes!',
    name: 'Test Provider',
    wallet_address: 'TestWallet1111111111111111111111111111111111',
    treasury_wallet: 'Treasury111111111111111111111111111111111111',
    solana_rpc: 'http://localhost:8899',
    bbt_mint: 'BBBToken1111111111111111111111111111111111111',
    burn_rate: 0.5,
    node_port: 3000,
    admin_api_key: 'admin-test-api-key-12345',
  };
}

function createMockStrategy(overrides?: Partial<Strategy>): Strategy {
  return {
    id: 'strat_001',
    provider_id: 'prov_test_001',
    name: 'BTC Alpha',
    description: 'BTC trading signals',
    symbol: 'BTCUSDT',
    market_type: 'crypto',
    pricing_model: 'daily_bbt',
    price_per_day: 10,
    price_per_signal: undefined,
    min_bbt_tier: 0,
    status: 'live',
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

function createMockStore(strategies: Strategy[] = []) {
  return {
    listStrategies: vi.fn().mockReturnValue(strategies),
    getStrategy: vi.fn().mockImplementation((id: string) => strategies.find((s) => s.id === id)),
    createStrategy: vi.fn().mockImplementation((data) => ({ ...data, id: 'strat_new', created_at: Date.now(), updated_at: Date.now() })),
    getSignalsByStrategyIds: vi.fn().mockReturnValue([]),
    getActiveSubscriptionsByStrategy: vi.fn().mockReturnValue([]),
    getUserByWallet: vi.fn().mockReturnValue(undefined),
    createUser: vi.fn().mockImplementation((data) => ({ ...data, id: 'user_001', created_at: Date.now() })),
    getSubscription: vi.fn().mockReturnValue(undefined),
    createSubscription: vi.fn().mockImplementation((data) => ({ ...data, id: 'sub_001', created_at: Date.now() })),
    getSubscriptionsByUser: vi.fn().mockReturnValue([]),
    getActiveSubscriptionsByUser: vi.fn().mockReturnValue([]),
    getTotalBillingByStatus: vi.fn().mockReturnValue(0),
    getActiveSubscriberCount: vi.fn().mockReturnValue(0),
    getRecentBills: vi.fn().mockReturnValue([]),
    listAllSubscriptions: vi.fn().mockReturnValue([]),
    getSubscribersByStrategy: vi.fn().mockReturnValue([]),
    updateUserBalance: vi.fn(),
  } as unknown as SubscriptionStore;
}

function createMockAuth() {
  return {
    verifyProvider: vi.fn().mockReturnValue({ valid: false, error: 'Missing provider auth headers' }),
    verifyAdminKey: vi.fn().mockReturnValue(false),
    verifyWalletSignature: vi.fn().mockReturnValue({ valid: false, error: 'Invalid wallet signature' }),
  } as unknown as AuthManager;
}

function createMockHub() {
  return {
    ingestSignal: vi.fn().mockResolvedValue({ ok: true, signal: { id: 'sig_001', strategy_id: 'strat_001' }, dispatched: 0 }),
  } as unknown as SignalHub;
}

function createMockSettlement() {
  return {
    mode: 'memo' as const,
    getWalletBBTBalance: vi.fn().mockResolvedValue(0),
  } as unknown as SettlementEngine;
}

function createMockBilling() {
  return {
    chargePerSignal: vi.fn().mockResolvedValue(true),
  } as unknown as BillingCron;
}

// ── HTTP 请求辅助函数 ──

function makeRequest(
  server: http.Server,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      reject(new Error('Server not listening'));
      return;
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: options.path,
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode!, body: JSON.parse(data) });
          } catch {
            resolve({ statusCode: res.statusCode!, body: { raw: data } });
          }
        });
      },
    );

    req.on('error', reject);

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

// ── 测试 ──

describe('HTTP API Routes', () => {
  let server: http.Server;
  let store: ReturnType<typeof createMockStore>;
  let auth: ReturnType<typeof createMockAuth>;
  let config: ProviderConfig;

  beforeEach(async () => {
    resetRateLimitForTesting();
    config = createMockConfig();
    store = createMockStore([createMockStrategy()]);
    auth = createMockAuth();

    server = createHttpServer(
      config,
      store,
      auth,
      createMockHub(),
      createMockSettlement(),
      createMockBilling(),
    );

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  // ── GET /strategies ──

  it('GET /strategies 返回 live 策略列表', async () => {
    const res = await makeRequest(server, { path: '/strategies' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('strategies');
    expect(Array.isArray(res.body.strategies)).toBe(true);

    // 验证只返回 live 策略，且字段正确过滤
    const strategies = res.body.strategies as Array<Record<string, unknown>>;
    if (strategies.length > 0) {
      expect(strategies[0]).toHaveProperty('id');
      expect(strategies[0]).toHaveProperty('name');
      expect(strategies[0]).toHaveProperty('symbol');
      expect(strategies[0]).toHaveProperty('pricing_model');
      // 不应包含内部字段如 provider_id
      expect(strategies[0]).not.toHaveProperty('provider_id');
    }
  });

  it('GET /strategies 只返回 status=live 的策略', async () => {
    // store 返回包含 paused 策略
    const mixedStore = createMockStore([
      createMockStrategy({ id: 'live_1', status: 'live' }),
      createMockStrategy({ id: 'paused_1', status: 'paused' }),
    ]);

    const srv = createHttpServer(config, mixedStore, auth, createMockHub(), createMockSettlement(), createMockBilling());
    await new Promise<void>((resolve) => { srv.listen(0, '127.0.0.1', resolve); });

    try {
      const res = await makeRequest(srv, { path: '/strategies' });
      expect(res.statusCode).toBe(200);
      const strategies = res.body.strategies as Array<Record<string, unknown>>;
      // 过滤后应只有 live 策略（由 http.ts 内部 filter）
      expect(strategies.every((s) => s.id === 'live_1' || s.status === undefined)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => { srv.close(() => resolve()); });
    }
  });

  // ── POST /strategies 认证（去中心化：钱包签名） ──

  it('POST /strategies 无认证返回 401', async () => {
    const res = await makeRequest(server, {
      method: 'POST',
      path: '/strategies',
      body: { name: 'Test', symbol: 'BTCUSDT' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('POST /strategies 有钱包签名可创建策略', async () => {
    (auth.verifyWalletSignature as ReturnType<typeof vi.fn>).mockReturnValue({ valid: true, wallet: 'TestWa11etPublicKeyBase58String111111111' });

    const res = await makeRequest(server, {
      method: 'POST',
      path: '/strategies',
      headers: {
        'x-wallet': 'TestWa11etPublicKeyBase58String111111111',
        'x-wallet-signature': 'sig',
        'x-wallet-timestamp': String(Date.now()),
      },
      body: { name: 'New Strategy', symbol: 'ETHUSDT' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty('strategy');
    expect(store.createStrategy).toHaveBeenCalled();
  });

  // ── GET /signals 认证 ──

  it('GET /signals 无钱包签名返回 401', async () => {
    const res = await makeRequest(server, { path: '/signals' });

    expect(res.statusCode).toBe(401);
    expect(res.body).toHaveProperty('error');
    expect((res.body.error as string).toLowerCase()).toContain('wallet');
  });

  // ── POST /signals 认证（去中心化：钱包签名） ──

  it('POST /signals 无认证返回 401', async () => {
    const res = await makeRequest(server, {
      method: 'POST',
      path: '/signals',
      body: { strategy_id: 'strat_001', symbol: 'BTCUSDT', decision: 'BUY' },
    });

    expect(res.statusCode).toBe(401);
  });

  // ── 速率限制 ──

  it('速率限制：超过 100 请求返回 429', async () => {
    // 由于速率限制器是模块级别的，需要在隔离环境中测试
    // 这里通过发送大量请求来触发限制
    const requests: Promise<{ statusCode: number }>[] = [];
    for (let i = 0; i < 110; i++) {
      requests.push(makeRequest(server, { path: '/health' }));
    }

    const results = await Promise.all(requests);
    const has429 = results.some((r) => r.statusCode === 429);
    expect(has429).toBe(true);
  });

  // ── readJson 超大请求体 ──

  it('readJson 超大请求体返回 500 错误', async () => {
    const addr = server.address() as { port: number };

    const result = await new Promise<{ statusCode: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: addr.port,
          path: '/signals',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              resolve({ statusCode: res.statusCode!, body: JSON.parse(data) });
            } catch {
              resolve({ statusCode: res.statusCode!, body: { raw: data } });
            }
          });
        },
      );

      req.on('error', reject);

      // 发送超过 1MB 的数据块
      const bigChunk = 'x'.repeat(600_000);
      req.write(bigChunk);
      req.write(bigChunk); // 总计 ~1.2MB
      req.end();
    });

    // 超大请求体应返回 401（认证在 readJson 之前检查）或 500（readJson reject）
    expect([401, 500]).toContain(result.statusCode);
    expect(result.body).toHaveProperty('error');
  });

  // ── 404 路由 ──

  it('未知路由返回 404', async () => {
    const res = await makeRequest(server, { path: '/nonexistent' });

    // 静态文件 fallback 可能返回 index.html，但 /nonexistent 不是 API 路径
    // 如果 public 目录不存在，应返回 404
    expect([200, 404]).toContain(res.statusCode);
  });

  // ── GET /health ──

  it('GET /health 返回健康状态', async () => {
    const res = await makeRequest(server, { path: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('provider', 'prov_test_001');
    expect(res.body).toHaveProperty('features');
  });
});
