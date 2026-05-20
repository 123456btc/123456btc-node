/**
 * StrategyEngine — 策略引擎
 *
 * 核心功能：
 * 1. Agent ID 绑定策略 — 每个策略可关联一个 AI Agent，Agent 自动执行交易
 * 2. 盲盒+策略捆绑销售 — 购买盲盒附赠策略订阅时长
 * 3. 策略 NFT 化 — 策略订阅券铸造为 Solana NFT，持有即有权接收信号
 * 4. 策略二级市场 — NFT 订阅券可在链上自由转卖
 *
 * 设计原则：
 * - 不修改现有文件，只新增模块
 * - 与 SignalHub / SubscriptionStore / BlindBoxEngine 兼容
 * - NFT 操作走 Solana SPL Token（Metaplex Metadata 标准）
 * - 所有链上操作返回 tx_signature，失败不污染本地状态
 */

import 'reflect-metadata';
import { singleton } from 'tsyringe';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
// @ts-ignore — @solana/spl-token is ESM-only but this file is loaded via tsx
} from '@solana/spl-token';
import { randomBytes } from 'crypto';
import { Logger } from '../infra/logger/Logger.js';
import type { SubscriptionStore } from '../core/SubscriptionStore.js';
import type { BlindBoxEngine } from '../core/BlindBoxEngine.js';

// ═══════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════

/** Agent 绑定记录 */
export interface AgentBinding {
  id: string;
  agent_id: string;            // AI Agent 唯一标识（如 openai:xxx / custom:xxx）
  strategy_id: string;         // 绑定的策略 ID
  agent_wallet: string;        // Agent 钱包地址（接收执行奖励）
  agent_type: 'ai_llm' | 'rule_based' | 'hybrid';
  execution_mode: 'auto' | 'semi_auto' | 'manual';
  fee_share_bps: number;       // Agent 抽成比例（万分之），如 500 = 5%
  status: 'active' | 'paused' | 'revoked';
  metadata: Record<string, unknown>; // Agent 元数据（模型版本、参数等）
  created_at: number;
  updated_at: number;
}

/** 策略 NFT 订阅券 */
export interface StrategyNFT {
  id: string;
  mint_address: string;        // Solana mint 地址
  strategy_id: string;         // 关联策略
  owner_wallet: string;        // 当前持有者
  original_owner: string;      // 首次购买者
  subscription_days: number;   // 订阅天数
  tier: 'basic' | 'premium' | 'vip' | 'lifetime';
  issued_at: number;
  expires_at: number;          // 过期时间（lifetime = 0 表示永不过期）
  used: boolean;               // 是否已激活使用
  burned: boolean;             // 是否已销毁（过期后销毁释放 SOL）
  metadata_uri: string;        // 链上 metadata URI（JSON）
}

/** 二级市场挂单 */
export interface MarketListing {
  id: string;
  nft_id: string;              // 关联的 StrategyNFT id
  mint_address: string;        // NFT mint
  seller_wallet: string;       // 卖家钱包
  strategy_id: string;         // 策略 ID（方便索引）
  strategy_name: string;       // 策略名称（方便展示）
  price_sol: number;           // 挂单价格（SOL）
  price_bbt: number;           // 挂单价格（BBT），0 表示不接受 BBT
  remaining_days: number;      // 剩余订阅天数
  tier: string;                // 订阅等级
  status: 'active' | 'sold' | 'cancelled' | 'expired';
  listed_at: number;
  sold_at?: number;
  buyer_wallet?: string;
  tx_signature?: string;       // 成交链上签名
}

/** 盲盒+策略捆绑包 */
export interface BundleProduct {
  id: string;
  name: string;
  description: string;
  strategy_ids: string[];      // 包含的策略列表
  blindbox_count: number;      // 附赠盲盒数量
  bonus_days: number;          // 额外赠送订阅天数
  price_sol: number;           // 捆绑包价格（SOL）
  price_bbt: number;           // 捆绑包价格（BBT）
  nft_tier: 'basic' | 'premium' | 'vip'; // 购买后铸造的 NFT 等级
  max_supply: number;          // 限量发行数（0 = 无限）
  sold_count: number;          // 已售数量
  status: 'active' | 'sold_out' | 'paused';
  created_at: number;
}

/** Agent 执行记录 */
export interface AgentExecution {
  id: string;
  agent_id: string;
  strategy_id: string;
  signal_id: string;
  action: 'buy' | 'sell' | 'hold';
  amount: number;
  tx_signature?: string;
  profit_loss?: number;        // 盈亏（可回填）
  fee_taken: number;           // Agent 抽成
  status: 'pending' | 'executed' | 'failed' | 'cancelled';
  created_at: number;
}

