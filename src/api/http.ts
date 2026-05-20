/**
 * HTTP API — 私域运营完整接口
 * Provider 管理 + 用户订阅 + 支付 + 信号查询
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import type { SubscriptionStore } from '../core/SubscriptionStore.js';
import type { AuthManager } from '../core/AuthManager.js';
import type { SignalHub } from '../core/SignalHub.js';
import type { SettlementEngine } from '../core/SettlementEngine.js';
import type { BillingCron } from '../core/BillingCron.js';
import type { ProviderConfig } from '../types/index.js';
import { getCurrentTimestamp } from '../utils/crypto.js';
import type { AutoExecutionEngine } from '../core/AutoExecutionEngine.js';
import type { BlindBoxEngine } from '../core/BlindBoxEngine.js';
import type { InscriptionTier } from '../core/BlindBoxEngine.js';
import { handleShareCardRoute } from './shareCard.js';

const PUBLIC_DIR = path.join(process.cwd(), 'public');

// 简易 IP 速率限制器
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 分钟
const RATE_LIMIT_MAX = 100; // 每窗口最大请求数
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

/** 重置速率限制器（仅供测试使用） */
export function resetRateLimitForTesting() {
  rateLimitMap.clear();
}

// 防止 payment_tx 重放的幂等性集合
const usedPaymentTxes = new Set<string>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

// 定期清理过期条目
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 60_000);

// 用户钱包签名验证辅助函数
function verifyWalletAuth(req: http.IncomingMessage, auth: AuthManager): { valid: boolean; wallet?: string; error?: string } {
  const wallet = req.headers['x-wallet'] as string;
  const signature = req.headers['x-wallet-signature'] as string;
  const timestamp = req.headers['x-wallet-timestamp'] as string;

  if (!wallet || !signature || !timestamp) {
    return { valid: false, error: 'Missing wallet auth headers (x-wallet, x-wallet-signature, x-wallet-timestamp)' };
  }

  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) {
    return { valid: false, error: 'Invalid timestamp' };
  }

  const result = auth.verifyWalletSignature(wallet, signature, ts);
  return result.valid ? { valid: true, wallet } : { valid: false, error: result.error };
}

