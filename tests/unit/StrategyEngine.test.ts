import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock @solana/web3.js ──────────────────────────────────────────
vi.mock('@solana/web3.js', () => {
  class MockPublicKey {
    private _value: string;
    constructor(value: string) { this._value = value; }
    toBase58() { return this._value; }
    static default = { pubkey: 'mock' };
  }

  class MockKeypair {
    publicKey: MockPublicKey;
    secretKey: Uint8Array;
    constructor(pk: string, sk?: Uint8Array) {
      this.publicKey = new MockPublicKey(pk);
      this.secretKey = sk || new Uint8Array(64);
    }
    static generate() {
      return new MockKeypair(`mock_mint_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    }
    static fromSecretKey(sk: Uint8Array) {
      return new MockKeypair(`mock_from_sk_${Date.now()}`, sk);
    }
  }

  return {
    Connection: vi.fn().mockImplementation(() => ({})),
    Keypair: MockKeypair,
    PublicKey: MockPublicKey,
    Transaction: vi.fn().mockImplementation(() => ({
      add: vi.fn(),
    })),
    SystemProgram: {
      createAccount: vi.fn().mockReturnValue('createAccount_ix'),
    },
    sendAndConfirmTransaction: vi.fn().mockResolvedValue('mock_tx_signature'),
  };
});

// ── Mock @solana/spl-token ────────────────────────────────────────
vi.mock('@solana/spl-token', () => ({
  createInitializeMintInstruction: vi.fn().mockReturnValue('initMint_ix'),
  createAssociatedTokenAccountInstruction: vi.fn().mockReturnValue('createATA_ix'),
  createMintToInstruction: vi.fn().mockReturnValue('mintTo_ix'),
  createTransferInstruction: vi.fn().mockReturnValue('transfer_ix'),
  getAssociatedTokenAddress: vi.fn().mockResolvedValue('mock_ata_address'),
  getMinimumBalanceForRentExemptMint: vi.fn().mockResolvedValue(1461600),
  MINT_SIZE: 82,
  TOKEN_PROGRAM_ID: 'mock_token_program',
  ASSOCIATED_TOKEN_PROGRAM_ID: 'mock_ata_program',
}));

// ── Mock reflect-metadata (no-op) ─────────────────────────────────
vi.mock('reflect-metadata', () => ({}));

// ── Mock tsyringe ─────────────────────────────────────────────────
vi.mock('tsyringe', () => ({
  singleton: () => (target: any) => target,
}));

// ── Mock Logger ───────────────────────────────────────────────────
const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

// ── Mock SubscriptionStore ────────────────────────────────────────
function createMockStore() {
  const strategies = new Map<string, any>();
  const subscriptions = new Map<string, any>();
  const billings: any[] = [];
  let subCounter = 0;

  return {
    getStrategy: vi.fn((id: string) => strategies.get(id)),
    getSubscription: vi.fn((userId: string, strategyId: string) => {
      return subscriptions.get(`${userId}:${strategyId}`) || undefined;
    }),
    createSubscription: vi.fn((data: any) => {
      const id = `sub_${++subCounter}`;
      const sub = { ...data, id, created_at: Date.now() };
      subscriptions.set(`${data.user_id}:${data.strategy_id}`, sub);
      return sub;
    }),
    extendSubscription: vi.fn(),
    createBilling: vi.fn((data: any) => {
      billings.push({ ...data, id: `bill_${billings.length}`, created_at: Date.now() });
    }),
    // helper for tests to register a strategy
    _addStrategy: (id: string, data: any) => strategies.set(id, { id, ...data }),
    _getBillings: () => billings,
    _getSubscriptions: () => subscriptions,
  } as any;
}

// ── Import after mocks ────────────────────────────────────────────
import { StrategyEngine } from '../../src/strategy/StrategyEngine.js';

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function createEngine(store?: any): StrategyEngine {
  return new StrategyEngine(mockLogger, store);
}

const STRAT_ID = 'strat_btc_001';
const AGENT_ID = 'openai:gpt4-alpha';
const WALLET_A = 'So11111111111111111111111111111111111111112';
const WALLET_B = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe('StrategyEngine', () => {
  let engine: StrategyEngine;
  let mockStore: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = createMockStore();
    // Register default strategy so bindAgent doesn't throw
    mockStore._addStrategy(STRAT_ID, { name: 'BTC Alpha' });
    engine = createEngine(mockStore);
  });

  // ─────────────────────────────────────────────────────────────
  // 1. Agent 绑定策略
  // ─────────────────────────────────────────────────────────────
  describe('Agent Binding', () => {
    it('bindAgent: should create a binding with default options', () => {
      const binding = engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A);

      expect(binding).toBeDefined();
      expect(binding.id).toContain('agent_');
      expect(binding.agent_id).toBe(AGENT_ID);
      expect(binding.strategy_id).toBe(STRAT_ID);
      expect(binding.agent_wallet).toBe(WALLET_A);
      expect(binding.agent_type).toBe('ai_llm');
      expect(binding.execution_mode).toBe('auto');
      expect(binding.fee_share_bps).toBe(100); // default 1%
      expect(binding.status).toBe('active');
      expect(binding.created_at).toBeGreaterThan(0);
      expect(binding.updated_at).toBeGreaterThan(0);
    });

    it('bindAgent: should respect custom options', () => {
      const binding = engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A, {
        agentType: 'rule_based',
        executionMode: 'semi_auto',
        feeShareBps: 500,
        metadata: { model: 'v2' },
      });

      expect(binding.agent_type).toBe('rule_based');
      expect(binding.execution_mode).toBe('semi_auto');
      expect(binding.fee_share_bps).toBe(500);
      expect(binding.metadata).toEqual({ model: 'v2' });
    });

    it('bindAgent: should throw if strategy not found in store', () => {
      // store returns undefined for getStrategy
      expect(() => engine.bindAgent('nonexistent', AGENT_ID, WALLET_A))
        .toThrow('Strategy not found: nonexistent');
    });

    it('bindAgent: should allow binding when store has strategy', () => {
      const binding = engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A);
      expect(binding.strategy_id).toBe(STRAT_ID);
      expect(mockStore.getStrategy).toHaveBeenCalledWith(STRAT_ID);
    });

    it('bindAgent: should throw on duplicate active binding', () => {
      engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A);

      expect(() => engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A))
        .toThrow(`Agent ${AGENT_ID} already bound to strategy ${STRAT_ID}`);
    });

    it('bindAgent: should allow re-binding after unbind', () => {
      engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A);
      engine.unbindAgent(AGENT_ID);

      // Should not throw
      const binding2 = engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A);
      expect(binding2.status).toBe('active');
    });

    it('unbindAgent: should revoke active binding', () => {
      engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A);

      const result = engine.unbindAgent(AGENT_ID);
      expect(result).toBe(true);

      const binding = engine.getAgentBindings(AGENT_ID);
      expect(binding?.status).toBe('revoked');
    });

    it('unbindAgent: should return false for unknown agent', () => {
      expect(engine.unbindAgent('unknown_agent')).toBe(false);
    });

    it('unbindAgent: should return false for already revoked agent', () => {
      engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A);
      engine.unbindAgent(AGENT_ID);

      expect(engine.unbindAgent(AGENT_ID)).toBe(false);
    });

    it('pauseAgent: should pause active binding', () => {
      engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A);

      expect(engine.pauseAgent(AGENT_ID)).toBe(true);
      expect(engine.getAgentBindings(AGENT_ID)?.status).toBe('paused');
    });

    it('pauseAgent: should return false for non-active agent', () => {
      expect(engine.pauseAgent('unknown')).toBe(false);
    });

    it('resumeAgent: should resume paused binding', () => {
      engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A);
      engine.pauseAgent(AGENT_ID);

      expect(engine.resumeAgent(AGENT_ID)).toBe(true);
      expect(engine.getAgentBindings(AGENT_ID)?.status).toBe('active');
    });

    it('resumeAgent: should return false for non-paused agent', () => {
      engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A);

      // Active, not paused
      expect(engine.resumeAgent(AGENT_ID)).toBe(false);
    });

    it('getStrategyAgents: should return only active bindings', () => {
      const agent2 = 'custom:bot_2';
      engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A);
      engine.bindAgent(STRAT_ID, agent2, WALLET_B);
      engine.pauseAgent(AGENT_ID);

      const agents = engine.getStrategyAgents(STRAT_ID);
      expect(agents.length).toBe(1);
      expect(agents[0].agent_id).toBe(agent2);
    });

    it('getStrategyAgents: should return empty array for unknown strategy', () => {
      expect(engine.getStrategyAgents('nonexistent')).toEqual([]);
    });

    it('getAgentBindings: should return the binding for a known agent', () => {
      engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A);

      const binding = engine.getAgentBindings(AGENT_ID);
      expect(binding).toBeDefined();
      expect(binding?.strategy_id).toBe(STRAT_ID);
    });

    it('getAgentBindings: should return undefined for unknown agent', () => {
      expect(engine.getAgentBindings('unknown')).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Agent 执行记录
  // ─────────────────────────────────────────────────────────────
  describe('Agent Execution', () => {
    it('recordAgentExecution: should create a pending execution', () => {
      engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A, { feeShareBps: 500 });

      const exec = engine.recordAgentExecution(AGENT_ID, 'sig_001', 'buy', 1000);

      expect(exec).toBeDefined();
      expect(exec.id).toContain('exec_');
      expect(exec.agent_id).toBe(AGENT_ID);
      expect(exec.strategy_id).toBe(STRAT_ID);
      expect(exec.signal_id).toBe('sig_001');
      expect(exec.action).toBe('buy');
      expect(exec.amount).toBe(1000);
      expect(exec.fee_taken).toBe(50); // 1000 * 500/10000
      expect(exec.status).toBe('pending');
    });

    it('recordAgentExecution: should throw if agent is not active', () => {
      engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A);
      engine.pauseAgent(AGENT_ID);

      expect(() => engine.recordAgentExecution(AGENT_ID, 'sig_001', 'buy', 100))
        .toThrow(`Agent ${AGENT_ID} is not active`);
    });

    it('recordAgentExecution: should throw for unknown agent', () => {
      expect(() => engine.recordAgentExecution('unknown', 'sig_001', 'sell', 50))
        .toThrow('Agent unknown is not active');
    });

    it('updateExecutionStatus: should update execution fields', () => {
      engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A);
      const exec = engine.recordAgentExecution(AGENT_ID, 'sig_001', 'buy', 1000);

      const result = engine.updateExecutionStatus(exec.id, 'executed', 'tx_abc123', 150);

      expect(result).toBe(true);
      expect(exec.status).toBe('executed');
      expect(exec.tx_signature).toBe('tx_abc123');
      expect(exec.profit_loss).toBe(150);
    });

    it('updateExecutionStatus: should return false for unknown execution', () => {
      expect(engine.updateExecutionStatus('nonexistent', 'executed')).toBe(false);
    });

    it('updateExecutionStatus: should work without optional fields', () => {
      engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A);
      const exec = engine.recordAgentExecution(AGENT_ID, 'sig_001', 'hold', 0);

      const result = engine.updateExecutionStatus(exec.id, 'cancelled');
      expect(result).toBe(true);
      expect(exec.status).toBe('cancelled');
      expect(exec.tx_signature).toBeUndefined();
      expect(exec.profit_loss).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 3. Agent Stats
  // ─────────────────────────────────────────────────────────────
  describe('Agent Stats', () => {
    it('getAgentStats: should compute correct stats', () => {
      engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A, { feeShareBps: 100 });

      const e1 = engine.recordAgentExecution(AGENT_ID, 's1', 'buy', 1000);
      engine.updateExecutionStatus(e1.id, 'executed', 'tx1', 200);

      const e2 = engine.recordAgentExecution(AGENT_ID, 's2', 'sell', 500);
      engine.updateExecutionStatus(e2.id, 'failed');

      const e3 = engine.recordAgentExecution(AGENT_ID, 's3', 'buy', 2000);
      engine.updateExecutionStatus(e3.id, 'executed', 'tx3', -100);

      const stats = engine.getAgentStats(AGENT_ID);

      expect(stats.totalExecutions).toBe(3);
      expect(stats.successRate).toBeCloseTo((2 / 3) * 100, 1);
      expect(stats.totalVolume).toBe(3500);       // 1000 + 500 + 2000
      expect(stats.totalFees).toBe(35);            // 10 + 5 + 20
      expect(stats.profitLoss).toBe(100);          // 200 + 0 + (-100)
    });

    it('getAgentStats: should return zeros for unknown agent', () => {
      const stats = engine.getAgentStats('unknown');

      expect(stats.totalExecutions).toBe(0);
      expect(stats.successRate).toBe(0);
      expect(stats.totalVolume).toBe(0);
      expect(stats.totalFees).toBe(0);
      expect(stats.profitLoss).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 4. 捆绑销售（Bundle）
  // ─────────────────────────────────────────────────────────────
  describe('Bundle Products', () => {
    it('constructor: should initialize 3 default bundles', () => {
      const bundles = engine.getBundleProducts();
      expect(bundles.length).toBe(3);
    });

    it('getBundleProducts: should return only active bundles', () => {
      const basic = engine.getBundle('bundle_default_basic');
      expect(basic).toBeDefined();
      // All defaults are active
      const products = engine.getBundleProducts();
      expect(products.every((b) => b.status === 'active')).toBe(true);
    });

    it('getBundle: should return bundle by id', () => {
      const bundle = engine.getBundle('bundle_default_premium');
      expect(bundle).toBeDefined();
      expect(bundle!.name).toBe('进阶盲盒包');
      expect(bundle!.blindbox_count).toBe(10);
      expect(bundle!.bonus_days).toBe(30);
      expect(bundle!.price_sol).toBe(0.15);
      expect(bundle!.price_bbt).toBe(150);
      expect(bundle!.nft_tier).toBe('premium');
      expect(bundle!.max_supply).toBe(1000);
    });

    it('getBundle: should return undefined for unknown id', () => {
      expect(engine.getBundle('nonexistent')).toBeUndefined();
    });

    it('createBundle: should create a custom bundle', () => {
      const bundle = engine.createBundle('Custom Pack', 'A test pack', ['s1', 's2'], {
        blindboxCount: 5,
        bonusDays: 14,
        priceSol: 0.1,
        priceBbt: 100,
        nftTier: 'premium',
        maxSupply: 50,
      });

      expect(bundle.id).toContain('bundle_');
      expect(bundle.name).toBe('Custom Pack');
      expect(bundle.description).toBe('A test pack');
      expect(bundle.strategy_ids).toEqual(['s1', 's2']);
      expect(bundle.blindbox_count).toBe(5);
      expect(bundle.bonus_days).toBe(14);
      expect(bundle.price_sol).toBe(0.1);
      expect(bundle.price_bbt).toBe(100);
      expect(bundle.nft_tier).toBe('premium');
      expect(bundle.max_supply).toBe(50);
      expect(bundle.sold_count).toBe(0);
      expect(bundle.status).toBe('active');
    });

    it('createBundle: should use default options', () => {
      const bundle = engine.createBundle('Default Pack', 'Defaults', []);

      expect(bundle.blindbox_count).toBe(3);
      expect(bundle.bonus_days).toBe(7);
      expect(bundle.price_sol).toBe(0.05);
      expect(bundle.price_bbt).toBe(50);
      expect(bundle.nft_tier).toBe('basic');
      expect(bundle.max_supply).toBe(0);
    });

    it('createBundle: bundle should be retrievable after creation', () => {
      const bundle = engine.createBundle('My Pack', 'desc', ['s1']);
      const retrieved = engine.getBundle(bundle.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.name).toBe('My Pack');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 5. 购买捆绑包（purchaseBundle）
  // ─────────────────────────────────────────────────────────────
  describe('purchaseBundle', () => {
    it('should fail for non-existent bundle', async () => {
      const result = await engine.purchaseBundle('fake_bundle', WALLET_A, 'user_001', 'sol');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Bundle not available');
    });

    it('should fail for sold-out bundle', async () => {
      // Use VIP bundle (max_supply = 100)
      const vipBundle = engine.getBundle('bundle_default_vip')!;
      // Manually set sold_count to max
      (vipBundle as any).sold_count = 100;

      const result = await engine.purchaseBundle('bundle_default_vip', WALLET_A, 'user_001', 'sol');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Bundle sold out');
      expect(vipBundle.status).toBe('sold_out');
    });

    it('should detect idempotent tx (duplicate purchase)', async () => {
      // Add a strategy so NFT gets minted
      mockStore._addStrategy(STRAT_ID, { name: 'BTC Alpha' });

      // Create a bundle with a strategy
      const bundle = engine.createBundle('Test Bundle', 'desc', [STRAT_ID]);

      // First purchase
      const r1 = await engine.purchaseBundle(bundle.id, WALLET_A, 'user_001', 'sol', 'tx_unique_123');
      expect(r1.success).toBe(true);

      // Second purchase with same txSignature
      const r2 = await engine.purchaseBundle(bundle.id, WALLET_A, 'user_001', 'sol', 'tx_unique_123');
      expect(r2.success).toBe(false);
      expect(r2.error).toBe('Transaction already processed');
    });

    it('should purchase bundle and return NFT + blindbox credits + subscriptions', async () => {
      mockStore._addStrategy(STRAT_ID, { name: 'BTC Alpha' });

      const bundle = engine.createBundle('Full Pack', 'desc', [STRAT_ID], {
        blindboxCount: 5,
        bonusDays: 14,
        nftTier: 'premium',
      });

      const result = await engine.purchaseBundle(bundle.id, WALLET_A, 'user_001', 'sol', 'tx_001');

      expect(result.success).toBe(true);
      expect(result.nft).toBeDefined();
      expect(result.nft!.strategy_id).toBe(STRAT_ID);
      expect(result.nft!.owner_wallet).toBe(WALLET_A);
      expect(result.nft!.tier).toBe('premium');
      expect(result.nft!.subscription_days).toBe(14);
      expect(result.blindboxCredits).toBe(5);
      expect(result.subscriptions).toEqual([STRAT_ID]);

      // sold_count incremented
      expect(bundle.sold_count).toBe(1);
    });

    it('should create subscription via store', async () => {
      mockStore._addStrategy(STRAT_ID, { name: 'BTC Alpha' });
      const bundle = engine.createBundle('Sub Pack', 'desc', [STRAT_ID], { bonusDays: 7 });

      await engine.purchaseBundle(bundle.id, WALLET_A, 'user_sub', 'sol', 'tx_sub_001');

      expect(mockStore.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user_sub',
          strategy_id: STRAT_ID,
          status: 'active',
          billing_model: 'free',
        }),
      );
    });

    it('should extend existing subscription if already active', async () => {
      mockStore._addStrategy(STRAT_ID, { name: 'BTC Alpha' });

      // Simulate existing subscription
      const existingSub = { id: 'existing_sub_001', status: 'active', expires_at: Date.now() + 86400000 };
      mockStore.getSubscription.mockReturnValueOnce(existingSub);

      const bundle = engine.createBundle('Extend Pack', 'desc', [STRAT_ID], { bonusDays: 7 });

      const result = await engine.purchaseBundle(bundle.id, WALLET_A, 'user_ext', 'sol', 'tx_ext_001');

      expect(result.success).toBe(true);
      expect(mockStore.extendSubscription).toHaveBeenCalledWith(
        'existing_sub_001',
        expect.any(Number),
      );
    });

    it('should record billing via store', async () => {
      mockStore._addStrategy(STRAT_ID, { name: 'BTC Alpha' });
      const bundle = engine.createBundle('Bill Pack', 'desc', [STRAT_ID], { priceBbt: 200 });

      await engine.purchaseBundle(bundle.id, WALLET_A, 'user_bill', 'bbt', 'tx_bill_001');

      expect(mockStore.createBilling).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user_bill',
          type: 'subscription',
          amount_bbt: 200,
          status: 'confirmed',
          tx_signature: 'tx_bill_001',
        }),
      );
    });

    it('should return empty subscriptions when bundle has no strategies', async () => {
      const bundle = engine.createBundle('No Strat', 'desc', []);

      const result = await engine.purchaseBundle(bundle.id, WALLET_A, 'user_none', 'sol');

      expect(result.success).toBe(true);
      expect(result.subscriptions).toEqual([]);
      expect(result.nft).toBeUndefined();
      expect(result.blindboxCredits).toBe(3); // default
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 6. NFT 铸造（mintSubscriptionNFT）
  // ─────────────────────────────────────────────────────────────
  describe('NFT Minting', () => {
    it('mintSubscriptionNFT: should create NFT with correct fields', async () => {
      mockStore._addStrategy(STRAT_ID, { name: 'BTC Alpha' });

      const nft = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 30, 'premium');

      expect(nft).toBeDefined();
      expect(nft.id).toContain('nft_');
      expect(nft.mint_address).toBeDefined();
      expect(nft.strategy_id).toBe(STRAT_ID);
      expect(nft.owner_wallet).toBe(WALLET_A);
      expect(nft.original_owner).toBe(WALLET_A);
      expect(nft.subscription_days).toBe(30);
      expect(nft.tier).toBe('premium');
      expect(nft.used).toBe(false);
      expect(nft.burned).toBe(false);
      expect(nft.expires_at).toBeGreaterThan(Date.now());
    });

    it('mintSubscriptionNFT: lifetime tier should have expires_at = 0', async () => {
      const nft = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 365, 'lifetime');

      expect(nft.tier).toBe('lifetime');
      expect(nft.expires_at).toBe(0);
    });

    it('mintSubscriptionNFT: basic tier as default', async () => {
      const nft = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 7);

      expect(nft.tier).toBe('basic');
      expect(nft.subscription_days).toBe(7);
    });

    it('mintSubscriptionNFT: should store NFT and make it retrievable', async () => {
      const nft = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 30, 'vip');

      // By ID
      expect(engine.getNFT(nft.id)).toBe(nft);
      // By mint
      expect(engine.getNFTByMint(nft.mint_address)).toBe(nft);
      // By owner
      const userNfts = engine.getUserNFTs(WALLET_A);
      expect(userNfts.length).toBe(1);
      expect(userNfts[0].id).toBe(nft.id);
    });

    it('mintSubscriptionNFT: should use metadataNote as metadata_uri', async () => {
      const nft = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 7, 'basic', 'custom_uri_note');

      expect(nft.metadata_uri).toBe('custom_uri_note');
    });

    it('mintSubscriptionNFT: should default metadata_uri to ipfs:// prefix', async () => {
      const nft = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 7);

      expect(nft.metadata_uri).toMatch(/^ipfs:\/\//);
    });

    it('getUserNFTs: should exclude burned NFTs', async () => {
      const nft1 = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 1);
      const nft2 = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 1);

      // Burn nft1 (set expires_at to past first)
      nft1.expires_at = Date.now() - 1000;
      engine.burnExpiredNFT(nft1.id);

      const userNfts = engine.getUserNFTs(WALLET_A);
      expect(userNfts.length).toBe(1);
      expect(userNfts[0].id).toBe(nft2.id);
    });

    it('getUserNFTs: should return empty for unknown wallet', () => {
      expect(engine.getUserNFTs('unknown_wallet')).toEqual([]);
    });

    it('getNFT: should return undefined for unknown nftId', () => {
      expect(engine.getNFT('nonexistent')).toBeUndefined();
    });

    it('getNFTByMint: should return undefined for unknown mint', () => {
      expect(engine.getNFTByMint('nonexistent_mint')).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 7. NFT 激活（activateNFT）
  // ─────────────────────────────────────────────────────────────
  describe('NFT Activation', () => {
    it('activateNFT: should mark NFT as used and create subscription', async () => {
      mockStore._addStrategy(STRAT_ID, { name: 'BTC Alpha' });
      const nft = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 30, 'premium');

      const result = engine.activateNFT(nft.id, 'user_activate');

      expect(result.success).toBe(true);
      expect(nft.used).toBe(true);
      expect(mockStore.createSubscription).toHaveBeenCalled();
    });

    it('activateNFT: should extend existing subscription', async () => {
      mockStore._addStrategy(STRAT_ID, { name: 'BTC Alpha' });
      const nft = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 30, 'premium');

      const existingSub = { id: 'existing_sub', status: 'active', expires_at: Date.now() + 86400000 };
      mockStore.getSubscription.mockReturnValueOnce(existingSub);

      const result = engine.activateNFT(nft.id, 'user_extend');

      expect(result.success).toBe(true);
      expect(mockStore.extendSubscription).toHaveBeenCalled();
    });

    it('activateNFT: should fail for non-existent NFT', () => {
      const result = engine.activateNFT('nonexistent', 'user_001');
      expect(result.success).toBe(false);
      expect(result.error).toBe('NFT not found');
    });

    it('activateNFT: should fail for already activated NFT', async () => {
      const nft = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 30);

      engine.activateNFT(nft.id, 'user_001');
      const result = engine.activateNFT(nft.id, 'user_001');

      expect(result.success).toBe(false);
      expect(result.error).toBe('NFT already activated');
    });

    it('activateNFT: should fail for burned NFT', async () => {
      const nft = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 1);
      nft.expires_at = Date.now() - 1000;
      engine.burnExpiredNFT(nft.id);

      const result = engine.activateNFT(nft.id, 'user_001');
      expect(result.success).toBe(false);
      expect(result.error).toBe('NFT has been burned');
    });

    it('activateNFT: should fail for expired NFT', async () => {
      const nft = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 30);
      // Set to past but not burned
      nft.expires_at = Date.now() - 1000;

      const result = engine.activateNFT(nft.id, 'user_001');
      expect(result.success).toBe(false);
      expect(result.error).toBe('NFT has expired');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 8. NFT 销毁（burnExpiredNFT）
  // ─────────────────────────────────────────────────────────────
  describe('NFT Burning', () => {
    it('burnExpiredNFT: should burn an expired NFT', async () => {
      const nft = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 1);
      nft.expires_at = Date.now() - 1000;

      const result = engine.burnExpiredNFT(nft.id);

      expect(result).toBe(true);
      expect(nft.burned).toBe(true);
    });

    it('burnExpiredNFT: should remove NFT from owner index', async () => {
      const nft = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 1);
      nft.expires_at = Date.now() - 1000;

      engine.burnExpiredNFT(nft.id);

      expect(engine.getUserNFTs(WALLET_A)).toEqual([]);
    });

    it('burnExpiredNFT: should return false for non-existent NFT', () => {
      expect(engine.burnExpiredNFT('nonexistent')).toBe(false);
    });

    it('burnExpiredNFT: should return false for already burned NFT', async () => {
      const nft = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 1);
      nft.expires_at = Date.now() - 1000;

      engine.burnExpiredNFT(nft.id);
      expect(engine.burnExpiredNFT(nft.id)).toBe(false);
    });

    it('burnExpiredNFT: should return false for non-expired NFT', async () => {
      const nft = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 365);

      expect(engine.burnExpiredNFT(nft.id)).toBe(false);
      expect(nft.burned).toBe(false);
    });

    it('burnExpiredNFT: lifetime NFT (expires_at=0) should NOT be burned', async () => {
      // expires_at=0 means lifetime — should be protected from burning
      const nft = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 0, 'lifetime');

      expect(engine.burnExpiredNFT(nft.id)).toBe(false);
      expect(nft.burned).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 9. 二级市场（Marketplace）
  // ─────────────────────────────────────────────────────────────
  describe('Marketplace', () => {
    let nft: Awaited<ReturnType<typeof engine.mintSubscriptionNFT>>;

    beforeEach(async () => {
      nft = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 30, 'premium');
    });

    // ── listForSale ──

    it('listForSale: should create a market listing', () => {
      const listing = engine.listForSale(nft.id, WALLET_A, 0.5, 100);

      expect(listing).toBeDefined();
      expect(listing.id).toContain('listing_');
      expect(listing.nft_id).toBe(nft.id);
      expect(listing.mint_address).toBe(nft.mint_address);
      expect(listing.seller_wallet).toBe(WALLET_A);
      expect(listing.strategy_id).toBe(STRAT_ID);
      expect(listing.price_sol).toBe(0.5);
      expect(listing.price_bbt).toBe(100);
      expect(listing.status).toBe('active');
      expect(listing.remaining_days).toBeGreaterThan(0);
    });

    it('listForSale: should throw for non-existent NFT', () => {
      expect(() => engine.listForSale('fake_nft', WALLET_A, 1))
        .toThrow('NFT not found');
    });

    it('listForSale: should throw if not the owner', () => {
      expect(() => engine.listForSale(nft.id, WALLET_B, 1))
        .toThrow('Not the NFT owner');
    });

    it('listForSale: should throw for burned NFT', () => {
      nft.expires_at = Date.now() - 1000;
      engine.burnExpiredNFT(nft.id);

      expect(() => engine.listForSale(nft.id, WALLET_A, 1))
        .toThrow('NFT has been burned');
    });

    it('listForSale: should throw for activated NFT', () => {
      engine.activateNFT(nft.id, 'user_001');

      expect(() => engine.listForSale(nft.id, WALLET_A, 1))
        .toThrow('Cannot sell an activated NFT');
    });

    it('listForSale: lifetime NFT should have remaining_days = 9999', async () => {
      const lifetimeNft = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 0, 'lifetime');

      const listing = engine.listForSale(lifetimeNft.id, WALLET_A, 2.0);
      expect(listing.remaining_days).toBe(9999);
    });

    // ── cancelListing ──

    it('cancelListing: should cancel an active listing', () => {
      const listing = engine.listForSale(nft.id, WALLET_A, 0.5);

      const result = engine.cancelListing(listing.id, WALLET_A);

      expect(result).toBe(true);
      expect(listing.status).toBe('cancelled');
    });

    it('cancelListing: should return false for wrong seller', () => {
      const listing = engine.listForSale(nft.id, WALLET_A, 0.5);

      expect(engine.cancelListing(listing.id, WALLET_B)).toBe(false);
    });

    it('cancelListing: should return false for non-existent listing', () => {
      expect(engine.cancelListing('fake_listing', WALLET_A)).toBe(false);
    });

    it('cancelListing: should remove from activeListings', () => {
      const listing = engine.listForSale(nft.id, WALLET_A, 0.5);

      engine.cancelListing(listing.id, WALLET_A);

      const active = engine.getActiveListings();
      expect(active.find((l) => l.id === listing.id)).toBeUndefined();
    });

    // ── getActiveListings ──

    it('getActiveListings: should return active listings sorted by price', async () => {
      const nft2 = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 30, 'basic');

      engine.listForSale(nft.id, WALLET_A, 0.5);
      engine.listForSale(nft2.id, WALLET_A, 0.2);

      const listings = engine.getActiveListings();
      expect(listings.length).toBe(2);
      expect(listings[0].price_sol).toBe(0.2);
      expect(listings[1].price_sol).toBe(0.5);
    });

    it('getActiveListings: should filter by strategyId', async () => {
      const strat2 = 'strat_eth_001';
      const nft2 = await engine.mintSubscriptionNFT(strat2, WALLET_A, 30, 'basic');

      engine.listForSale(nft.id, WALLET_A, 0.5);
      engine.listForSale(nft2.id, WALLET_A, 0.3);

      const filtered = engine.getActiveListings(STRAT_ID);
      expect(filtered.length).toBe(1);
      expect(filtered[0].strategy_id).toBe(STRAT_ID);
    });

    it('getActiveListings: should filter by tier', async () => {
      const nft2 = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 30, 'basic');

      engine.listForSale(nft.id, WALLET_A, 0.5);
      engine.listForSale(nft2.id, WALLET_A, 0.3);

      const filtered = engine.getActiveListings(undefined, 'premium');
      expect(filtered.length).toBe(1);
      expect(filtered[0].tier).toBe('premium');
    });

    // ── getUserListings ──

    it('getUserListings: should return user listings sorted by listed_at desc', async () => {
      const nft2 = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 30, 'basic');

      engine.listForSale(nft.id, WALLET_A, 0.5);
      engine.listForSale(nft2.id, WALLET_A, 0.3);

      const listings = engine.getUserListings(WALLET_A);
      expect(listings.length).toBe(2);
      // Sorted desc by listed_at
      expect(listings[0].listed_at).toBeGreaterThanOrEqual(listings[1].listed_at);
    });

    it('getUserListings: should return empty for unknown wallet', () => {
      expect(engine.getUserListings('unknown')).toEqual([]);
    });

    // ── purchaseFromMarket ──

    it('purchaseFromMarket: should transfer NFT and create subscription', async () => {
      mockStore._addStrategy(STRAT_ID, { name: 'BTC Alpha' });

      const listing = engine.listForSale(nft.id, WALLET_A, 0.5, 50);

      const result = await engine.purchaseFromMarket(listing.id, WALLET_B, 'buyer_001', 'tx_market_001');

      expect(result.success).toBe(true);
      expect(result.nft).toBeDefined();
      expect(result.nft!.owner_wallet).toBe(WALLET_B);

      // Listing updated
      expect(listing.status).toBe('sold');
      expect(listing.buyer_wallet).toBe(WALLET_B);
      expect(listing.tx_signature).toBe('tx_market_001');

      // Owner index updated
      expect(engine.getUserNFTs(WALLET_A)).toEqual([]);
      expect(engine.getUserNFTs(WALLET_B).length).toBe(1);
    });

    it('purchaseFromMarket: should fail for non-existent listing', async () => {
      const result = await engine.purchaseFromMarket('fake', WALLET_B, 'buyer_001');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Listing not available');
    });

    it('purchaseFromMarket: should fail when buying own listing', async () => {
      const listing = engine.listForSale(nft.id, WALLET_A, 0.5);

      const result = await engine.purchaseFromMarket(listing.id, WALLET_A, 'seller_001');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Cannot buy your own listing');
    });

    it('purchaseFromMarket: should fail for burned NFT', async () => {
      const listing = engine.listForSale(nft.id, WALLET_A, 0.5);

      // Burn the NFT after listing
      nft.expires_at = Date.now() - 1000;
      engine.burnExpiredNFT(nft.id);

      const result = await engine.purchaseFromMarket(listing.id, WALLET_B, 'buyer_001');
      expect(result.success).toBe(false);
      expect(result.error).toBe('NFT no longer valid');
      expect(listing.status).toBe('expired');
    });

    it('purchaseFromMarket: should fail for expired NFT', async () => {
      const listing = engine.listForSale(nft.id, WALLET_A, 0.5);

      // Set NFT as expired (but not burned)
      nft.expires_at = Date.now() - 1000;

      const result = await engine.purchaseFromMarket(listing.id, WALLET_B, 'buyer_001');
      expect(result.success).toBe(false);
      expect(result.error).toBe('NFT has expired');
      expect(listing.status).toBe('expired');
    });

    it('purchaseFromMarket: should record billing', async () => {
      mockStore._addStrategy(STRAT_ID, { name: 'BTC Alpha' });
      const listing = engine.listForSale(nft.id, WALLET_A, 0.5, 75);

      await engine.purchaseFromMarket(listing.id, WALLET_B, 'buyer_001', 'tx_bill');

      expect(mockStore.createBilling).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'buyer_001',
          type: 'subscription',
          amount_bbt: 75,
          status: 'confirmed',
          tx_signature: 'tx_bill',
        }),
      );
    });

    it('purchaseFromMarket: should remove listing from active listings', async () => {
      const listing = engine.listForSale(nft.id, WALLET_A, 0.5);

      await engine.purchaseFromMarket(listing.id, WALLET_B, 'buyer_001');

      const active = engine.getActiveListings();
      expect(active.find((l) => l.id === listing.id)).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 10. Market Stats
  // ─────────────────────────────────────────────────────────────
  describe('Market Stats', () => {
    it('getMarketStats: should return zeros when no listings', () => {
      const stats = engine.getMarketStats();

      expect(stats.totalListings).toBe(0);
      expect(stats.activeListings).toBe(0);
      expect(stats.totalSold).toBe(0);
      expect(stats.totalVolume).toBe(0);
      expect(stats.averagePrice).toBe(0);
      expect(stats.floorPrice).toBe(0);
    });

    it('getMarketStats: should compute correct stats', async () => {
      const nft1 = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 30, 'basic');
      const nft2 = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 30, 'premium');
      const nft3 = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 30, 'vip');

      const l1 = engine.listForSale(nft1.id, WALLET_A, 0.1);
      const l2 = engine.listForSale(nft2.id, WALLET_A, 0.3);
      engine.listForSale(nft3.id, WALLET_A, 0.5);

      // Sell one
      await engine.purchaseFromMarket(l1.id, WALLET_B, 'buyer_001');
      await engine.purchaseFromMarket(l2.id, WALLET_B, 'buyer_002');

      const stats = engine.getMarketStats();

      expect(stats.totalListings).toBe(3);
      expect(stats.activeListings).toBe(1);
      expect(stats.totalSold).toBe(2);
      expect(stats.totalVolume).toBeCloseTo(0.4, 5);  // 0.1 + 0.3
      expect(stats.averagePrice).toBeCloseTo(0.2, 5);  // 0.4 / 2
      expect(stats.floorPrice).toBeCloseTo(0.5, 5);    // only 1 active at 0.5
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 11. Strategy Enhanced Info
  // ─────────────────────────────────────────────────────────────
  describe('Strategy Enhanced Info', () => {
    it('getStrategyEnhanced: should return strategy stats', async () => {
      // Bind agents
      engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A);
      engine.bindAgent(STRAT_ID, 'custom:bot2', WALLET_B);

      // Mint NFTs
      const nft1 = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 30, 'basic');
      await engine.mintSubscriptionNFT(STRAT_ID, WALLET_B, 30, 'premium');

      // List one on market
      engine.listForSale(nft1.id, WALLET_A, 0.2);

      const info = engine.getStrategyEnhanced(STRAT_ID);

      expect(info.agents.length).toBe(2);
      expect(info.nftsIssued).toBe(2);
      expect(info.nftsActive).toBe(2); // neither burned nor used
      expect(info.marketListings).toBe(1);
      expect(info.floorPrice).toBeCloseTo(0.2, 5);
    });

    it('getStrategyEnhanced: should return empty stats for unknown strategy', () => {
      const info = engine.getStrategyEnhanced('nonexistent');

      expect(info.agents).toEqual([]);
      expect(info.nftsIssued).toBe(0);
      expect(info.nftsActive).toBe(0);
      expect(info.marketListings).toBe(0);
      expect(info.floorPrice).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 12. Edge Cases / Integration
  // ─────────────────────────────────────────────────────────────
  describe('Edge Cases', () => {
    it('should work without SubscriptionStore (optional dependency)', async () => {
      const noStoreEngine = createEngine(); // no store

      // bindAgent should work without store check
      const binding = noStoreEngine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A);
      expect(binding.status).toBe('active');

      // mintNFT should work
      const nft = await noStoreEngine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 7);
      expect(nft.id).toContain('nft_');

      // purchaseBundle should work (subscriptions will be skipped)
      const bundle = noStoreEngine.createBundle('No Store Bundle', 'desc', [STRAT_ID]);
      const result = await noStoreEngine.purchaseBundle(bundle.id, WALLET_A, 'user_001', 'sol');
      expect(result.success).toBe(true);
      expect(result.subscriptions).toEqual([]);
    });

    it('should handle multiple NFTs per user', async () => {
      const nft1 = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 7, 'basic');
      const nft2 = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 30, 'premium');
      const nft3 = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 365, 'vip');

      const userNfts = engine.getUserNFTs(WALLET_A);
      expect(userNfts.length).toBe(3);
    });

    it('should handle multiple agents per strategy', () => {
      engine.bindAgent(STRAT_ID, 'agent_1', WALLET_A);
      engine.bindAgent(STRAT_ID, 'agent_2', WALLET_B);

      const agents = engine.getStrategyAgents(STRAT_ID);
      expect(agents.length).toBe(2);
    });

    it('should handle full lifecycle: bind -> execute -> stats', () => {
      engine.bindAgent(STRAT_ID, AGENT_ID, WALLET_A, { feeShareBps: 250 });

      const e1 = engine.recordAgentExecution(AGENT_ID, 's1', 'buy', 1000);
      engine.updateExecutionStatus(e1.id, 'executed', 'tx1', 50);

      const e2 = engine.recordAgentExecution(AGENT_ID, 's2', 'sell', 2000);
      engine.updateExecutionStatus(e2.id, 'executed', 'tx2', -30);

      const stats = engine.getAgentStats(AGENT_ID);
      expect(stats.totalExecutions).toBe(2);
      expect(stats.successRate).toBe(100);
      expect(stats.totalVolume).toBe(3000);
      expect(stats.totalFees).toBe(75);  // 25 + 50
      expect(stats.profitLoss).toBe(20); // 50 + (-30)
    });

    it('should handle full NFT lifecycle: mint -> list -> buy -> activate', async () => {
      mockStore._addStrategy(STRAT_ID, { name: 'BTC Alpha' });

      // 1. Mint
      const nft = await engine.mintSubscriptionNFT(STRAT_ID, WALLET_A, 30, 'premium');
      expect(nft.used).toBe(false);

      // 2. List
      const listing = engine.listForSale(nft.id, WALLET_A, 0.5);
      expect(listing.status).toBe('active');

      // 3. Buy from market
      const buyResult = await engine.purchaseFromMarket(listing.id, WALLET_B, 'buyer_001', 'tx_final');
      expect(buyResult.success).toBe(true);
      expect(buyResult.nft!.owner_wallet).toBe(WALLET_B);

      // 4. Activate NFT
      const activateResult = engine.activateNFT(nft.id, 'buyer_001');
      expect(activateResult.success).toBe(true);
      expect(nft.used).toBe(true);

      // 5. Verify final state
      const stats = engine.getMarketStats();
      expect(stats.totalSold).toBe(1);
    });
  });
});