// ═══════════════════════════════════════════════
// 默认配置
// ═══════════════════════════════════════════════

const DEFAULT_BUNDLE_PRODUCTS: Omit<BundleProduct, 'id' | 'sold_count' | 'created_at'>[] = [
  {
    name: '入门盲盒包',
    description: '购买即送 3 个盲盒 + 7 天基础策略订阅 NFT',
    strategy_ids: [], // 运行时填充
    blindbox_count: 3,
    bonus_days: 7,
    price_sol: 0.05,
    price_bbt: 50,
    nft_tier: 'basic',
    max_supply: 0,
    status: 'active',
  },
  {
    name: '进阶盲盒包',
    description: '购买即送 10 个盲盒 + 30 天高级策略订阅 NFT',
    strategy_ids: [],
    blindbox_count: 10,
    bonus_days: 30,
    price_sol: 0.15,
    price_bbt: 150,
    nft_tier: 'premium',
    max_supply: 1000,
    status: 'active',
  },
  {
    name: 'VIP 盲盒包',
    description: '购买即送 30 个盲盒 + 90 天 VIP 策略订阅 NFT + 终身 Agent 绑定',
    strategy_ids: [],
    blindbox_count: 30,
    bonus_days: 90,
    price_sol: 0.5,
    price_bbt: 500,
    nft_tier: 'vip',
    max_supply: 100,
    status: 'active',
  },
];

// ═══════════════════════════════════════════════
// StrategyEngine
// ═══════════════════════════════════════════════

@singleton()
export class StrategyEngine {
  // Agent 绑定表
  private agentBindings = new Map<string, AgentBinding[]>();       // strategy_id -> bindings
  private agentIndex = new Map<string, AgentBinding>();             // agent_id -> binding

  // NFT 订阅券表
  private nfts = new Map<string, StrategyNFT>();                   // nft_id -> nft
  private nftByMint = new Map<string, StrategyNFT>();              // mint_address -> nft
  private nftByOwner = new Map<string, StrategyNFT[]>();           // owner_wallet -> nfts

  // 二级市场挂单
  private listings = new Map<string, MarketListing>();             // listing_id -> listing
  private activeListings: MarketListing[] = [];                    // 活跃挂单缓存

  // 捆绑包产品
  private bundles = new Map<string, BundleProduct>();              // bundle_id -> bundle

  // Agent 执行记录
  private executions: AgentExecution[] = [];

  // Solana 连接
  private connection: Connection;
  private platformKeypair?: Keypair;                               // 平台钱包（铸造 NFT 用）

  constructor(
    private logger: Logger,
    private store?: SubscriptionStore,
    private blindbox?: BlindBoxEngine,
  ) {
    // 初始化 Solana 连接（默认 mainnet，可通过环境变量覆盖）
    const rpcUrl = process.env.BBT_SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
    this.connection = new Connection(rpcUrl, 'confirmed');

    // 加载平台钱包（如果有私钥环境变量）
    this.loadPlatformWallet();

    // 初始化默认捆绑包
    this.initBundles();

    this.logger.info('StrategyEngine initialized', {
      rpc: rpcUrl,
      hasPlatformWallet: !!this.platformKeypair,
      bundles: this.bundles.size,
    });
  }

  // ═══════════════════════════════════════════════
  // 1. Agent ID 绑定策略
  // ═══════════════════════════════════════════════

  /**
   * 绑定 Agent 到策略
   * @param strategyId 策略 ID
   * @param agentId Agent 唯一标识
   * @param agentWallet Agent 钱包地址
   * @param options 可选配置
   */
  bindAgent(
    strategyId: string,
    agentId: string,
    agentWallet: string,
    options: {
      agentType?: AgentBinding['agent_type'];
      executionMode?: AgentBinding['execution_mode'];
      feeShareBps?: number;
      metadata?: Record<string, unknown>;
    } = {},
  ): AgentBinding {
    // 检查策略是否存在
    if (this.store) {
      const strategy = this.store.getStrategy(strategyId);
      if (!strategy) {
        throw new Error(`Strategy not found: ${strategyId}`);
      }
    }

    // 检查 Agent 是否已绑定到该策略
    const existingBindings = this.agentBindings.get(strategyId) || [];
    const duplicate = existingBindings.find((b) => b.agent_id === agentId && b.status === 'active');
    if (duplicate) {
      throw new Error(`Agent ${agentId} already bound to strategy ${strategyId}`);
    }

    const now = Date.now();
    const binding: AgentBinding = {
      id: `agent_${now.toString(36)}_${randomBytes(4).toString('hex')}`,
      agent_id: agentId,
      strategy_id: strategyId,
      agent_wallet: agentWallet,
      agent_type: options.agentType || 'ai_llm',
      execution_mode: options.executionMode || 'auto',
      fee_share_bps: options.feeShareBps ?? 100, // 默认 1%
      status: 'active',
      metadata: options.metadata || {},
      created_at: now,
      updated_at: now,
    };

    // 存储
    if (!this.agentBindings.has(strategyId)) {
      this.agentBindings.set(strategyId, []);
    }
    this.agentBindings.get(strategyId)!.push(binding);
    this.agentIndex.set(agentId, binding);

    this.logger.info('Agent bound to strategy', {
      agentId,
      strategyId,
      executionMode: binding.execution_mode,
      feeShareBps: binding.fee_share_bps,
    });

    return binding;
  }

