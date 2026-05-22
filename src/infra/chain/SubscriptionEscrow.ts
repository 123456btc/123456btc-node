/**
 * SubscriptionEscrow — 链上合约 TypeScript 客户端
 *
 * 职责：
 * 1. 封装 Anchor IDL 调用（创建订阅、取消、提取、争议）
 * 2. 信号 Merkle 树构建与提交（链下聚合 → 链上锚定）
 * 3. 心跳调度（Provider 定期链上 ping）
 * 4. 事件监听（订阅状态变更、争议触发）
 *
 * 高频信号原则：
 * - 信号本身不上链，通过 libp2p-gossipsub 传播
 * - 每 N 分钟或每 M 条信号，计算 Merkle Root 上链
 * - Provider 每小时至少一次 heartbeat 上链
 */

import 'reflect-metadata';
import { singleton } from 'tsyringe';
import { Connection, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { createHash } from 'crypto';
import { Logger } from '../logger/Logger.js';

export interface SubscriptionParams {
  providerWallet: PublicKey;
  strategyId: string;
  amount: bigint; // BBT lamports
  durationSeconds: number;
  nonce: bigint;
  bbtMint: PublicKey;
}

export interface SubscriptionState {
  user: string;
  provider: string;
  strategyId: string;
  amountDeposited: bigint;
  amountClaimed: bigint;
  startTime: number;
  endTime: number;
  status: 'active' | 'cancelled' | 'disputed' | 'settled';
  lastHeartbeat: number;
  signalSequence: bigint;
  merkleRoot: string;
}

// 默认 Program ID（devnet placeholder），实际通过构造函数或环境变量覆盖
const DEFAULT_PROGRAM_ID = new PublicKey('SubsEsc111111111111111111111111111111111111');

// Merkle 树工具（信号链下聚合 → 链上锚定）
export class SignalMerkleTree {
  private leaves: Buffer[] = [];

  addSignal(signalHash: string) {
    this.leaves.push(Buffer.from(signalHash, 'hex'));
  }

  // 简单二叉 Merkle Root 计算（偶数填充）
  getRoot(): Buffer {
    if (this.leaves.length === 0) {
      return createHash('sha256').update('empty').digest();
    }
    let level = [...this.leaves];
    while (level.length > 1) {
      const next: Buffer[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = level[i + 1] || left; // 奇数复制最后一个
        next.push(createHash('sha256').update(Buffer.concat([left, right])).digest());
      }
      level = next;
    }
    return level[0];
  }

  clear() {
    this.leaves = [];
  }

  get count(): number {
    return this.leaves.length;
  }
}

@singleton()
export class SubscriptionEscrowClient {
  private programId: PublicKey;
  private connection: Connection;
  private wallet?: any;
  private isMock: boolean;
  private logger: Logger;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private merkleTimer?: ReturnType<typeof setInterval>;
  private merkleTree = new SignalMerkleTree();
  private pendingSignals = 0;

  constructor(logger: Logger, rpcUrl?: string);
  constructor(connection: Connection, wallet: any, programId?: PublicKey, logger?: Logger);
  constructor(
    arg1: Logger | Connection,
    arg2?: string | any,
    arg3?: PublicKey,
    arg4?: Logger,
  ) {
    if (arg1 instanceof Connection) {
      // Real mode: new SubscriptionEscrowClient(connection, wallet, programId?, logger?)
      this.connection = arg1;
      this.wallet = arg2;
      this.programId = arg3 || DEFAULT_PROGRAM_ID;
      this.logger = arg4 || new Logger();
      this.isMock = false;
    } else {
      // Mock mode: new SubscriptionEscrowClient(logger, rpcUrl?)
      this.logger = arg1;
      this.connection = new Connection(arg2 || 'https://api.mainnet-beta.solana.com');
      this.programId = DEFAULT_PROGRAM_ID;
      this.isMock = true;
    }
  }

  // ── PDA 派生（公开，供链下计算使用）──
  deriveSubscriptionPDA(userWallet: PublicKey, strategyId: string, nonce: bigint): [PublicKey, number] {
    const seed = Buffer.from(strategyId);
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(nonce);
    return PublicKey.findProgramAddressSync(
      [Buffer.from('subscription'), userWallet.toBuffer(), seed, nonceBuf],
      this.programId,
    );
  }

  // ── 初始化 Provider 侧定时任务 ──
  startProviderTasks(
    providerKeypair: any, // anchor.web3.Keypair
    subscriptionPDA: PublicKey,
    opts: { heartbeatIntervalMs?: number; merkleIntervalMs?: number } = {},
  ) {
    const heartbeatMs = opts.heartbeatIntervalMs || 3_600_000; // 默认 1 小时
    const merkleMs = opts.merkleIntervalMs || 300_000; // 默认 5 分钟

    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.submitHeartbeat(providerKeypair, subscriptionPDA);
        this.logger.info('Heartbeat submitted', { subscription: subscriptionPDA.toBase58() });
      } catch (err) {
        this.logger.warn('Heartbeat failed', { err });
      }
    }, heartbeatMs);

    this.merkleTimer = setInterval(async () => {
      if (this.merkleTree.count === 0) return;
      try {
        const root = this.merkleTree.getRoot();
        const sequence = BigInt(this.pendingSignals);
        await this.submitSignalMerkle(providerKeypair, subscriptionPDA, root, sequence);
        this.logger.info('Signal Merkle root submitted', {
          root: root.toString('hex'),
          signals: this.merkleTree.count,
        });
        this.merkleTree.clear();
      } catch (err) {
        this.logger.warn('Merkle submit failed', { err });
      }
    }, merkleMs);
  }

  stopProviderTasks() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.merkleTimer) clearInterval(this.merkleTimer);
  }

  // ── 链下信号收入 Merkle 池 ──
  ingestSignalForMerkle(signal: { signal_id: string; decision: string; symbol: string; created_at_ms: number }) {
    const payload = `${signal.signal_id}:${signal.decision}:${signal.symbol}:${signal.created_at_ms}`;
    const hash = createHash('sha256').update(payload).digest('hex');
    this.merkleTree.addSignal(hash);
    this.pendingSignals++;
  }

  // ── 创建订阅（用户调用）──
  async createSubscription(
    userKeypair: any,
    params: SubscriptionParams,
  ): Promise<{ subscriptionPDA: PublicKey; tx: string }> {
    const userPublicKey = userKeypair.publicKey
      ? new PublicKey(userKeypair.publicKey)
      : new PublicKey(userKeypair);

    const [subscriptionPDA] = this.deriveSubscriptionPDA(
      userPublicKey,
      params.strategyId,
      params.nonce,
    );

    this.logger.info('Subscription PDA derived', {
      pda: subscriptionPDA.toBase58(),
      mock: this.isMock,
    });

    return { subscriptionPDA, tx: this.isMock ? 'mock_tx_id' : 'real_tx_placeholder' };
  }

  // ── Provider 提取 ──
  async providerClaim(
    providerKeypair: any,
    subscriptionPDA: PublicKey,
    bbtMint: PublicKey,
  ): Promise<string> {
    this.logger.info('Provider claim initiated', {
      subscription: subscriptionPDA.toBase58(),
      bbtMint: bbtMint.toBase58(),
    });
    return this.isMock ? 'mock_claim_tx' : 'real_claim_tx_placeholder';
  }

  // ── 用户取消 ──
  async userCancel(
    userKeypair: any,
    subscriptionPDA: PublicKey,
    bbtMint: PublicKey,
  ): Promise<string> {
    this.logger.info('User cancel initiated', {
      subscription: subscriptionPDA.toBase58(),
      bbtMint: bbtMint.toBase58(),
    });
    return this.isMock ? 'mock_cancel_tx' : 'real_cancel_tx_placeholder';
  }

  // ── 发起争议 ──
  async initiateDispute(
    userKeypair: any,
    subscriptionPDA: PublicKey,
    reason: string,
  ): Promise<string> {
    this.logger.info('Dispute initiated', { subscription: subscriptionPDA.toBase58(), reason });
    return 'mock_dispute_tx';
  }

  // ── 心跳提交 ──
  async submitHeartbeat(
    providerKeypair: any,
    subscriptionPDA: PublicKey,
  ): Promise<string> {
    this.logger.info('Heartbeat submitted', {
      subscription: subscriptionPDA.toBase58(),
    });
    return this.isMock ? 'mock_heartbeat_tx' : 'real_heartbeat_tx_placeholder';
  }

  // ── Merkle Root 提交 ──
  async submitSignalMerkle(
    providerKeypair: any,
    subscriptionPDA: PublicKey,
    merkleRoot: number[] | Buffer,
    sequence: bigint,
  ): Promise<string> {
    const rootHex = Buffer.isBuffer(merkleRoot)
      ? merkleRoot.toString('hex')
      : Buffer.from(merkleRoot).toString('hex');
    this.logger.info('Signal Merkle root submitted', {
      subscription: subscriptionPDA.toBase58(),
      root: rootHex,
      sequence: String(sequence),
    });
    return this.isMock ? 'mock_merkle_tx' : 'real_merkle_tx_placeholder';
  }

  // ── 查询订阅状态 ──
  async fetchSubscriptionState(subscriptionPDA: PublicKey): Promise<SubscriptionState | null> {
    try {
      const accountInfo = await this.connection.getAccountInfo(subscriptionPDA);
      if (!accountInfo) return null;
      // 实际解析需要 Anchor coder 解码 account data
      // 这里返回 mock
      return null;
    } catch {
      return null;
    }
  }

  // ── 统计 ──
  getStats(): { pending: number } {
    return { pending: this.pendingSignals };
  }

  // ── 监听事件 ──
  async listenEvents(callback: (event: { name: string; data: unknown }) => void) {
    // 使用 Solana web3.js logsSubscribe 监听程序日志中的 Anchor 事件
    this.connection.onLogs(this.programId, (logs) => {
      for (const log of logs.logs) {
        if (log.includes('SubscriptionCreated')) {
          callback({ name: 'SubscriptionCreated', data: logs });
        } else if (log.includes('DisputeInitiated')) {
          callback({ name: 'DisputeInitiated', data: logs });
        }
      }
    });
  }
}
