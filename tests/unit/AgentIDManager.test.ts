/**
 * AgentIDManager 单元测试
 *
 * 覆盖核心功能：
 * 1. Agent 注册（成功/失败/重复注册）
 * 2. Bot ID NFT 铸造（余额不足/成功）
 * 3. 信誉系统计算（加分/减分/衰减）
 * 4. Agent 状态管理（激活/挂起/封禁）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─────────────────────────────────────────────
// Mock 依赖 — 使用 vi.hoisted 确保在 vi.mock 之前可用
// ─────────────────────────────────────────────

const {
  mockGetAccount,
  mockGetAssociatedTokenAddress,
  mockCreateAssociatedTokenAccountInstruction,
  mockCreateMintToInstruction,
  mockCreateSetAuthorityInstruction,
  mockCreateInitializeMintInstruction,
  mockCreateTransferInstruction,
  mockConnectionGetMinBalance,
  mockConnectionGetLatestBlockhash,
  mockConnectionSendTransaction,
  mockConnectionConfirmTransaction,
  mockSystemProgramCreateAccount,
} = vi.hoisted(() => ({
  mockGetAccount: vi.fn(),
  mockGetAssociatedTokenAddress: vi.fn(),
  mockCreateAssociatedTokenAccountInstruction: vi.fn(),
  mockCreateMintToInstruction: vi.fn(),
  mockCreateSetAuthorityInstruction: vi.fn(),
  mockCreateInitializeMintInstruction: vi.fn(),
  mockCreateTransferInstruction: vi.fn(),
  mockConnectionGetMinBalance: vi.fn(),
  mockConnectionGetLatestBlockhash: vi.fn(),
  mockConnectionSendTransaction: vi.fn(),
  mockConnectionConfirmTransaction: vi.fn(),
  mockSystemProgramCreateAccount: vi.fn(),
}));

// ── Mock @solana/web3.js ──
vi.mock('@solana/web3.js', () => {
  class MockPublicKey {
    _value: string;
    constructor(value: string) {
      this._value = value;
    }
    toBase58() {
      return this._value;
    }
    toBuffer() {
      return Buffer.from(this._value);
    }
    static findProgramAddressSync() {
      return [new MockPublicKey('MockPDA1111111111111111111111111111111111111'), 255];
    }
  }

  class MockKeypair {
    publicKey: MockPublicKey;
    secretKey: Uint8Array;
    constructor(pubKey?: string) {
      this.publicKey = new MockPublicKey(pubKey || 'DefaultKeypair111111111111111111111111111111');
      this.secretKey = new Uint8Array(64);
    }
    static generate() {
      return new MockKeypair('GeneratedMint111111111111111111111111111111');
    }
  }

  class MockTransaction {
    recentBlockhash = '';
    feePayer: any = null;
    add = vi.fn().mockReturnThis();
    partialSign = vi.fn();
  }

  return {
    Connection: vi.fn().mockImplementation(() => ({
      getMinimumBalanceForRentExemption: mockConnectionGetMinBalance,
      getLatestBlockhash: mockConnectionGetLatestBlockhash,
      sendTransaction: mockConnectionSendTransaction,
      confirmTransaction: mockConnectionConfirmTransaction,
    })),
    PublicKey: MockPublicKey,
    Keypair: MockKeypair,
    Transaction: MockTransaction,
    SystemProgram: {
      createAccount: mockSystemProgramCreateAccount,
    },
  };
});

// ── Mock @solana/spl-token ──
vi.mock('@solana/spl-token', () => ({
  getAssociatedTokenAddress: mockGetAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction: mockCreateAssociatedTokenAccountInstruction,
  createMintToInstruction: mockCreateMintToInstruction,
  createSetAuthorityInstruction: mockCreateSetAuthorityInstruction,
  createInitializeMintInstruction: mockCreateInitializeMintInstruction,
  createTransferInstruction: mockCreateTransferInstruction,
  AuthorityType: { MintTokens: 0 },
  TOKEN_PROGRAM_ID: 'TokenProgramID',
  ASSOCIATED_TOKEN_PROGRAM_ID: 'AssociatedTokenProgramID',
  getAccount: mockGetAccount,
}));

// ── Import 被测模块 ──
import { AgentIDManager, type AgentRegistrationInput, type AgentMetadata } from '../../src/agent/AgentIDManager.js';
import { Keypair } from '@solana/web3.js';

// ─────────────────────────────────────────────
// 常量 & 辅助
// ─────────────────────────────────────────────

const TEST_WALLET = 'TestWallet1111111111111111111111111111111111';
const TEST_BBT_MINT = 'BBBMint1111111111111111111111111111111111111';
const TEST_RPC = 'http://localhost:8899';

const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

function createValidInput(overrides: Partial<AgentRegistrationInput> = {}): AgentRegistrationInput {
  return {
    wallet_address: TEST_WALLET,
    display_name: 'Test Agent',
    signature: 'test-signature',
    timestamp: Date.now(),
    ...overrides,
  };
}

function createTestMetadata(overrides: Partial<AgentMetadata> = {}): AgentMetadata {
  return {
    name: 'Test Agent',
    description: 'A test agent for unit testing',
    capabilities: ['signal_provider', 'trader'],
    version: '1.0.0',
    ...overrides,
  };
}

/** 注册一个标准测试 Agent 并返回 profile */
function registerTestAgent(mgr: AgentIDManager, wallet = TEST_WALLET) {
  return mgr.register(createValidInput({ wallet_address: wallet }));
}

