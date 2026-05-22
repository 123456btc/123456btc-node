import { describe, it, expect, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { SettlementEngine } from '../../src/core/SettlementEngine.js';
import type { SubscriptionStore } from '../../src/core/SubscriptionStore.js';
import type { ProviderConfig } from '../../src/types/index.js';

function createMockConfig(): ProviderConfig {
  const wallet = Keypair.generate();
  const treasury = Keypair.generate();
  const bbtMint = Keypair.generate();
  return {
    provider_id: 'prov_test_001',
    provider_secret: 'super-secret-key-for-hmac-testing-32bytes!',
    name: 'Test Provider',
    wallet_address: wallet.publicKey.toBase58(),
    treasury_wallet: treasury.publicKey.toBase58(),
    solana_rpc: 'http://localhost:8899',
    bbt_mint: bbtMint.publicKey.toBase58(),
    burn_rate: 0.5,
    node_port: 3000,
    admin_api_key: 'admin-test-api-key-12345',
  };
}

function createMockStore(): SubscriptionStore {
  return {
    listStrategies: vi.fn().mockReturnValue([]),
    getStrategy: vi.fn().mockReturnValue(undefined),
    createStrategy: vi.fn(),
    getSignalsByStrategyIds: vi.fn().mockReturnValue([]),
    getActiveSubscriptionsByStrategy: vi.fn().mockReturnValue([]),
    getUserByWallet: vi.fn().mockReturnValue(undefined),
    createUser: vi.fn(),
    getSubscription: vi.fn().mockReturnValue(undefined),
    createSubscription: vi.fn(),
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

describe('SettlementEngine', () => {
  it('defaults to memo mode', async () => {
    const config = createMockConfig();
    const store = createMockStore();
    const engine = new SettlementEngine(config, store);
    await engine.init();
    expect(engine.mode).toBe('memo');
  });

  it('switches to escrow mode on enableEscrowMode', async () => {
    const config = createMockConfig();
    const store = createMockStore();
    const engine = new SettlementEngine(config, store);
    await engine.init();

    const providerKeypair = Keypair.generate();
    engine.enableEscrowMode(providerKeypair);

    expect(engine.mode).toBe('escrow');
    engine.stop();
  });

  it('buildEscrowSubscription returns PDA and memo without chain call', async () => {
    const config = createMockConfig();
    const store = createMockStore();
    const engine = new SettlementEngine(config, store);
    await engine.init();

    const providerKeypair = Keypair.generate();
    engine.enableEscrowMode(providerKeypair);

    const userWallet = new PublicKey('11111111111111111111111111111112');
    const result = await engine.buildEscrowSubscription(userWallet, 'strat_001', 10, 30);

    expect(result.subscriptionPDA).toBeInstanceOf(PublicKey);
    expect(result.amount).toBe(10);
    expect(result.memo).toMatch(/^sub:strat_001:/);

    engine.stop();
  });

  it('providerClaim returns tx string in mock mode', async () => {
    const config = createMockConfig();
    const store = createMockStore();
    const engine = new SettlementEngine(config, store);
    await engine.init();

    const providerKeypair = Keypair.generate();
    engine.enableEscrowMode(providerKeypair);

    const subscriptionPDA = new PublicKey('11111111111111111111111111111113');
    const tx = await engine.providerClaim(subscriptionPDA, providerKeypair);
    expect(typeof tx).toBe('string');

    engine.stop();
  });

  it('userCancel returns tx string in mock mode', async () => {
    const config = createMockConfig();
    const store = createMockStore();
    const engine = new SettlementEngine(config, store);
    await engine.init();

    const providerKeypair = Keypair.generate();
    engine.enableEscrowMode(providerKeypair);

    const userKeypair = Keypair.generate();
    const subscriptionPDA = new PublicKey('11111111111111111111111111111113');
    const tx = await engine.userCancel(subscriptionPDA, userKeypair);
    expect(typeof tx).toBe('string');

    engine.stop();
  });
});
