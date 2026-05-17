/**
 * 123456btc Telegram Bot
 * 用户触达主渠道：策略发现、订阅管理、实时信号推送
 *
 * 命令清单：
 * /start     — 欢迎 + 钱包绑定指引
 * /wallet    — 绑定/查看 Solana 钱包
 * /strategies — 查看 Provider 策略列表
 * /subscribe <id> [days] — 创建订阅 + 生成支付指令
 * /status    — 查看当前订阅状态
 * /signals   — 查看最近 5 条信号
 * /cancel <sub_id> — 取消订阅（合约退款）
 * /help      — 命令帮助
 */

import { Telegraf, Markup, Context } from 'telegraf';
import type { SessionContext } from 'telegraf/session';
import type { SubscriptionStore } from '../core/SubscriptionStore.js';
import type { SettlementEngine } from '../core/SettlementEngine.js';
import type { SignalHub } from '../core/SignalHub.js';
import { Logger } from '../infra/logger/Logger.js';

interface BotSession {
  walletAddress?: string;
  lastStrategyId?: string;
}

type BotContext = SessionContext<BotSession>;

export interface TelegramBotOptions {
  token: string;
  store: SubscriptionStore;
  settlement: SettlementEngine;
  hub: SignalHub;
  providerWallet: string;
  providerName: string;
  nodeHttpUrl: string; // e.g. http://localhost:1119
}

export class TelegramBotService {
  private bot: Telegraf<BotContext>;
  private logger: Logger;
  private opts: TelegramBotOptions;

  constructor(opts: TelegramBotOptions) {
    this.opts = opts;
    this.logger = new Logger();
    this.bot = new Telegraf<BotSession & Context>(opts.token);
    this.registerCommands();
    this.registerActions();
  }

  // ── 启动 ──
  async start() {
    // 使用 polling 模式（生产环境可切换为 webhook）
    await this.bot.launch();
    this.logger.info('Telegram Bot started', { provider: this.opts.providerName });

    // 优雅退出
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }

  stop() {
    this.bot.stop('manual');
    this.logger.info('Telegram Bot stopped');
  }

