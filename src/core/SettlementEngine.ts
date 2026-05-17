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
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) return { valid: false, error: 'Transaction not found' };
      if (tx.meta?.err) return { valid: false, error: 'Transaction failed' };

      const instructions = tx.transaction.message.instructions;
      for (const ix of instructions) {
        if (ix.program !== 'spl-token' && (ix as any).programId !== TOKEN_PROGRAM_ID.toBase58()) continue;
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

  // ── 监听收款（日订阅确认） ──

  async pollIncomingPayments(sinceSignature?: string): Promise<{ signature: string; amount: number; memo?: string }[]> {
    const signatures = await this.connection.getSignaturesForAddress(
      this.providerATA!,
      { limit: 20 },
      'confirmed'
    );

    const results: { signature: string; amount: number; memo?: string }[] = [];

    for (const sigInfo of signatures) {
      if (sinceSignature && sigInfo.signature === sinceSignature) break;
      if (sigInfo.err) continue;

      const tx = await this.connection.getParsedTransaction(sigInfo.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (!tx?.meta?.postTokenBalances || !tx.meta.preTokenBalances) continue;

      // 计算 Provider ATA 的余额变化
      const pre = tx.meta.preTokenBalances.find(
        (b) => b.owner === this.config.wallet_address && b.mint === this.config.bbt_mint
      );
      const post = tx.meta.postTokenBalances.find(
        (b) => b.owner === this.config.wallet_address && b.mint === this.config.bbt_mint
      );

      if (!pre || !post) continue;

      const preAmount = Number(pre.uiTokenAmount.amount);
      const postAmount = Number(post.uiTokenAmount.amount);
      const delta = (postAmount - preAmount) / 1e6;

      if (delta > 0) {
        // 尝试解析 memo
        const memoInstr = tx.transaction.message.instructions.find(
          (ix: Record<string, unknown>) => ix.program === 'memo' || (ix as { programId?: string }).programId === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
        );
        const memo = memoInstr ? (memoInstr as { parsed?: string }).parsed : undefined;
        results.push({ signature: sigInfo.signature, amount: delta, memo });
      }
    }

    return results;
  }

  // ── 构建转账指令（用户 → Provider） ──

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

    // 可选：添加 memo
    if (memo) {
      tx.add(
        new Transaction().add(
          SystemProgram.transfer({ fromPubkey: fromWallet, toPubkey: fromWallet, lamports: 0 })
        )
      );
      // 实际 memo 需要使用 @solana/spl-memo，这里简化
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

  // ── 链上 burn（可选） ──

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
    this.heartbeat = new ProviderHeartbeat(
      {
        providerKeypair,
        programId: programId || new PublicKey('11111111111111111111111111111111'),
        vaultATA: this.providerATA!,
        cluster: this.config.solana_rpc,
      },
      this.store,
      this.logger,
    );
    this.heartbeat.start();
    this.logger.info('SettlementEngine switched to escrow mode');
  }

  /**
   * 构建创建订阅的合约调用参数
   * 用户端使用：生成交易让用户签名
   */
  async buildEscrowSubscription(
    userWallet: PublicKey,
    strategyId: string,
    amountBbt: number,
    durationDays: number,
  ): Promise<{ subscriptionPDA: PublicKey; amount: number; memo: string }> {
    const durationSeconds = durationDays * 86400;
    const amount = Math.round(amountBbt * 1e6); // lamports

    const { subscriptionPDA } = await this.escrowClient.createSubscription(
      { publicKey: userWallet } as any, // mock keypair interface
      {
        userWallet,
        providerWallet: this.providerWallet,
        strategyId,
        amount: BigInt(amount),
        durationSeconds,
      }
    );

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
    return this.escrowClient.providerClaim(providerKeypair, subscriptionPDA);
  }

  /**
   * 用户取消订阅（按比例退款）
   */
  async userCancel(subscriptionPDA: PublicKey, userKeypair: Keypair): Promise<string> {
    return this.escrowClient.userCancel(userKeypair, subscriptionPDA);
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
  }
}
