/**
 * SolanaListener — 监听 Solana 桥接合约事件
 * 事件: lock_bbt (用户锁定 BBT), unlock_bbt (中继器解锁 BBT 给用户)
 */

import {
  Connection,
  PublicKey,
  Keypair,
  type Logs,
  type Context,
} from '@solana/web3.js';
import { Logger } from '../../infra/logger/Logger.js';
import type { BridgeConfig, BridgeEvent } from '../config.js';

// ── 链上事件 Discriminator (Anchor 风格, sha256 全限定名称取前 8 字节) ──

const LOCK_BBT_DISC = Buffer.from([0xdd, 0x13, 0x7a, 0x6c, 0xef, 0x9a, 0x2f, 0x7c]);
const UNLOCK_BBT_DISC = Buffer.from([0xf1, 0xc2, 0x3a, 0x8b, 0x4e, 0x67, 0x9d, 0x01]);

// ── 事件数据解析 ──

export interface SolanaLockEvent {
  sender: string;
  recipient: string;
  amount: bigint;
  token: string;
  nonce: bigint;
  target_chain: number;
  tx_hash: string;
  slot: number;
}

export interface SolanaUnlockEvent {
  recipient: string;
  amount: bigint;
  token: string;
  nonce: bigint;
  source_tx_hash: string;
  tx_hash: string;
  slot: number;
}

export type SolanaBridgeEventCallback = (event: BridgeEvent) => void | Promise<void>;

export class SolanaListener {
  private connection: Connection;
  private programId: PublicKey;
  private logger: Logger;
  private config: BridgeConfig;
  private subscriptionId: number | null = null;
  private callbacks: SolanaBridgeEventCallback[] = [];
  private running = false;
  private processedTxs = new Set<string>();

  constructor(config: BridgeConfig, logger: Logger) {
    this.config = config;
    this.connection = new Connection(config.solana_rpc, 'confirmed');
    this.programId = new PublicKey(config.solana_bridge_program);
    this.logger = logger;
  }

  // ── 注册事件回调 ──

  onEvent(callback: SolanaBridgeEventCallback): void {
    this.callbacks.push(callback);
  }

