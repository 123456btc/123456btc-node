/**
 * BlindBoxOTC — 盲盒 OTC 入金/出金模块
 *
 * 核心设计：
 * 1. 固定面值系列：青铜1U / 白银10U / 黄金100U / 铂金1000U / 钻石10000U
 * 2. 卖家发行盲盒 → 锁定 BBT 到链上托管合约（PDA Escrow）
 * 3. 买家支付法币 → 获得盲盒密钥 → 链上提取 BBT
 * 4. 托管释放：双方确认后自动释放，或超时自动退款
 * 5. 争议仲裁：DAO 多签投票，质押 BBT 作为仲裁保证金
 *
 * 安全原则：
 * - 所有资金操作走链上合约，链下只做匹配和法币确认
 * - 法币确认需要卖家签名 + 买家签名（2-of-2）
 * - 争议期间资金冻结，等待 DAO 投票
 * - 每笔交易有唯一 nonce，防重放
 */

import 'reflect-metadata';
import { singleton } from 'tsyringe';
import { randomBytes, createHash } from 'crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
// @ts-ignore — @solana/spl-token is ESM-only but this file is loaded via tsx
} from '@solana/spl-token';
import { Logger } from '../infra/logger/Logger.js';

// ═══════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════

/** 盲盒面值等级 */
export enum BlindBoxTier {
  BRONZE   = 'bronze',    // 1 USDT
  SILVER   = 'silver',    // 10 USDT
  GOLD     = 'gold',      // 100 USDT
  PLATINUM = 'platinum',  // 1000 USDT
  DIAMOND  = 'diamond',   // 10000 USDT
}

/** 面值配置（USDT → BBT 换算） */
export interface TierConfig {
  tier: BlindBoxTier;
  name: string;
  usdtValue: number;        // 法币面值
  bbtRequired: number;      // 发行所需锁定的 BBT 数量（含手续费）
  platformFeeBps: number;   // 平台手续费（万分之）
  icon: string;
  color: string;
}

/** 盲盒状态 */
export enum BlindBoxStatus {
  CREATED     = 'created',      // 已创建，等待卖家锁定 BBT
  LOCKED      = 'locked',       // BBT 已锁定到托管合约
  LISTED      = 'listed',       // 已上架等待买家
  RESERVED    = 'reserved',     // 已被买家预留（法币支付中）
  PAID        = 'paid',         // 法币已支付，等待双方确认
  CONFIRMED   = 'confirmed',    // 双方已确认，释放中
  COMPLETED   = 'completed',    // 交易完成，BBT 已释放给买家
  DISPUTED    = 'disputed',     // 争议中
  CANCELLED   = 'cancelled',    // 已取消，BBT 退还卖家
  EXPIRED     = 'expired',      // 超时过期
}

/** 盲盒记录 */
export interface BlindBoxOTCRecord {
  id: string;                   // 唯一 ID
  nonce: string;                // 链上 nonce（防重放）
  tier: BlindBoxTier;
  usdtValue: number;
  bbtAmount: number;            // 锁定的 BBT 数量

  sellerWallet: string;         // 卖家钱包地址
  buyerWallet?: string;         // 买家钱包地址

  status: BlindBoxStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;            // 过期时间

  // 托管相关
  escrowPDA?: string;           // 链上托管账户 PDA
  lockTxSignature?: string;     // BBT 锁定交易签名
  releaseTxSignature?: string;  // BBT 释放交易签名

  // 法币确认
  fiatPaymentRef?: string;      // 法币支付凭证（银行流水号等）
  sellerConfirmed: boolean;     // 卖家确认收到法币
  buyerConfirmed: boolean;      // 买家确认收到盲盒

  // 争议
  disputeId?: string;
  disputeReason?: string;

  // 盲盒密钥（买家购买后获得）
  boxSecret?: string;           // 盲盒密钥（SHA256 hash 存链上，明文给买家）
}

/** 争议记录 */
export interface DisputeRecord {
  id: string;
  blindBoxId: string;
  initiator: string;            // 发起争议的钱包
  reason: string;
  evidence?: string;            // 证据描述/IPFS hash
  status: 'open' | 'voting' | 'resolved_seller' | 'resolved_buyer' | 'escalated';
  createdAt: number;
  resolvedAt?: number;

  // DAO 投票
  votes: DisputeVote[];
  quorumRequired: number;       // 最低投票数
  votingEndsAt: number;         // 投票截止时间
}

/** DAO 仲裁投票 */
export interface DisputeVote {
  voterWallet: string;
  vote: 'seller' | 'buyer';    // 支持卖家或买家
  weight: number;               // 投票权重（基于 BBT 质押量）
  reason?: string;
  votedAt: number;
}

/** DAO 仲裁员 */
export interface Arbitrator {
  wallet: string;
  stakedBbt: number;            // 质押的 BBT 数量
  reputation: number;           // 信誉分（0-100）
  activeDisputes: number;       // 当前处理的争议数
  totalResolved: number;        // 历史已解决争议数
  joinedAt: number;
}