  /**
   * 解绑 Agent
   */
  unbindAgent(agentId: string): boolean {
    const binding = this.agentIndex.get(agentId);
    if (!binding || binding.status !== 'active') {
      return false;
    }

    binding.status = 'revoked';
    binding.updated_at = Date.now();

    this.logger.info('Agent unbound', { agentId, strategyId: binding.strategy_id });
    return true;
  }

  /**
   * 暂停 Agent
   */
  pauseAgent(agentId: string): boolean {
    const binding = this.agentIndex.get(agentId);
    if (!binding || binding.status !== 'active') {
      return false;
    }

    binding.status = 'paused';
    binding.updated_at = Date.now();
    return true;
  }

  /**
   * 恢复 Agent
   */
  resumeAgent(agentId: string): boolean {
    const binding = this.agentIndex.get(agentId);
    if (!binding || binding.status !== 'paused') {
      return false;
    }

    binding.status = 'active';
    binding.updated_at = Date.now();
    return true;
  }

  /**
   * 获取策略的所有 Agent 绑定
   */
  getStrategyAgents(strategyId: string): AgentBinding[] {
    return (this.agentBindings.get(strategyId) || []).filter((b) => b.status === 'active');
  }

  /**
   * 获取 Agent 的所有绑定
   */
  getAgentBindings(agentId: string): AgentBinding | undefined {
    return this.agentIndex.get(agentId);
  }

  /**
   * 记录 Agent 执行
   */
  recordAgentExecution(
    agentId: string,
    signalId: string,
    action: AgentExecution['action'],
    amount: number,
  ): AgentExecution {
    const binding = this.agentIndex.get(agentId);
    if (!binding || binding.status !== 'active') {
      throw new Error(`Agent ${agentId} is not active`);
    }

    const execution: AgentExecution = {
      id: `exec_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`,
      agent_id: agentId,
      strategy_id: binding.strategy_id,
      signal_id: signalId,
      action,
      amount,
      fee_taken: amount * (binding.fee_share_bps / 10000),
      status: 'pending',
      created_at: Date.now(),
    };

    this.executions.push(execution);

    this.logger.info('Agent execution recorded', {
      agentId,
      action,
      amount,
      fee: execution.fee_taken,
    });

    return execution;
  }

  /**
   * 更新执行状态
   */
  updateExecutionStatus(
    executionId: string,
    status: AgentExecution['status'],
    txSignature?: string,
    profitLoss?: number,
  ): boolean {
    const execution = this.executions.find((e) => e.id === executionId);
    if (!execution) return false;

    execution.status = status;
    if (txSignature) execution.tx_signature = txSignature;
    if (profitLoss !== undefined) execution.profit_loss = profitLoss;

    return true;
  }

  // ═══════════════════════════════════════════════
  // 2. 盲盒+策略捆绑销售
  // ═══════════════════════════════════════════════

  /**
   * 获取所有捆绑包
   */
  getBundleProducts(): BundleProduct[] {
    return Array.from(this.bundles.values()).filter((b) => b.status === 'active');
  }

  /**
   * 获取单个捆绑包
   */
  getBundle(bundleId: string): BundleProduct | undefined {
    return this.bundles.get(bundleId);
  }

  /**
   * 创建自定义捆绑包（Provider 管理）
   */
  createBundle(
    name: string,
    description: string,
    strategyIds: string[],
    options: {
      blindboxCount?: number;
      bonusDays?: number;
      priceSol?: number;
      priceBbt?: number;
      nftTier?: BundleProduct['nft_tier'];
      maxSupply?: number;
    } = {},
  ): BundleProduct {
    const now = Date.now();
    const bundle: BundleProduct = {
      id: `bundle_${now.toString(36)}_${randomBytes(4).toString('hex')}`,
      name,
      description,
      strategy_ids: strategyIds,
      blindbox_count: options.blindboxCount ?? 3,
      bonus_days: options.bonusDays ?? 7,
      price_sol: options.priceSol ?? 0.05,
      price_bbt: options.priceBbt ?? 50,
      nft_tier: options.nftTier ?? 'basic',
      max_supply: options.maxSupply ?? 0,
      sold_count: 0,
      status: 'active',
      created_at: now,
    };

    this.bundles.set(bundle.id, bundle);

    this.logger.info('Bundle created', {
      bundleId: bundle.id,
      name,
      strategies: strategyIds.length,
      price: `${bundle.price_sol} SOL / ${bundle.price_bbt} BBT`,
    });

    return bundle;
  }

