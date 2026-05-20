/**
 * 123456btc MCP Server — 集成版
 *
 * 在原有 server.ts 基础上加载 Agent / BlindBox / Strategy 三大模块。
 * 启动方式: npx tsx src/mcp/server-integrated.ts
 * 传输方式: STDIO (标准输入输出)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SubscriptionStore } from '../core/SubscriptionStore.js';
import { SignalHub } from '../core/SignalHub.js';
import { AuthManager } from '../core/AuthManager.js';
import { registerIntegrations } from './integrations.js';

// ── 配置 ──

const CONFIG_DIR = path.join(os.homedir(), '.123456btc-node');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const DATA_DIR = path.join(CONFIG_DIR, 'data');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config not found. Run: 123456btc-node init --name "YourName" --wallet <YOUR_WALLET>`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

// ── 初始化 ──

const config = loadConfig();
let store: SubscriptionStore;
let hub: SignalHub;
let auth: AuthManager;

async function init() {
  const dbPath = path.join(DATA_DIR, 'node.db');
  store = await SubscriptionStore.create(dbPath);
  auth = new AuthManager(config);
  hub = new SignalHub(store, console as any);
}

// ── MCP Server ──

const server = new McpServer({
  name: '123456btc',
  version: '0.3.0',
});

// ═══════════════════════════════════════════
// 原有 Tools（与 server.ts 保持一致）
// ═══════════════════════════════════════════

server.tool(
  'list_strategies',
  '列出所有可用的交易策略，包括名称、价格、创建者钱包等信息',
  {
    status: z.enum(['live', 'paused', 'archived']).optional().describe('按状态筛选，默认 live'),
  },
  async ({ status }) => {
    const strategies = store.listStrategies();
    const filtered = status ? strategies.filter(s => s.status === status) : strategies.filter(s => s.status === 'live');
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(filtered.map(s => ({
          id: s.id,
          name: s.name,
          symbol: s.symbol,
          pricing_model: s.pricing_model,
          price_per_day: s.price_per_day,
          price_per_signal: s.price_per_signal,
          creator_wallet: s.creator_wallet,
          status: s.status,
        })), null, 2),
      }],
    };
  },
);

server.tool(
  'create_strategy',
  '创建一个新的交易策略。创建者自动绑定当前节点钱包地址。',
  {
    name: z.string().describe('策略名称'),
    symbol: z.string().describe('交易对，如 BTCUSDT'),
    description: z.string().optional().describe('策略描述'),
    pricing_model: z.enum(['daily_bbt', 'per_signal_bbt', 'free']).default('daily_bbt').describe('计费模式'),
    price_per_day: z.number().optional().describe('每日价格 (BBT)，daily_bbt 模式必填'),
    price_per_signal: z.number().optional().describe('每信号价格 (BBT)，per_signal_bbt 模式必填'),
  },
  async ({ name, symbol, description, pricing_model, price_per_day, price_per_signal }) => {
    const strategy = store.createStrategy({
      provider_id: config.wallet_address,
      creator_wallet: config.wallet_address,
      name,
      description,
      symbol,
      market_type: 'crypto',
      pricing_model,
      price_per_day,
      price_per_signal,
      min_bbt_tier: 0,
      status: 'live',
    });
    return {
      content: [{
        type: 'text',
        text: `策略创建成功:\n${JSON.stringify(strategy, null, 2)}`,
      }],
    };
  },
);

server.tool(
  'publish_signal',
  '向自己的策略发布一个交易信号 (BUY/SELL/HOLD)。只有策略创建者可以发布。',
  {
    strategy_id: z.string().describe('策略 ID'),
    symbol: z.string().describe('交易对'),
    decision: z.enum(['BUY', 'SELL', 'HOLD']).describe('交易决策'),
    price: z.number().optional().describe('当前价格'),
    confidence: z.number().min(0).max(1).optional().describe('置信度 0-1'),
    reason: z.string().optional().describe('信号原因'),
  },
  async ({ strategy_id, symbol, decision, price, confidence, reason }) => {
    const strategy = store.getStrategy(strategy_id);
    if (!strategy) {
      return { content: [{ type: 'text', text: `错误: 策略 ${strategy_id} 不存在` }] };
    }
    if (strategy.creator_wallet !== config.wallet_address) {
      return { content: [{ type: 'text', text: `错误: 你不是策略 ${strategy_id} 的创建者` }] };
    }

    const result = await hub.ingestSignal({
      strategy_id,
      symbol,
      decision,
      price,
      confidence,
      reason,
    }, config.wallet_address);

    if (result.ok) {
      return {
        content: [{
          type: 'text',
          text: `信号发布成功!\n信号 ID: ${result.signal?.id}\n广播给 ${result.dispatched} 个订阅者`,
        }],
      };
    }
    return { content: [{ type: 'text', text: `发布失败: ${result.error}` }] };
  },
);

server.tool(
  'get_signals',
  '查看某个策略的历史信号',
  {
    strategy_id: z.string().describe('策略 ID'),
    limit: z.number().default(10).describe('返回数量'),
  },
  async ({ strategy_id, limit }) => {
    const signals = store.getSignalsByStrategyIds([strategy_id], limit);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(signals, null, 2),
      }],
    };
  },
);

server.tool(
  'my_subscriptions',
  '查看当前钱包的所有活跃订阅',
  {},
  async () => {
    const user = store.getUserByWallet(config.wallet_address);
    if (!user) {
      return { content: [{ type: 'text', text: '当前钱包未注册，请先调用 register_wallet' }] };
    }
    const subs = store.getActiveSubscriptionsByUser(user.id);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(subs, null, 2),
      }],
    };
  },
);

server.tool(
  'register_wallet',
  '注册当前钱包到节点（首次使用需要）',
  {
    display_name: z.string().optional().describe('显示名称'),
  },
  async ({ display_name }) => {
    let user = store.getUserByWallet(config.wallet_address);
    if (!user) {
      user = store.createUser({
        wallet_address: config.wallet_address,
        display_name: display_name || config.name || config.wallet_address.slice(0, 8),
        chain_bbt_balance: 0,
        status: 'active',
      });
    }
    return {
      content: [{
        type: 'text',
        text: `钱包已注册:\n用户 ID: ${user.id}\n钱包: ${user.wallet_address}`,
      }],
    };
  },
);

server.tool(
  'node_status',
  '查看当前节点状态和配置信息',
  {},
  async () => {
    const strategies = store.listStrategies();
    const myStrategies = strategies.filter(s => s.creator_wallet === config.wallet_address);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          wallet: config.wallet_address,
          name: config.name,
          role: config.role,
          bbt_mint: config.bbt_mint,
          strategies_created: myStrategies.length,
          total_strategies: strategies.length,
          port: config.node_port,
        }, null, 2),
      }],
    };
  },
);

// ═══════════════════════════════════════════
// 注册 Agent / BlindBox / Strategy 集成
// ═══════════════════════════════════════════

registerIntegrations(server, config);

// ── 启动 ──

async function main() {
  await init();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[123456btc MCP] Server started (stdio) — with Agent/BlindBox/Strategy integrations');
}

main().catch((err) => {
  console.error('[123456btc MCP] Fatal:', err);
  process.exit(1);
});
