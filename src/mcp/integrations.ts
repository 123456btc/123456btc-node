/**
 * MCP Integrations — Agent / BlindBox / Strategy 模块集成
 *
 * 将三大模块注册为 MCP 工具和资源，供 AI Agent 对话式调用。
 *
 * 工具列表：
 *   - agent_register   注册 Agent
 *   - agent_status     查询 Agent 状态
 *   - blindbox_create  创建盲盒
 *   - blindbox_list    列出市场盲盒
 *   - blindbox_buy     购买盲盒
 *   - strategy_bind    绑定策略
 *   - strategy_bundle  购买捆绑包
 *
 * 资源列表：
 *   - agent://info/{agent_id}        Agent 详情
 *   - blindbox://market              盲盒市场数据
 *   - strategy://subscriptions       策略订阅状态
 *
 * 用法：在 server.ts 中调用 registerIntegrations(server, config)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// ── 模块导入 ──
import { AgentIDManager } from '../agent/AgentIDManager.js';
import { BlindBoxOTC, BlindBoxTier } from '../blindbox/BlindBoxOTC.js';
import { StrategyEngine } from '../strategy/StrategyEngine.js';
import { Logger } from '../infra/logger/Logger.js';
import type { AgentProfile, AgentMetadata } from '../agent/AgentIDManager.js';
import type { BlindBoxOTCRecord } from '../blindbox/BlindBoxOTC.js';
import type { BundleProduct } from '../strategy/StrategyEngine.js';

// 创建一个简易 logger（MCP 环境不需要完整 AppConfig）
const mcpLogger = new Logger();

// ═══════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

function errorResult(message: string) {
  return textResult(`ERROR: ${message}`);
}

// ═══════════════════════════════════════════════
// 主注册函数
// ═══════════════════════════════════════════════

/**
 * 将 Agent / BlindBox / Strategy 三大模块注册为 MCP 工具和资源。
 *
 * @param server  MCP Server 实例
 * @param config  节点配置（来自 ~/.123456btc-node/config.json）
 */
