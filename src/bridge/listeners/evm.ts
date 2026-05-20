/**
 * EvmListener — 监听 EVM 桥接合约事件
 * 事件: BBTLocked, BBTUnlocked
 */

import { ethers, Contract, JsonRpcProvider, type EventLog, type Log } from 'ethers';
import { Logger } from '../../infra/logger/Logger.js';
import type { BridgeConfig, BridgeEvent } from '../config.js';

// ── 桥接合约 ABI (仅事件部分) ──

const BRIDGE_ABI = [
  // 用户锁定 BBT，准备跨链到目标链
  'event BBTLocked(address indexed sender, uint256 amount, uint256 targetChain, bytes32 targetAddress, uint256 timestamp, uint256 nonce)',
  // 中继器解锁 BBT，将跨过来的 BBT 释放给用户
  'event BBTUnlocked(address indexed recipient, uint256 amount, uint256 sourceChain, bytes32 sourceTxHash, uint256 timestamp)',
  // 中继器铸造 wrapped BBT（目标链收到跨链资产）
  'event BBTMinted(address indexed to, uint256 amount, uint256 sourceChain, bytes32 sourceTxHash, uint256 timestamp)',
  // 销毁 wrapped BBT（反向桥接）
  'event BBTBurned(address indexed from, uint256 amount, uint256 timestamp)',
];

export type EvmBridgeEventCallback = (event: BridgeEvent) => void | Promise<void>;

export class EvmListener {
  private provider: JsonRpcProvider;
  private contract: Contract;
  private logger: Logger;
  private config: BridgeConfig;
  private callbacks: EvmBridgeEventCallback[] = [];
  private running = false;
  private lastProcessedBlock = 0;

  constructor(config: BridgeConfig, logger: Logger) {
    this.config = config;
    this.provider = new JsonRpcProvider(config.evm_rpc, config.evm_chain_id);
    this.contract = new Contract(config.evm_bridge_contract, BRIDGE_ABI, this.provider);
    this.logger = logger;
  }

  // ── 注册事件回调 ──

  onEvent(callback: EvmBridgeEventCallback): void {
    this.callbacks.push(callback);
  }

