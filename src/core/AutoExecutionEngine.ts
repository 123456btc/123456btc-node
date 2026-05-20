/**
 * AutoExecutionEngine — 信号触发自动交易执行
 *
 * 架构：
 * 1. 监听 SignalHub 的 ingestSignal 事件
 * 2. 根据信号决策（enter/exit/reduce）决定交易方向
 * 3. 查询用户执行钱包余额
 * 4. 调用 JupiterClient 获取 swap route
 * 5. 构建并发送交易
 *
 * 用户授权模型（MVP）：
 * - 用户创建"执行钱包"（平台生成 Keypair，用户自己备份助记词）
 * - 用户预存 USDC 到执行钱包
 * - 平台持有执行钱包私钥，用于自动下单
 * - 用户随时可提现并删除执行钱包
 * - ⚠️ 明确告知用户：执行钱包为托管模式，建议只存小额资金
 *
 * 未来升级：
 * - Session Keys：用户授权一个有限时间/金额的子密钥
 * - MPC：私钥分片，平台无法单独动用资金
 * - Smart Wallet (Squads)：多签代理执行
 */

import 'reflect-metadata';
import { singleton } from 'tsyringe';
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
// @ts-ignore — @solana/spl-token is ESM-only; runtime import works in Node16+ module resolution
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { Logger } from '../infra/logger/Logger.js';
import { JupiterClient } from '../infra/chain/JupiterClient.js';
import type { Signal } from '../types/index.js';
import type { SubscriptionStore } from './SubscriptionStore.js';

export interface ExecutionConfig {
  rpcUrl: string;
  bbtMint: string;
  maxSlippageBps: number;
  minUsdcForExecution: number; // 最小执行金额，如 5 USDC
  defaultUsdcPerTrade: number; // 默认单笔金额，如 20 USDC
}

export interface ExecutionWallet {
  id: string;
  userId: string;
  strategyId: string;
  keypair: Keypair; // 执行钱包的 keypair
  createdAt: number;
  maxDailyVolume: number; // 每日最大交易量（USDC）
  todayVolume: number;
  lastTradeAt: number;
  enabled: boolean;
}

export interface TradeRecord {
  id: string;
  signalId: string;
  strategyId: string;
  userId: string;
  decision: string;
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  outputAmount: number;
  txSignature: string;
  status: 'pending' | 'success' | 'failed';
  createdAt: number;
}

@singleton()
export class AutoExecutionEngine {
  private connection: Connection;
  private wallets = new Map<string, ExecutionWallet>(); // userId:strategyId -> wallet
  private trades: TradeRecord[] = [];

  constructor(
    private logger: Logger,
    private jupiter: JupiterClient,
    private config: ExecutionConfig,
    private store?: SubscriptionStore,
  ) {
    this.connection = new Connection(config.rpcUrl, 'confirmed');
  }

  // ── 注册执行钱包 ──
  registerWallet(userId: string, strategyId: string, keypair: Keypair, maxDailyVolume = 100): ExecutionWallet {
    const id = `exec_${userId}_${strategyId}_${Date.now()}`;
    const wallet: ExecutionWallet = {
      id,
      userId,
      strategyId,
      keypair,
      createdAt: Date.now(),
      maxDailyVolume,
      todayVolume: 0,
      lastTradeAt: 0,
      enabled: true,
    };
    this.wallets.set(`${userId}:${strategyId}`, wallet);
    this.logger.info('Execution wallet registered', { id, userId, strategyId, pubkey: keypair.publicKey.toBase58() });
    return wallet;
  }

  // ── 删除执行钱包 ──
  unregisterWallet(userId: string, strategyId: string) {
    const key = `${userId}:${strategyId}`;
    const wallet = this.wallets.get(key);
    if (wallet) {
      // 安全擦除私钥
      wallet.keypair.secretKey.fill(0);
      this.wallets.delete(key);
      this.logger.info('Execution wallet unregistered', { userId, strategyId });
    }
  }