/** OTC 配置 */
export interface BlindBoxOTCConfig {
  bbtMint: string;
  treasuryWallet: string;       // 平台 treasury 收款地址
  escrowProgramId: string;      // 托管合约 Program ID
  rpcUrl: string;

  platformFeeBps: number;       // 默认平台手续费（万分之）
  lockTimeoutMs: number;        // BBT 锁定超时（毫秒）
  paymentTimeoutMs: number;     // 法币支付超时（毫秒）
  confirmTimeoutMs: number;     // 双方确认超时（毫秒）
  disputeWindowMs: number;      // 争议窗口期（毫秒）

  minArbitratorStake: number;   // 仲裁员最低质押 BBT
  quorumRequired: number;       // 争议投票最低票数
  votingDurationMs: number;     // 投票持续时间（毫秒）
  maxActiveBoxesPerSeller: number; // 每个卖家最大同时活跃盲盒数
}

// 面值配置表
const TIER_CONFIGS: TierConfig[] = [
  {
    tier: BlindBoxTier.BRONZE,
    name: '青铜盲盒',
    usdtValue: 1,
    bbtRequired: 100,        // 100 BBT 锁定
    platformFeeBps: 300,     // 3%
    icon: '🥉',
    color: '#cd7f32',
  },
  {
    tier: BlindBoxTier.SILVER,
    name: '白银盲盒',
    usdtValue: 10,
    bbtRequired: 1000,
    platformFeeBps: 250,     // 2.5%
    icon: '🥈',
    color: '#c0c0c0',
  },
  {
    tier: BlindBoxTier.GOLD,
    name: '黄金盲盒',
    usdtValue: 100,
    bbtRequired: 10000,
    platformFeeBps: 200,     // 2%
    icon: '🥇',
    color: '#ffd700',
  },
  {
    tier: BlindBoxTier.PLATINUM,
    name: '铂金盲盒',
    usdtValue: 1000,
    bbtRequired: 100000,
    platformFeeBps: 150,     // 1.5%
    icon: '💍',
    color: '#e5e4e2',
  },
  {
    tier: BlindBoxTier.DIAMOND,
    name: '钻石盲盒',
    usdtValue: 10000,
    bbtRequired: 1000000,
    platformFeeBps: 100,     // 1%
    icon: '💎',
    color: '#b9f2ff',
  },
];

const DEFAULT_CONFIG: BlindBoxOTCConfig = {
  bbtMint: '3s4AK2x2nGkKP8ZADbcKuhdPr3coSuh1XnwZEzWgpump',
  treasuryWallet: '',
  escrowProgramId: '11111111111111111111111111111111',
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  platformFeeBps: 200,
  lockTimeoutMs: 300_000,         // 5 分钟
  paymentTimeoutMs: 1_800_000,    // 30 分钟
  confirmTimeoutMs: 3_600_000,    // 1 小时
  disputeWindowMs: 86_400_000,    // 24 小时
  minArbitratorStake: 10_000,     // 10000 BBT
  quorumRequired: 3,
  votingDurationMs: 43_200_000,   // 12 小时
  maxActiveBoxesPerSeller: 50,
};

// ═══════════════════════════════════════════════════════════
// BlindBoxOTC 主类
// ═══════════════════════════════════════════════════════════

@singleton()
export class BlindBoxOTC {
  private connection: Connection;
  private config: BlindBoxOTCConfig;
  private bbtMint: PublicKey;

  // 内存存储（生产环境迁移至 SQLite / Redis）
  private boxes: Map<string, BlindBoxOTCRecord> = new Map();
  private disputes: Map<string, DisputeRecord> = new Map();
  private arbitrators: Map<string, Arbitrator> = new Map();
  private nonces: Set<string> = new Set();          // 已使用的 nonce
  private usedPaymentRefs: Set<string> = new Set(); // 已使用的法币支付凭证

  // 幂等性保护
  private pendingLocks: Set<string> = new Set();    // 正在锁定的盲盒 ID
  private pendingReleases: Set<string> = new Set(); // 正在释放的盲盒 ID

  constructor(private logger: Logger) {
    this.config = { ...DEFAULT_CONFIG };
    this.connection = new Connection(this.config.rpcUrl, 'confirmed');
    this.bbtMint = new PublicKey(this.config.bbtMint);
  }

  // ═══════════════════════════════════════════════════════════
  // 1. 配置管理
  // ═══════════════════════════════════════════════════════════

  /** 获取当前配置 */
  getConfig(): BlindBoxOTCConfig {
    return { ...this.config };
  }

  /** 更新配置（Provider 管理） */
  updateConfig(partial: Partial<BlindBoxOTCConfig>) {
    this.config = { ...this.config, ...partial };
    if (partial.rpcUrl) {
      this.connection = new Connection(partial.rpcUrl, 'confirmed');
    }
    if (partial.bbtMint) {
      this.bbtMint = new PublicKey(partial.bbtMint);
    }
    this.logger.info('BlindBoxOTC config updated', { keys: Object.keys(partial) });
  }

