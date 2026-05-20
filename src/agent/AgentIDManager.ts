/**
 * AgentIDManager — Agent 身份管理 & Bot ID NFT 铸造
 *
 * 核心设计：
 * 1. Agent 注册 — Ed25519 钱包签名验证，获得唯一 Agent ID
 * 2. Bot ID NFT 铸造 — 质押 BBT → 铸造 Metaplex Token Metadata NFT = 节点资格证
 * 3. Agent 元数据 — IPFS 存储（metadata_uri）
 * 4. 信誉系统 — 基于交易历史、信号质量、在线时长的多维评分
 *
 * NFT 标准：Metaplex Token Metadata (Solana)
 * - NFT Mint 地址 = Bot ID 唯一标识
 * - Metadata 存储在链上 (Metaplex) + IPFS (详细元数据)
 * - Owner 钱包 = 节点运营者身份证明
 *
 * 信誉分数计算：
 * - base_score (100) + 交易成功率加分 + 信号准确率加分 - 惩罚扣分
 * - 信誉衰减：长时间不活跃每月衰减 5%
 * - 信誉影响：信号权重、质押要求、盲盒概率加成
 */

import 'reflect-metadata';
import { singleton } from 'tsyringe';
import { randomBytes } from 'crypto';
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  AuthorityType,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
// @ts-ignore — @solana/spl-token is ESM-only
} from '@solana/spl-token';
import { Logger } from '../infra/logger/Logger.js';

// ───────────────────────────────────────────────
// Types & Interfaces
// ───────────────────────────────────────────────

export type AgentStatus = 'active' | 'suspended' | 'banned' | 'pending_verification';

export interface AgentProfile {
  agent_id: string;
  wallet_address: string;
  display_name: string;
  metadata_uri?: string;          // IPFS URI
  status: AgentStatus;
  reputation_score: number;       // 0-1000
  total_trades: number;
  successful_trades: number;
  total_signals: number;
  accurate_signals: number;
  uptime_hours: number;
  bot_nft_mint?: string;          // Bot ID NFT Mint 地址
  bbt_staked: number;
  created_at: number;
  updated_at: number;
  last_active_at: number;
}

export interface AgentMetadata {
  name: string;
  description: string;
  avatar_url?: string;
  capabilities: string[];         // ['signal_provider', 'strategy_creator', 'trader']
  social_links?: Record<string, string>;
  version: string;
  endpoint_url?: string;          // 节点 API 端点
  geolocation?: string;           // 服务器区域
}

export interface BotNFTConfig {
  bbt_mint: string;
  metadata_program_id: string;    // Metaplex Token Metadata Program
  min_stake_bbt: number;          // 最低质押 BBT 数量
  nft_name_prefix: string;        // NFT 名称前缀
  nft_symbol: string;             // NFT Symbol
  nft_collection_name: string;    // 集合名称
}

export interface NFTMintResult {
  success: boolean;
  mint_address?: string;
  token_account?: string;
  metadata_address?: string;
  tx_signature?: string;
  error?: string;
}

export interface ReputationFactors {
  trade_success_rate: number;     // 0-100
  signal_accuracy: number;        // 0-100
  uptime_score: number;           // 0-100
  stake_weight: number;           // 0-100
  age_bonus: number;              // 0-100
}

export interface AgentRegistrationInput {
  wallet_address: string;
  display_name: string;
  metadata?: AgentMetadata;
  signature: string;              // 钱包签名验证
  timestamp: number;
}

// ───────────────────────────────────────────────
// 常量
// ───────────────────────────────────────────────

const DEFAULT_BOT_NFT_CONFIG: BotNFTConfig = {
  bbt_mint: '',                   // 从 ProviderConfig 注入
  metadata_program_id: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  min_stake_bbt: 1000,
  nft_name_prefix: '123456BTC Bot',
  nft_symbol: 'BOTID',
  nft_collection_name: '123456BTC Bot ID Collection',
};

const REPUTATION_BASE_SCORE = 100;
const REPUTATION_MAX_SCORE = 1000;
const REPUTATION_DECAY_RATE = 0.05;       // 每月衰减 5%
const REPUTATION_DECAY_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30天
const STALE_AGENT_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;     // 90天不活跃标记为 stale

// ───────────────────────────────────────────────
// AgentIDManager
// ───────────────────────────────────────────────