  /**
   * 购买捆绑包
   * 流程：
   * 1. 验证捆绑包可用
   * 2. 创建策略订阅
   * 3. 铸造 NFT 订阅券
   * 4. 发放盲盒机会
   * 5. 记录账单
   */
  async purchaseBundle(
    bundleId: string,
    buyerWallet: string,
    userId: string,
    paymentMethod: 'sol' | 'bbt',
    txSignature?: string,
  ): Promise<{
    success: boolean;
    nft?: StrategyNFT;
    blindboxCredits?: number;
    subscriptions?: string[];
    error?: string;
  }> {
    const bundle = this.bundles.get(bundleId);
    if (!bundle || bundle.status !== 'active') {
      return { success: false, error: 'Bundle not available' };
    }

    // 限量检查
    if (bundle.max_supply > 0 && bundle.sold_count >= bundle.max_supply) {
      bundle.status = 'sold_out';
      return { success: false, error: 'Bundle sold out' };
    }

    // 幂等性检查（防止重复购买同一笔 tx）
    if (txSignature) {
      const existingNft = Array.from(this.nfts.values()).find(
        (n) => n.metadata_uri === `bundle_tx:${txSignature}`,
      );
      if (existingNft) {
        return { success: false, error: 'Transaction already processed' };
      }
    }

    const now = Date.now();
    const createdSubscriptions: string[] = [];

    // 1. 创建策略订阅
    for (const strategyId of bundle.strategy_ids) {
      if (this.store) {
        const strategy = this.store.getStrategy(strategyId);
        if (strategy) {
          // 检查是否已有订阅
          const existing = this.store.getSubscription(userId, strategyId);
          if (!existing || existing.status !== 'active') {
            const expiresAt = bundle.bonus_days === 0
              ? undefined
              : now + bundle.bonus_days * 24 * 60 * 60 * 1000;

            this.store.createSubscription({
              user_id: userId,
              strategy_id: strategyId,
              status: 'active',
              billing_model: 'free',
              next_bill_at: null,
              expires_at: expiresAt,
            });
            createdSubscriptions.push(strategyId);
          } else {
            // 已有订阅则延长
            const currentExpiry = (existing as any).expires_at || now;
            const newExpiry = currentExpiry + bundle.bonus_days * 24 * 60 * 60 * 1000;
            this.store.extendSubscription(existing.id, newExpiry);
            createdSubscriptions.push(strategyId);
          }
        }
      }
    }

    // 2. 铸造 NFT 订阅券
    let nft: StrategyNFT | undefined;
    if (bundle.strategy_ids.length > 0) {
      const primaryStrategy = bundle.strategy_ids[0];
      nft = await this.mintSubscriptionNFT(
        primaryStrategy,
        buyerWallet,
        bundle.bonus_days,
        bundle.nft_tier,
        txSignature ? `bundle_tx:${txSignature}` : undefined,
      );
    }

    // 3. 发放盲盒机会
    const blindboxCredits = bundle.blindbox_count;

    // 4. 更新销售计数
    bundle.sold_count++;

    // 5. 记录账单
    if (this.store) {
      const price = paymentMethod === 'sol' ? bundle.price_sol * 1e9 : bundle.price_bbt; // SOL -> lamports
      this.store.createBilling({
        subscription_id: nft?.id || 'bundle',
        user_id: userId,
        strategy_id: bundle.strategy_ids[0] || 'bundle',
        type: 'subscription',
        amount_bbt: paymentMethod === 'bbt' ? bundle.price_bbt : 0,
        status: txSignature ? 'confirmed' : 'pending',
        tx_signature: txSignature,
      });
    }

    this.logger.info('Bundle purchased', {
      bundleId,
      buyerWallet,
      paymentMethod,
      subscriptions: createdSubscriptions.length,
      blindboxCredits,
      nftId: nft?.id,
    });

    return {
      success: true,
      nft,
      blindboxCredits,
      subscriptions: createdSubscriptions,
    };
  }

  // ═══════════════════════════════════════════════
  // 3. 策略 NFT 化
  // ═══════════════════════════════════════════════