// ─────────────────────────────────────────────
// 测试套件
// ─────────────────────────────────────────────

describe('AgentIDManager', () => {
  let manager: AgentIDManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new AgentIDManager(mockLogger);
  });

  // ═══════════════════════════════════════════
  // 1. Agent 注册
  // ═══════════════════════════════════════════

  describe('register', () => {
    it('注册成功：返回正确的 AgentProfile', () => {
      const agent = registerTestAgent(manager);

      expect(agent.agent_id).toMatch(/^agent_/);
      expect(agent.wallet_address).toBe(TEST_WALLET);
      expect(agent.display_name).toBe('Test Agent');
      expect(agent.status).toBe('pending_verification');
      expect(agent.reputation_score).toBe(100);
      expect(agent.total_trades).toBe(0);
      expect(agent.successful_trades).toBe(0);
      expect(agent.total_signals).toBe(0);
      expect(agent.accurate_signals).toBe(0);
      expect(agent.uptime_hours).toBe(0);
      expect(agent.bbt_staked).toBe(0);
      expect(agent.created_at).toBeGreaterThan(0);
      expect(agent.updated_at).toBeGreaterThan(0);
      expect(agent.last_active_at).toBeGreaterThan(0);
      expect(agent.bot_nft_mint).toBeUndefined();
    });

    it('注册成功：带 metadata 生成 metadata_uri', () => {
      const input = createValidInput({
        metadata: createTestMetadata(),
      });
      const agent = manager.register(input);

      expect(agent.metadata_uri).toBeDefined();
      expect(agent.metadata_uri).toMatch(/^ipfs:\/\//);
    });

    it('注册成功：可通过钱包地址反查', () => {
      const agent = registerTestAgent(manager);
      const found = manager.getAgentByWallet(TEST_WALLET);

      expect(found).toBeDefined();
      expect(found!.agent_id).toBe(agent.agent_id);
    });

    it('注册失败：重复钱包抛出异常', () => {
      registerTestAgent(manager);

      expect(() => registerTestAgent(manager)).toThrow('Wallet already registered');
    });

    it('注册成功：被封禁的钱包可重新注册', () => {
      const agent1 = registerTestAgent(manager);
      manager.ban(agent1.agent_id, 'test violation');

      const agent2 = registerTestAgent(manager);

      expect(agent2.agent_id).not.toBe(agent1.agent_id);
      expect(agent2.status).toBe('pending_verification');
    });

    it('注册失败：过期时间戳抛出异常', () => {
      const input = createValidInput({ timestamp: Date.now() - 600_000 }); // 10 分钟前

      expect(() => manager.register(input)).toThrow('Invalid registration signature');
    });

    it('注册失败：昵称过短抛出异常', () => {
      const input = createValidInput({ display_name: 'A' }); // 1 字符

      expect(() => manager.register(input)).toThrow('Display name must be 2-64 characters');
    });

    it('注册失败：昵称过长抛出异常', () => {
      const input = createValidInput({ display_name: 'A'.repeat(65) }); // 65 字符

      expect(() => manager.register(input)).toThrow('Display name must be 2-64 characters');
    });

    it('注册失败：空昵称抛出异常', () => {
      const input = createValidInput({ display_name: '' });

      expect(() => manager.register(input)).toThrow('Display name must be 2-64 characters');
    });
  });

  // ═══════════════════════════════════════════
  // 2. Bot ID NFT 铸造
  // ═══════════════════════════════════════════

  describe('mintBotNFT', () => {
    let agentId: string;

    beforeEach(() => {
      // 注册 Agent
      const agent = registerTestAgent(manager);
      agentId = agent.agent_id;

      // 设置默认 mock 返回值
      mockGetAssociatedTokenAddress.mockResolvedValue({
        toBase58: () => 'MockATA1111111111111111111111111111111111111',
      });
      mockGetAccount.mockResolvedValue({ amount: BigInt(10_000_000_000) }); // 10000 BBT
      mockConnectionGetMinBalance.mockResolvedValue(1_000_000);
      mockConnectionGetLatestBlockhash.mockResolvedValue({ blockhash: 'mock-blockhash' });
      mockConnectionSendTransaction.mockResolvedValue('mock-tx-signature');
      mockConnectionConfirmTransaction.mockResolvedValue(undefined);
      mockSystemProgramCreateAccount.mockReturnValue({});
      mockCreateAssociatedTokenAccountInstruction.mockReturnValue({});
      mockCreateMintToInstruction.mockReturnValue({});
      mockCreateSetAuthorityInstruction.mockReturnValue({});
      mockCreateInitializeMintInstruction.mockReturnValue({});
    });

    it('铸造失败：未初始化（无 Connection）', async () => {
      // 不调用 init()，保持 connection 为 undefined
      const result = await manager.mintBotNFT(agentId, Keypair.generate(), 2000);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not initialized');
    });

    it('铸造失败：Agent 不存在', async () => {
      manager.init(TEST_RPC, TEST_BBT_MINT);
      const result = await manager.mintBotNFT('non_existent_id', Keypair.generate(), 2000);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Agent not found');
    });

    it('铸造失败：Agent 已被封禁', async () => {
      manager.init(TEST_RPC, TEST_BBT_MINT);
      manager.ban(agentId, 'test');

      const result = await manager.mintBotNFT(agentId, Keypair.generate(), 2000);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Agent is banned');
    });

    it('铸造失败：已铸造过 Bot ID NFT', async () => {
      manager.init(TEST_RPC, TEST_BBT_MINT);

      // 第一次铸造成功
      const result1 = await manager.mintBotNFT(agentId, Keypair.generate(), 2000);
      expect(result1.success).toBe(true);

      // 第二次铸造失败
      const result2 = await manager.mintBotNFT(agentId, Keypair.generate(), 2000);
      expect(result2.success).toBe(false);
      expect(result2.error).toBe('Bot ID NFT already minted');
    });

    it('铸造失败：质押低于最低要求', async () => {
      manager.init(TEST_RPC, TEST_BBT_MINT, 1000);

      const result = await manager.mintBotNFT(agentId, Keypair.generate(), 500);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Minimum stake is 1000');
    });

    it('铸造失败：BBT 余额不足', async () => {
      manager.init(TEST_RPC, TEST_BBT_MINT, 1000);
      // 设置余额很低
      mockGetAccount.mockResolvedValue({ amount: BigInt(500_000) }); // 0.5 BBT

      const result = await manager.mintBotNFT(agentId, Keypair.generate(), 1000);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient BBT balance');
    });

    it('铸造失败：BBT Token Account 不存在', async () => {
      manager.init(TEST_RPC, TEST_BBT_MINT, 1000);
      // getAccount 抛出异常模拟 account 不存在
      mockGetAccount.mockRejectedValue(new Error('Account not found'));

      const result = await manager.mintBotNFT(agentId, Keypair.generate(), 1000);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Agent BBT token account not found');
    });

    it('铸造成功：返回正确的铸造结果', async () => {
      manager.init(TEST_RPC, TEST_BBT_MINT, 1000);
      const providerKeypair = Keypair.generate();

      const result = await manager.mintBotNFT(agentId, providerKeypair, 2000);

      expect(result.success).toBe(true);
      expect(result.mint_address).toBeDefined();
      expect(result.mint_address).toMatch(/^Generated/);
      expect(result.token_account).toBeDefined();
      expect(result.tx_signature).toBe('mock-tx-signature');
    });

    it('铸造成功：自动激活 Agent 并更新状态', async () => {
      manager.init(TEST_RPC, TEST_BBT_MINT, 1000);

      // 铸造前状态为 pending_verification
      const before = manager.getAgent(agentId)!;
      expect(before.status).toBe('pending_verification');
      expect(before.bot_nft_mint).toBeUndefined();

      await manager.mintBotNFT(agentId, Keypair.generate(), 2000);

      // 铸造后状态变为 active
      const after = manager.getAgent(agentId)!;
      expect(after.status).toBe('active');
      expect(after.bot_nft_mint).toBeDefined();
      expect(after.bbt_staked).toBe(2000);
    });

    it('铸造成功：可通过 NFT Mint 地址反查 Agent', async () => {
      manager.init(TEST_RPC, TEST_BBT_MINT, 1000);

      const result = await manager.mintBotNFT(agentId, Keypair.generate(), 2000);

      const found = manager.getAgentByNFT(result.mint_address!);
      expect(found).toBeDefined();
      expect(found!.agent_id).toBe(agentId);
    });
  });

  // ═══════════════════════════════════════════
  // 3. 信誉系统
  // ═══════════════════════════════════════════

  describe('信誉系统', () => {
    let agentId: string;

    beforeEach(() => {
      const agent = registerTestAgent(manager);
      agentId = agent.agent_id;
    });

    // ── recordTrade ──

    it('recordTrade：成功交易增加成功计数和信誉', () => {
      manager.recordTrade(agentId, true);
      const agent = manager.getAgent(agentId)!;

      expect(agent.total_trades).toBe(1);
      expect(agent.successful_trades).toBe(1);
      expect(agent.reputation_score).toBeGreaterThan(100);
    });

    it('recordTrade：失败交易只增加总计数', () => {
      manager.recordTrade(agentId, false);
      const agent = manager.getAgent(agentId)!;

      expect(agent.total_trades).toBe(1);
      expect(agent.successful_trades).toBe(0);
    });

    it('recordTrade：不存在的 Agent 抛出异常', () => {
      expect(() => manager.recordTrade('non_existent', true)).toThrow('Agent not found');
    });

    it('recordTrade：多次交易累积统计', () => {
      manager.recordTrade(agentId, true);
      manager.recordTrade(agentId, true);
      manager.recordTrade(agentId, false);

      const agent = manager.getAgent(agentId)!;
      expect(agent.total_trades).toBe(3);
      expect(agent.successful_trades).toBe(2);
    });

    // ── recordSignalResult ──

    it('recordSignalResult：准确信号增加准确计数和信誉', () => {
      manager.recordSignalResult(agentId, true);
      const agent = manager.getAgent(agentId)!;

      expect(agent.total_signals).toBe(1);
      expect(agent.accurate_signals).toBe(1);
      expect(agent.reputation_score).toBeGreaterThan(100);
    });

    it('recordSignalResult：不准确信号只增加总计数', () => {
      manager.recordSignalResult(agentId, false);
      const agent = manager.getAgent(agentId)!;

      expect(agent.total_signals).toBe(1);
      expect(agent.accurate_signals).toBe(0);
    });

    it('recordSignalResult：不存在的 Agent 抛出异常', () => {
      expect(() => manager.recordSignalResult('non_existent', true)).toThrow('Agent not found');
    });

    // ── recordUptime ──

    it('recordUptime：增加在线时长和信誉', () => {
      manager.recordUptime(agentId, 50);
      const agent = manager.getAgent(agentId)!;

      expect(agent.uptime_hours).toBe(50);
      expect(agent.reputation_score).toBeGreaterThan(100);
    });

    it('recordUptime：不存在的 Agent 抛出异常', () => {
      expect(() => manager.recordUptime('non_existent', 10)).toThrow('Agent not found');
    });

    it('recordUptime：多次记录累积', () => {
      manager.recordUptime(agentId, 30);
      manager.recordUptime(agentId, 20);

      const agent = manager.getAgent(agentId)!;
      expect(agent.uptime_hours).toBe(50);
    });

    // ── penalize ──

    it('penalize：扣减信誉分数', () => {
      manager.penalize(agentId, 20, 'test violation');
      const agent = manager.getAgent(agentId)!;

      expect(agent.reputation_score).toBe(80); // 100 - 20
    });

    it('penalize：信誉分数不低于 0', () => {
      manager.penalize(agentId, 150, 'severe violation');
      const agent = manager.getAgent(agentId)!;

      expect(agent.reputation_score).toBe(0);
    });

    it('penalize：不存在的 Agent 抛出异常', () => {
      expect(() => manager.penalize('non_existent', 10, 'test')).toThrow('Agent not found');
    });

    it('penalize：信誉低于 50 自动挂起', () => {
      manager.penalize(agentId, 60, 'major violation'); // 100 - 60 = 40 < 50
      const agent = manager.getAgent(agentId)!;

      expect(agent.status).toBe('suspended');
      expect(agent.reputation_score).toBe(40);
    });

    it('penalize：信誉不低于 50 不自动挂起', () => {
      manager.penalize(agentId, 30, 'minor violation'); // 100 - 30 = 70 >= 50
      const agent = manager.getAgent(agentId)!;

      expect(agent.status).toBe('pending_verification'); // 保持原状态
    });

    // ── decayInactiveReputation ──

    it('decayInactiveReputation：不衰减活跃中的 Agent', () => {
      // Agent 刚注册，last_active_at = now
      const decayed = manager.decayInactiveReputation();
      const agent = manager.getAgent(agentId)!;

      expect(decayed).toBe(0);
      expect(agent.reputation_score).toBe(100);
    });

    it('decayInactiveReputation：衰减不活跃的 active Agent', () => {
      // 先激活 Agent
      const agent = manager.getAgent(agentId)!;
      agent.status = 'active';
      // 设置 last_active_at 为 31 天前
      agent.last_active_at = Date.now() - 31 * 24 * 60 * 60 * 1000;

      const decayed = manager.decayInactiveReputation();

      expect(decayed).toBe(1);
      const updated = manager.getAgent(agentId)!;
      // 100 * (1 - 0.05)^1 = 95
      expect(updated.reputation_score).toBe(95);
    });

    it('decayInactiveReputation：90 天不活跃自动挂起', () => {
      const agent = manager.getAgent(agentId)!;
      agent.status = 'active';
      agent.last_active_at = Date.now() - 91 * 24 * 60 * 60 * 1000; // 91 天前

      manager.decayInactiveReputation();

      const updated = manager.getAgent(agentId)!;
      expect(updated.status).toBe('suspended');
    });

    it('decayInactiveReputation：只影响 active 状态的 Agent', () => {
      const agent = manager.getAgent(agentId)!;
      agent.status = 'suspended';
      agent.last_active_at = Date.now() - 60 * 24 * 60 * 60 * 1000;

      const decayed = manager.decayInactiveReputation();

      expect(decayed).toBe(0); // suspended Agent 不参与衰减
    });

    // ── getReputationFactors ──

    it('getReputationFactors：新 Agent 返回默认因子', () => {
      const factors = manager.getReputationFactors(agentId);

      expect(factors).toBeDefined();
      expect(factors!.trade_success_rate).toBe(50);  // 无交易时默认 50
      expect(factors!.signal_accuracy).toBe(50);      // 无信号时默认 50
      expect(factors!.uptime_score).toBe(0);           // 0 在线时长
      expect(factors!.stake_weight).toBe(0);           // 0 质押
      expect(factors!.age_bonus).toBeGreaterThanOrEqual(0);
    });

    it('getReputationFactors：不存在的 Agent 返回 undefined', () => {
      const factors = manager.getReputationFactors('non_existent');
      expect(factors).toBeUndefined();
    });

    it('getReputationFactors：有交易记录的 Agent 计算正确', () => {
      // 100% 成功率
      manager.recordTrade(agentId, true);
      manager.recordTrade(agentId, true);

      const factors = manager.getReputationFactors(agentId);
      expect(factors!.trade_success_rate).toBe(100);
    });
  });

  // ═══════════════════════════════════════════
  // 4. Agent 状态管理
  // ═══════════════════════════════════════════

  describe('状态管理', () => {
    let agentId: string;

    beforeEach(() => {
      const agent = registerTestAgent(manager);
      agentId = agent.agent_id;
    });

    // ── ban ──

    it('ban：封禁 Agent', () => {
      const result = manager.ban(agentId, 'violation');
      const agent = manager.getAgent(agentId)!;

      expect(result).toBe(true);
      expect(agent.status).toBe('banned');
    });

    it('ban：不存在的 Agent 返回 false', () => {
      const result = manager.ban('non_existent', 'test');
      expect(result).toBe(false);
    });

    // ── reactivate ──

    it('reactivate：从 suspended 恢复成功', () => {
      const agent = manager.getAgent(agentId)!;
      agent.status = 'suspended';
      agent.reputation_score = 80; // >= 50

      const result = manager.reactivate(agentId);

      expect(result).toBe(true);
      expect(manager.getAgent(agentId)!.status).toBe('active');
    });

    it('reactivate：非 suspended 状态返回 false', () => {
      // pending_verification 状态
      const result = manager.reactivate(agentId);
      expect(result).toBe(false);
    });

    it('reactivate：信誉过低返回 false', () => {
      const agent = manager.getAgent(agentId)!;
      agent.status = 'suspended';
      agent.reputation_score = 30; // < 50

      const result = manager.reactivate(agentId);
      expect(result).toBe(false);
      expect(manager.getAgent(agentId)!.status).toBe('suspended');
    });

    it('reactivate：不存在的 Agent 返回 false', () => {
      const result = manager.reactivate('non_existent');
      expect(result).toBe(false);
    });

    // ── validateNodeEligibility ──

    it('validateNodeEligibility：合格 Agent 返回 eligible', async () => {
      // 先铸造 NFT 并激活
      manager.init(TEST_RPC, TEST_BBT_MINT, 1000);
      mockGetAssociatedTokenAddress.mockResolvedValue({
        toBase58: () => 'MockATA1111111111111111111111111111111111111',
      });
      mockGetAccount.mockResolvedValue({ amount: BigInt(10_000_000_000) });
      mockConnectionGetMinBalance.mockResolvedValue(1_000_000);
      mockConnectionGetLatestBlockhash.mockResolvedValue({ blockhash: 'mock' });
      mockConnectionSendTransaction.mockResolvedValue('mock-sig');
      mockConnectionConfirmTransaction.mockResolvedValue(undefined);

      await manager.mintBotNFT(agentId, Keypair.generate(), 2000);

      const result = manager.validateNodeEligibility(agentId);
      expect(result.eligible).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('validateNodeEligibility：不存在的 Agent 不合格', () => {
      const result = manager.validateNodeEligibility('non_existent');
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('Agent not found');
    });

    it('validateNodeEligibility：非 active 状态不合格', () => {
      // pending_verification 状态
      const result = manager.validateNodeEligibility(agentId);
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain('pending_verification');
    });

    it('validateNodeEligibility：无 Bot ID NFT 不合格', () => {
      // 手动设为 active 但没有 NFT
      const agent = manager.getAgent(agentId)!;
      agent.status = 'active';

      const result = manager.validateNodeEligibility(agentId);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('Bot ID NFT not minted');
    });

    it('validateNodeEligibility：信誉过低不合格', () => {
      const agent = manager.getAgent(agentId)!;
      agent.status = 'active';
      agent.bot_nft_mint = 'FakeMint1111111111111111111111111111111111';
      agent.reputation_score = 30; // < 50

      const result = manager.validateNodeEligibility(agentId);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('Reputation too low');
    });

    // ── getStats ──

    it('getStats：返回正确的统计信息', () => {
      // 注册多个 Agent
      const agent2 = registerTestAgent(manager, 'Wallet22222222222222222222222222222222222222');
      manager.ban(agentId, 'test');

      // agent2 手动设为 active
      const a2 = manager.getAgent(agent2.agent_id)!;
      a2.status = 'active';
      a2.bbt_staked = 500;

      const stats = manager.getStats();

      expect(stats.total).toBe(2);
      expect(stats.active).toBe(1);
      expect(stats.banned).toBe(1);
      expect(stats.pending).toBe(0); // agent1 被 ban 后不再是 pending
      expect(stats.suspended).toBe(0);
      expect(stats.with_nft).toBe(0);
      expect(stats.total_staked).toBe(500);
      expect(stats.avg_reputation).toBeGreaterThan(0);
    });

    it('getStats：空数据返回全零', () => {
      // 使用全新的 manager，不被 beforeEach 注册的 Agent 影响
      const freshManager = new AgentIDManager(mockLogger);
      const stats = freshManager.getStats();

      expect(stats.total).toBe(0);
      expect(stats.active).toBe(0);
      expect(stats.suspended).toBe(0);
      expect(stats.banned).toBe(0);
      expect(stats.pending).toBe(0);
      expect(stats.with_nft).toBe(0);
      expect(stats.avg_reputation).toBe(0);
      expect(stats.total_staked).toBe(0);
    });
  });

  // ═══════════════════════════════════════════
  // 5. 查询与元数据
  // ═══════════════════════════════════════════

  describe('查询与元数据', () => {
    it('getAgent：按 ID 查询', () => {
      const agent = registerTestAgent(manager);
      const found = manager.getAgent(agent.agent_id);

      expect(found).toBeDefined();
      expect(found!.agent_id).toBe(agent.agent_id);
    });

    it('getAgent：不存在返回 undefined', () => {
      expect(manager.getAgent('non_existent')).toBeUndefined();
    });

    it('getAgentByWallet：按钱包查询', () => {
      registerTestAgent(manager);
      const found = manager.getAgentByWallet(TEST_WALLET);

      expect(found).toBeDefined();
      expect(found!.wallet_address).toBe(TEST_WALLET);
    });

    it('getAgentByWallet：不存在返回 undefined', () => {
      expect(manager.getAgentByWallet('UnknownWallet')).toBeUndefined();
    });

    it('listAgents：列出所有 Agent 并按信誉降序', () => {
      const a1 = registerTestAgent(manager, 'Wallet111111111111111111111111111111111111111');
      const a2 = registerTestAgent(manager, 'Wallet222222222222222222222222222222222222222');

      // a2 信誉更高
      manager.getAgent(a2.agent_id)!.reputation_score = 200;

      const list = manager.listAgents();
      expect(list.length).toBe(2);
      expect(list[0].agent_id).toBe(a2.agent_id); // 信誉高的排前面
    });

    it('listAgents：按状态过滤', () => {
      registerTestAgent(manager, 'Wallet111111111111111111111111111111111111111');
      const a2 = registerTestAgent(manager, 'Wallet222222222222222222222222222222222222222');
      manager.ban(a2.agent_id, 'test');

      const pending = manager.listAgents('pending_verification');
      const banned = manager.listAgents('banned');

      expect(pending.length).toBe(1);
      expect(banned.length).toBe(1);
    });

    it('getActiveAgentCount：只计算 active 状态', () => {
      const a1 = registerTestAgent(manager, 'Wallet111111111111111111111111111111111111111');
      const a2 = registerTestAgent(manager, 'Wallet222222222222222222222222222222222222222');

      manager.getAgent(a1.agent_id)!.status = 'active';
      // a2 保持 pending_verification

      expect(manager.getActiveAgentCount()).toBe(1);
    });

    it('updateMetadata：更新元数据返回 IPFS URI', () => {
      const agent = registerTestAgent(manager);
      const metadata = createTestMetadata({ name: 'Updated Name' });

      const uri = manager.updateMetadata(agent.agent_id, metadata);

      expect(uri).toMatch(/^ipfs:\/\//);
      expect(manager.getAgent(agent.agent_id)!.metadata_uri).toBe(uri);
    });

    it('updateMetadata：不存在的 Agent 抛出异常', () => {
      expect(() => manager.updateMetadata('non_existent', createTestMetadata())).toThrow('Agent not found');
    });

    it('getMetadata：返回元数据 URI', () => {
      const input = createValidInput({ metadata: createTestMetadata() });
      const agent = manager.register(input);

      const meta = manager.getMetadata(agent.agent_id);

      expect(meta).toBeDefined();
      expect(meta!.uri).toMatch(/^ipfs:\/\//);
    });

    it('getMetadata：不存在返回 undefined', () => {
      expect(manager.getMetadata('non_existent')).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════
  // 6. init 初始化
  // ═══════════════════════════════════════════

  describe('init', () => {
    it('初始化：创建 Connection 并设置配置', () => {
      manager.init(TEST_RPC, TEST_BBT_MINT, 2000);

      // 验证 Logger 被调用
      expect(mockLogger.info).toHaveBeenCalledWith(
        'AgentIDManager initialized',
        expect.objectContaining({
          minStake: 2000,
        }),
      );
    });

    it('初始化：不指定 minStake 使用默认值 1000', () => {
      manager.init(TEST_RPC, TEST_BBT_MINT);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'AgentIDManager initialized',
        expect.objectContaining({
          minStake: 1000,
        }),
      );
    });
  });
});
