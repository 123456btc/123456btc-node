/**
 * SettlementEngine — Solana 链上 BBT 结算
 * 监听收款、确认订阅、处理按信号扣费
 */

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  SendTransactionError,
  Keypair,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
// @ts-ignore — @solana/spl-token is ESM-only but this file is loaded via tsx
} from '@solana/spl-token';
import type { ProviderConfig } from '../types/index.js';
import type { SubscriptionStore } from './SubscriptionStore.js';
import { SubscriptionEscrowClient } from '../infra/chain/SubscriptionEscrow.js';
import { ProviderHeartbeat } from './ProviderHeartbeat.js';
import { Logger } from '../infra/logger/Logger.js';

export interface PaymentIntent {
  subscription_id: string;
  strategy_id: string;
  user_wallet: string;
  amount_bbt: number;
}

export class SettlementEngine {
  private connection: Connection;
  private providerATA: PublicKey | null = null;
  private bbtMint: PublicKey;
  private providerWallet: PublicKey;
  private escrowClient: SubscriptionEscrowClient;
  private heartbeat?: ProviderHeartbeat;
  private logger: Logger;

  // 模式切换：'memo' = 旧版Memo解析, 'escrow' = 合约托管
  public mode: 'memo' | 'escrow' = 'memo';

  constructor(
    private config: ProviderConfig,
    private store: SubscriptionStore,
  ) {
    this.connection = new Connection(config.solana_rpc, 'confirmed');
    this.bbtMint = new PublicKey(config.bbt_mint);
    this.providerWallet = new PublicKey(config.wallet_address);
    this.logger = new Logger();
    this.escrowClient = new SubscriptionEscrowClient(this.logger, config.solana_rpc);
  }

