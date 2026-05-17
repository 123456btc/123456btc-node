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

const PUBLIC_DIR = path.join(process.cwd(), 'public');

export function createHttpServer(
  config: ProviderConfig,
  store: SubscriptionStore,
  auth: AuthManager,
  hub: SignalHub,
  settlement: SettlementEngine,
  billing: BillingCron,
  autoExecution?: AutoExecutionEngine,
  blindBox?: BlindBoxEngine,
): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // ── 静态文件服务（Web Dashboard）──
    if (req.method === 'GET' && !url.pathname.startsWith('/provider/') && !url.pathname.startsWith('/admin/') && !url.pathname.startsWith('/execution/') && !url.pathname.startsWith('/user/') && !url.pathname.startsWith('/subscriptions') && !url.pathname.startsWith('/signals') && !url.pathname.startsWith('/strategies') && url.pathname !== '/health') {
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
      // 1. Provider 信号推送
      // ═══════════════════════════════════════════
      if (req.method === 'POST' && url.pathname === '/provider/signals') {
        const providerAuth = auth.verifyProvider(req.headers as Record<string, string>);
        if (!providerAuth.valid) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: providerAuth.error }));
          return;
        }

        const body = await readJson(req);
        const result = await hub.ingestSignal(body, providerAuth.providerId!);

        if (!result.ok) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: result.error }));
          return;
        }

        // per_signal_bbt 计费
        const subs = store.getActiveSubscriptionsByStrategy(result.signal!.strategy_id);
        for (const sub of subs) {
          billing.chargePerSignal(sub, result.signal!);
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
        const strategies = store.listStrategies(config.provider_id)
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
            display_name: body.display_name || wallet.slice(0, 8) + '...',
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
        const body = await readJson(req);
        const wallet = body.wallet_address as string;
        const strategyId = body.strategy_id as string;

        if (!wallet || !strategyId) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'wallet_address and strategy_id required' }));
          return;
        }

        const user = store.getUserByWallet(wallet);
        if (!user) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'User not found, register first' }));
          return;
        }

        const strategy = store.getStrategy(strategyId);
        if (!strategy || strategy.provider_id !== config.provider_id) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Strategy not found' }));
          return;
        }

        // 检查是否已有订阅
        const existing = store.getSubscription(user.id, strategyId);
        if (existing && existing.status === 'active') {
          res.statusCode = 409;
          res.end(JSON.stringify({ error: 'Already subscribed', subscription_id: existing.id }));
          return;
        }

        // 创建待激活订阅
        const sub = store.createSubscription({
          user_id: user.id,
          strategy_id: strategyId,
          status: strategy.pricing_model === 'free' ? 'active' : 'expired', // 付费需先付款
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
            provider_wallet: config.wallet_address,
            bbt_mint: config.bbt_mint,
            amount_bbt: amount,
            memo,
            instruction: `请向 ${config.wallet_address} 转账 ${amount} BBT，Memo 填写: ${memo}`,
          },
        }));
        return;
      }

      // ═══════════════════════════════════════════
      // 6. 用户查询订阅状态
      // ═══════════════════════════════════════════
      if (req.method === 'GET' && url.pathname === '/subscriptions') {
        const wallet = url.searchParams.get('wallet');
        if (!wallet) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Missing wallet param' }));
          return;
        }
        const user = store.getUserByWallet(wallet);
        if (!user) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'User not found' }));
          return;
        }
        const subs = store.getActiveSubscriptionsByUser(user.id);
        res.statusCode = 200;
        res.end(JSON.stringify({ subscriptions: subs }));
        return;
      }

      // ═══════════════════════════════════════════
      // 7. 用户查询信号历史（HTTP 轮询，适合手机端）
      // ═══════════════════════════════════════════
      if (req.method === 'GET' && url.pathname === '/signals') {
        const wallet = url.searchParams.get('wallet');
        const strategyId = url.searchParams.get('strategy_id');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);

        if (!wallet) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Missing wallet param' }));
          return;
        }

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
        const wallet = url.searchParams.get('wallet');
        if (!wallet) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Missing wallet param' }));
          return;
        }
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
      // 9. Admin: 创建策略
      // ═══════════════════════════════════════════
      if (req.method === 'POST' && url.pathname === '/admin/strategies') {
        if (!auth.verifyAdminKey(req.headers as Record<string, string>)) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }
        const body = await readJson(req);
        const strategy = store.createStrategy({
          provider_id: config.provider_id,
          name: body.name,
          description: body.description,
          symbol: body.symbol,
          market_type: body.market_type || 'crypto',
          pricing_model: body.pricing_model || 'daily_bbt',
          price_per_day: body.price_per_day,
          price_per_signal: body.price_per_signal,
          min_bbt_tier: body.min_bbt_tier || 0,
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
            total_confirmed_bbt: totalConfirmed.total,
            total_pending_bbt: totalPending.total,
            total_failed_bbt: totalFailed.total,
            active_subscribers: subscriberCount.total,
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

        const wallet = autoExecution.registerWallet(userId, strategyId, keypair, body.max_daily_volume || 100);
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
        const wallet = url.searchParams.get('wallet');
        if (!wallet) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'wallet param required' }));
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
      // 19. 健康检查
      // ═══════════════════════════════════════════
      if (req.method === 'GET' && url.pathname === '/health') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          status: 'ok',
          provider: config.provider_id,
          features: {
            escrow: settlement.mode === 'escrow',
            auto_execution: !!autoExecution,
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
    req.on('data', (chunk) => (data += chunk));
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
