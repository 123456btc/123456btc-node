/**
 * ProviderHeartbeat — Provider 链上服务证明定时任务
 *
 * 职责：
 * 1. 每小时提交 heartbeat 到合约（证明服务在线）
 * 2. 每 5 分钟提交信号 Merkle Root（证明在发信号）
 * 3. 每天自动 claim 已到期费用
 * 4. 监听争议事件
 *
 * 与链下系统的衔接：
 * - 信号通过 libp2p-gossipsub 传播（纯链下）
 * - Merkle Root 聚合来自 SignalHub 的 ingestSignal 事件
 * - Heartbeat 是独立的链上 ping
 */

import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { Logger } from '../infra/logger/Logger.js';
import { SignalMerkleTree, SubscriptionEscrowClient } from '../infra/chain/SubscriptionEscrow.js';
import type { SubscriptionStore } from './SubscriptionStore.js';

export interface HeartbeatConfig {
  providerKeypair: Keypair;
  programId: PublicKey;
  vaultATA: PublicKey;
  cluster: string;
  heartbeatIntervalMs?: number;
  merkleIntervalMs?: number;
  claimIntervalMs?: number;
}

export class ProviderHeartbeat {
  private connection: Connection;
  private escrow: SubscriptionEscrowClient;
  private merkleTree = new SignalMerkleTree();
  private timers: ReturnType<typeof setInterval>[] = [];
  private pendingSignals = 0;

  constructor(
    private config: HeartbeatConfig,
    private store: SubscriptionStore,
    private logger: Logger,
  ) {
    this.connection = new Connection(config.cluster, 'confirmed');
    this.escrow = new SubscriptionEscrowClient(logger, config.cluster);
  }

  // ── 启动所有定时任务 ──
  start() {
    const hbMs = this.config.heartbeatIntervalMs || 3_600_000; // 1h
    const mkMs = this.config.merkleIntervalMs || 300_000; // 5min
    const clMs = this.config.claimIntervalMs || 86_400_000; // 24h

    // 1. Heartbeat: 证明 Provider 存活
    this.timers.push(
      setInterval(async () => {
        await this.runHeartbeat();
      }, hbMs)
    );

    // 2. Merkle Root: 证明信号服务
    this.timers.push(
      setInterval(async () => {
        await this.runMerkleSubmit();
      }, mkMs)
    );

    // 3. Auto Claim: 提取已到期费用
    this.timers.push(
      setInterval(async () => {
        await this.runAutoClaim();
      }, clMs)
    );

    this.logger.info('ProviderHeartbeat started', {
      heartbeatInterval: hbMs,
      merkleInterval: mkMs,
      claimInterval: clMs,
      provider: this.config.providerKeypair.publicKey.toBase58(),
    });
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.logger.info('ProviderHeartbeat stopped');
  }

  // ── 收入信号到 Merkle 池 ──
  ingestSignal(signal: { signal_id: string; decision: string; symbol: string; created_at_ms: number }) {
    this.escrow.ingestSignalForMerkle(signal);
    this.pendingSignals++;
  }

  // ── 内部：提交心跳 ──
  private async runHeartbeat() {
    try {
      // 实际实现需要 Anchor IDL + 构建 transaction
      // 这里记录意图，真实调用需接入 deployed program
      this.logger.info('Heartbeat tick', {
        provider: this.config.providerKeypair.publicKey.toBase58(),
        pendingSignals: this.pendingSignals,
      });
    } catch (err) {
      this.logger.warn('Heartbeat failed', { err });
    }
  }

  // ── 内部：提交 Merkle Root ──
  private async runMerkleSubmit() {
    const stats = this.escrow.getStats?.();
    if (!stats || (stats as any).pending === 0) return;

    try {
      this.logger.info('Merkle submit tick', {
        signals: this.pendingSignals,
        provider: this.config.providerKeypair.publicKey.toBase58(),
      });
      this.pendingSignals = 0;
    } catch (err) {
      this.logger.warn('Merkle submit failed', { err });
    }
  }

  // ── 内部：自动 claim ──
  private async runAutoClaim() {
    try {
      // 查询所有活跃订阅，逐个 claim
      // 实际实现需要遍历 subscription PDAs
      this.logger.info('Auto claim tick', {
        provider: this.config.providerKeypair.publicKey.toBase58(),
      });
    } catch (err) {
      this.logger.warn('Auto claim failed', { err });
    }
  }
}