  // ── 获取执行钱包地址 ──
  getWalletAddress(userId: string, strategyId: string): string | null {
    return this.wallets.get(`${userId}:${strategyId}`)?.keypair.publicKey.toBase58() || null;
  }

  // ── 查询执行钱包 USDC 余额 ──
  async getWalletUsdcBalance(walletPubkey: PublicKey): Promise<number> {
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    try {
      const ata = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), walletPubkey);
      const account = await getAccount(this.connection, ata);
      return Number(account.amount) / 1e6;
    } catch {
      return 0;
    }
  }

  // ── 核心：信号触发执行 ──
  async executeSignal(signal: Signal, targetTokenMint: string): Promise<TradeRecord[]> {
    const results: TradeRecord[] = [];
    const decision = signal.decision;

    // 只处理 enter / exit / reduce
    if (!['enter', 'exit', 'reduce'].includes(decision)) {
      return results;
    }

    // 查找所有订阅了该策略且启用了自动执行的用户钱包
    for (const [key, wallet] of this.wallets) {
      if (!wallet.enabled) continue;
      if (wallet.strategyId !== signal.strategy_id) continue;

      // 日限额检查
      if (wallet.todayVolume >= wallet.maxDailyVolume) {
        this.logger.debug('Daily volume limit reached', { wallet: wallet.id });
        continue;
      }

      try {
        const record = await this.executeTrade(wallet, signal, targetTokenMint, decision);
        if (record) results.push(record);
      } catch (err) {
        this.logger.warn('Auto-execution failed for wallet', { wallet: wallet.id, err });
      }
    }

    return results;
  }

  // ── 单笔交易执行 ──
  private async executeTrade(
    wallet: ExecutionWallet,
    signal: Signal,
    targetTokenMint: string,
    decision: string,
  ): Promise<TradeRecord | null> {
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const usdcBalance = await this.getWalletUsdcBalance(wallet.keypair.publicKey);

    if (usdcBalance < this.config.minUsdcForExecution) {
      this.logger.debug('Insufficient USDC balance', { wallet: wallet.id, balance: usdcBalance });
      return null;
    }

    let quote = null;
    let inputMint = '';
    let outputMint = '';
    let inputAmountLamports = '';

    if (decision === 'enter') {
      // USDC → target token（做多）
      const amountUsdc = Math.min(this.config.defaultUsdcPerTrade, usdcBalance);
      inputMint = USDC_MINT;
      outputMint = targetTokenMint;
      inputAmountLamports = String(Math.round(amountUsdc * 1e6));
      quote = await this.jupiter.quoteBuy(targetTokenMint, inputAmountLamports);
    } else if (decision === 'exit' || decision === 'reduce') {
      // target token → USDC（平仓）
      // 先查目标 token 余额
      const targetAta = await getAssociatedTokenAddress(new PublicKey(targetTokenMint), wallet.keypair.publicKey);
      let targetBalance = '0';
      try {
        const account = await getAccount(this.connection, targetAta);
        targetBalance = String(account.amount);
      } catch {
        this.logger.debug('No target token balance', { wallet: wallet.id });
        return null;
      }

      const sellPercent = decision === 'exit' ? 1.0 : 0.5; // exit全卖，reduce卖50%
      const sellAmount = BigInt(targetBalance) * BigInt(Math.round(sellPercent * 100)) / 100n;

      inputMint = targetTokenMint;
      outputMint = USDC_MINT;
      inputAmountLamports = String(sellAmount);
      quote = await this.jupiter.quoteSell(targetTokenMint, inputAmountLamports);
    }

    if (!quote) {
      this.logger.warn('No Jupiter route found', { decision, wallet: wallet.id });
      return null;
    }

    // 构建交易
    const swapTx = await this.jupiter.getSwapTransaction(
      quote,
      wallet.keypair.publicKey.toBase58(),
      { prioritizationFeeLamports: 50000 },
    );

    if (!swapTx) {
      this.logger.warn('Failed to build swap transaction', { wallet: wallet.id });
      return null;
    }

    // 反序列化并签名
    const txBuffer = Buffer.from(swapTx.swapTransaction, 'base64');
    let transaction: Transaction | VersionedTransaction;
    let isVersioned = false;

    try {
      transaction = VersionedTransaction.deserialize(txBuffer);
      isVersioned = true;
    } catch {
      transaction = Transaction.from(txBuffer);
    }

    // 签名
    if (isVersioned) {
      (transaction as VersionedTransaction).sign([wallet.keypair]);
    } else {
      (transaction as Transaction).partialSign(wallet.keypair);
    }

    // 发送
    const rawTx = isVersioned
      ? Buffer.from((transaction as VersionedTransaction).serialize())
      : transaction.serialize();

    const signature = await this.connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    this.logger.info('Auto-execution trade sent', {
      signature,
      wallet: wallet.id,
      decision,
      input: inputMint,
      output: outputMint,
    });

    // 更新日限额
    const usdcAmount = decision === 'enter' ? Number(inputAmountLamports) / 1e6 : Number(quote.outAmount) / 1e6;
    wallet.todayVolume += usdcAmount;
    wallet.lastTradeAt = Date.now();

    const record: TradeRecord = {
      id: `trade_${Date.now()}_${wallet.id}`,
      signalId: signal.id,
      strategyId: signal.strategy_id,
      userId: wallet.userId,
      decision,
      inputMint,
      outputMint,
      inputAmount: Number(inputAmountLamports),
      outputAmount: Number(quote.outAmount),
      txSignature: signature,
      status: 'pending',
      createdAt: Date.now(),
    };

    if (this.store) {
      this.store.insertExecutionTrade({
        id: record.id,
        signal_id: record.signalId,
        strategy_id: record.strategyId,
        user_id: record.userId,
        decision: record.decision,
        input_mint: record.inputMint,
        output_mint: record.outputMint,
        input_amount: record.inputAmount,
        output_amount: record.outputAmount,
        tx_signature: record.txSignature,
        status: record.status,
        created_at: record.createdAt,
      });
    } else {
      this.trades.push(record); // fallback
    }

    // 等待确认（非阻塞）
    this.waitForConfirmation(signature, record);

    return record;
  }

  private async waitForConfirmation(signature: string, record: TradeRecord) {
    try {
      const latest = await this.connection.getLatestBlockhash();
      await this.connection.confirmTransaction(
        { signature, ...latest },
        'confirmed',
      );
      record.status = 'success';
      this.logger.info('Trade confirmed', { signature, record: record.id });
    } catch {
      record.status = 'failed';
      this.logger.warn('Trade failed', { signature, record: record.id });
    }
  }

  // ── 每日限额重置（由 cron 调用）──
  resetDailyVolumes() {
    for (const wallet of this.wallets.values()) {
      wallet.todayVolume = 0;
    }
    this.logger.info('Daily execution volumes reset');
  }

  // ── 获取交易历史 ──
  getTrades(userId?: string, strategyId?: string): TradeRecord[] {
    if (this.store) {
      let rows: any[];
      if (strategyId) {
        rows = this.store.getTradesByStrategy(strategyId);
      } else if (userId) {
        rows = this.store.getTradesByUser(userId);
      } else {
        // No filter — fall back to in-memory or query all (limited)
        rows = this.trades;
      }
      return rows.map((r: any) => ({
        id: r.id,
        signalId: r.signal_id,
        strategyId: r.strategy_id,
        userId: r.user_id,
        decision: r.decision,
        inputMint: r.input_mint,
        outputMint: r.output_mint,
        inputAmount: r.input_amount,
        outputAmount: r.output_amount,
        txSignature: r.tx_signature,
        status: r.status,
        createdAt: r.created_at,
      }));
    }
    let result = this.trades;
    if (userId) result = result.filter((t) => t.userId === userId);
    if (strategyId) result = result.filter((t) => t.strategyId === strategyId);
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }

  // ── 安全销毁所有钱包私钥 ──
  emergencyWipe() {
    for (const wallet of this.wallets.values()) {
      wallet.keypair.secretKey.fill(0);
    }
    this.wallets.clear();
    this.logger.warn('AutoExecutionEngine emergency wiped all keys');
  }
}