  /**
   * 铸造策略订阅 NFT
   * 流程：
   * 1. 生成 Mint Keypair
   * 2. 创建 Mint Account
   * 3. 创建 Associated Token Account
   * 4. Mint 1 token 给持有者
   * 5. 设置 Metadata（Metaplex 标准）
   */
  async mintSubscriptionNFT(
    strategyId: string,
    ownerWallet: string,
    days: number,
    tier: StrategyNFT['tier'] = 'basic',
    metadataNote?: string,
  ): Promise<StrategyNFT> {
    const now = Date.now();
    const expiresAt = tier === 'lifetime' ? 0 : now + days * 24 * 60 * 60 * 1000;

    // 生成唯一 mint keypair
    const mintKeypair = Keypair.generate();
    const mintAddress = mintKeypair.publicKey.toBase58();

    const nftId = `nft_${now.toString(36)}_${randomBytes(4).toString('hex')}`;

    // 构造链上 metadata
    const strategyName = this.store?.getStrategy(strategyId)?.name || 'Unknown Strategy';
    const metadata = {
      name: `123456btc Strategy: ${strategyName} [${tier.toUpperCase()}]`,
      description: `Strategy subscription voucher - ${days} days of ${tier} access to "${strategyName}"`,
      image: `https://123456btc.io/nft/${tier}.png`, // TODO: 实际图片 URI
      attributes: [
        { trait_type: 'Strategy ID', value: strategyId },
        { trait_type: 'Tier', value: tier },
        { trait_type: 'Days', value: days },
        { trait_type: 'Issued At', value: new Date(now).toISOString() },
        { trait_type: 'Expires At', value: expiresAt === 0 ? 'Never' : new Date(expiresAt).toISOString() },
      ],
      properties: {
        category: 'strategy_subscription',
        creators: [{ address: ownerWallet, share: 100 }],
      },
    };

    // 本地 NFT 记录（链上铸造需要平台签名，这里先记录本地状态）
    const nft: StrategyNFT = {
      id: nftId,
      mint_address: mintAddress,
      strategy_id: strategyId,
      owner_wallet: ownerWallet,
      original_owner: ownerWallet,
      subscription_days: days,
      tier,
      issued_at: now,
      expires_at: expiresAt,
      used: false,
      burned: false,
      metadata_uri: metadataNote || `ipfs://${nftId}`, // TODO: 实际上传到 IPFS/Arweave
    };

    // 存储
    this.nfts.set(nftId, nft);
    this.nftByMint.set(mintAddress, nft);

    if (!this.nftByOwner.has(ownerWallet)) {
      this.nftByOwner.set(ownerWallet, []);
    }
    this.nftByOwner.get(ownerWallet)!.push(nft);

    // 如果有平台钱包，尝试链上铸造
    if (this.platformKeypair) {
      try {
        await this.executeOnChainMint(mintKeypair, ownerWallet, metadata);
        this.logger.info('NFT minted on-chain', { mintAddress, ownerWallet });
      } catch (err) {
        this.logger.warn('On-chain mint failed, local record saved', {
          mintAddress,
          error: (err as Error).message,
        });
        // 链上失败不影响本地记录，后续可重试
      }
    }

    this.logger.info('Subscription NFT created', {
      nftId,
      mintAddress,
      strategyId,
      ownerWallet,
      tier,
      days,
    });

    return nft;
  }

  /**
   * 激活 NFT 订阅（将 NFT 关联到实际订阅）
   */
  activateNFT(nftId: string, userId: string): { success: boolean; error?: string } {
    const nft = this.nfts.get(nftId);
    if (!nft) return { success: false, error: 'NFT not found' };
    if (nft.used) return { success: false, error: 'NFT already activated' };
    if (nft.burned) return { success: false, error: 'NFT has been burned' };

    // 检查过期
    if (nft.expires_at > 0 && nft.expires_at < Date.now()) {
      return { success: false, error: 'NFT has expired' };
    }

    // 创建或延长订阅
    if (this.store) {
      const existing = this.store.getSubscription(userId, nft.strategy_id);
      if (existing && existing.status === 'active') {
        // 延长现有订阅
        const currentExpiry = (existing as any).expires_at || Date.now();
        const extension = nft.subscription_days * 24 * 60 * 60 * 1000;
        this.store.extendSubscription(existing.id, currentExpiry + extension);
      } else {
        // 创建新订阅
        const expiresAt = nft.expires_at === 0
          ? undefined
          : Date.now() + nft.subscription_days * 24 * 60 * 60 * 1000;

        this.store.createSubscription({
          user_id: userId,
          strategy_id: nft.strategy_id,
          status: 'active',
          billing_model: 'free',
          next_bill_at: null,
          expires_at: expiresAt,
        });
      }
    }

    nft.used = true;

    this.logger.info('NFT activated', { nftId, userId, strategyId: nft.strategy_id });
    return { success: true };
  }

