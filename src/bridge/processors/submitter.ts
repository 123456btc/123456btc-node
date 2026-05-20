/**
 * TransactionSubmitter — 提交跨链证明到目标链
 * 处理 Solana ↔ EVM 双向提交，含重试逻辑
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { ethers, Contract, Wallet, JsonRpcProvider } from 'ethers';
import fs from 'fs';
import { Logger } from '../../infra/logger/Logger.js';
import type { BridgeConfig, BridgeEvent, BridgeProof } from '../config.js';

// ── EVM 提交合约 ABI (仅 submitProof 函数) ──

const SUBMIT_ABI = [
  'function submitProof(bytes32 eventId, bytes32 merkleRoot, bytes32 leafHash, bytes32[] proof, bytes[] signatures) external',
];

// ── 提交结果 ──

export interface SubmitResult {
  success: boolean;
  tx_hash?: string;
  chain: 'solana' | 'evm';
  error?: string;
  attempts: number;
}

export class TransactionSubmitter {
  private config: BridgeConfig;
  private logger: Logger;

  // Solana
  private solanaConnection: Connection;
  private solanaKeypair: Keypair | null = null;

  // EVM
  private evmProvider: JsonRpcProvider;
  private evmWallet: Wallet | null = null;
  private evmContract: Contract | null = null;

  // 重试
  private retryQueue = new Map<string, { event: BridgeEvent; proof: BridgeProof; attempts: number }>();

  constructor(config: BridgeConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    this.solanaConnection = new Connection(config.solana_rpc, 'confirmed');
    this.evmProvider = new JsonRpcProvider(config.evm_rpc, config.evm_chain_id);
  }

  // ── 初始化签名者 ──

  async init(): Promise<void> {
    // 加载 Solana 中继器密钥
    if (this.config.solana_relayer_keypair_path) {
      try {
        const keypairData = JSON.parse(
          fs.readFileSync(this.config.solana_relayer_keypair_path, 'utf-8'),
        );
        this.solanaKeypair = Keypair.fromSecretKey(
          Buffer.from(keypairData),
        );
        this.logger.info('Solana relayer keypair loaded', {
          pubkey: this.solanaKeypair.publicKey.toBase58(),
        });
      } catch (err) {
        this.logger.warn('Failed to load Solana relayer keypair', {
          path: this.config.solana_relayer_keypair_path,
        });
      }
    }

    // 初始化 EVM 钱包
    if (this.config.evm_relayer_private_key) {
      this.evmWallet = new Wallet(this.config.evm_relayer_private_key, this.evmProvider);
      this.evmContract = new Contract(
        this.config.evm_bridge_contract,
        SUBMIT_ABI,
        this.evmWallet,
      );
      this.logger.info('EVM relayer wallet initialized', {
        address: this.evmWallet.address,
      });
    }
  }

  // ── 提交证明到目标链 ──

  async submitProof(event: BridgeEvent, proof: BridgeProof): Promise<SubmitResult> {
    this.logger.info('Submitting bridge proof', {
      event_id: event.id,
      target_chain: event.target_chain,
    });

    if (event.target_chain === 'evm') {
      return this.submitToEvm(event, proof);
    } else if (event.target_chain === 'solana') {
      return this.submitToSolana(event, proof);
    }

    return {
      success: false,
      chain: event.target_chain,
      error: `Unsupported target chain: ${event.target_chain}`,
      attempts: 0,
    };
  }

  // ── 带重试的提交 ──

  async submitWithRetry(event: BridgeEvent, proof: BridgeProof): Promise<SubmitResult> {
    const maxAttempts = this.config.max_retries;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.submitProof(event, proof);
      result.attempts = attempt;

      if (result.success) {
        this.retryQueue.delete(event.id);
        return result;
      }

      lastError = result.error;
      this.logger.warn('Bridge proof submission failed, retrying', {
        event_id: event.id,
        attempt,
        max_attempts: maxAttempts,
        error: lastError,
      });

      // 指数退避
      if (attempt < maxAttempts) {
        const delay = this.config.retry_delay_ms * Math.pow(2, attempt - 1);
        await this.sleep(delay);
      }
    }

    // 全部失败，加入重试队列
    this.retryQueue.set(event.id, { event, proof, attempts: maxAttempts });

    return {
      success: false,
      chain: event.target_chain,
      error: `Failed after ${maxAttempts} attempts: ${lastError}`,
      attempts: maxAttempts,
    };
  }

  // ── 处理重试队列 ──

  async processRetryQueue(): Promise<void> {
    if (this.retryQueue.size === 0) return;

    this.logger.info('Processing retry queue', { size: this.retryQueue.size });

    for (const [eventId, entry] of this.retryQueue) {
      const result = await this.submitProof(entry.event, entry.proof);

      if (result.success) {
        this.retryQueue.delete(eventId);
        this.logger.info('Retry successful', { event_id: eventId });
      } else {
        entry.attempts++;
        this.logger.warn('Retry failed', {
          event_id: eventId,
          error: result.error,
        });
      }
    }
  }

  // ── 提交到 EVM ──

  private async submitToEvm(event: BridgeEvent, proof: BridgeProof): Promise<SubmitResult> {
    if (!this.evmContract) {
      return {
        success: false,
        chain: 'evm',
        error: 'EVM relayer wallet not initialized',
        attempts: 0,
      };
    }

    try {
      const eventIdBytes = ethers.id(event.id).slice(0, 66); // bytes32
      const rootBytes = proof.merkle_root;
      const leafBytes = proof.leaf_hash;
      const proofBytes = proof.merkle_proof;
      const sigBytes = proof.signatures.map((s) => s.signature);

      const tx = await this.evmContract.submitProof(
        eventIdBytes,
        rootBytes,
        leafBytes,
        proofBytes,
        sigBytes,
      );

      const receipt = await tx.wait();

      if (receipt.status === 1) {
        this.logger.info('EVM proof submitted successfully', {
          tx_hash: receipt.hash,
          gas_used: receipt.gasUsed.toString(),
        });

        return {
          success: true,
          tx_hash: receipt.hash,
          chain: 'evm',
          attempts: 0,
        };
      }

      return {
        success: false,
        chain: 'evm',
        error: 'Transaction reverted',
        attempts: 0,
      };
    } catch (err) {
      return {
        success: false,
        chain: 'evm',
        error: err instanceof Error ? err.message : String(err),
        attempts: 0,
      };
    }
  }

  // ── 提交到 Solana ──

  private async submitToSolana(event: BridgeEvent, proof: BridgeProof): Promise<SubmitResult> {
    if (!this.solanaKeypair) {
      return {
        success: false,
        chain: 'solana',
        error: 'Solana relayer keypair not loaded',
        attempts: 0,
      };
    }

    try {
      const programId = new PublicKey(this.config.solana_bridge_program);

      // 构建指令数据: [discriminator(8)] + [event_id(32)] + [merkle_root(32)] + [proof_data]
      const eventIdBuf = Buffer.from(event.id.padEnd(32, '\0').slice(0, 32), 'utf-8');
      const rootBuf = Buffer.from(proof.merkle_root.slice(2), 'hex');
      const leafBuf = Buffer.from(proof.leaf_hash.slice(2), 'hex');

      // 序列化 proof 和 signatures
      const proofData = Buffer.concat(
        proof.merkle_proof.map((p) => Buffer.from(p.slice(2), 'hex')),
      );
      const sigData = Buffer.concat(
        proof.signatures.map((s) => Buffer.from(s.signature.slice(2), 'hex')),
      );

      // Discriminator: sha256("global:submit_bridge_proof")[0..8]
      const discBuf = Buffer.from([0x9a, 0x3b, 0x7c, 0xd2, 0xe1, 0x5f, 0x8a, 0x04]);

      const data = Buffer.concat([discBuf, eventIdBuf, rootBuf, leafBuf, proofData, sigData]);

      const instruction = new TransactionInstruction({
        keys: [
          { pubkey: this.solanaKeypair.publicKey, isSigner: true, isWritable: true },
          { pubkey: programId, isSigner: false, isWritable: false },
        ],
        programId,
        data,
      });

      const tx = new Transaction().add(instruction);
      const { blockhash } = await this.solanaConnection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = this.solanaKeypair.publicKey;
      tx.sign(this.solanaKeypair);

      const signature = await this.solanaConnection.sendRawTransaction(tx.serialize());

      // 等待确认
      const confirmation = await this.solanaConnection.confirmTransaction(signature, 'confirmed');

      if (confirmation.value.err) {
        return {
          success: false,
          chain: 'solana',
          error: `Transaction confirmed with error: ${JSON.stringify(confirmation.value.err)}`,
          attempts: 0,
        };
      }

      this.logger.info('Solana proof submitted successfully', { tx_hash: signature });

      return {
        success: true,
        tx_hash: signature,
        chain: 'solana',
        attempts: 0,
      };
    } catch (err) {
      return {
        success: false,
        chain: 'solana',
        error: err instanceof Error ? err.message : String(err),
        attempts: 0,
      };
    }
  }

  // ── 获取重试队列大小 ──

  getRetryQueueSize(): number {
    return this.retryQueue.size;
  }

  // ── 工具方法 ──

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