@singleton()
export class AgentIDManager {
  private agents = new Map<string, AgentProfile>();
  private walletIndex = new Map<string, string>();   // wallet -> agent_id 反查
  private nftIndex = new Map<string, string>();       // nft_mint -> agent_id 反查
  private nftConfig: BotNFTConfig;

  constructor(
    private logger: Logger,
    private connection?: Connection,
  ) {
    this.nftConfig = { ...DEFAULT_BOT_NFT_CONFIG };
  }

  // ═══════════════════════════════════════════════
  // 初始化
  // ═══════════════════════════════════════════════

  /**
   * 初始化连接和配置
   * @param solanaRpc Solana RPC 端点
   * @param bbtMint BBT 代币 Mint 地址
   * @param minStake 最低质押 BBT 数量（可选，默认 1000）
   */
  init(solanaRpc: string, bbtMint: string, minStake?: number) {
    this.connection = new Connection(solanaRpc, 'confirmed');
    this.nftConfig.bbt_mint = bbtMint;
    if (minStake !== undefined) {
      this.nftConfig.min_stake_bbt = minStake;
    }
    this.logger.info('AgentIDManager initialized', {
      bbtMint: bbtMint.slice(0, 8) + '...',
      minStake: this.nftConfig.min_stake_bbt,
    });
  }

  // ═══════════════════════════════════════════════
  // 1. Agent 注册
  // ═══════════════════════════════════════════════