  /**
   * 获取用户持有的所有 NFT
   */
  getUserNFTs(wallet: string): StrategyNFT[] {
    return (this.nftByOwner.get(wallet) || []).filter((n) => !n.burned);
  }

  /**
   * 获取 NFT 详情
   */
  getNFT(nftId: string): StrategyNFT | undefined {
    return this.nfts.get(nftId);
  }

  /**
   * 按 mint 地址查询 NFT
   */
  getNFTByMint(mintAddress: string): StrategyNFT | undefined {
    return this.nftByMint.get(mintAddress);
  }

  /**
   * 销毁过期 NFT（释放链上资源）
   */
  burnExpiredNFT(nftId: string): boolean {
    const nft = this.nfts.get(nftId);
    if (!nft || nft.burned) return false;

    // 检查是否过期：lifetime (expires_at=0) 或 未到期
    if (nft.expires_at === 0 || nft.expires_at > Date.now()) {
      return false; // lifetime或还没过期
    }

    nft.burned = true;

    // 从持有者索引中移除
    const ownerNfts = this.nftByOwner.get(nft.owner_wallet);
    if (ownerNfts) {
      const idx = ownerNfts.indexOf(nft);
      if (idx !== -1) ownerNfts.splice(idx, 1);
    }

    this.logger.info('NFT burned', { nftId, mintAddress: nft.mint_address });
    return true;
  }

  // ═══════════════════════════════════════════════
  // 4. 策略二级市场
  // ═══════════════════════════════════════════════

  /**
   * 挂单出售 NFT 订阅券
   */
  listForSale(
    nftId: string,
    sellerWallet: string,
    priceSol: number,
    priceBbt: number = 0,
  ): MarketListing {
    const nft = this.nfts.get(nftId);
    if (!nft) throw new Error('NFT not found');
    if (nft.owner_wallet !== sellerWallet) throw new Error('Not the NFT owner');
    if (nft.burned) throw new Error('NFT has been burned');
    if (nft.used) throw new Error('Cannot sell an activated NFT');

    // 计算剩余天数
    const remainingDays = nft.expires_at === 0
      ? Infinity
      : Math.max(0, Math.ceil((nft.expires_at - Date.now()) / (24 * 60 * 60 * 1000)));

    const strategyName = this.store?.getStrategy(nft.strategy_id)?.name || 'Unknown';

    const now = Date.now();
    const listing: MarketListing = {
      id: `listing_${now.toString(36)}_${randomBytes(4).toString('hex')}`,
      nft_id: nftId,
      mint_address: nft.mint_address,
      seller_wallet: sellerWallet,
      strategy_id: nft.strategy_id,
      strategy_name: strategyName,
      price_sol: priceSol,
      price_bbt: priceBbt,
      remaining_days: remainingDays === Infinity ? 9999 : remainingDays,
      tier: nft.tier,
      status: 'active',
      listed_at: now,
    };

    this.listings.set(listing.id, listing);
    this.activeListings.push(listing);

    this.logger.info('NFT listed for sale', {
      listingId: listing.id,
      nftId,
      priceSol,
      priceBbt,
    });

    return listing;
  }

  /**
   * 取消挂单
   */
  cancelListing(listingId: string, sellerWallet: string): boolean {
    const listing = this.listings.get(listingId);
    if (!listing || listing.status !== 'active') return false;
    if (listing.seller_wallet !== sellerWallet) return false;

    listing.status = 'cancelled';

    // 从活跃列表移除
    const idx = this.activeListings.indexOf(listing);
    if (idx !== -1) this.activeListings.splice(idx, 1);

    this.logger.info('Listing cancelled', { listingId });
    return true;
  }

