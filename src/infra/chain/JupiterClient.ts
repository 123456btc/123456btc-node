/**
 * JupiterClient — Jupiter Aggregator v6 API 封装
 *
 * 职责：
 * 1. 获取 swap 报价（quote）
 * 2. 构建 swap 交易（transaction）
 * 3. 路由发现：任意 SPL token → 任意 SPL token
 *
 * 自动执行场景：
 * - 信号触发时，将 USDC → target token（做多）或 target token → USDC（平仓）
 * - 也可用于 BBT 订阅：用户没有 BBT 时，USDC → BBT 一键兑换
 */

import 'reflect-metadata';
import { singleton } from 'tsyringe';
import { Logger } from '../logger/Logger.js';

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6';
const JUPITER_PRICE_API = 'https://price.jup.ag/v4';

export interface SwapRoute {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: { amount: string; feeBps: number } | null;
  priceImpactPct: string;
  routePlan: RouteStep[];
  contextSlot: number;
  timeTaken: number;
}

export interface RouteStep {
  swapInfo: {
    ammKey: string;
    label: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount: string;
    feeMint: string;
  };
  percent: number;
}

export interface SwapTransaction {
  swapTransaction: string; // base64 encoded transaction
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
  computeUnitLimit?: number;
  prioritizationType: string;
  dynamicSlippageReport?: {
    slippageBps: number;
    expectedProfitBps: number;
    amplifiedPriceImpactBps: number;
  };
}

export interface SwapInstruction {
  tokenLedgerInstruction?: any;
  computeBudgetInstructions: any[];
  setupInstructions: any[];
  swapInstruction: any;
  cleanupInstruction?: any;
  addressLookupTableAddresses: string[];
  prioritizationFeeLamports: number;
  computeUnitLimit?: number;
  prioritizationType: string;
  dynamicSlippageReport?: any;
}

@singleton()
export class JupiterClient {
  constructor(private logger: Logger) {}

  // ── 获取报价 ──
  async getQuote(params: {
    inputMint: string; // token address
    outputMint: string;
    amount: string; // in input token base units (lamports/smallest unit)
    slippageBps?: number; // default 50 = 0.5%
    onlyDirectRoutes?: boolean;
    asLegacyTransaction?: boolean;
  }): Promise<SwapRoute | null> {
    const url = new URL(`${JUPITER_QUOTE_API}/quote`);
    url.searchParams.set('inputMint', params.inputMint);
    url.searchParams.set('outputMint', params.outputMint);
    url.searchParams.set('amount', params.amount);
    url.searchParams.set('slippageBps', String(params.slippageBps ?? 50));
    if (params.onlyDirectRoutes) url.searchParams.set('onlyDirectRoutes', 'true');
    if (params.asLegacyTransaction) url.searchParams.set('asLegacyTransaction', 'true');

    try {
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        const err = await res.text();
        this.logger.warn('Jupiter quote failed', { status: res.status, err });
        return null;
      }
      const data = await res.json() as SwapRoute;
      return data;
    } catch (err) {
      this.logger.warn('Jupiter quote error', { err });
      return null;
    }
  }

  // ── 构建 swap 交易（完整交易，用户直接签名发送）──
  async getSwapTransaction(
    quote: SwapRoute,
    userPublicKey: string,
    opts: { wrapAndUnwrapSol?: boolean; prioritizationFeeLamports?: number; asLegacyTransaction?: boolean } = {},
  ): Promise<SwapTransaction | null> {
    try {
      const res = await fetch(`${JUPITER_QUOTE_API}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey,
          wrapAndUnwrapSol: opts.wrapAndUnwrapSol ?? true,
          prioritizationFeeLamports: opts.prioritizationFeeLamports ?? 10000,
          asLegacyTransaction: opts.asLegacyTransaction ?? false,
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        this.logger.warn('Jupiter swap build failed', { status: res.status, err });
        return null;
      }
      return await res.json() as SwapTransaction;
    } catch (err) {
      this.logger.warn('Jupiter swap build error', { err });
      return null;
    }
  }

  // ── 获取 swap 指令（用于组合交易）──
  async getSwapInstructions(
    quote: SwapRoute,
    userPublicKey: string,
  ): Promise<SwapInstruction | null> {
    try {
      const res = await fetch(`${JUPITER_QUOTE_API}/swap-instructions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey,
          wrapAndUnwrapSol: true,
        }),
      });
      if (!res.ok) return null;
      return await res.json() as SwapInstruction;
    } catch {
      return null;
    }
  }

  // ── 获取 token 价格 ──
  async getPrice(mints: string[]): Promise<Record<string, { price: number; vsToken: string }>> {
    try {
      const ids = mints.join(',');
      const res = await fetch(`${JUPITER_PRICE_API}/price?ids=${ids}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return {};
      const data = await res.json() as { data: Record<string, { price: number; vsToken: string }> };
      return data.data || {};
    } catch {
      return {};
    }
  }

  // ── 便利：USDC → target token（做多）──
  async quoteBuy(
    targetMint: string,
    usdcAmountLamports: string, // USDC has 6 decimals
  ): Promise<SwapRoute | null> {
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    return this.getQuote({
      inputMint: USDC_MINT,
      outputMint: targetMint,
      amount: usdcAmountLamports,
      slippageBps: 100, // 1% slippage for auto-execution
    });
  }

  // ── 便利：target token → USDC（平仓/退出）──
  async quoteSell(
    targetMint: string,
    tokenAmountLamports: string,
  ): Promise<SwapRoute | null> {
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    return this.getQuote({
      inputMint: targetMint,
      outputMint: USDC_MINT,
      amount: tokenAmountLamports,
      slippageBps: 100,
    });
  }

  // ── 便利：USDC → BBT（订阅用）──
  async quoteSwapToBBT(bbtMint: string, usdcAmountLamports: string): Promise<SwapRoute | null> {
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    return this.getQuote({
      inputMint: USDC_MINT,
      outputMint: bbtMint,
      amount: usdcAmountLamports,
      slippageBps: 50,
    });
  }
}