  // ── 启动实时监听 ──

  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('EvmListener already running');
      return;
    }

    this.running = true;

    // 记录启动时的区块高度，只处理新事件
    this.lastProcessedBlock = await this.provider.getBlockNumber();

    this.logger.info('Starting EVM bridge listener', {
      contract: this.config.evm_bridge_contract,
      chain_id: this.config.evm_chain_id,
      from_block: this.lastProcessedBlock,
    });

    // 监听 BBTLocked (用户锁定BBT跨链)
    this.contract.on(
      'BBTLocked',
      (sender, amount, targetChain, targetAddress, timestamp, nonce, event) => {
        void this.handleLockedEvent(
          sender, amount, targetChain, targetAddress, timestamp, nonce, event,
        );
      },
    );

    // 监听 BBTUnlocked (中继器解锁BBT给用户)
    this.contract.on(
      'BBTUnlocked',
      (recipient, amount, sourceChain, sourceTxHash, timestamp, event) => {
        void this.handleUnlockedEvent(
          recipient, amount, sourceChain, sourceTxHash, timestamp, event,
        );
      },
    );

    // 监听 BBTMinted (中继器铸造wrapped BBT)
    this.contract.on(
      'BBTMinted',
      (to, amount, sourceChain, sourceTxHash, timestamp, event) => {
        void this.handleMintedEvent(
          to, amount, sourceChain, sourceTxHash, timestamp, event,
        );
      },
    );

    this.logger.info('EVM event listeners registered');
  }

  // ── 停止监听 ──

  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;
    await this.contract.removeAllListeners();

    this.logger.info('EVM bridge listener stopped');
  }

  // ── 处理 BBTLocked 事件 ──

  private async handleLockedEvent(
    sender: string,
    amount: bigint,
    targetChain: bigint,
    targetAddress: string,
    timestamp: bigint,
    nonce: bigint,
    event: EventLog,
  ): Promise<void> {
    const txHash = (event as unknown as { transactionHash: string }).transactionHash;
    const blockNumber = (event as unknown as { blockNumber: number }).blockNumber;

    try {
      const bridgeEvent: BridgeEvent = {
        id: `evm:${txHash}:lock:${nonce.toString()}`,
        source_chain: 'evm',
        target_chain: 'solana',
        event_name: 'BBTLocked',
        sender,
        recipient: '', // targetAddress is bytes32, not a direct address
        amount: amount.toString(),
        amount_human: ethers.formatEther(amount),
        token: '', // no token field in this event
        tx_hash: txHash,
        block_number: blockNumber,
        timestamp: Number(timestamp),
        nonce: nonce.toString(),
        raw_data: JSON.stringify({
          targetAddress: Buffer.from(targetAddress).toString('hex'),
          targetChain: targetChain.toString(),
        }),
        status: 'pending',
        created_at: Date.now(),
        updated_at: Date.now(),
      };

      this.logger.info('EVM BBTLocked event detected', {
        tx: txHash.slice(0, 16) + '...',
        sender,
        amount: bridgeEvent.amount_human,
        nonce: nonce.toString(),
        targetChain: targetChain.toString(),
      });

      for (const cb of this.callbacks) {
        try {
          await cb(bridgeEvent);
        } catch (err) {
          this.logger.error('EVM locked event callback error', err as Error, { tx: txHash });
        }
      }
    } catch (err) {
      this.logger.error('Failed to process BBTLocked event', err as Error, { tx: txHash });
    }
  }

  // ── 处理 BBTUnlocked 事件 ──

  private async handleUnlockedEvent(
    recipient: string,
    amount: bigint,
    sourceChain: bigint,
    sourceTxHash: string,
    timestamp: bigint,
    event: EventLog,
  ): Promise<void> {
    const txHash = (event as unknown as { transactionHash: string }).transactionHash;
    const blockNumber = (event as unknown as { blockNumber: number }).blockNumber;

    try {
      const bridgeEvent: BridgeEvent = {
        id: `evm:${txHash}:unlock:${Date.now()}`,
        source_chain: 'solana',
        target_chain: 'evm',
        event_name: 'BBTUnlocked',
        sender: '',
        recipient,
        amount: amount.toString(),
        amount_human: ethers.formatEther(amount),
        token: '',
        tx_hash: txHash,
        block_number: blockNumber,
        timestamp: Number(timestamp),
        nonce: '',
        raw_data: JSON.stringify({
          sourceTxHash: Buffer.from(sourceTxHash).toString('hex'),
          sourceChain: sourceChain.toString(),
        }),
        status: 'confirmed',
        created_at: Date.now(),
        updated_at: Date.now(),
      };

      this.logger.info('EVM BBTUnlocked event detected', {
        tx: txHash.slice(0, 16) + '...',
        recipient,
        amount: bridgeEvent.amount_human,
      });

      for (const cb of this.callbacks) {
        try {
          await cb(bridgeEvent);
        } catch (err) {
          this.logger.error('EVM unlocked event callback error', err as Error, { tx: txHash });
        }
      }
    } catch (err) {
      this.logger.error('Failed to process BBTUnlocked event', err as Error, { tx: txHash });
    }
  }

  // ── 处理 BBTMinted 事件 ──

  private async handleMintedEvent(
    to: string,
    amount: bigint,
    sourceChain: bigint,
    sourceTxHash: string,
    timestamp: bigint,
    event: EventLog,
  ): Promise<void> {
    const txHash = (event as unknown as { transactionHash: string }).transactionHash;
    const blockNumber = (event as unknown as { blockNumber: number }).blockNumber;

    try {
      const bridgeEvent: BridgeEvent = {
        id: `evm:${txHash}:mint:${Date.now()}`,
        source_chain: 'solana',
        target_chain: 'evm',
        event_name: 'BBTMinted',
        sender: '',
        recipient: to,
        amount: amount.toString(),
        amount_human: ethers.formatEther(amount),
        token: '',
        tx_hash: txHash,
        block_number: blockNumber,
        timestamp: Number(timestamp),
        nonce: '',
        raw_data: JSON.stringify({
          sourceTxHash: Buffer.from(sourceTxHash).toString('hex'),
          sourceChain: sourceChain.toString(),
        }),
        status: 'confirmed',
        created_at: Date.now(),
        updated_at: Date.now(),
      };

      this.logger.info('EVM BBTMinted event detected', {
        tx: txHash.slice(0, 16) + '...',
        to,
        amount: bridgeEvent.amount_human,
      });

      for (const cb of this.callbacks) {
        try {
          await cb(bridgeEvent);
        } catch (err) {
          this.logger.error('EVM minted event callback error', err as Error, { tx: txHash });
        }
      }
    } catch (err) {
      this.logger.error('Failed to process BBTMinted event', err as Error, { tx: txHash });
    }
  }

  // ── 获取历史事件（补扫） ──

  async scanHistoricalEvents(fromBlock: number, toBlock?: number): Promise<BridgeEvent[]> {
    const endBlock = toBlock || await this.provider.getBlockNumber();
    const events: BridgeEvent[] = [];

    this.logger.info('Scanning historical EVM events', { from: fromBlock, to: endBlock });

    // 扫描 BBTLocked 事件
    const lockedFilter = this.contract.filters.BBTLocked();
    const lockedLogs = await this.contract.queryFilter(lockedFilter, fromBlock, endBlock);

    for (const log of lockedLogs) {
      if (!('args' in log)) continue;
      const { sender, amount, targetChain, targetAddress, timestamp, nonce } = log.args;
      const blockNumber = log.blockNumber;

      events.push({
        id: `evm:${log.transactionHash}:lock:${nonce.toString()}`,
        source_chain: 'evm',
        target_chain: 'solana',
        event_name: 'BBTLocked',
        sender: String(sender),
        recipient: '',
        amount: amount.toString(),
        amount_human: ethers.formatEther(amount),
        token: '',
        tx_hash: log.transactionHash,
        block_number: blockNumber,
        timestamp: Number(timestamp),
        nonce: nonce.toString(),
        raw_data: JSON.stringify({ targetAddress: Buffer.from(targetAddress).toString('hex'), targetChain: targetChain.toString() }),
        status: 'pending',
        created_at: Date.now(),
        updated_at: Date.now(),
      });
    }

    // 扫描 BBTUnlocked 事件
    const unlockedFilter = this.contract.filters.BBTUnlocked();
    const unlockedLogs = await this.contract.queryFilter(unlockedFilter, fromBlock, endBlock);

    for (const log of unlockedLogs) {
      if (!('args' in log)) continue;
      const { recipient, amount, sourceChain, sourceTxHash, timestamp } = log.args;
      const blockNumber = log.blockNumber;

      events.push({
        id: `evm:${log.transactionHash}:unlock:${Date.now()}`,
        source_chain: 'solana',
        target_chain: 'evm',
        event_name: 'BBTUnlocked',
        sender: '',
        recipient: String(recipient),
        amount: amount.toString(),
        amount_human: ethers.formatEther(amount),
        token: '',
        tx_hash: log.transactionHash,
        block_number: blockNumber,
        timestamp: Number(timestamp),
        nonce: '',
        raw_data: JSON.stringify({ sourceTxHash: Buffer.from(sourceTxHash).toString('hex'), sourceChain: sourceChain.toString() }),
        status: 'confirmed',
        created_at: Date.now(),
        updated_at: Date.now(),
      });
    }

    // 扫描 BBTMinted 事件
    const mintedFilter = this.contract.filters.BBTMinted();
    const mintedLogs = await this.contract.queryFilter(mintedFilter, fromBlock, endBlock);

    for (const log of mintedLogs) {
      if (!('args' in log)) continue;
      const { to, amount, sourceChain, sourceTxHash, timestamp } = log.args;
      const blockNumber = log.blockNumber;

      events.push({
        id: `evm:${log.transactionHash}:mint:${Date.now()}`,
        source_chain: 'solana',
        target_chain: 'evm',
        event_name: 'BBTMinted',
        sender: '',
        recipient: String(to),
        amount: amount.toString(),
        amount_human: ethers.formatEther(amount),
        token: '',
        tx_hash: log.transactionHash,
        block_number: blockNumber,
        timestamp: Number(timestamp),
        nonce: '',
        raw_data: JSON.stringify({ sourceTxHash: Buffer.from(sourceTxHash).toString('hex'), sourceChain: sourceChain.toString() }),
        status: 'confirmed',
        created_at: Date.now(),
        updated_at: Date.now(),
      });
    }

    this.logger.info('Historical scan complete', { events_found: events.length });
    return events;
  }

  // ── 工具方法 ──

  private async getBlockTimestamp(blockNumber: number): Promise<number> {
    try {
      const block = await this.provider.getBlock(blockNumber);
      return block?.timestamp ?? Math.floor(Date.now() / 1000);
    } catch {
      return Math.floor(Date.now() / 1000);
    }
  }

  getProvider(): JsonRpcProvider {
    return this.provider;
  }

  getContract(): Contract {
    return this.contract;
  }

  isRunning(): boolean {
    return this.running;
  }
}