  // ── 信号推送（由 SignalHub 调用）──
  async broadcastSignal(chatIds: number[], signal: { symbol: string; decision: string; confidence: number; strategy_name: string }) {
    const emoji = decisionEmoji(signal.decision);
    const text = `
${emoji} <b>${signal.strategy_name}</b>
<code>${signal.symbol}</code>  ·  ${signal.decision.toUpperCase()}
置信度: ${Math.round(signal.confidence * 100)}%
    `.trim();

    for (const chatId of chatIds) {
      try {
        await this.bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
      } catch (err) {
        this.logger.warn('TG broadcast failed', { chatId, err });
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // 命令注册
  // ═══════════════════════════════════════════════════════

  private registerCommands() {
    // /start
    this.bot.command('start', async (ctx) => {
      const welcome = `
🎯 欢迎加入 <b>${this.opts.providerName}</b> 信号圈

这里是去中心化策略订阅入口：
• 绑定钱包 → <code>/wallet 你的Solana地址</code>
• 查看策略 → <code>/strategies</code>
• 立即订阅 → <code>/subscribe 策略ID 天数</code>
• 查看信号 → <code>/signals</code>

资金由链上合约托管，按时间释放，可随时取消退款。
      `.trim();
      await ctx.reply(welcome, { parse_mode: 'HTML' });
    });

    // /wallet
    this.bot.command('wallet', async (ctx) => {
      const text = ctx.message.text.replace('/wallet', '').trim();
      if (!text) {
        const saved = ctx.session?.walletAddress;
        await ctx.reply(saved
          ? `💳 已绑定钱包:\n<code>${saved}</code>\n\n修改钱包: /wallet 新地址`
          : '💳 请发送钱包地址:\n<code>/wallet 你的Solana地址</code>', { parse_mode: 'HTML' });
        return;
      }
      // 简单校验
      if (text.length < 32 || text.length > 48) {
        await ctx.reply('❌ 无效的 Solana 地址格式');
        return;
      }
      ctx.session = { ...ctx.session, walletAddress: text };
      await ctx.reply(`✅ 钱包已绑定:\n<code>${text}</code>`, { parse_mode: 'HTML' });
    });

    // /strategies
    this.bot.command('strategies', async (ctx) => {
      try {
        const res = await fetch(`${this.opts.nodeHttpUrl}/strategies`);
        const data = await res.json() as { strategies: any[] };
        if (!data.strategies?.length) {
          await ctx.reply('暂无上线策略');
          return;
        }
        const lines = data.strategies.map((s) =>
          `📊 <b>${s.name}</b> (${s.symbol})\n` +
          `ID: <code>${s.id}</code>\n` +
          `计价: ${s.pricing_model} · ${s.price_per_day ? s.price_per_day + ' BBT/天' : s.price_per_signal ? s.price_per_signal + ' BBT/信号' : '免费'}\n`
        );
        await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
      } catch {
        await ctx.reply('⚠️ 获取策略列表失败，请稍后重试');
      }
    });

    // /subscribe
    this.bot.command('subscribe', async (ctx) => {
      const parts = ctx.message.text.split(' ').slice(1);
      const strategyId = parts[0];
      const days = parseInt(parts[1] || '7', 10);
      const wallet = ctx.session?.walletAddress;

      if (!strategyId) {
        await ctx.reply('用法: /subscribe 策略ID 天数\n例: /subscribe strat_abc 7');
        return;
      }
      if (!wallet) {
        await ctx.reply('❌ 请先绑定钱包: /wallet 你的Solana地址');
        return;
      }

      try {
        // 1. 注册用户（如未注册）
        await fetch(`${this.opts.nodeHttpUrl}/users/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet_address: wallet }),
        });

        // 2. 创建订阅
        const res = await fetch(`${this.opts.nodeHttpUrl}/subscriptions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet_address: wallet, strategy_id: strategyId, duration_days: days }),
        });
        const data = await res.json() as any;

        if (res.status === 409 && data.subscription_id) {
          await ctx.reply(`ℹ️ 你已订阅该策略\n订阅ID: <code>${data.subscription_id}</code>`, { parse_mode: 'HTML' });
          return;
        }
        if (!res.ok) {
          await ctx.reply(`❌ 订阅失败: ${data.error || '未知错误'}`);
          return;
        }

        // 3. 生成支付信息
        const amount = data.amount_bbt || days * (data.price_per_day || 0);
        const memo = data.memo || `sub:${data.subscription_id}`;

        const payText = `
✅ 订阅订单已创建

策略: <b>${data.strategy_name || strategyId}</b>
时长: ${days} 天
金额: <b>${amount} BBT</b>

请向以下地址转账:
<code>${this.opts.providerWallet}</code>

⚠️ 务必在 Memo 中填写:
<code>${memo}</code>

转账确认后自动激活订阅。
        `.trim();

        await ctx.reply(payText, { parse_mode: 'HTML' });
      } catch {
        await ctx.reply('⚠️ 创建订阅失败，请稍后重试');
      }
    });

    // /status
    this.bot.command('status', async (ctx) => {
      const wallet = ctx.session?.walletAddress;
      if (!wallet) {
        await ctx.reply('❌ 请先绑定钱包: /wallet 你的Solana地址');
        return;
      }
      try {
        const res = await fetch(`${this.opts.nodeHttpUrl}/users/${wallet}/subscriptions`);
        const data = await res.json() as { subscriptions: any[] };
        if (!data.subscriptions?.length) {
          await ctx.reply('暂无活跃订阅\n查看策略: /strategies');
          return;
        }
        const lines = data.subscriptions.map((sub) => {
          const statusIcon = sub.status === 'active' ? '🟢' : '🔴';
          return `${statusIcon} <b>${sub.strategy_name}</b>\n到期: ${sub.expires_at ? new Date(sub.expires_at).toLocaleDateString() : 'N/A'}\n`;
        });
        await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
      } catch {
        await ctx.reply('⚠️ 获取状态失败');
      }
    });

    // /signals
    this.bot.command('signals', async (ctx) => {
      try {
        const res = await fetch(`${this.opts.nodeHttpUrl}/signals?limit=5`);
        const data = await res.json() as { signals: any[] };
        if (!data.signals?.length) {
          await ctx.reply('暂无最近信号');
          return;
        }
        const lines = data.signals.map((s) => {
          const emoji = decisionEmoji(s.decision);
          return `${emoji} <b>${s.symbol}</b> ${s.decision.toUpperCase()} · ${Math.round((s.confidence || 0) * 100)}%\n<code>${s.strategy_id}</code> · ${new Date(s.created_at_ms).toLocaleString()}`;
        });
        await ctx.reply(lines.join('\n\n'), { parse_mode: 'HTML' });
      } catch {
        await ctx.reply('⚠️ 获取信号失败');
      }
    });

    // /cancel
    this.bot.command('cancel', async (ctx) => {
      const subId = ctx.message.text.replace('/cancel', '').trim();
      if (!subId) {
        await ctx.reply('用法: /cancel 订阅ID');
        return;
      }
      // 实际取消需要调用合约 user_cancel，这里指引用户
      await ctx.reply(
        `取消订阅需链上操作:\n` +
        `1. 访问: ${this.opts.nodeHttpUrl}\n` +
        `2. 或使用CLI: 123456btc-node cancel --sub ${subId}\n\n` +
        `剩余金额将按时间比例退回钱包。`
      );
    });

    // /help
    this.bot.command('help', async (ctx) => {
      await ctx.reply(`
📖 命令帮助

/start       — 欢迎
/wallet      — 绑定/查看钱包
/strategies  — 查看策略列表
/subscribe   — 订阅策略
/status      — 查看订阅状态
/signals     — 查看最近信号
/cancel      — 取消订阅
/help        — 显示本帮助
      `.trim());
    });
  }

  private registerActions() {
    // Inline keyboard callbacks (预留)
    this.bot.action(/subscribe_(.+)/, async (ctx) => {
      const strategyId = ctx.match[1];
      await ctx.answerCbQuery();
      await ctx.reply(`使用命令订阅:\n/subscribe ${strategyId} 7`);
    });
  }
}

function decisionEmoji(decision: string): string {
  switch (decision) {
    case 'enter': return '🟢';
    case 'exit': return '🔴';
    case 'reduce': return '🟡';
    case 'hold': return '🔵';
    case 'cancel': return '⚪';
    default: return '⚫';
  }
}