  /** 获取所有面值配置 */
  getTierConfigs(): TierConfig[] {
    return [...TIER_CONFIGS];
  }

  /** 获取指定面值配置 */
  getTierConfig(tier: BlindBoxTier): TierConfig | undefined {
    return TIER_CONFIGS.find((c) => c.tier === tier);
  }

  // ═══════════════════════════════════════════════════════════
  // 2. 盲盒发行（卖家）
  // ═══════════════════════════════════════════════════════════

  /**
   * 创建盲盒（卖家发起）
   * 1. 验证面值和卖家资格
   * 2. 生成 nonce 和盲盒密钥
   * 3. 构建 BBT 锁定交易（卖家签名后上链）
   * 4. 状态：CREATED → 等待链上确认 → LOCKED
   */
  async createBox(
    sellerWallet: string,
    tier: BlindBoxTier,
  ): Promise<{ box: BlindBoxOTCRecord; lockTransaction: Transaction }> {
    const tierConfig = this.getTierConfig(tier);
    if (!tierConfig) {
      throw new Error(`Invalid tier: ${tier}`);
    }

    // 检查卖家活跃盲盒数量
    const activeCount = this.countActiveBoxesBySeller(sellerWallet);
    if (activeCount >= this.config.maxActiveBoxesPerSeller) {
      throw new Error(`Max active boxes limit reached: ${this.config.maxActiveBoxesPerSeller}`);
    }

    // 生成唯一 nonce（防重放）
    const nonce = randomBytes(16).toString('hex');
    if (this.nonces.has(nonce)) {
      throw new Error('Nonce collision, retry');
    }
    this.nonces.add(nonce);

    // 生成盲盒密钥（SHA256 hash 存链上，明文给卖家后续转交买家）
    const boxSecret = randomBytes(32).toString('hex');
    const boxSecretHash = createHash('sha256').update(boxSecret).digest('hex');

    const now = Date.now();
    const boxId = `otc_${now}_${randomBytes(4).toString('hex')}`;

    const box: BlindBoxOTCRecord = {
      id: boxId,
      nonce,
      tier,
      usdtValue: tierConfig.usdtValue,
      bbtAmount: tierConfig.bbtRequired,
      sellerWallet,
      status: BlindBoxStatus.CREATED,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.config.lockTimeoutMs,
      sellerConfirmed: false,
      buyerConfirmed: false,
      boxSecret,
    };

    // 构建链上锁定交易
    const lockTx = await this.buildLockTransaction(
      sellerWallet,
      tierConfig.bbtRequired,
      boxId,
      nonce,
      boxSecretHash,
    );

    this.boxes.set(boxId, box);

    this.logger.info('BlindBox created', {
      boxId,
      tier,
      usdtValue: tierConfig.usdtValue,
      bbtRequired: tierConfig.bbtRequired,
      seller: sellerWallet.slice(0, 8),
    });

    return { box, lockTransaction: lockTx };
  }