export function createHttpServer(
  config: ProviderConfig,
  store: SubscriptionStore,
  auth: AuthManager,
  hub: SignalHub,
  settlement: SettlementEngine,
  billing: BillingCron,
  autoExecution?: AutoExecutionEngine,
  blindBox?: BlindBoxEngine,
  inscriptionForge?: BlindBoxEngine,
): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // 速率限制
    const clientIp = req.socket.remoteAddress || 'unknown';
    if (!checkRateLimit(clientIp)) {
      res.statusCode = 429;
      res.end(JSON.stringify({ error: 'Too many requests' }));
      return;
    }

    // ── Share Card Routes (SVG images for social sharing) ──
    if (handleShareCardRoute(req, res, url, inscriptionForge)) return;

    // ── 静态文件服务（Web Dashboard）──
    if (req.method === 'GET' && !url.pathname.startsWith('/provider/') && !url.pathname.startsWith('/admin/') && !url.pathname.startsWith('/execution/') && !url.pathname.startsWith('/user/') && !url.pathname.startsWith('/subscriptions') && !url.pathname.startsWith('/signals') && !url.pathname.startsWith('/strategies') && !url.pathname.startsWith('/collection/') && !url.pathname.startsWith('/leaderboard') && !url.pathname.startsWith('/epoch/') && !url.pathname.startsWith('/slot-hunting') && !url.pathname.startsWith('/inscribe/') && !url.pathname.startsWith('/share/') && url.pathname !== '/health') {
      let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
      // 防止目录遍历
      if (!filePath.startsWith(PUBLIC_DIR)) {
        res.statusCode = 403;
        res.end('Forbidden');
        return;
      }
      // 如果请求的是目录，返回 index.html
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath);
        const mimeTypes: Record<string, string> = {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.svg': 'image/svg+xml',
        };
        res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
        fs.createReadStream(filePath).pipe(res);
        return;
      }
      // 如果是 SPA 路由（非文件），返回 index.html
      if (!path.extname(url.pathname)) {
        res.setHeader('Content-Type', 'text/html');
        fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
        return;
      }
    }

    res.setHeader('Content-Type', 'application/json');

    try {
      // ═══════════════════════════════════════════
      // 1. 信号推送（策略创建者用钱包签名发布）
      // ═══════════════════════════════════════════
      if (req.method === 'POST' && url.pathname === '/signals') {
        const walletAuth = verifyWalletAuth(req, auth);
        if (!walletAuth.valid) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: walletAuth.error || 'Wallet auth required' }));
          return;
        }

        const body = await readJson(req);
        const result = await hub.ingestSignal(body, walletAuth.wallet!);

        if (!result.ok) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: result.error }));
          return;
        }

        // per_signal_bbt 计费（实时查询链上余额）
        const subs = store.getActiveSubscriptionsByStrategy(result.signal!.strategy_id);
        for (const sub of subs) {
          await billing.chargePerSignal(sub, result.signal!);
        }

        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          signal_id: result.signal!.id,
          dispatched: result.dispatched,
        }));
        return;
      }

      // ═══════════════════════════════════════════
      // 2. 公开策略列表（用户发现）
      // ═══════════════════════════════════════════
      if (req.method === 'GET' && url.pathname === '/strategies') {
        const strategies = store.listStrategies()
          .filter((s) => s.status === 'live')
          .map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            symbol: s.symbol,
            market_type: s.market_type,
            pricing_model: s.pricing_model,
            price_per_day: s.price_per_day,
            price_per_signal: s.price_per_signal,
            min_bbt_tier: s.min_bbt_tier,
            creator_wallet: s.creator_wallet,
          }));
        res.statusCode = 200;
        res.end(JSON.stringify({ strategies }));
        return;
      }

      // ═══════════════════════════════════════════
      // 3. 策略详情
      // ═══════════════════════════════════════════
      if (req.method === 'GET' && url.pathname.startsWith('/strategies/')) {
        const id = url.pathname.split('/')[2];
        const strategy = store.getStrategy(id);
        if (!strategy || strategy.status !== 'live') {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Strategy not found' }));
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify({
          strategy: {
            id: strategy.id,
            name: strategy.name,
            description: strategy.description,
            symbol: strategy.symbol,
            market_type: strategy.market_type,
            pricing_model: strategy.pricing_model,
            price_per_day: strategy.price_per_day,
            price_per_signal: strategy.price_per_signal,
            min_bbt_tier: strategy.min_bbt_tier,
          }
        }));
        return;
      }

      // ═══════════════════════════════════════════
      // 4. 用户注册（私域圈子加入）
      // ═══════════════════════════════════════════
      if (req.method === 'POST' && url.pathname === '/users/register') {
        const body = await readJson(req);
        const wallet = body.wallet_address as string;
        if (!wallet) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'wallet_address required' }));
          return;
        }

        let user = store.getUserByWallet(wallet);
        if (!user) {
          user = store.createUser({
            wallet_address: wallet,
            display_name: (body.display_name as string) || wallet.slice(0, 8) + '...',
            chain_bbt_balance: 0,
            status: 'active',
          });
        }

        res.statusCode = 200;
        res.end(JSON.stringify({
          user_id: user.id,
          wallet_address: user.wallet_address,
          display_name: user.display_name,
        }));
        return;
      }

      // ═══════════════════════════════════════════
      // 5. 用户创建订阅（生成付款订单）
      // ═══════════════════════════════════════════
      if (req.method === 'POST' && url.pathname === '/subscriptions') {
        // 钱包签名验证
        const walletAuth = verifyWalletAuth(req, auth);
        if (!walletAuth.valid) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'Wallet signature required', detail: walletAuth.error }));
          return;
        }

        const body = await readJson(req);
        const wallet = walletAuth.wallet!;
        const strategyId = body.strategy_id as string;

        if (!strategyId) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'strategy_id required' }));
          return;
        }

        // 校验请求体中的 wallet_address 与签名钱包一致
        if (body.wallet_address && body.wallet_address !== wallet) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: 'wallet_address mismatch with signed wallet' }));
          return;
        }

        const user = store.getUserByWallet(wallet);
        if (!user) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'User not found, register first' }));
          return;
        }

        const strategy = store.getStrategy(strategyId);
        if (!strategy || strategy.status !== 'live') {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Strategy not found' }));
          return;
        }

        // 检查是否已有订阅
        const existing = store.getSubscription(user.id, strategyId);
        if (existing && (existing.status === 'active' || existing.status === 'pending')) {
          // 如果是 pending 状态，返回付款信息让用户继续付款
          if (existing.status === 'pending') {
            const amount = strategy.pricing_model === 'daily_bbt' ? strategy.price_per_day : 0;
            const memo = `BBT-SUB|${existing.id}|${strategyId}|${wallet}`;
            res.statusCode = 200;
            res.end(JSON.stringify({
              subscription_id: existing.id,
              status: existing.status,
              strategy: { id: strategy.id, name: strategy.name, pricing_model: strategy.pricing_model, price_per_day: strategy.price_per_day, price_per_signal: strategy.price_per_signal },
              payment: { creator_wallet: strategy.creator_wallet, bbt_mint: config.bbt_mint, amount_bbt: amount, memo, instruction: `请向 ${strategy.creator_wallet} 转账 ${amount} BBT，Memo 填写: ${memo}` },
            }));
            return;
          }
          res.statusCode = 409;
          res.end(JSON.stringify({ error: 'Already subscribed', subscription_id: existing.id }));
          return;
        }

        // 创建待激活订阅
        const sub = store.createSubscription({
          user_id: user.id,
          strategy_id: strategyId,
          status: strategy.pricing_model === 'free' ? 'active' : 'pending', // 付费需先付款
          billing_model: strategy.pricing_model as 'daily_bbt' | 'per_signal_bbt' | 'free',
          next_bill_at: strategy.pricing_model === 'free' ? null : getCurrentTimestamp() + 24 * 60 * 60 * 1000,
        });

        // 生成付款信息
        const amount = strategy.pricing_model === 'daily_bbt' ? strategy.price_per_day : 0;
        const memo = `BBT-SUB|${sub.id}|${strategyId}|${wallet}`;

        res.statusCode = 201;
        res.end(JSON.stringify({
          subscription_id: sub.id,
          status: sub.status,
          strategy: {
            id: strategy.id,
            name: strategy.name,
            pricing_model: strategy.pricing_model,
            price_per_day: strategy.price_per_day,
            price_per_signal: strategy.price_per_signal,
          },
          payment: strategy.pricing_model === 'free' ? null : {
            creator_wallet: strategy.creator_wallet,
            bbt_mint: config.bbt_mint,
            amount_bbt: amount,
            memo,
            instruction: `请向 ${strategy.creator_wallet} 转账 ${amount} BBT，Memo 填写: ${memo}`,
          },
        }));
        return;
      }

      // ═══════════════════════════════════════════
      // 6. 用户查询订阅状态
      // ═══════════════════════════════════════════
      if (req.method === 'GET' && url.pathname === '/subscriptions') {
        // 钱包签名验证
        const walletAuth = verifyWalletAuth(req, auth);
        if (!walletAuth.valid) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'Wallet signature required', detail: walletAuth.error }));
          return;
        }
        const wallet = walletAuth.wallet!;

        const user = store.getUserByWallet(wallet);
        if (!user) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'User not found' }));
          return;
        }
        const subs = store.getSubscriptionsByUser(user.id);
        // 为 pending 订阅附加付款信息
        const subsWithPayment = subs.map((sub) => {
          if (sub.status === 'pending') {
            const strategy = store.getStrategy(sub.strategy_id);
            const amount = strategy?.pricing_model === 'daily_bbt' ? strategy.price_per_day : 0;
            return {
              ...sub,
              payment: {
                provider_wallet: config.wallet_address,
                bbt_mint: config.bbt_mint,
                amount_bbt: amount,
                memo: `BBT-SUB|${sub.id}|${sub.strategy_id}|${wallet}`,
              },
            };
          }
          return sub;
        });
        res.statusCode = 200;
        res.end(JSON.stringify({ subscriptions: subsWithPayment }));
        return;
      }

      // ═══════════════════════════════════════════
      // 7. 用户查询信号历史（HTTP 轮询，适合手机端）
      // ═══════════════════════════════════════════
      if (req.method === 'GET' && url.pathname === '/signals') {
        // 钱包签名验证
        const walletAuth = verifyWalletAuth(req, auth);
        if (!walletAuth.valid) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'Wallet signature required', detail: walletAuth.error }));
          return;
        }
        const wallet = walletAuth.wallet!;

        const strategyId = url.searchParams.get('strategy_id');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);

        const user = store.getUserByWallet(wallet);
        if (!user) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'User not found' }));
          return;
        }

        let strategyIds: string[] = [];
        if (strategyId) {
          // 验证用户是否订阅了该策略
          const sub = store.getSubscription(user.id, strategyId);
          if (!sub || sub.status !== 'active') {
            res.statusCode = 403;
            res.end(JSON.stringify({ error: 'Not subscribed to this strategy' }));
            return;
          }
          strategyIds = [strategyId];
        } else {
          const subs = store.getActiveSubscriptionsByUser(user.id);
          strategyIds = subs.map((s) => s.strategy_id);
        }

        if (strategyIds.length === 0) {
          res.statusCode = 200;
          res.end(JSON.stringify({ signals: [] }));
          return;
        }

        const rows = store.getSignalsByStrategyIds(strategyIds, limit);

        res.statusCode = 200;
        res.end(JSON.stringify({ signals: rows }));
        return;
      }

      // ═══════════════════════════════════════════
      // 8. 用户查询链上余额
      // ═══════════════════════════════════════════
      if (req.method === 'GET' && url.pathname === '/user/balance') {
        // 钱包签名验证
        const walletAuth = verifyWalletAuth(req, auth);
        if (!walletAuth.valid) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'Wallet signature required', detail: walletAuth.error }));
          return;
        }
        const wallet = walletAuth.wallet!;

        const balance = await settlement.getWalletBBTBalance(wallet);
        // 更新本地缓存
        const user = store.getUserByWallet(wallet);
        if (user) {
          store.updateUserBalance(user.id, balance);
        }
        res.statusCode = 200;
        res.end(JSON.stringify({ wallet, balance }));
        return;
      }

      // ═══════════════════════════════════════════
      // 9. 创建策略（任何人可用钱包签名创建）
      // ═══════════════════════════════════════════
      if (req.method === 'POST' && url.pathname === '/strategies') {
        const walletAuth = verifyWalletAuth(req, auth);
        if (!walletAuth.valid) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: walletAuth.error || 'Wallet auth required' }));
          return;
        }
        const body = await readJson(req);
        const strategy = store.createStrategy({
          provider_id: walletAuth.wallet!,
          creator_wallet: walletAuth.wallet!,
          name: body.name as string,
          description: body.description as string,
          symbol: body.symbol as string,
          market_type: (body.market_type as string) || 'crypto',
          pricing_model: (body.pricing_model as 'daily_bbt' | 'per_signal_bbt' | 'free') || 'daily_bbt',
          price_per_day: body.price_per_day as number | undefined,
          price_per_signal: body.price_per_signal as number | undefined,
          min_bbt_tier: (body.min_bbt_tier as number) || 0,
          status: 'live',
        });
        res.statusCode = 201;
        res.end(JSON.stringify({ strategy }));
        return;
      }

      // ═══════════════════════════════════════════
      // 10. Admin: Provider 收益面板
      // ═══════════════════════════════════════════
      if (req.method === 'GET' && url.pathname === '/admin/earnings') {
        if (!auth.verifyAdminKey(req.headers as Record<string, string>)) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }

        const totalConfirmed = store.getTotalBillingByStatus('confirmed');
        const totalPending = store.getTotalBillingByStatus('pending');
        const totalFailed = store.getTotalBillingByStatus('failed');
        const subscriberCount = store.getActiveSubscriberCount();
        const recentBills = store.getRecentBills(50);

        res.statusCode = 200;
        res.end(JSON.stringify({
          summary: {
            total_confirmed_bbt: totalConfirmed,
            total_pending_bbt: totalPending,
            total_failed_bbt: totalFailed,
            active_subscribers: subscriberCount,
          },
          recent_records: recentBills,
        }));
        return;
      }

      // ═══════════════════════════════════════════
      // 11. Admin: 订阅者列表
      // ═══════════════════════════════════════════
      if (req.method === 'GET' && url.pathname === '/admin/subscribers') {
        if (!auth.verifyAdminKey(req.headers as Record<string, string>)) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }
        const strategyId = url.searchParams.get('strategy_id');
        let subscribers;
        if (strategyId) {
          subscribers = store.getSubscribersByStrategy(strategyId);
        } else {
          subscribers = store.listAllSubscriptions();
        }
        res.statusCode = 200;
        res.end(JSON.stringify({ subscribers }));
        return;
      }

      // ═══════════════════════════════════════════
      // 12. 自动执行：创建执行钱包
      // ═══════════════════════════════════════════
      if (req.method === 'POST' && url.pathname === '/execution/wallets') {
        if (!auth.verifyAdminKey(req.headers as Record<string, string>)) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }
        if (!autoExecution) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'Auto-execution not enabled' }));
          return;
        }
        const body = await readJson(req);
        const userId = body.user_id as string;
        const strategyId = body.strategy_id as string;
        const walletSeed = body.wallet_seed as string; // 可选：用户提供的seed

        if (!userId || !strategyId) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'user_id and strategy_id required' }));
          return;
        }

        // 生成执行钱包 keypair
        const { Keypair } = await import('@solana/web3.js');
        let keypair: any;
        if (walletSeed && walletSeed.length >= 32) {
          const seed = Uint8Array.from(Buffer.from(walletSeed.slice(0, 32)));
          keypair = Keypair.fromSeed(seed);
        } else {
          keypair = Keypair.generate();
        }

        const wallet = autoExecution.registerWallet(userId, strategyId, keypair, (body.max_daily_volume as number) || 100);
        res.statusCode = 201;
        res.end(JSON.stringify({
          wallet_id: wallet.id,
          public_key: wallet.keypair.publicKey.toBase58(),
          warning: '请向此地址存入小额 USDC 用于自动交易。平台持有私钥，建议只存可承受损失的资金。',
        }));
        return;
      }

      // ═══════════════════════════════════════════
      // 13. 自动执行：删除执行钱包
      // ═══════════════════════════════════════════
      if (req.method === 'DELETE' && url.pathname === '/execution/wallets') {
        if (!auth.verifyAdminKey(req.headers as Record<string, string>)) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }
        if (!autoExecution) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'Auto-execution not enabled' }));
          return;
        }
        const body = await readJson(req);
        const userId = body.user_id as string;
        const strategyId = body.strategy_id as string;
        if (!userId || !strategyId) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'user_id and strategy_id required' }));
          return;
        }
        autoExecution.unregisterWallet(userId, strategyId);
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // ═══════════════════════════════════════════
      // 14. 自动执行：查询交易历史
      // ═══════════════════════════════════════════
      if (req.method === 'GET' && url.pathname === '/execution/trades') {
        if (!auth.verifyAdminKey(req.headers as Record<string, string>)) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }
        if (!autoExecution) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'Auto-execution not enabled' }));
          return;
        }
        const userId = url.searchParams.get('user_id') || undefined;
        const strategyId = url.searchParams.get('strategy_id') || undefined;
        const trades = autoExecution.getTrades(userId, strategyId);
        res.statusCode = 200;
        res.end(JSON.stringify({ trades }));
        return;
      }

      // ═══════════════════════════════════════════
      // 15. 盲盒：获取配置
      // ═══════════════════════════════════════════
      if (req.method === 'GET' && url.pathname === '/blindbox/config') {
        if (!blindBox) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'Blind box not enabled' }));
          return;
        }
        const cfg = blindBox.getConfig();
        res.statusCode = 200;
        res.end(JSON.stringify({
          ...cfg,
          treasuryWallet: config.treasury_wallet,
          bbtMint: config.bbt_mint,
          priceBbt: cfg.priceBbt,
        }));
        return;
      }

      // ═══════════════════════════════════════════
      // 16. 盲盒：开盒
      // ═══════════════════════════════════════════
      if (req.method === 'POST' && url.pathname === '/blindbox/open') {
        if (!blindBox) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'Blind box not enabled' }));
          return;
        }
        const body = await readJson(req);
        const wallet = body.wallet_address as string;
        const paymentTx = body.payment_tx as string;
        if (!wallet) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'wallet_address required' }));
          return;
        }
        if (!paymentTx) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'payment_tx required: transfer 10 BBT to treasury first' }));
          return;
        }

        // 验证链上支付
        const verify = await settlement.verifyPaymentTx(
          paymentTx,
          wallet,
          config.treasury_wallet,
          blindBox.getConfig().priceBbt,
        );
        if (!verify.valid) {
          res.statusCode = 402;
          res.end(JSON.stringify({ error: `Payment verification failed: ${verify.error}` }));
          return;
        }

        // 防止 payment_tx 重放
        if (usedPaymentTxes.has(paymentTx)) {
          res.statusCode = 409;
          res.end(JSON.stringify({ error: 'Payment transaction already used' }));
          return;
        }
        usedPaymentTxes.add(paymentTx);

        const user = store.getUserByWallet(wallet);
        const userId = user ? user.id : wallet;

        try {
          const record = blindBox.open(userId, wallet);
          // 自动发放奖品
          const claim = await blindBox.claimPrize(record);

          const tier = blindBox.getConfig().tiers.find((t) => t.id === record.tierId);
          res.statusCode = 200;
          res.end(JSON.stringify({
            record_id: record.id,
            tierId: record.tierId,
            tierName: record.tierName,
            icon: tier?.icon,
            color: tier?.color,
            type: tier?.type,
            value: tier?.value,
            claimStatus: claim.success,
            claimDetail: claim.detail,
            dailyRemaining: blindBox.getConfig().dailyLimit - blindBox.getUserDailyCount(userId),
          }));
        } catch (err: any) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // ═══════════════════════════════════════════
      // 17. 盲盒：最近开盒记录
      // ═══════════════════════════════════════════
      if (req.method === 'GET' && url.pathname === '/blindbox/history') {
        if (!blindBox) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'Blind box not enabled' }));
          return;
        }
        const records = blindBox.getRecentHistory(20).map((r) => {
          const tier = blindBox!.getConfig().tiers.find((t) => t.id === r.tierId);
          return { ...r, icon: tier?.icon, color: tier?.color };
        });
        res.statusCode = 200;
        res.end(JSON.stringify({ records }));
        return;
      }

      // ═══════════════════════════════════════════
      // 18. 盲盒：我的奖品
      // ═══════════════════════════════════════════
      if (req.method === 'GET' && url.pathname === '/blindbox/my') {
        if (!blindBox) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'Blind box not enabled' }));
          return;
        }
        const walletAuth = verifyWalletAuth(req, auth);
        if (!walletAuth.valid) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'Wallet signature required', detail: walletAuth.error }));
          return;
        }
        const wallet = walletAuth.wallet!;
        // 兼容：如果 query 参数提供了 wallet，必须与签名钱包一致
        const queryWallet = url.searchParams.get('wallet');
        if (queryWallet && queryWallet !== wallet) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: 'wallet param mismatch with signed wallet' }));
          return;
        }
        const user = store.getUserByWallet(wallet);
        const userId = user ? user.id : wallet;
        const records = blindBox.getUserHistory(userId).map((r) => {
          const tier = blindBox!.getConfig().tiers.find((t) => t.id === r.tierId);
          return { ...r, icon: tier?.icon, color: tier?.color };
        });
        res.statusCode = 200;
        res.end(JSON.stringify({ records }));
        return;
      }

      // ═══════════════════════════════════════════
      // 19. Provider 质押
      // ═══════════════════════════════════════════
      if (req.method === 'POST' && url.pathname === '/stake') {
        const walletAuth = verifyWalletAuth(req, auth);
        if (!walletAuth.valid) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: walletAuth.error }));
          return;
        }
        const body = await readJson(req);
        const amount = body.amount_bbt as number;
        if (!amount || amount <= 0) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'amount_bbt must be > 0' }));
          return;
        }
        const stake = store.createStake(walletAuth.wallet!, amount);
        res.statusCode = 201;
        res.end(JSON.stringify({ stake }));
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/stake/')) {
        const wallet = url.pathname.split('/')[2];
        const stake = store.getActiveStake(wallet);
        res.end(JSON.stringify({ stake: stake || null }));
        return;
      }

      // ═══════════════════════════════════════════
      // 21. InscriptionForge: 铸造铭文
      // ═══════════════════════════════════════════
      if (req.method === 'POST' && url.pathname === '/inscribe') {
        if (!inscriptionForge) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'InscriptionForge not enabled' }));
          return;
        }
        const walletAuth = verifyWalletAuth(req, auth);
        if (!walletAuth.valid) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'Wallet signature required', detail: walletAuth.error }));
          return;
        }
        const body = await readJson(req);
        const tier = body.tier as string;
        const validTiers = ['bronze', 'silver', 'gold', 'diamond'];
        if (!tier || !validTiers.includes(tier)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Invalid tier. Must be one of: bronze, silver, gold, diamond' }));
          return;
        }
        const seedWord = body.seedWord as string | undefined;
        try {
          const record = inscriptionForge.inscribe(walletAuth.wallet!, tier as InscriptionTier, seedWord);
          res.statusCode = 201;
          res.end(JSON.stringify({
            success: true,
            inscription: record,
          }));
        } catch (err: any) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // ═══════════════════════════════════════════
      // 22. InscriptionForge: 用户铭文收藏
      // ═══════════════════════════════════════════
      if (req.method === 'GET' && url.pathname.startsWith('/collection/')) {
        if (!inscriptionForge) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'InscriptionForge not enabled' }));
          return;
        }
        const wallet = url.pathname.split('/')[2];
        if (!wallet) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'wallet address required' }));
          return;
        }
        const collection = inscriptionForge.getCollection(wallet);
        res.statusCode = 200;
        res.end(JSON.stringify({
          wallet,
          inscriptions: collection.inscriptions,
          luckScore: collection.luckScore,
          stats: collection.stats,
        }));
        return;
      }

      // ═══════════════════════════════════════════
      // 23. InscriptionForge: 排行榜
      // ═══════════════════════════════════════════
      if (req.method === 'GET' && url.pathname === '/leaderboard') {
        if (!inscriptionForge) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'InscriptionForge not enabled' }));
          return;
        }
        const type = url.searchParams.get('type') || 'luckiest';
        const validTypes = ['luckiest', 'whale', 'opened', 'jackpot', 'referral'];
        if (!validTypes.includes(type)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Invalid leaderboard type. Must be one of: luckiest, whale, opened, jackpot, referral' }));
          return;
        }
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
        const leaderboard = inscriptionForge.getLeaderboard(type as any, limit);
        res.statusCode = 200;
        res.end(JSON.stringify({ type, leaderboard }));
        return;
      }

      // ═══════════════════════════════════════════
      // 24. InscriptionForge: Epoch 状态
      // ═══════════════════════════════════════════
      if (req.method === 'GET' && url.pathname === '/epoch/status') {
        if (!inscriptionForge) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'InscriptionForge not enabled' }));
          return;
        }
        const epoch = inscriptionForge.getEpochStatus();
        res.statusCode = 200;
        res.end(JSON.stringify({ epoch }));
        return;
      }

      // ═══════════════════════════════════════════
      // 25. InscriptionForge: Slot Hunting
      // ═══════════════════════════════════════════
      if (req.method === 'GET' && url.pathname === '/slot-hunting') {
        if (!inscriptionForge) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'InscriptionForge not enabled' }));
          return;
        }
        const slotHunting = inscriptionForge.getSlotHunting();
        res.statusCode = 200;
        res.end(JSON.stringify(slotHunting));
        return;
      }

      // ═══════════════════════════════════════════
      // 26. InscriptionForge: 命名铭文
      // ═══════════════════════════════════════════
      if (req.method === 'POST' && /^\/inscribe\/[^/]+\/name$/.test(url.pathname)) {
        if (!inscriptionForge) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'InscriptionForge not enabled' }));
          return;
        }
        const walletAuth = verifyWalletAuth(req, auth);
        if (!walletAuth.valid) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'Wallet signature required', detail: walletAuth.error }));
          return;
        }
        const parts = url.pathname.split('/');
        const inscriptionId = parts[2];
        const body = await readJson(req);
        const name = body.name as string;
        if (!name || typeof name !== 'string') {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'name is required and must be a string' }));
          return;
        }
        try {
          const updated = inscriptionForge.nameInscription(inscriptionId, name, walletAuth.wallet!);
          res.statusCode = 200;
          res.end(JSON.stringify({ success: true, inscription: updated }));
        } catch (err: any) {
          const code = err.message.includes('not found') ? 404 : err.message.includes('Only the owner') ? 403 : 400;
          res.statusCode = code;
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // ═══════════════════════════════════════════
      // 27. InscriptionForge: 铭文属性
      // ═══════════════════════════════════════════
      if (req.method === 'GET' && /^\/inscribe\/[^/]+\/attributes$/.test(url.pathname)) {
        if (!inscriptionForge) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'InscriptionForge not enabled' }));
          return;
        }
        const parts = url.pathname.split('/');
        const inscriptionId = parts[2];
        const attributes = inscriptionForge.getAttributes(inscriptionId);
        if (!attributes) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Inscription not found' }));
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify({ id: inscriptionId, attributes }));
        return;
      }

      // ═══════════════════════════════════════════
      // 20. 健康检查
      // ═══════════════════════════════════════════
      if (req.method === 'GET' && url.pathname === '/health') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          status: 'ok',
          provider: config.provider_id,
          features: {
            escrow: settlement.mode === 'escrow',
            auto_execution: !!autoExecution,
            inscription_forge: !!inscriptionForge,
          },
        }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (e) {
      console.error('[HTTP Error]', e);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  return server;
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_048_576) { // 1MB
        reject(new Error('Request body too large'));
        return;
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