  // ── 启动监听 ──

  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('SolanaListener already running');
      return;
    }

    this.running = true;
    this.logger.info('Starting Solana bridge listener', {
      program: this.config.solana_bridge_program,
      rpc: this.config.solana_rpc,
    });

    // 方式 1: 订阅日志（推荐，低延迟）
    this.subscriptionId = this.connection.onLogs(
      this.programId,
      (logs: Logs, ctx: Context) => {
        void this.handleLogs(logs, ctx);
      },
      'confirmed',
    );

    this.logger.info('Solana log subscription active', { subscriptionId: this.subscriptionId });
  }

  // ── 停止监听 ──

  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    if (this.subscriptionId !== null) {
      await this.connection.removeOnLogsListener(this.subscriptionId);
      this.subscriptionId = null;
    }

    this.logger.info('Solana bridge listener stopped');
  }

  // ── 处理日志 ──

  private async handleLogs(logs: Logs, ctx: Context): Promise<void> {
    const txSignature = logs.signature;

    // 去重
    if (this.processedTxs.has(txSignature)) return;
    this.processedTxs.add(txSignature);

    // 防止 Set 无限增长
    if (this.processedTxs.size > 10000) {
      const entries = Array.from(this.processedTxs);
      this.processedTxs = new Set(entries.slice(-5000));
    }

    if (logs.err) {
      this.logger.debug('Skipping failed Solana tx', { tx: txSignature });
      return;
    }

    try {
      // 解析程序日志中的事件数据
      const events = this.parseEventsFromLogs(logs.logs, txSignature, ctx.slot);

      for (const event of events) {
        this.logger.info('Solana bridge event detected', {
          event_name: event.event_name,
          tx: txSignature.slice(0, 16) + '...',
          amount: event.amount_human,
        });

        // 触发回调
        for (const cb of this.callbacks) {
          try {
            await cb(event);
          } catch (err) {
            this.logger.error('Solana event callback error', err as Error, {
              tx: txSignature,
            });
          }
        }
      }
    } catch (err) {
      this.logger.error('Failed to parse Solana bridge logs', err as Error, {
        tx: txSignature,
      });
    }
  }

  // ── 从程序日志解析事件 ──

  private parseEventsFromLogs(
    logMessages: string[],
    txSignature: string,
    slot: number,
  ): BridgeEvent[] {
    const events: BridgeEvent[] = [];

    for (const msg of logMessages) {
      // Anchor 事件格式: "Program data: <base64>"
      if (!msg.startsWith('Program data: ')) continue;

      const base64Data = msg.slice('Program data: '.length);
      let data: Buffer;
      try {
        data = Buffer.from(base64Data, 'base64');
      } catch {
        continue;
      }

      if (data.length < 8) continue;

      const discriminator = data.subarray(0, 8);

      if (discriminator.equals(LOCK_BBT_DISC)) {
        const parsed = this.parseLockEvent(data.subarray(8));
        if (parsed) {
          events.push({
            id: `solana:${txSignature}:lock:${parsed.nonce.toString()}`,
            source_chain: 'solana',
            target_chain: 'evm',
            event_name: 'lock_bbt',
            sender: parsed.sender,
            recipient: parsed.recipient,
            amount: parsed.amount.toString(),
            amount_human: (Number(parsed.amount) / 1e6).toFixed(6),
            token: parsed.token,
            tx_hash: txSignature,
            block_number: slot,
            timestamp: Math.floor(Date.now() / 1000),
            nonce: parsed.nonce.toString(),
            raw_data: base64Data,
            status: 'pending',
            created_at: Date.now(),
            updated_at: Date.now(),
          });
        }
      } else if (discriminator.equals(UNLOCK_BBT_DISC)) {
        const parsed = this.parseUnlockEvent(data.subarray(8));
        if (parsed) {
          events.push({
            id: `solana:${txSignature}:unlock:${parsed.nonce.toString()}`,
            source_chain: 'evm',
            target_chain: 'solana',
            event_name: 'unlock_bbt',
            sender: '',
            recipient: parsed.recipient,
            amount: parsed.amount.toString(),
            amount_human: (Number(parsed.amount) / 1e6).toFixed(6),
            token: parsed.token,
            tx_hash: txSignature,
            block_number: slot,
            timestamp: Math.floor(Date.now() / 1000),
            nonce: parsed.nonce.toString(),
            raw_data: base64Data,
            status: 'confirmed',
            created_at: Date.now(),
            updated_at: Date.now(),
          });
        }
      }
    }

    return events;
  }

  // ── 解析 lock_bbt 事件数据 ──
  // Layout: sender(32) + recipient(32) + amount(8) + token(32) + nonce(8) + target_chain(2)

  private parseLockEvent(data: Buffer): SolanaLockEvent | null {
    if (data.length < 114) return null;

    let offset = 0;
    const sender = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    const recipient = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    const amount = data.readBigUInt64LE(offset);
    offset += 8;
    const token = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    const nonce = data.readBigUInt64LE(offset);
    offset += 8;
    const targetChain = data.readUInt16LE(offset);

    return { sender, recipient, amount, token, nonce, target_chain: targetChain, tx_hash: '', slot: 0 };
  }

  // ── 解析 unlock_bbt 事件数据 ──
  // Layout: recipient(32) + amount(8) + token(32) + nonce(8) + source_tx_hash(32)

  private parseUnlockEvent(data: Buffer): SolanaUnlockEvent | null {
    if (data.length < 112) return null;

    let offset = 0;
    const recipient = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    const amount = data.readBigUInt64LE(offset);
    offset += 8;
    const token = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    const nonce = data.readBigUInt64LE(offset);
    offset += 8;
    const sourceTxHash = data.subarray(offset, offset + 32).toString('hex');

    return { recipient, amount, token, nonce, source_tx_hash: sourceTxHash, tx_hash: '', slot: 0 };
  }

  // ── 获取 Connection (供外部使用) ──

  getConnection(): Connection {
    return this.connection;
  }

  isRunning(): boolean {
    return this.running;
  }
}