  /**
   * 确认 BBT 已锁定（链上交易确认后调用）
   * 验证交易签名后更新状态为 LOCKED
   */
  async confirmLock(
    boxId: string,
    lockTxSignature: string,
  ): Promise<BlindBoxOTCRecord> {
    const box = this.boxes.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}`);
    if (box.status !== BlindBoxStatus.CREATED) {
      throw new Error(`Invalid status for lock confirm: ${box.status}`);
    }

    // 幂等性检查
    if (this.pendingLocks.has(boxId)) {
      throw new Error('Lock confirmation already in progress');
    }
    this.pendingLocks.add(boxId);

    try {
      // 验证链上交易
      const valid = await this.verifyLockTx(lockTxSignature, box.sellerWallet, box.bbtAmount);
      if (!valid) {
        throw new Error('Invalid lock transaction');
      }

      box.status = BlindBoxStatus.LOCKED;
      box.lockTxSignature = lockTxSignature;
      box.updatedAt = Date.now();
      // 锁定后 48 小时内有效
      box.expiresAt = Date.now() + 48 * 60 * 60 * 1000;

      this.logger.info('BlindBox BBT locked', { boxId, tx: lockTxSignature.slice(0, 16) });
      return box;
    } finally {
      this.pendingLocks.delete(boxId);
    }
  }

  /**
   * 上架盲盒（锁定确认后自动或手动上架）
   */
  listBox(boxId: string): BlindBoxOTCRecord {
    const box = this.boxes.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}`);
    if (box.status !== BlindBoxStatus.LOCKED) {
      throw new Error(`Cannot list: status is ${box.status}`);
    }

    box.status = BlindBoxStatus.LISTED;
    box.updatedAt = Date.now();

    this.logger.info('BlindBox listed', { boxId, tier: box.tier, usdt: box.usdtValue });
    return box;
  }

  // ═══════════════════════════════════════════════════════════
  // 3. 盲盒交易（买家）
  // ═══════════════════════════════════════════════════════════

  /**
   * 预留盲盒（买家发起购买）
   * 买家选定盲盒后，状态变为 RESERVED，等待法币支付
   */
  reserveBox(
    boxId: string,
    buyerWallet: string,
  ): BlindBoxOTCRecord {
    const box = this.boxes.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}`);
    if (box.status !== BlindBoxStatus.LISTED) {
      throw new Error(`Box not available: ${box.status}`);
    }
    if (box.sellerWallet === buyerWallet) {
      throw new Error('Cannot buy your own blind box');
    }
    if (Date.now() > box.expiresAt) {
      box.status = BlindBoxStatus.EXPIRED;
      throw new Error('Box has expired');
    }

    box.status = BlindBoxStatus.RESERVED;
    box.buyerWallet = buyerWallet;
    box.updatedAt = Date.now();
    box.expiresAt = Date.now() + this.config.paymentTimeoutMs;

    this.logger.info('BlindBox reserved', {
      boxId,
      buyer: buyerWallet.slice(0, 8),
      usdt: box.usdtValue,
    });
    return box;
  }

  /**
   * 确认法币支付（买家提交支付凭证）
   * 买家已通过银行/支付宝/微信等完成法币转账
   * 提交支付凭证（银行流水号等），状态变为 PAID
   */
  confirmFiatPayment(
    boxId: string,
    buyerWallet: string,
    paymentRef: string,
  ): BlindBoxOTCRecord {
    const box = this.boxes.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}`);
    if (box.status !== BlindBoxStatus.RESERVED) {
      throw new Error(`Invalid status: ${box.status}`);
    }
    if (box.buyerWallet !== buyerWallet) {
      throw new Error('Only the reserved buyer can confirm payment');
    }

    // 法币支付凭证去重
    if (this.usedPaymentRefs.has(paymentRef)) {
      throw new Error('Payment reference already used');
    }
    this.usedPaymentRefs.add(paymentRef);

    box.status = BlindBoxStatus.PAID;
    box.fiatPaymentRef = paymentRef;
    box.updatedAt = Date.now();
    box.expiresAt = Date.now() + this.config.confirmTimeoutMs;

    this.logger.info('Fiat payment confirmed', {
      boxId,
      paymentRef: paymentRef.slice(0, 8),
    });
    return box;
  }

  // ═══════════════════════════════════════════════════════════
  // 4. 托管释放
  // ═══════════════════════════════════════════════════════════

  /**
   * 卖家确认收到法币
   * 卖家确认已收到买家的法币转账
   */
  sellerConfirm(boxId: string, sellerWallet: string): BlindBoxOTCRecord {
    const box = this.boxes.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}`);
    if (box.sellerWallet !== sellerWallet) {
      throw new Error('Only seller can confirm');
    }
    if (box.status !== BlindBoxStatus.PAID) {
      throw new Error(`Invalid status: ${box.status}`);
    }

    box.sellerConfirmed = true;
    box.updatedAt = Date.now();

    this.logger.info('Seller confirmed fiat receipt', { boxId });

    // 双方都确认则自动释放
    if (box.sellerConfirmed && box.buyerConfirmed) {
      return this.triggerRelease(box);
    }
    return box;
  }

  /**
   * 买家确认收到盲盒密钥
   * 买家确认已收到卖家提供的盲盒密钥
   */
  buyerConfirm(boxId: string, buyerWallet: string): BlindBoxOTCRecord {
    const box = this.boxes.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}`);
    if (box.buyerWallet !== buyerWallet) {
      throw new Error('Only buyer can confirm');
    }
    if (box.status !== BlindBoxStatus.PAID) {
      throw new Error(`Invalid status: ${box.status}`);
    }

    box.buyerConfirmed = true;
    box.updatedAt = Date.now();

    this.logger.info('Buyer confirmed box key received', { boxId });

    // 双方都确认则自动释放
    if (box.sellerConfirmed && box.buyerConfirmed) {
      return this.triggerRelease(box);
    }
    return box;
  }

  /**
   * 触发 BBT 释放（双方确认后自动调用）
   * 将托管的 BBT 释放给买家，扣除平台手续费给 treasury
   */
  private triggerRelease(box: BlindBoxOTCRecord): BlindBoxOTCRecord {
    if (this.pendingReleases.has(box.id)) {
      this.logger.warn('Release already in progress', { boxId: box.id });
      return box;
    }
    this.pendingReleases.add(box.id);

    box.status = BlindBoxStatus.CONFIRMED;
    box.updatedAt = Date.now();

    this.logger.info('BlindBox release triggered', {
      boxId: box.id,
      bbtAmount: box.bbtAmount,
      buyer: box.buyerWallet?.slice(0, 8),
    });

    // 异步执行链上释放（不阻塞返回）
    this.executeRelease(box).catch((err) => {
      this.logger.error('Release execution failed', err, { boxId: box.id });
    });

    return box;
  }

  /**
   * 执行链上释放交易
   * 从托管 PDA 转 BBT 到买家钱包，手续费转到 treasury
   */
  private async executeRelease(box: BlindBoxOTCRecord): Promise<void> {
    try {
      const tierConfig = this.getTierConfig(box.tier);
      if (!tierConfig) throw new Error('Tier config not found');

      // 计算手续费
      const fee = Math.floor(box.bbtAmount * tierConfig.platformFeeBps / 10000);
      const releaseAmount = box.bbtAmount - fee;

      // 构建释放交易
      const releaseTx = await this.buildReleaseTransaction(
        box.buyerWallet!,
        releaseAmount,
        fee,
        box.id,
        box.nonce,
      );

      // TODO: 使用 Provider Keypair 签名并发送交易
      // const signature = await this.connection.sendTransaction(releaseTx, [providerKeypair]);
      const signature = 'pending_release_tx'; // 占位

      box.releaseTxSignature = signature;
      box.status = BlindBoxStatus.COMPLETED;
      box.updatedAt = Date.now();

      this.logger.info('BlindBox BBT released', {
        boxId: box.id,
        releaseAmount,
        fee,
        tx: signature,
      });
    } catch (err) {
      this.logger.error('Release failed', err as Error, { boxId: box.id });
      // 释放失败不改变状态，保持 CONFIRMED，等待重试或人工干预
    } finally {
      this.pendingReleases.delete(box.id);
    }
  }

  /**
   * 超时自动处理
   * - CREATED 超时：自动取消
   * - RESERVED 超时：自动释放回 LISTED
   * - PAID 超时：进入争议窗口
   */
  processExpired(): { cancelled: string[]; released: string[]; disputed: string[] } {
    const now = Date.now();
    const cancelled: string[] = [];
    const released: string[] = [];
    const disputed: string[] = [];

    for (const [id, box] of this.boxes) {
      if (now <= box.expiresAt) continue;

      switch (box.status) {
        case BlindBoxStatus.CREATED:
          box.status = BlindBoxStatus.CANCELLED;
          box.updatedAt = now;
          cancelled.push(id);
          break;

        case BlindBoxStatus.RESERVED:
          // 买家未支付，释放回上架状态
          box.status = BlindBoxStatus.LISTED;
          box.buyerWallet = undefined;
          box.updatedAt = now;
          box.expiresAt = now + 48 * 60 * 60 * 1000;
          released.push(id);
          break;

        case BlindBoxStatus.PAID:
          // 未确认，进入争议流程
          box.status = BlindBoxStatus.DISPUTED;
          box.updatedAt = now;
          this.createAutoDispute(box);
          disputed.push(id);
          break;

        case BlindBoxStatus.LOCKED:
          // 锁定后未上架，自动取消并退还
          box.status = BlindBoxStatus.CANCELLED;
          box.updatedAt = now;
          cancelled.push(id);
          break;

        default:
          break;
      }
    }

    if (cancelled.length || released.length || disputed.length) {
      this.logger.info('Processed expired boxes', { cancelled, released, disputed });
    }

    return { cancelled, released, disputed };
  }

  // ═══════════════════════════════════════════════════════════
  // 5. 争议仲裁（DAO 投票）
  // ═══════════════════════════════════════════════════════════

  /**
   * 发起争议（买家或卖家）
   * 争议期间资金冻结，等待 DAO 投票
   */
  initiateDispute(
    boxId: string,
    initiatorWallet: string,
    reason: string,
    evidence?: string,
  ): DisputeRecord {
    const box = this.boxes.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}`);

    // 只有交易双方可以发起争议
    if (initiatorWallet !== box.sellerWallet && initiatorWallet !== box.buyerWallet) {
      throw new Error('Only trading parties can initiate disputes');
    }

    // 只在特定状态可以争议
    const disputable: BlindBoxStatus[] = [
      BlindBoxStatus.PAID,
      BlindBoxStatus.CONFIRMED,
      BlindBoxStatus.COMPLETED,
    ];
    if (!disputable.includes(box.status)) {
      throw new Error(`Cannot dispute in status: ${box.status}`);
    }

    // 检查争议窗口
    const disputeDeadline = box.updatedAt + this.config.disputeWindowMs;
    if (Date.now() > disputeDeadline) {
      throw new Error('Dispute window has closed');
    }

    const disputeId = `disp_${Date.now()}_${randomBytes(4).toString('hex')}`;
    const now = Date.now();

    const dispute: DisputeRecord = {
      id: disputeId,
      blindBoxId: boxId,
      initiator: initiatorWallet,
      reason,
      evidence,
      status: 'open',
      createdAt: now,
      votes: [],
      quorumRequired: this.config.quorumRequired,
      votingEndsAt: now + this.config.votingDurationMs,
    };

    box.status = BlindBoxStatus.DISPUTED;
    box.disputeId = disputeId;
    box.disputeReason = reason;
    box.updatedAt = now;

    this.disputes.set(disputeId, dispute);

    this.logger.warn('Dispute initiated', {
      disputeId,
      boxId,
      initiator: initiatorWallet.slice(0, 8),
      reason: reason.slice(0, 50),
    });

    return dispute;
  }

  /**
   * DAO 仲裁员投票
   * 仲裁员质押 BBT 获得投票权，按权重投票
   */
  castVote(
    disputeId: string,
    voterWallet: string,
    vote: 'seller' | 'buyer',
    reason?: string,
  ): DisputeRecord {
    const dispute = this.disputes.get(disputeId);
    if (!dispute) throw new Error(`Dispute not found: ${disputeId}`);
    if (dispute.status !== 'open' && dispute.status !== 'voting') {
      throw new Error(`Dispute not open for voting: ${dispute.status}`);
    }
    if (Date.now() > dispute.votingEndsAt) {
      throw new Error('Voting period has ended');
    }

    // 验证仲裁员资格
    const arbitrator = this.arbitrators.get(voterWallet);
    if (!arbitrator) throw new Error('Not a registered arbitrator');
    if (arbitrator.stakedBbt < this.config.minArbitratorStake) {
      throw new Error(`Insufficient stake: need ${this.config.minArbitratorStake} BBT`);
    }

    // 检查重复投票
    const existingVote = dispute.votes.find((v) => v.voterWallet === voterWallet);
    if (existingVote) throw new Error('Already voted');

    // 计算投票权重（基于质押量和信誉分）
    const weight = Math.floor(arbitrator.stakedBbt * arbitrator.reputation / 100);

    dispute.votes.push({
      voterWallet,
      vote,
      weight,
      reason,
      votedAt: Date.now(),
    });

    dispute.status = 'voting';

    this.logger.info('Dispute vote cast', {
      disputeId,
      voter: voterWallet.slice(0, 8),
      vote,
      weight,
    });

    // 检查是否达到法定人数
    if (dispute.votes.length >= dispute.quorumRequired) {
      this.resolveDispute(dispute);
    }

    return dispute;
  }

  /**
   * 解决争议（投票结束后）
   * 按权重计票，多数方获胜
   */
  private resolveDispute(dispute: DisputeRecord): void {
    const box = this.boxes.get(dispute.blindBoxId);
    if (!box) return;

    // 按权重计票
    let sellerWeight = 0;
    let buyerWeight = 0;

    for (const vote of dispute.votes) {
      if (vote.vote === 'seller') {
        sellerWeight += vote.weight;
      } else {
        buyerWeight += vote.weight;
      }
    }

    const now = Date.now();

    if (sellerWeight > buyerWeight) {
      // 卖家胜：BBT 退还卖家
      dispute.status = 'resolved_seller';
      box.status = BlindBoxStatus.CANCELLED;
      this.logger.info('Dispute resolved: seller wins', {
        disputeId: dispute.id,
        sellerWeight,
        buyerWeight,
      });
    } else if (buyerWeight > sellerWeight) {
      // 买家胜：BBT 释放给买家
      dispute.status = 'resolved_buyer';
      box.status = BlindBoxStatus.COMPLETED;
      this.logger.info('Dispute resolved: buyer wins', {
        disputeId: dispute.id,
        sellerWeight,
        buyerWeight,
      });
    } else {
      // 平票：升级处理（人工介入或扩大仲裁团）
      dispute.status = 'escalated';
      this.logger.warn('Dispute escalated: tied vote', {
        disputeId: dispute.id,
        sellerWeight,
        buyerWeight,
      });
    }

    dispute.resolvedAt = now;
    box.updatedAt = now;

    // 更新仲裁员信誉分
    this.updateArbitratorReputation(dispute);
  }

  /**
   * 自动创建超时争议（系统触发）
   */
  private createAutoDispute(box: BlindBoxOTCRecord): void {
    const disputeId = `disp_auto_${Date.now()}_${randomBytes(4).toString('hex')}`;
    const now = Date.now();

    const dispute: DisputeRecord = {
      id: disputeId,
      blindBoxId: box.id,
      initiator: 'system',
      reason: 'Payment timeout: both parties failed to confirm within time limit',
      status: 'open',
      createdAt: now,
      votes: [],
      quorumRequired: this.config.quorumRequired,
      votingEndsAt: now + this.config.votingDurationMs,
    };

    box.disputeId = disputeId;
    this.disputes.set(disputeId, dispute);

    this.logger.warn('Auto dispute created due to timeout', { boxId: box.id, disputeId });
  }

  // ═══════════════════════════════════════════════════════════
  // 6. 仲裁员管理
  // ═══════════════════════════════════════════════════════════

  /**
   * 注册仲裁员（质押 BBT）
   */
  registerArbitrator(wallet: string, stakedBbt: number): Arbitrator {
    if (stakedBbt < this.config.minArbitratorStake) {
      throw new Error(`Minimum stake required: ${this.config.minArbitratorStake} BBT`);
    }

    const existing = this.arbitrators.get(wallet);
    if (existing) {
      // 追加质押
      existing.stakedBbt += stakedBbt;
      this.logger.info('Arbitrator stake increased', { wallet: wallet.slice(0, 8), total: existing.stakedBbt });
      return existing;
    }

    const arbitrator: Arbitrator = {
      wallet,
      stakedBbt,
      reputation: 50, // 初始信誉分
      activeDisputes: 0,
      totalResolved: 0,
      joinedAt: Date.now(),
    };

    this.arbitrators.set(wallet, arbitrator);
    this.logger.info('Arbitrator registered', { wallet: wallet.slice(0, 8), staked: stakedBbt });
    return arbitrator;
  }

  /**
   * 更新仲裁员信誉分
   * 投票与多数方一致 → 信誉 +5
   * 投票与多数方不一致 → 信誉 -3
   */
  private updateArbitratorReputation(dispute: DisputeRecord): void {
    let winnerSide: 'seller' | 'buyer' | null = null;
    if (dispute.status === 'resolved_seller') winnerSide = 'seller';
    if (dispute.status === 'resolved_buyer') winnerSide = 'buyer';
    if (!winnerSide) return; // 平票不更新信誉

    for (const vote of dispute.votes) {
      const arbitrator = this.arbitrators.get(vote.voterWallet);
      if (!arbitrator) continue;

      if (vote.vote === winnerSide) {
        arbitrator.reputation = Math.min(100, arbitrator.reputation + 5);
      } else {
        arbitrator.reputation = Math.max(0, arbitrator.reputation - 3);
      }
      arbitrator.totalResolved++;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 7. 查询接口
  // ═══════════════════════════════════════════════════════════

  /** 获取盲盒详情 */
  getBox(boxId: string): BlindBoxOTCRecord | undefined {
    const box = this.boxes.get(boxId);
    if (!box) return undefined;
    // 隐藏密钥（只有买家能看到）
    return { ...box, boxSecret: undefined };
  }

  /** 获取盲盒详情（含密钥，仅买家调用） */
  getBoxWithSecret(boxId: string, buyerWallet: string): BlindBoxOTCRecord | undefined {
    const box = this.boxes.get(boxId);
    if (!box || box.buyerWallet !== buyerWallet) return undefined;
    return { ...box };
  }

  /** 获取所有上架中的盲盒（市场列表） */
  getMarketListings(tier?: BlindBoxTier): BlindBoxOTCRecord[] {
    const listings: BlindBoxOTCRecord[] = [];
    for (const box of this.boxes.values()) {
      if (box.status !== BlindBoxStatus.LISTED) continue;
      if (tier && box.tier !== tier) continue;
      // 市场列表不显示密钥
      listings.push({ ...box, boxSecret: undefined });
    }
    return listings.sort((a, b) => a.usdtValue - b.usdtValue || a.createdAt - b.createdAt);
  }

  /** 获取卖家的所有盲盒 */
  getSellerBoxes(sellerWallet: string): BlindBoxOTCRecord[] {
    const boxes: BlindBoxOTCRecord[] = [];
    for (const box of this.boxes.values()) {
      if (box.sellerWallet === sellerWallet) {
        boxes.push({ ...box, boxSecret: undefined });
      }
    }
    return boxes.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 获取买家的所有盲盒 */
  getBuyerBoxes(buyerWallet: string): BlindBoxOTCRecord[] {
    const boxes: BlindBoxOTCRecord[] = [];
    for (const box of this.boxes.values()) {
      if (box.buyerWallet === buyerWallet) {
        boxes.push({ ...box }); // 买家可以看到密钥
      }
    }
    return boxes.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 获取争议详情 */
  getDispute(disputeId: string): DisputeRecord | undefined {
    return this.disputes.get(disputeId);
  }

  /** 获取盲盒关联的争议 */
  getDisputeByBoxId(boxId: string): DisputeRecord | undefined {
    for (const dispute of this.disputes.values()) {
      if (dispute.blindBoxId === boxId) return dispute;
    }
    return undefined;
  }

  /** 获取所有仲裁员 */
  getArbitrators(): Arbitrator[] {
    return [...this.arbitrators.values()].sort((a, b) => b.reputation - a.reputation);
  }

  /** 获取统计信息 */
  getStats(): {
    totalBoxes: number;
    activeBoxes: number;
    completedTrades: number;
    totalVolumeUsdt: number;
    openDisputes: number;
    totalArbitrators: number;
  } {
    let activeBoxes = 0;
    let completedTrades = 0;
    let totalVolumeUsdt = 0;
    let openDisputes = 0;

    for (const box of this.boxes.values()) {
      if ([BlindBoxStatus.LISTED, BlindBoxStatus.RESERVED, BlindBoxStatus.PAID, BlindBoxStatus.LOCKED].includes(box.status)) {
        activeBoxes++;
      }
      if (box.status === BlindBoxStatus.COMPLETED) {
        completedTrades++;
        totalVolumeUsdt += box.usdtValue;
      }
    }

    for (const dispute of this.disputes.values()) {
      if (dispute.status === 'open' || dispute.status === 'voting') {
        openDisputes++;
      }
    }

    return {
      totalBoxes: this.boxes.size,
      activeBoxes,
      completedTrades,
      totalVolumeUsdt,
      openDisputes,
      totalArbitrators: this.arbitrators.size,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // 8. 内部工具方法
  // ═══════════════════════════════════════════════════════════

  /** 统计卖家活跃盲盒数量 */
  private countActiveBoxesBySeller(sellerWallet: string): number {
    let count = 0;
    const activeStatuses: BlindBoxStatus[] = [
      BlindBoxStatus.CREATED,
      BlindBoxStatus.LOCKED,
      BlindBoxStatus.LISTED,
      BlindBoxStatus.RESERVED,
      BlindBoxStatus.PAID,
    ];
    for (const box of this.boxes.values()) {
      if (box.sellerWallet === sellerWallet && activeStatuses.includes(box.status)) {
        count++;
      }
    }
    return count;
  }

  /**
   * 构建 BBT 锁定交易
   * 卖家将 BBT 转入托管 PDA
   */
  private async buildLockTransaction(
    sellerWallet: string,
    bbtAmount: number,
    boxId: string,
    nonce: string,
    boxSecretHash: string,
  ): Promise<Transaction> {
    const seller = new PublicKey(sellerWallet);
    const sellerATA = await getAssociatedTokenAddress(
      this.bbtMint, seller, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    // 计算托管 PDA
    const [escrowPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('blindbox_escrow'),
        Buffer.from(boxId),
        Buffer.from(nonce),
      ],
      new PublicKey(this.config.escrowProgramId),
    );

    const escrowATA = await getAssociatedTokenAddress(
      this.bbtMint, escrowPDA, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const tx = new Transaction();

    // Memo 指令（记录交易元数据）
    const memo = JSON.stringify({
      op: 'blindbox_lock',
      boxId,
      nonce,
      secretHash: boxSecretHash,
      ts: Date.now(),
    });
    const { createMemoInstruction } = await import('@solana/spl-memo');
    tx.add(createMemoInstruction(memo));

    // BBT 转账到托管账户
    tx.add(
      createTransferInstruction(
        sellerATA,
        escrowATA,
        seller,
        BigInt(Math.round(bbtAmount * 1e6)), // 6 decimals
        [],
        TOKEN_PROGRAM_ID,
      ),
    );

    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = seller;

    return tx;
  }

  /**
   * 构建 BBT 释放交易
   * 从托管 PDA 转 BBT 到买家钱包 + 手续费到 treasury
   */
  private async buildReleaseTransaction(
    buyerWallet: string,
    releaseAmount: number,
    feeAmount: number,
    boxId: string,
    nonce: string,
  ): Promise<Transaction> {
    const buyer = new PublicKey(buyerWallet);
    const treasury = new PublicKey(this.config.treasuryWallet);

    const [escrowPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('blindbox_escrow'),
        Buffer.from(boxId),
        Buffer.from(nonce),
      ],
      new PublicKey(this.config.escrowProgramId),
    );

    const escrowATA = await getAssociatedTokenAddress(
      this.bbtMint, escrowPDA, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const buyerATA = await getAssociatedTokenAddress(
      this.bbtMint, buyer, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const treasuryATA = await getAssociatedTokenAddress(
      this.bbtMint, treasury, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const tx = new Transaction();

    // Memo
    const memo = JSON.stringify({
      op: 'blindbox_release',
      boxId,
      nonce,
      release: releaseAmount,
      fee: feeAmount,
      ts: Date.now(),
    });
    const { createMemoInstruction } = await import('@solana/spl-memo');
    tx.add(createMemoInstruction(memo));

    // 释放 BBT 给买家
    tx.add(
      createTransferInstruction(
        escrowATA,
        buyerATA,
        escrowPDA, // PDA authority
        BigInt(Math.round(releaseAmount * 1e6)),
        [],
        TOKEN_PROGRAM_ID,
      ),
    );

    // 手续费给 treasury
    if (feeAmount > 0) {
      tx.add(
        createTransferInstruction(
          escrowATA,
          treasuryATA,
          escrowPDA,
          BigInt(Math.round(feeAmount * 1e6)),
          [],
          TOKEN_PROGRAM_ID,
        ),
      );
    }

    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = treasury; // treasury 付 gas

    return tx;
  }

  /**
   * 验证锁定交易
   * 检查链上交易是否包含正确的 BBT 转账
   */
  private async verifyLockTx(
    signature: string,
    sellerWallet: string,
    expectedAmount: number,
  ): Promise<boolean> {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) return false;
      if (tx.meta?.err) return false;

      const instructions = tx.transaction.message.instructions;
      for (const ix of instructions) {
        if ((ix as any).program !== 'spl-token' && (ix as any).programId !== TOKEN_PROGRAM_ID.toBase58()) continue;
        const parsed = (ix as any).parsed;
        if (!parsed || parsed.type !== 'transfer') continue;

        const info = parsed.info;
        if (!info) continue;

        const fromWallet = info.sourceOwner || info.authority;
        const amount = Number(info.amount) / 1e6;

        if (fromWallet !== sellerWallet) continue;
        if (Math.abs(amount - expectedAmount) > 0.01) continue;

        return true;
      }

      return false;
    } catch (err) {
      this.logger.error('Lock tx verification failed', err as Error, { signature });
      return false;
    }
  }
}