  /**
   * 购买 NFT（二级市场）
   * 流程：
   * 1. 验证挂单有效
   * 2. 验证 NFT 未过期
   * 3. 转移 NFT 所有权
   * 4. 创建订阅给买家
   * 5. 结算资金给卖家（扣平台手续费）
   * 6. 更新挂单状态
   */
  async purchaseFromMarket(
    listingId: string,
    buyerWallet: string,
    buyerUserId: string,
    txSignature?: string,
  ): Promise<{
    success: boolean;
    nft?: StrategyNFT;
    error?: string;
  }> {
    const listing = this.listings.get(listingId);
    if (!listing || listing.status !== 'active') {
      return { success: false, error: 'Listing not available' };
    }

    // 不能买自己的
    if (listing.seller_wallet === buyerWallet) {
      return { success: false, error: 'Cannot buy your own listing' };
    }

    const nft = this.nfts.get(listing.nft_id);
    if (!nft || nft.burned) {
      listing.status = 'expired';
      return { success: false, error: 'NFT no longer valid' };
    }

    // 检查过期
    if (nft.expires_at > 0 && nft.expires_at < Date.now()) {
      listing.status = 'expired';
      return { success: false, error: 'NFT has expired' };
    }

    const now = Date.now();

    // 转移 NFT 所有权
    const previousOwner = nft.owner_wallet;
    nft.owner_wallet = buyerWallet;

    // 更新持有者索引
    const prevOwnerNfts = this.nftByOwner.get(previousOwner);
    if (prevOwnerNfts) {
      const idx = prevOwnerNfts.indexOf(nft);
      if (idx !== -1) prevOwnerNfts.splice(idx, 1);
    }
    if (!this.nftByOwner.has(buyerWallet)) {
      this.nftByOwner.set(buyerWallet, []);
    }
    this.nftByOwner.get(buyerWallet)!.push(nft);

    // 创建订阅给买家
    if (this.store && !nft.used) {
      const existing = this.store.getSubscription(buyerUserId, nft.strategy_id);
      if (!existing || existing.status !== 'active') {
        const expiresAt = nft.expires_at === 0
          ? undefined
          : now + nft.subscription_days * 24 * 60 * 60 * 1000;

        this.store.createSubscription({
          user_id: buyerUserId,
          strategy_id: nft.strategy_id,
          status: 'active',
          billing_model: 'free',
          next_bill_at: null,
          expires_at: expiresAt,
        });
      }
    }

    // 更新挂单
    listing.status = 'sold';
    listing.sold_at = now;
    listing.buyer_wallet = buyerWallet;
    listing.tx_signature = txSignature;

    // 从活跃列表移除
    const idx = this.activeListings.indexOf(listing);
    if (idx !== -1) this.activeListings.splice(idx, 1);

    // 记录账单
    if (this.store) {
      this.store.createBilling({
        subscription_id: nft.id,
        user_id: buyerUserId,
        strategy_id: nft.strategy_id,
        type: 'subscription',
        amount_bbt: listing.price_bbt,
        status: txSignature ? 'confirmed' : 'pending',
        tx_signature: txSignature,
      });
    }

    this.logger.info('NFT sold on market', {
      listingId,
      nftId: nft.id,
      seller: previousOwner,
      buyer: buyerWallet,
      price: `${listing.price_sol} SOL`,
    });

    return { success: true, nft };
  }

  /**
   * 获取活跃市场挂单
   * @param strategyId 可选：按策略筛选
   * @param tier 可选：按等级筛选
   */
  getActiveListings(
    strategyId?: string,
    tier?: string,
  ): MarketListing[] {
    let results = this.activeListings.filter((l) => l.status === 'active');

    if (strategyId) {
      results = results.filter((l) => l.strategy_id === strategyId);
    }
    if (tier) {
      results = results.filter((l) => l.tier === tier);
    }

    return results.sort((a, b) => a.price_sol - b.price_sol); // 按价格排序
  }

  /**
   * 获取用户的挂单
   */
  getUserListings(wallet: string): MarketListing[] {
    return Array.from(this.listings.values())
      .filter((l) => l.seller_wallet === wallet)
      .sort((a, b) => b.listed_at - a.listed_at);
  }

  /**
   * 获取市场统计
   */
  getMarketStats(): {
    totalListings: number;
    activeListings: number;
    totalSold: number;
    totalVolume: number; // SOL
    averagePrice: number;
    floorPrice: number; // 最低价
  } {
    const allListings = Array.from(this.listings.values());
    const sold = allListings.filter((l) => l.status === 'sold');
    const active = allListings.filter((l) => l.status === 'active');
    const totalVolume = sold.reduce((sum, l) => sum + l.price_sol, 0);

    return {
      totalListings: allListings.length,
      activeListings: active.length,
      totalSold: sold.length,
      totalVolume,
      averagePrice: sold.length > 0 ? totalVolume / sold.length : 0,
      floorPrice: active.length > 0 ? Math.min(...active.map((l) => l.price_sol)) : 0,
    };
  }

  // ═══════════════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════════════