export function registerIntegrations(
  server: McpServer,
  config: Record<string, any>,
) {
  // ── 初始化模块实例 ──
  const agentMgr = new AgentIDManager(mcpLogger);
  const blindbox = new BlindBoxOTC(mcpLogger);
  const strategyEngine = new StrategyEngine(mcpLogger);

  // 如果配置中有 Solana RPC 和 BBT Mint，初始化 AgentIDManager
  if (config.solana_rpc && config.bbt_mint) {
    agentMgr.init(config.solana_rpc, config.bbt_mint);
  }

  // ─────────────────────────────────────────────
  // TOOL: agent_register
  // ─────────────────────────────────────────────

  server.tool(
    'agent_register',
    '注册一个新的 AI Agent。需要提供钱包地址、显示名称和签名。注册后 Agent 处于 pending_verification 状态，铸造 Bot ID NFT 后自动激活。',
    {
      wallet_address: z.string().describe('Agent 钱包地址 (Solana)'),
      display_name: z.string().min(2).max(64).describe('Agent 显示名称'),
      signature: z.string().describe('钱包签名（防伪造注册）'),
      capabilities: z.array(z.string()).optional().describe('Agent 能力列表，如 ["signal_provider", "trader"]'),
      description: z.string().optional().describe('Agent 描述'),
      endpoint_url: z.string().optional().describe('Agent API 端点'),
    },
    async ({ wallet_address, display_name, signature, capabilities, description, endpoint_url }) => {
      try {
        const metadata: AgentMetadata | undefined = capabilities
          ? {
              name: display_name,
              description: description || '',
              capabilities,
              version: '1.0.0',
              endpoint_url,
            }
          : undefined;

        const agent = agentMgr.register({
          wallet_address,
          display_name,
          signature,
          timestamp: Date.now(),
          metadata,
        });

        return jsonResult({
          success: true,
          message: `Agent 注册成功，当前状态: ${agent.status}`,
          agent: {
            agent_id: agent.agent_id,
            wallet_address: agent.wallet_address,
            display_name: agent.display_name,
            status: agent.status,
            reputation_score: agent.reputation_score,
            created_at: new Date(agent.created_at).toISOString(),
          },
        });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ─────────────────────────────────────────────
  // TOOL: agent_status
  // ─────────────────────────────────────────────

  server.tool(
    'agent_status',
    '查询 Agent 状态。支持按 agent_id 或 wallet_address 查询。',
    {
      agent_id: z.string().optional().describe('Agent ID'),
      wallet_address: z.string().optional().describe('Agent 钱包地址'),
    },
    async ({ agent_id, wallet_address }) => {
      try {
        let agent: AgentProfile | undefined;

        if (agent_id) {
          agent = agentMgr.getAgent(agent_id);
        } else if (wallet_address) {
          agent = agentMgr.getAgentByWallet(wallet_address);
        } else {
          // 无参数时返回统计概览
          const stats = agentMgr.getStats();
          return jsonResult({
            message: '请提供 agent_id 或 wallet_address 查询具体 Agent，以下是系统概览',
            stats,
          });
        }

        if (!agent) {
          return errorResult('Agent 不存在');
        }

        const factors = agentMgr.getReputationFactors(agent.agent_id);
        const eligibility = agentMgr.validateNodeEligibility(agent.agent_id);

        return jsonResult({
          agent,
          reputation_factors: factors,
          node_eligibility: eligibility,
        });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ─────────────────────────────────────────────
  // TOOL: blindbox_create
  // ─────────────────────────────────────────────

  server.tool(
    'blindbox_create',
    '创建一个 OTC 盲盒。卖家选择面值等级，系统生成锁定交易。卖家签名上链后盲盒进入市场。',
    {
      seller_wallet: z.string().describe('卖家钱包地址'),
      tier: z.enum(['bronze', 'silver', 'gold', 'platinum', 'diamond']).describe('盲盒面值等级：bronze=1U, silver=10U, gold=100U, platinum=1000U, diamond=10000U'),
    },
    async ({ seller_wallet, tier }) => {
      try {
        const tierEnum = tier as BlindBoxTier;
        const { box, lockTransaction } = await blindbox.createBox(seller_wallet, tierEnum);

        return jsonResult({
          success: true,
          message: '盲盒创建成功，请签名以下交易以锁定 BBT',
          box: {
            id: box.id,
            tier: box.tier,
            usdt_value: box.usdtValue,
            bbt_amount: box.bbtAmount,
            status: box.status,
            expires_at: new Date(box.expiresAt).toISOString(),
          },
          lock_instructions: {
            description: '将 lockTransaction 序列化后用卖家钱包签名并上链',
            note: '签名上链后调用 confirmLock 确认',
          },
        });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ─────────────────────────────────────────────
  // TOOL: blindbox_list
  // ─────────────────────────────────────────────

  server.tool(
    'blindbox_list',
    '列出市场上所有可购买的盲盒。可按面值等级筛选。',
    {
      tier: z.enum(['bronze', 'silver', 'gold', 'platinum', 'diamond']).optional().describe('按面值等级筛选'),
    },
    async ({ tier }) => {
      try {
        const tierEnum = tier ? (tier as BlindBoxTier) : undefined;
        const listings = blindbox.getMarketListings(tierEnum);
        const stats = blindbox.getStats();

        return jsonResult({
          total_listings: listings.length,
          market_stats: stats,
          listings: listings.map((b: BlindBoxOTCRecord) => ({
            id: b.id,
            tier: b.tier,
            usdt_value: b.usdtValue,
            bbt_amount: b.bbtAmount,
            seller: b.sellerWallet.slice(0, 8) + '...',
            created_at: new Date(b.createdAt).toISOString(),
          })),
        });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ─────────────────────────────────────────────
  // TOOL: blindbox_buy
  // ─────────────────────────────────────────────

  server.tool(
    'blindbox_buy',
    '购买一个市场上的盲盒。买家选定盲盒后进入预留状态，需在超时前完成法币支付。',
    {
      box_id: z.string().describe('盲盒 ID'),
      buyer_wallet: z.string().describe('买家钱包地址'),
    },
    async ({ box_id, buyer_wallet }) => {
      try {
        const box = blindbox.reserveBox(box_id, buyer_wallet);

        return jsonResult({
          success: true,
          message: '盲盒已预留，请在超时前完成法币支付',
          box: {
            id: box.id,
            tier: box.tier,
            usdt_value: box.usdtValue,
            bbt_amount: box.bbtAmount,
            status: box.status,
            expires_at: new Date(box.expiresAt).toISOString(),
          },
          next_steps: [
            '1. 通过银行/支付宝/微信向卖家转账 ' + box.usdtValue + ' USDT',
            '2. 调用 confirm_fiat_payment 提交支付凭证',
            '3. 卖家确认收到法币后，BBT 自动释放到你的钱包',
          ],
        });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ─────────────────────────────────────────────
  // TOOL: strategy_bind
  // ─────────────────────────────────────────────

  server.tool(
    'strategy_bind',
    '将一个 AI Agent 绑定到交易策略。绑定后 Agent 可自动执行该策略的交易信号。',
    {
      strategy_id: z.string().describe('策略 ID'),
      agent_id: z.string().describe('Agent ID'),
      agent_wallet: z.string().describe('Agent 钱包地址（接收执行奖励）'),
      agent_type: z.enum(['ai_llm', 'rule_based', 'hybrid']).default('ai_llm').describe('Agent 类型'),
      execution_mode: z.enum(['auto', 'semi_auto', 'manual']).default('auto').describe('执行模式'),
      fee_share_bps: z.number().min(0).max(10000).default(100).describe('Agent 抽成比例（万分之），100 = 1%'),
    },
    async ({ strategy_id, agent_id, agent_wallet, agent_type, execution_mode, fee_share_bps }) => {
      try {
        const binding = strategyEngine.bindAgent(strategy_id, agent_id, agent_wallet, {
          agentType: agent_type,
          executionMode: execution_mode,
          feeShareBps: fee_share_bps,
        });

        return jsonResult({
          success: true,
          message: `Agent ${agent_id} 已绑定到策略 ${strategy_id}`,
          binding: {
            id: binding.id,
            agent_id: binding.agent_id,
            strategy_id: binding.strategy_id,
            agent_type: binding.agent_type,
            execution_mode: binding.execution_mode,
            fee_share_bps: binding.fee_share_bps,
            status: binding.status,
          },
        });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ─────────────────────────────────────────────
  // TOOL: strategy_bundle
  // ─────────────────────────────────────────────

  server.tool(
    'strategy_bundle',
    '购买盲盒+策略捆绑包。可查看所有捆绑包或购买指定捆绑包。',
    {
      action: z.enum(['list', 'purchase']).default('list').describe('操作：list=查看列表, purchase=购买'),
      bundle_id: z.string().optional().describe('捆绑包 ID（purchase 时必填）'),
      buyer_wallet: z.string().optional().describe('买家钱包地址（purchase 时必填）'),
      user_id: z.string().optional().describe('用户 ID（purchase 时必填）'),
      payment_method: z.enum(['sol', 'bbt']).default('sol').describe('支付方式'),
      tx_signature: z.string().optional().describe('链上支付交易签名（可选，用于幂等性校验）'),
    },
    async ({ action, bundle_id, buyer_wallet, user_id, payment_method, tx_signature }) => {
      try {
        if (action === 'list') {
          const bundles = strategyEngine.getBundleProducts();
          return jsonResult({
            bundles: bundles.map((b: BundleProduct) => ({
              id: b.id,
              name: b.name,
              description: b.description,
              blindbox_count: b.blindbox_count,
              bonus_days: b.bonus_days,
              price_sol: b.price_sol,
              price_bbt: b.price_bbt,
              nft_tier: b.nft_tier,
              max_supply: b.max_supply,
              sold_count: b.sold_count,
              remaining: b.max_supply > 0 ? b.max_supply - b.sold_count : 'unlimited',
            })),
          });
        }

        // purchase
        if (!bundle_id || !buyer_wallet || !user_id) {
          return errorResult('购买捆绑包需要 bundle_id、buyer_wallet 和 user_id');
        }

        const result = await strategyEngine.purchaseBundle(
          bundle_id,
          buyer_wallet,
          user_id,
          payment_method,
          tx_signature,
        );

        if (!result.success) {
          return errorResult(result.error || '购买失败');
        }

        return jsonResult({
          success: true,
          message: '捆绑包购买成功',
          nft: result.nft
            ? {
                id: result.nft.id,
                mint_address: result.nft.mint_address,
                strategy_id: result.nft.strategy_id,
                tier: result.nft.tier,
                subscription_days: result.nft.subscription_days,
                expires_at: result.nft.expires_at > 0
                  ? new Date(result.nft.expires_at).toISOString()
                  : 'lifetime',
              }
            : null,
          blindbox_credits: result.blindboxCredits,
          subscriptions_created: result.subscriptions,
        });
      } catch (e: any) {
        return errorResult(e.message);
      }
    },
  );

  // ─────────────────────────────────────────────
  // RESOURCE: agent://info/{agent_id}
  // ─────────────────────────────────────────────

  server.resource(
    'agent-info',
    'agent://info/{agent_id}',
    { description: 'Agent 详细信息，包含信誉分、交易统计、节点资格等' },
    async (uri: URL) => {
      const agentId = uri.pathname.replace(/^\//, '');
      const agent = agentMgr.getAgent(agentId);
      if (!agent) {
        return {
          contents: [{
            uri: uri.href,
            text: JSON.stringify({ error: 'Agent not found' }),
          }],
        };
      }
      const factors = agentMgr.getReputationFactors(agentId);
      const eligibility = agentMgr.validateNodeEligibility(agentId);
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({ agent, reputation_factors: factors, node_eligibility: eligibility }, null, 2),
        }],
      };
    },
  );

  // ─────────────────────────────────────────────
  // RESOURCE: blindbox://market
  // ─────────────────────────────────────────────

  server.resource(
    'blindbox-market',
    'blindbox://market',
    { description: '盲盒市场实时数据，包含所有可购买的盲盒和市场统计' },
    async (uri: URL) => {
      const listings = blindbox.getMarketListings();
      const stats = blindbox.getStats();
      const tierConfigs = blindbox.getTierConfigs();
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            market_stats: stats,
            tier_configs: tierConfigs.map(c => ({
              tier: c.tier,
              name: c.name,
              usdt_value: c.usdtValue,
              bbt_required: c.bbtRequired,
              fee_bps: c.platformFeeBps,
            })),
            active_listings: listings.map(b => ({
              id: b.id,
              tier: b.tier,
              usdt_value: b.usdtValue,
              bbt_amount: b.bbtAmount,
              seller: b.sellerWallet,
              created_at: new Date(b.createdAt).toISOString(),
            })),
          }, null, 2),
        }],
      };
    },
  );

  // ─────────────────────────────────────────────
  // RESOURCE: strategy://subscriptions
  // ─────────────────────────────────────────────

  server.resource(
    'strategy-subscriptions',
    'strategy://subscriptions',
    { description: '策略订阅状态，包含捆绑包产品、Agent 绑定和 NFT 市场数据' },
    async (uri: URL) => {
      const bundles = strategyEngine.getBundleProducts();
      const marketStats = strategyEngine.getMarketStats();
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            bundles: bundles.map(b => ({
              id: b.id,
              name: b.name,
              blindbox_count: b.blindbox_count,
              bonus_days: b.bonus_days,
              price_sol: b.price_sol,
              price_bbt: b.price_bbt,
              sold_count: b.sold_count,
            })),
            market: marketStats,
          }, null, 2),
        }],
      };
    },
  );

  mcpLogger.info('MCP integrations registered', {
    tools: [
      'agent_register', 'agent_status',
      'blindbox_create', 'blindbox_list', 'blindbox_buy',
      'strategy_bind', 'strategy_bundle',
    ],
    resources: ['agent-info', 'blindbox-market', 'strategy-subscriptions'],
  });
}