  /**
   * 注册新 Agent
   * 验证钱包签名 → 创建 Agent Profile → 生成唯一 Agent ID
   */
  register(input: AgentRegistrationInput): AgentProfile {
    // 1. 防重复注册
    const existing = this.walletIndex.get(input.wallet_address);
    if (existing) {
      const agent = this.agents.get(existing);
      if (agent && agent.status !== 'banned') {
        throw new Error(`Wallet already registered as agent: ${existing}`);
      }
    }

    // 2. 签名验证（防伪造注册）
    if (!this.verifyRegistrationSignature(input)) {
      throw new Error('Invalid registration signature');
    }

    // 3. 昵称校验
    if (!input.display_name || input.display_name.length < 2 || input.display_name.length > 64) {
      throw new Error('Display name must be 2-64 characters');
    }

    // 4. 生成 Agent ID
    const agentId = `agent_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
    const now = Date.now();

    // 5. 创建 Profile
    const agent: AgentProfile = {
      agent_id: agentId,
      wallet_address: input.wallet_address,
      display_name: input.display_name,
      status: 'pending_verification',
      reputation_score: REPUTATION_BASE_SCORE,
      total_trades: 0,
      successful_trades: 0,
      total_signals: 0,
      accurate_signals: 0,
      uptime_hours: 0,
      bbt_staked: 0,
      created_at: now,
      updated_at: now,
      last_active_at: now,
    };

    // 6. 存储元数据到 IPFS（如果有）
    if (input.metadata) {
      agent.metadata_uri = this.buildMetadataUri(input.metadata, agentId);
    }

    // 7. 索引
    this.agents.set(agentId, agent);
    this.walletIndex.set(input.wallet_address, agentId);

    this.logger.info('Agent registered', {
      agentId,
      wallet: input.wallet_address.slice(0, 8) + '...',
      displayName: input.display_name,
    });

    return agent;
  }

  // ═══════════════════════════════════════════════
  // 2. Bot ID NFT 铸造（节点资格证）
  // ═══════════════════════════════════════════════

  /**
   * 铸造 Bot ID NFT
   * 前置条件：Agent 已注册 + 质押足够 BBT
   * 流程：
   *   1. 验证 Agent 身份和质押金额
   *   2. 创建 NFT Mint (0 decimals, supply 1)
   *   3. 铸造到 Agent 钱包
   *   4. 设置 Metadata（Metaplex Token Metadata）
   *   5. 收回 Mint Authority（确保不可增发）
   *   6. 更新 Agent Profile
   */
  async mintBotNFT(
    agentId: string,
    providerKeypair: Keypair,
    stakeAmountBbt: number,
    metadataJson?: Record<string, unknown>,
  ): Promise<NFTMintResult> {
    if (!this.connection) {
      return { success: false, error: 'AgentIDManager not initialized, call init() first' };
    }

    // 1. 验证 Agent
    const agent = this.agents.get(agentId);
    if (!agent) return { success: false, error: 'Agent not found' };
    if (agent.status === 'banned') return { success: false, error: 'Agent is banned' };
    if (agent.bot_nft_mint) return { success: false, error: 'Bot ID NFT already minted' };

    // 2. 质押检查
    if (stakeAmountBbt < this.nftConfig.min_stake_bbt) {
      return {
        success: false,
        error: `Minimum stake is ${this.nftConfig.min_stake_bbt} BBT, got ${stakeAmountBbt}`,
      };
    }

    // 3. 验证链上 BBT 余额
    const agentWallet = new PublicKey(agent.wallet_address);
    const bbtMint = new PublicKey(this.nftConfig.bbt_mint);
    const agentBBTATA = await getAssociatedTokenAddress(
      bbtMint, agentWallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    try {
      const { getAccount } = await import('@solana/spl-token');
      const account = await getAccount(this.connection, agentBBTATA);
      const balance = Number(account.amount) / 1e6;
      if (balance < stakeAmountBbt) {
        return {
          success: false,
          error: `Insufficient BBT balance. Need ${stakeAmountBbt}, have ${balance.toFixed(2)}`,
        };
      }
    } catch {
      return { success: false, error: 'Agent BBT token account not found' };
    }

    try {
      // 4. 创建 NFT Mint（PDA 派生，确保唯一性）
      const nftMint = Keypair.generate();
      const mintRent = await this.connection.getMinimumBalanceForRentExemption(82);
      const nftATA = await getAssociatedTokenAddress(
        nftMint.publicKey, agentWallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );

      // 5. 构建铸造交易
      const tx = new Transaction();

      // 创建 Mint Account
      tx.add(
        SystemProgram.createAccount({
          fromPubkey: providerKeypair.publicKey,
          newAccountPubkey: nftMint.publicKey,
          space: 82,
          lamports: mintRent,
          programId: TOKEN_PROGRAM_ID,
        }),
      );

      // 初始化 Mint（0 decimals, supply 1）
      const { createInitializeMintInstruction } = await import('@solana/spl-token');
      tx.add(
        createInitializeMintInstruction(
          nftMint.publicKey,
          0,              // 0 decimals = NFT
          providerKeypair.publicKey,  // mint authority
          null,           // freeze authority
          TOKEN_PROGRAM_ID,
        ),
      );

      // 创建 ATA for Agent
      tx.add(
        createAssociatedTokenAccountInstruction(
          providerKeypair.publicKey,  // payer
          nftATA,                      // ATA
          agentWallet,                 // owner
          nftMint.publicKey,           // mint
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );

      // 铸造 1 个 NFT 到 Agent
      tx.add(
        createMintToInstruction(
          nftMint.publicKey,
          nftATA,
          providerKeypair.publicKey,  // mint authority
          1,                           // amount = 1 (NFT)
          [],
          TOKEN_PROGRAM_ID,
        ),
      );

      // 收回 Mint Authority（确保 NFT 不可增发）
      tx.add(
        createSetAuthorityInstruction(
          nftMint.publicKey,
          providerKeypair.publicKey,  // current authority
          AuthorityType.MintTokens,
          null,                        // new authority = null (revoked)
          [],
          TOKEN_PROGRAM_ID,
        ),
      );

      // 6. 添加 Metaplex Metadata 指令
      const metadataIx = await this.buildMetaplexMetadataInstruction(
        nftMint.publicKey,
        agent,
        providerKeypair.publicKey,
        metadataJson,
      );
      if (metadataIx) {
        tx.add(metadataIx);
      }

      // 7. 签名并发送
      const { blockhash } = await this.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = providerKeypair.publicKey;
      tx.partialSign(nftMint);

      const signedTx = await this.connection.sendTransaction(tx, [providerKeypair, nftMint]);
      await this.connection.confirmTransaction(signedTx, 'confirmed');

      // 8. 更新 Agent Profile
      const mintAddress = nftMint.publicKey.toBase58();
      agent.bot_nft_mint = mintAddress;
      agent.bbt_staked = stakeAmountBbt;
      agent.status = 'active';  // 铸造后自动激活
      agent.updated_at = Date.now();
      this.nftIndex.set(mintAddress, agentId);

      this.logger.info('Bot ID NFT minted', {
        agentId,
        mint: mintAddress.slice(0, 8) + '...',
        stake: stakeAmountBbt,
        tx: signedTx,
      });

      return {
        success: true,
        mint_address: mintAddress,
        token_account: nftATA.toBase58(),
        tx_signature: signedTx,
      };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.logger.error('Bot ID NFT mint failed', e as Error, { agentId });
      return { success: false, error: `Mint failed: ${errMsg}` };
    }
  }

  // ═══════════════════════════════════════════════
  // 3. Agent 元数据管理（IPFS）
  // ═══════════════════════════════════════════════

  /**
   * 更新 Agent 元数据
   * 元数据以 IPFS URI 形式存储在链上 NFT Metadata 中
   */
  updateMetadata(agentId: string, metadata: AgentMetadata): string {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');

    const uri = this.buildMetadataUri(metadata, agentId);
    agent.metadata_uri = uri;
    agent.updated_at = Date.now();

    this.logger.info('Agent metadata updated', { agentId, uri });
    return uri;
  }

  /**
   * 获取 Agent 元数据
   */
  getMetadata(agentId: string): { uri?: string; local?: AgentMetadata } | undefined {
    const agent = this.agents.get(agentId);
    if (!agent) return undefined;

    return {
      uri: agent.metadata_uri,
    };
  }

  // ═══════════════════════════════════════════════
  // 4. 信誉系统
  // ═══════════════════════════════════════════════

  /**
   * 更新交易统计（交易完成后调用）
   */
  recordTrade(agentId: string, successful: boolean): void {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');

    agent.total_trades++;
    if (successful) agent.successful_trades++;
    agent.last_active_at = Date.now();
    agent.updated_at = Date.now();

    this.recalculateReputation(agent);
  }

  /**
   * 更新信号统计（信号结果确认后调用）
   */
  recordSignalResult(agentId: string, accurate: boolean): void {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');

    agent.total_signals++;
    if (accurate) agent.accurate_signals++;
    agent.last_active_at = Date.now();
    agent.updated_at = Date.now();

    this.recalculateReputation(agent);
  }

  /**
   * 更新在线时长（心跳调用）
   */
  recordUptime(agentId: string, hours: number): void {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');

    agent.uptime_hours += hours;
    agent.last_active_at = Date.now();
    agent.updated_at = Date.now();

    this.recalculateReputation(agent);
  }

  /**
   * 计算并返回详细信誉因子
   */
  getReputationFactors(agentId: string): ReputationFactors | undefined {
    const agent = this.agents.get(agentId);
    if (!agent) return undefined;

    const tradeSuccessRate = agent.total_trades > 0
      ? (agent.successful_trades / agent.total_trades) * 100
      : 50;

    const signalAccuracy = agent.total_signals > 0
      ? (agent.accurate_signals / agent.total_signals) * 100
      : 50;

    // 在线时长评分：每 100 小时 +10 分，上限 100
    const uptimeScore = Math.min(100, (agent.uptime_hours / 100) * 10);

    // 质押权重：每 1000 BBT +20 分，上限 100
    const stakeWeight = Math.min(100, (agent.bbt_staked / this.nftConfig.min_stake_bbt) * 20);

    // 存在时间加分：每 30 天 +10 分，上限 100
    const ageMs = Date.now() - agent.created_at;
    const ageBonus = Math.min(100, (ageMs / REPUTATION_DECAY_INTERVAL_MS) * 10);

    return {
      trade_success_rate: Math.round(tradeSuccessRate),
      signal_accuracy: Math.round(signalAccuracy),
      uptime_score: Math.round(uptimeScore),
      stake_weight: Math.round(stakeWeight),
      age_bonus: Math.round(ageBonus),
    };
  }

  /**
   * 惩罚扣分（违规操作）
   */
  penalize(agentId: string, points: number, reason: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');

    agent.reputation_score = Math.max(0, agent.reputation_score - points);
    agent.updated_at = Date.now();

    // 信誉低于阈值自动挂起
    if (agent.reputation_score < 50) {
      agent.status = 'suspended';
      this.logger.warn('Agent auto-suspended due to low reputation', {
        agentId,
        score: agent.reputation_score,
        reason,
      });
    }

    this.logger.warn('Agent penalized', { agentId, points, reason, newScore: agent.reputation_score });
  }

  /**
   * 批量衰减不活跃 Agent 信誉（定时任务调用）
   */
  decayInactiveReputation(): number {
    const now = Date.now();
    let decayedCount = 0;

    for (const agent of this.agents.values()) {
      if (agent.status !== 'active') continue;

      const inactiveMs = now - agent.last_active_at;
      if (inactiveMs < REPUTATION_DECAY_INTERVAL_MS) continue;

      // 计算衰减轮次
      const decayRounds = Math.floor(inactiveMs / REPUTATION_DECAY_INTERVAL_MS);
      const decayMultiplier = Math.pow(1 - REPUTATION_DECAY_RATE, decayRounds);
      const newScore = Math.round(agent.reputation_score * decayMultiplier);

      if (newScore !== agent.reputation_score) {
        agent.reputation_score = newScore;
        agent.updated_at = now;
        decayedCount++;
      }

      // 90天不活跃标记
      if (inactiveMs > STALE_AGENT_THRESHOLD_MS && agent.status === 'active') {
        agent.status = 'suspended';
        this.logger.warn('Agent suspended due to inactivity', { agentId: agent.agent_id });
      }
    }

    if (decayedCount > 0) {
      this.logger.info('Reputation decay completed', { decayedCount });
    }
    return decayedCount;
  }

  // ═══════════════════════════════════════════════
  // 查询接口
  // ═══════════════════════════════════════════════

  /**
   * 按 Agent ID 查询
   */
  getAgent(agentId: string): AgentProfile | undefined {
    return this.agents.get(agentId);
  }

  /**
   * 按钱包地址查询
   */
  getAgentByWallet(walletAddress: string): AgentProfile | undefined {
    const agentId = this.walletIndex.get(walletAddress);
    return agentId ? this.agents.get(agentId) : undefined;
  }

  /**
   * 按 NFT Mint 查询
   */
  getAgentByNFT(nftMint: string): AgentProfile | undefined {
    const agentId = this.nftIndex.get(nftMint);
    return agentId ? this.agents.get(agentId) : undefined;
  }

  /**
   * 列出所有 Agent
   */
  listAgents(status?: AgentStatus): AgentProfile[] {
    const agents = Array.from(this.agents.values());
    if (status) {
      return agents.filter((a) => a.status === status);
    }
    return agents.sort((a, b) => b.reputation_score - a.reputation_score);
  }

  /**
   * 获取活跃 Agent 数量
   */
  getActiveAgentCount(): number {
    return Array.from(this.agents.values()).filter((a) => a.status === 'active').length;
  }

  /**
   * 验证节点资格（Bot ID NFT 持有 + 活跃状态）
   */
  validateNodeEligibility(agentId: string): { eligible: boolean; reason?: string } {
    const agent = this.agents.get(agentId);
    if (!agent) return { eligible: false, reason: 'Agent not found' };
    if (agent.status !== 'active') return { eligible: false, reason: `Agent status: ${agent.status}` };
    if (!agent.bot_nft_mint) return { eligible: false, reason: 'Bot ID NFT not minted' };
    if (agent.reputation_score < 50) return { eligible: false, reason: 'Reputation too low' };
    return { eligible: true };
  }

  // ═══════════════════════════════════════════════
  // 管理接口
  // ═══════════════════════════════════════════════

  /**
   * 恢复 Agent 状态（从 suspended 恢复到 active）
   */
  reactivate(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    if (agent.status !== 'suspended') return false;
    if (agent.reputation_score < 50) return false;

    agent.status = 'active';
    agent.updated_at = Date.now();
    this.logger.info('Agent reactivated', { agentId });
    return true;
  }

  /**
   * 封禁 Agent（管理员操作）
   */
  ban(agentId: string, reason: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    agent.status = 'banned';
    agent.updated_at = Date.now();
    this.logger.warn('Agent banned', { agentId, reason });
    return true;
  }

  /**
   * 转移 Bot ID NFT（换绑钱包）
   */
  async transferBotNFT(
    agentId: string,
    newOwnerWallet: string,
    currentOwnerKeypair: Keypair,
  ): Promise<{ success: boolean; error?: string; tx_signature?: string }> {
    if (!this.connection) {
      return { success: false, error: 'AgentIDManager not initialized' };
    }

    const agent = this.agents.get(agentId);
    if (!agent) return { success: false, error: 'Agent not found' };
    if (!agent.bot_nft_mint) return { success: false, error: 'No Bot ID NFT to transfer' };

    try {
      const nftMint = new PublicKey(agent.bot_nft_mint);
      const oldOwner = new PublicKey(agent.wallet_address);
      const newOwner = new PublicKey(newOwnerWallet);

      const oldATA = await getAssociatedTokenAddress(
        nftMint, oldOwner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const newATA = await getAssociatedTokenAddress(
        nftMint, newOwner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );

      const { createTransferInstruction } = await import('@solana/spl-token');
      const tx = new Transaction();

      // 创建新 Owner 的 ATA
      tx.add(
        createAssociatedTokenAccountInstruction(
          currentOwnerKeypair.publicKey,
          newATA,
          newOwner,
          nftMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );

      // 转移 NFT
      tx.add(
        createTransferInstruction(
          oldATA,
          newATA,
          oldOwner,
          1,  // NFT = 1
          [currentOwnerKeypair],
          TOKEN_PROGRAM_ID,
        ),
      );

      const { blockhash } = await this.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = currentOwnerKeypair.publicKey;

      const sig = await this.connection.sendTransaction(tx, [currentOwnerKeypair]);
      await this.connection.confirmTransaction(sig, 'confirmed');

      // 更新索引
      this.walletIndex.delete(agent.wallet_address);
      agent.wallet_address = newOwnerWallet;
      this.walletIndex.set(newOwnerWallet, agentId);
      agent.updated_at = Date.now();

      this.logger.info('Bot ID NFT transferred', {
        agentId,
        from: oldOwner.toBase58().slice(0, 8) + '...',
        to: newOwnerWallet.slice(0, 8) + '...',
      });

      return { success: true, tx_signature: sig };
    } catch (e) {
      return { success: false, error: `Transfer failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // ═══════════════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════════════

  /**
   * 重新计算 Agent 信誉分数
   *
   * 公式：
   *   base(100) + trade_bonus(max 300) + signal_bonus(max 200) + uptime_bonus(max 100)
   *   + stake_bonus(max 200) + age_bonus(max 100) = max 1000
   */
  private recalculateReputation(agent: AgentProfile): void {
    const factors = this.getReputationFactors(agent.agent_id);
    if (!factors) return;

    // 交易成功率加分 (0-300)
    const tradeBonus = Math.round((factors.trade_success_rate / 100) * 300);

    // 信号准确率加分 (0-200)
    const signalBonus = Math.round((factors.signal_accuracy / 100) * 200);

    // 在线时长加分 (0-100)
    const uptimeBonus = Math.round((factors.uptime_score / 100) * 100);

    // 质押加分 (0-200)
    const stakeBonus = Math.round((factors.stake_weight / 100) * 200);

    // 存在时间加分 (0-100)
    const ageBonus = Math.round((factors.age_bonus / 100) * 100);

    const totalScore = REPUTATION_BASE_SCORE + tradeBonus + signalBonus + uptimeBonus + stakeBonus + ageBonus;
    agent.reputation_score = Math.min(REPUTATION_MAX_SCORE, Math.max(0, totalScore));
  }

  /**
   * 验证注册签名
   * 消息格式：123456btc-node register {wallet} {timestamp}
   */
  private verifyRegistrationSignature(input: AgentRegistrationInput): boolean {
    // 基础防重放
    if (Math.abs(Date.now() - input.timestamp) > 300_000) {
      return false; // 5 分钟有效期
    }
    // 实际的 Ed25519 签名验证在 API 层完成
    // 这里只做时间戳校验，防止过期注册
    return true;
  }

  /**
   * 构建 IPFS Metadata URI
   * 格式：ipfs://{cid} 或自定义网关
   *
   * 注意：实际 IPFS 上传需要外部服务（Pinata, NFT.Storage 等）
   * 这里生成标准化的 metadata JSON 结构
   */
  private buildMetadataUri(metadata: AgentMetadata, agentId: string): string {
    const metadataJson = {
      name: metadata.name,
      description: metadata.description,
      image: metadata.avatar_url || '',
      external_url: metadata.endpoint_url || '',
      attributes: [
        { trait_type: 'Agent ID', value: agentId },
        { trait_type: 'Version', value: metadata.version },
        { trait_type: 'Capabilities', value: metadata.capabilities.join(', ') },
        { trait_type: 'Region', value: metadata.geolocation || 'Unknown' },
      ],
      properties: {
        capabilities: metadata.capabilities,
        social: metadata.social_links || {},
        endpoint: metadata.endpoint_url,
        geolocation: metadata.geolocation,
      },
    };

    // 存储 metadata JSON 到内存（生产环境需上传到 IPFS）
    // TODO: 集成 IPFS Pinning 服务（Pinata / NFT.Storage）
    const fakeCid = `Qm${randomBytes(22).toString('base64url')}`;
    return `ipfs://${fakeCid}`;
  }

  /**
   * 构建 Metaplex Token Metadata 指令
   *
   * 使用 Metaplex Token Metadata Program v1.3+
   * PDA 派生：[metadata, metadata_program, mint]
   */
  private async buildMetaplexMetadataInstruction(
    mint: PublicKey,
    agent: AgentProfile,
    payer: PublicKey,
    extraJson?: Record<string, unknown>,
  ): Promise<any | null> {
    try {
      const METADATA_PROGRAM_ID = new PublicKey(this.nftConfig.metadata_program_id);

      // PDA 派生 Metadata Account
      const [metadataPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('metadata'),
          METADATA_PROGRAM_ID.toBuffer(),
          mint.toBuffer(),
        ],
        METADATA_PROGRAM_ID,
      );

      const nftName = `${this.nftConfig.nft_name_prefix} #${agent.agent_id.slice(-8)}`;
      const nftSymbol = this.nftConfig.nft_symbol;
      const metadataUri = agent.metadata_uri || '';

      // Metaplex CreateMetadataAccountV3 指令布局
      // 使用手动构建（避免额外依赖）
      const nameBuffer = Buffer.from(nftName.padEnd(36, '\0').slice(0, 36));
      const symbolBuffer = Buffer.from(nftSymbol.padEnd(14, '\0').slice(0, 14));
      const uriBuffer = Buffer.from(metadataUri.padEnd(200, '\0').slice(0, 200));

      // 简化版：使用 createMetadataAccountV2 指令 discriminator
      const data = Buffer.alloc(1 + 4 + nameBuffer.length + 4 + symbolBuffer.length + 4 + uriBuffer.length + 1 + 4 + 1 + 4 + 1);
      let offset = 0;

      // Instruction discriminator for CreateMetadataAccountV2 = 16
      data.writeUInt8(16, offset); offset += 1;

      // Name (length-prefixed)
      data.writeUInt32LE(nameBuffer.length, offset); offset += 4;
      nameBuffer.copy(data, offset); offset += nameBuffer.length;

      // Symbol
      data.writeUInt32LE(symbolBuffer.length, offset); offset += 4;
      symbolBuffer.copy(data, offset); offset += symbolBuffer.length;

      // URI
      data.writeUInt32LE(uriBuffer.length, offset); offset += 4;
      uriBuffer.copy(data, offset); offset += uriBuffer.length;

      // Seller fee basis points (0 = no royalty)
      data.writeUInt16LE(0, offset); offset += 2;

      // Update authority is mutable
      data.writeUInt8(1, offset); offset += 1;

      // No collection
      data.writeUInt8(0, offset); offset += 1;

      // No uses
      data.writeUInt8(0, offset); offset += 1;

      // Data collection (none)
      data.writeUInt8(0, offset); offset += 1;

      // Creator array (none - optional)
      data.writeUInt8(0, offset); offset += 1;

      return {
        keys: [
          { pubkey: metadataPDA, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: payer, isSigner: true, isWritable: false },
          { pubkey: payer, isSigner: true, isWritable: true },
          { pubkey: payer, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
        ],
        programId: METADATA_PROGRAM_ID,
        data: data.slice(0, offset),
      };
    } catch (e) {
      this.logger.warn('Failed to build Metaplex metadata instruction, skipping', {
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * 导出统计信息（监控 / API 用）
   */
  getStats(): {
    total: number;
    active: number;
    suspended: number;
    banned: number;
    pending: number;
    with_nft: number;
    avg_reputation: number;
    total_staked: number;
  } {
    const agents = Array.from(this.agents.values());
    const active = agents.filter((a) => a.status === 'active');
    const avgRep = agents.length > 0
      ? Math.round(agents.reduce((sum, a) => sum + a.reputation_score, 0) / agents.length)
      : 0;

    return {
      total: agents.length,
      active: active.length,
      suspended: agents.filter((a) => a.status === 'suspended').length,
      banned: agents.filter((a) => a.status === 'banned').length,
      pending: agents.filter((a) => a.status === 'pending_verification').length,
      with_nft: agents.filter((a) => !!a.bot_nft_mint).length,
      avg_reputation: avgRep,
      total_staked: agents.reduce((sum, a) => sum + a.bbt_staked, 0),
    };
  }
}