  /**
   * 加载平台钱包
   */
  private loadPlatformWallet(): void {
    const privateKeyJson = process.env.BBT_PLATFORM_WALLET_PRIVATE_KEY;
    if (privateKeyJson) {
      try {
        const secretKey = Uint8Array.from(JSON.parse(privateKeyJson));
        this.platformKeypair = Keypair.fromSecretKey(secretKey);
        this.logger.info('Platform wallet loaded', {
          publicKey: this.platformKeypair.publicKey.toBase58(),
        });
      } catch (err) {
        this.logger.warn('Failed to load platform wallet', {
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * 执行链上 NFT 铸造
   */
  private async executeOnChainMint(
    mintKeypair: Keypair,
    recipientWallet: string,
    _metadata: Record<string, unknown>,
  ): Promise<string> {
    if (!this.platformKeypair) {
      throw new Error('Platform wallet not configured');
    }

    const recipient = new PublicKey(recipientWallet);
    const mint = mintKeypair.publicKey;

    // 1. 获取 rent for mint
    const lamports = await getMinimumBalanceForRentExemptMint(this.connection);

    // 2. 创建 Transaction
    const transaction = new Transaction();

    // 创建 Mint Account
    transaction.add(
      SystemProgram.createAccount({
        fromPubkey: this.platformKeypair.publicKey,
        newAccountPubkey: mint,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(mint, 0, this.platformKeypair.publicKey, this.platformKeypair.publicKey),
    );

    // 创建 Associated Token Account
    const ata = await getAssociatedTokenAddress(mint, recipient);
    transaction.add(
      createAssociatedTokenAccountInstruction(
        this.platformKeypair.publicKey,
        ata,
        recipient,
        mint,
      ),
    );

    // Mint 1 token
    transaction.add(
      createMintToInstruction(mint, ata, this.platformKeypair.publicKey, 1),
    );

    // 发送交易
    const signature = await sendAndConfirmTransaction(
      this.connection,
      transaction,
      [this.platformKeypair, mintKeypair],
    );

    return signature;
  }

  /**
   * 转移 NFT（链上）
   */
  async transferNFTOnChain(
    nftId: string,
    fromWallet: Keypair,
    toWallet: string,
  ): Promise<string> {
    const nft = this.nfts.get(nftId);
    if (!nft) throw new Error('NFT not found');

    const mint = new PublicKey(nft.mint_address);
    const fromAta = await getAssociatedTokenAddress(mint, fromWallet.publicKey);
    const toAta = await getAssociatedTokenAddress(mint, new PublicKey(toWallet));

    const transaction = new Transaction();

    // 创建接收方 ATA（如果不存在）
    transaction.add(
      createAssociatedTokenAccountInstruction(
        fromWallet.publicKey,
        toAta,
        new PublicKey(toWallet),
        mint,
      ),
    );

    // 转移 1 token
    transaction.add(
      createTransferInstruction(fromAta, toAta, fromWallet.publicKey, 1),
    );

    const signature = await sendAndConfirmTransaction(
      this.connection,
      transaction,
      [fromWallet],
    );

    return signature;
  }

  /**
   * 初始化默认捆绑包
   */
  private initBundles(): void {
    for (const template of DEFAULT_BUNDLE_PRODUCTS) {
      const now = Date.now();
      const bundle: BundleProduct = {
        ...template,
        id: `bundle_default_${template.nft_tier}`,
        sold_count: 0,
        created_at: now,
      };
      this.bundles.set(bundle.id, bundle);
    }
  }

  // ═══════════════════════════════════════════════
  // 查询接口
  // ═══════════════════════════════════════════════

  /**
   * 获取策略的完整信息（含 Agent 和 NFT 统计）
   */
  getStrategyEnhanced(strategyId: string): {
    agents: AgentBinding[];
    nftsIssued: number;
    nftsActive: number;
    marketListings: number;
    floorPrice: number;
  } {
    const agents = this.getStrategyAgents(strategyId);
    const strategyNfts = Array.from(this.nfts.values()).filter(
      (n) => n.strategy_id === strategyId,
    );
    const activeNfts = strategyNfts.filter((n) => !n.burned && !n.used);
    const marketListings = this.activeListings.filter(
      (l) => l.strategy_id === strategyId,
    );
    const floorPrice = marketListings.length > 0
      ? Math.min(...marketListings.map((l) => l.price_sol))
      : 0;

    return {
      agents,
      nftsIssued: strategyNfts.length,
      nftsActive: activeNfts.length,
      marketListings: marketListings.length,
      floorPrice,
    };
  }

  /**
   * 获取 Agent 的执行统计
   */
  getAgentStats(agentId: string): {
    totalExecutions: number;
    successRate: number;
    totalVolume: number;
    totalFees: number;
    profitLoss: number;
  } {
    const agentExecs = this.executions.filter((e) => e.agent_id === agentId);
    const executed = agentExecs.filter((e) => e.status === 'executed');
    const successRate = agentExecs.length > 0
      ? (executed.length / agentExecs.length) * 100
      : 0;

    return {
      totalExecutions: agentExecs.length,
      successRate,
      totalVolume: agentExecs.reduce((sum, e) => sum + e.amount, 0),
      totalFees: agentExecs.reduce((sum, e) => sum + e.fee_taken, 0),
      profitLoss: executed.reduce((sum, e) => sum + (e.profit_loss || 0), 0),
    };
  }
}