  async init() {
    // 预计算 Provider 的 BBT ATA
    this.providerATA = await getAssociatedTokenAddress(
      this.bbtMint,
      this.providerWallet,
      true, // allow PDA owner for robustness
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  // ── 验证用户链上 BBT 余额 ──

  async getWalletBBTBalance(walletAddress: string): Promise<number> {
    try {
      const wallet = new PublicKey(walletAddress);
      const ata = await getAssociatedTokenAddress(
        this.bbtMint, wallet, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const account = await getAccount(this.connection, ata);
      return Number(account.amount) / 1e6; // 6 decimals
    } catch {
      return 0;
    }
  }

  // ── 验证指定交易是否为有效的 BBT 支付 ──

  async verifyPaymentTx(
    signature: string,
    expectedFromWallet: string,
    expectedToWallet: string,
    expectedAmountBbt: number,
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) return { valid: false, error: 'Transaction not found' };
      if (tx.meta?.err) return { valid: false, error: 'Transaction failed' };

      const instructions = tx.transaction.message.instructions;
      for (const ix of instructions) {
        if ((ix as any).program !== 'spl-token' && (ix as any).programId !== TOKEN_PROGRAM_ID.toBase58()) continue;
        const parsed = (ix as any).parsed;
        if (!parsed || parsed.type !== 'transfer') continue;

        const info = parsed.info;
        if (!info) continue;

        const fromWallet = info.sourceOwner || info.authority;
        const toWallet = info.destinationOwner;
        const amount = Number(info.amount) / 1e6;

        if (fromWallet !== expectedFromWallet) continue;
        if (toWallet !== expectedToWallet) continue;
        if (Math.abs(amount - expectedAmountBbt) > 0.01) continue;

        return { valid: true };
      }

      return { valid: false, error: 'No matching BBT transfer found in transaction' };
    } catch (e) {
      return { valid: false, error: `Verification error: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // ── 监听收款（日订阅确认）──

  async pollIncomingPayments(sinceSignature?: string): Promise<{ signature: string; amount: number; memo?: string; fromWallet: string }[]> {
    const signatures = await this.connection.getSignaturesForAddress(
      this.providerATA!,
      { limit: 20 },
      'finalized'
    );

    const results: { signature: string; amount: number; memo?: string; fromWallet: string }[] = [];

    // Filter valid signatures first, respecting sinceSignature stop condition
    const validSigs: typeof signatures = [];
    for (const sigInfo of signatures) {
      if (sinceSignature && sigInfo.signature === sinceSignature) break;
      if (sigInfo.err) continue;
      validSigs.push(sigInfo);
    }

    // Parallel processing with concurrency limit
    const CONCURRENT_LIMIT = 5;
    for (let i = 0; i < validSigs.length; i += CONCURRENT_LIMIT) {
      const batch = validSigs.slice(i, i + CONCURRENT_LIMIT);
      const batchResults = await Promise.allSettled(
        batch.map(async (sigInfo) => {
          const tx = await this.connection.getParsedTransaction(sigInfo.signature, {
            commitment: 'finalized',
            maxSupportedTransactionVersion: 0,
          });

          if (!tx?.meta?.postTokenBalances || !tx.meta.preTokenBalances) return null;

          // 计算 Provider ATA 的余额变化
          const pre = tx.meta.preTokenBalances.find(
            (b) => b.owner === this.config.wallet_address && b.mint === this.config.bbt_mint
          );
          const post = tx.meta.postTokenBalances.find(
            (b) => b.owner === this.config.wallet_address && b.mint === this.config.bbt_mint
          );

          if (!pre || !post) return null;

          const preAmount = Number(pre.uiTokenAmount.amount);
          const postAmount = Number(post.uiTokenAmount.amount);
          const delta = (postAmount - preAmount) / 1e6;

          if (delta <= 0) return null;

          // 提取真实发送方：preTokenBalances 中余额减少的钱包 owner
          const senderEntry = tx.meta.preTokenBalances.find(
            (b) => b.mint === this.config.bbt_mint
              && b.owner !== this.config.wallet_address
              && b.owner !== undefined
          );
          const fromWallet = senderEntry?.owner || 'unknown';
          // 尝试解析 memo（兼容多个版本的 Memo 程序）
          const MEMO_PROGRAM_IDS = [
            'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', // spl-memo v1/v3
            'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMz', // spl-memo v2 (legacy)
          ];

          const memoInstr = tx.transaction.message.instructions.find(
            (ix: Record<string, unknown>) => {
              if (ix.program === 'spl-memo' || ix.program === 'memo') return true;
              const programId = (ix as { programId?: string }).programId;
              return programId ? MEMO_PROGRAM_IDS.includes(programId) : false;
            }
          );

          let memo: string | undefined;
          if (memoInstr) {
            const instr = memoInstr as Record<string, unknown>;
            if (typeof instr.parsed === 'string') {
              memo = instr.parsed;
            } else if (typeof (instr as any).data === 'string') {
              // Some versions use base58-encoded 'data' field
              try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const bs58 = require('bs58') as { decode: (input: string) => Uint8Array };
                memo = Buffer.from(bs58.decode((instr as any).data)).toString('utf-8');
              } catch {
                memo = (instr as any).data;
              }
            }
          }

          return { signature: sigInfo.signature, amount: delta, memo, fromWallet };
        })
      );

      // Collect successful results
      for (const result of batchResults) {
        if (result.status === 'fulfilled' && result.value) {
          results.push(result.value);
        }
      }
    }

    return results;
  }

  // ── 构建转账指令（用户 → Provider）──

  async buildTransferTx(
    fromWallet: PublicKey,
    amountBbt: number,
    memo?: string,
  ): Promise<{ transaction: Transaction; recentBlockhash: string }> {
    const fromATA = await getAssociatedTokenAddress(
      this.bbtMint, fromWallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const tx = new Transaction();

    // 确保 Provider ATA 存在（通常已存在）
    const providerATA = this.providerATA!;

    // 可选：添加 memo 指令
    if (memo) {
      const { createMemoInstruction } = await import('@solana/spl-memo');
      tx.add(createMemoInstruction(memo));
    }

    tx.add(
      createTransferInstruction(
        fromATA,
        providerATA,
        fromWallet,
        BigInt(Math.round(amountBbt * 1e6)),
        [],
        TOKEN_PROGRAM_ID,
      )
    );

    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = fromWallet;

    return { transaction: tx, recentBlockhash: blockhash };
  }

  // ── 链上 burn（可选）──

  async getBurnTx(amountBbt: number, authority: PublicKey): Promise<Transaction> {
    // 简化：burn 由 Provider 在收款后自行操作
    // 实际实现需要 SPL Token burn 指令
    const tx = new Transaction();
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = authority;
    return tx;
  }

  // ═══════════════════════════════════════════════════════════
  // 合约托管模式（Escrow）接口 — 替代 Memo 解析
  // ═══════════════════════════════════════════════════════════

  /**
   * 启用合约托管模式
   * 传入 Provider keypair 后，自动启动 heartbeat + merkle 定时任务
   */
  enableEscrowMode(providerKeypair: Keypair, programId?: PublicKey) {
    this.mode = 'escrow';
    // 切换到真实客户端
    this.escrowClient = new SubscriptionEscrowClient(
      this.connection,
      providerKeypair as any, // Anchor Wallet adapter
      programId,
      this.logger,
    );
    this.heartbeat = new ProviderHeartbeat(
      {
        providerKeypair,
        programId: programId || new PublicKey('11111111111111111111111111111111'),
        vaultATA: this.providerATA!,
        cluster: this.config.solana_rpc,
      },
      this.store,
      this.logger,
      this.escrowClient,
    );
    this.heartbeat.start();
    this.logger.info('SettlementEngine switched to escrow mode');
  }

  /**
   * 构建创建订阅的合约调用参数
   * 用户端使用：生成交易让用户签名（SettlementEngine 不持有用户私钥，不做链上提交）
   */
  async buildEscrowSubscription(
    userWallet: PublicKey,
    strategyId: string,
    amountBbt: number,
    durationDays: number,
  ): Promise<{ subscriptionPDA: PublicKey; amount: number; memo: string }> {
    const nonce = BigInt(Date.now());
    const [subscriptionPDA] = this.escrowClient.deriveSubscriptionPDA(userWallet, strategyId, nonce);

    return {
      subscriptionPDA,
      amount: amountBbt,
      memo: `sub:${strategyId}:${subscriptionPDA.toBase58().slice(0, 16)}`,
    };
  }

  /**
   * Provider 提取已到期费用
   */
  async providerClaim(subscriptionPDA: PublicKey, providerKeypair: Keypair): Promise<string> {
    return this.escrowClient.providerClaim(providerKeypair, subscriptionPDA, this.bbtMint);
  }

  /**
   * 用户取消订阅（按比例退款）
   */
  async userCancel(subscriptionPDA: PublicKey, userKeypair: Keypair): Promise<string> {
    return this.escrowClient.userCancel(userKeypair, subscriptionPDA, this.bbtMint);
  }

  /**
   * 查询订阅链上状态
   */
  async getEscrowState(subscriptionPDA: PublicKey) {
    return this.escrowClient.fetchSubscriptionState(subscriptionPDA);
  }

  /**
   * 监听合约事件（订阅创建、争议等）
   */
  async listenEscrowEvents(callback: (event: { name: string; data: unknown }) => void) {
    return this.escrowClient.listenEvents(callback);
  }

  /**
   * 收入信号到 Merkle 池（用于服务证明）
   */
  ingestSignalForEscrow(signal: { signal_id: string; decision: string; symbol: string; created_at_ms: number }) {
    this.heartbeat?.ingestSignal(signal);
  }

  stop() {
    this.heartbeat?.stop();
    this.escrowClient.stopProviderTasks?.();
  }
}
