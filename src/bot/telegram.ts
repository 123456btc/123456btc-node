/**
 * 123456btc Telegram Bot
 * 用户触达主渠道：策略发现、订阅管理、实时信号推送
 *
 * 命令清单：
 * /start      — 欢迎 + 钱包绑定指引
 * /wallet     — 绑定/查看 Solana 钱包
 * /strategies — 查看 Provider 策略列表
 * /subscribe <id> [days] — 创建订阅 + 生成支付指令
 * /status     — 查看当前订阅状态
 * /signals    — 查看最近 5 条信号
 * /cancel <sub_id> — 取消订阅（合约退款）
 * /help       — 命令帮助
 *
 * InscriptionForge 命令：
 * /inscribe   — 开始铭刻流程（四级选择 → 种子词 → 铸造动画 → 结果卡片）
 * /forge      — /inscribe 的别名
 * /collection — 查看铭文收藏
 * /epoch      — 当前纪元信息
 * /leaderboard — 铭刻排行榜
 * /name <id> <name> — 为铭文命名
 *
 * 群组特性：铭刻结果自动发到群 + "Try your own" 按钮
 * Inline Mode：@BotName <tier> 在任意聊天中启动铭刻
 */

import { Telegraf, Markup, Context } from 'telegraf';
import type { InlineQueryResultArticle } from 'telegraf/types';
import type { SessionContext } from 'telegraf/session';
import type { SubscriptionStore } from '../core/SubscriptionStore.js';
import type { SettlementEngine } from '../core/SettlementEngine.js';
import type { SignalHub } from '../core/SignalHub.js';
import { Logger } from '../infra/logger/Logger.js';
import {
  InscriptionForge,
  InscriptionTier,
  Inscription,
  ELEMENT_ICONS,
  ELEMENT_NAMES,
  RARITY_ICONS,
  RARITY_NAMES,
  TIER_CONFIG,
} from '../blindbox/InscriptionForge.js';

// ═══════════════════════════════════════════════
// Session 类型扩展
// ═══════════════════════════════════════════════

interface PendingForge {
  tier: InscriptionTier;
  step: 'seed';
}

interface BotSession {
  walletAddress?: string;
  lastStrategyId?: string;
  /** 铭刻流程中的暂存状态 */
  pendingForge?: PendingForge;
  /** Telegram user ID → 钱包地址映射已存在 walletAddress 中 */
}

type BotContext = SessionContext<BotSession>;

// ═══════════════════════════════════════════════
// 接口
// ═══════════════════════════════════════════════

export interface TelegramBotOptions {
  token: string;
  store: SubscriptionStore;
  settlement: SettlementEngine;
  hub: SignalHub;
  providerId: string;
  providerWallet: string;
  providerName: string;
  nodeHttpUrl: string;
}

// ═══════════════════════════════════════════════
// TelegramBotService
// ═══════════════════════════════════════════════

export class TelegramBotService {
  private bot: Telegraf<BotContext>;
  private logger: Logger;
  private opts: TelegramBotOptions;
  private forge: InscriptionForge;

  constructor(opts: TelegramBotOptions) {
    this.opts = opts;
    this.logger = new Logger();
    this.forge = new InscriptionForge();
    this.bot = new Telegraf<BotSession & Context>(opts.token);
    this.registerCommands();
    this.registerActions();
    this.registerInline();
  }

  // ── 启动 ──
  async start() {
    await this.bot.launch();
    this.logger.info('Telegram Bot started', {
      provider: this.opts.providerName,
      totalInscriptions: this.forge.getTotalInscriptions(),
    });

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
  // 工具方法
  // ═══════════════════════════════════════════════════════

  /** 检查钱包是否已绑定，如未绑定则发送提示并返回 false */
  private requireWallet(ctx: BotContext): string | null {
    const wallet = ctx.session?.walletAddress;
    if (!wallet) {
      ctx.reply('💳 请先绑定钱包:\n<code>/wallet 你的Solana地址</code>', { parse_mode: 'HTML' });
      return null;
    }
    return wallet;
  }

  /** 构造结果卡片 */
  private formatResultCard(inscription: Inscription): string {
    const tierCfg = TIER_CONFIG[inscription.tier];
    const elemIcon = ELEMENT_ICONS[inscription.element];
    const elemName = ELEMENT_NAMES[inscription.element];
    const rarIcon = RARITY_ICONS[inscription.rarity];
    const rarName = RARITY_NAMES[inscription.rarity];
    const nameLine = inscription.name ? `║  📛 ${inscription.name}\n` : '';

    return [
      '╔══════════════════════════╗',
      '║   INSCRIPTION FORGED     ║',
      '╠══════════════════════════╣',
      `║  #${inscription.number.toString().padStart(23)}║`,
      `║  ${tierCfg.icon} ${tierCfg.name.padEnd(22)}║`,
      `║  ${elemIcon} ${elemName.padEnd(23)}║`,
      `║  ${rarIcon} ${rarName.padEnd(23)}║`,
      `║  🍀 ${inscription.trait.name.padEnd(21)}║`,
      nameLine,
      `║  📜 Series: ${inscription.series.padEnd(14)}║`,
      `║  🕐 Epoch: ${inscription.epoch.toString().padEnd(15)}║`,
      `║  🎲 Slot: ${inscription.number.toLocaleString().padStart(15).padEnd(15)}║`,
      `║  🍀 Luck: ${inscription.luckScore.toString().padEnd(16)}║`,
      '╚══════════════════════════╝',
    ].join('\n');
  }

  /** 构造群组铭刻公告 */
  private formatGroupAnnounce(ctx: BotContext, inscription: Inscription): string {
    const tierCfg = TIER_CONFIG[inscription.tier];
    const elemName = ELEMENT_NAMES[inscription.element];
    const rarName = RARITY_NAMES[inscription.rarity];
    const user = ctx.from;
    const mention = user?.username ? `@${user.username}` : `<a href="tg://user?id=${user?.id}">${user?.first_name || 'Someone'}</a>`;

    return `🔥 ${mention} inscribed #${inscription.number} | ${tierCfg.icon} ${tierCfg.name} | ${ELEMENT_ICONS[inscription.element]} ${elemName} | ${RARITY_ICONS[inscription.rarity]} ${rarName} | 🍀 ${inscription.trait.name}`;
  }

  /** 进度条 */
  private progressBar(percent: number, length: number = 20): string {
    const filled = Math.round((percent / 100) * length);
    const empty = length - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
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

🔥 铭刻系统：
• 铸造铭文 → <code>/inscribe</code> 或 <code>/forge</code>
• 查看收藏 → <code>/collection</code>
• 纪元信息 → <code>/epoch</code>
• 排行榜   → <code>/leaderboard</code>

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
        const strategies = this.opts.store.listStrategies();
        if (!strategies?.length) {
          await ctx.reply('暂无上线策略');
          return;
        }
        const lines = strategies.map((s) =>
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
        let user = this.opts.store.getUserByWallet(wallet);
        if (!user) {
          user = this.opts.store.createUser({
            wallet_address: wallet,
            display_name: wallet.slice(0, 8),
            chain_bbt_balance: 0,
            status: 'active',
          });
        }

        const strategy = this.opts.store.getStrategy(strategyId);
        if (!strategy) {
          await ctx.reply('❌ 策略不存在');
          return;
        }

        const existing = this.opts.store.getSubscription(user.id, strategyId);
        if (existing) {
          await ctx.reply(`ℹ️ 你已订阅该策略\n订阅ID: <code>${existing.id}</code>`, { parse_mode: 'HTML' });
          return;
        }

        const expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
        const sub = this.opts.store.createSubscription({
          user_id: user.id,
          strategy_id: strategyId,
          status: 'pending',
          billing_model: strategy.pricing_model,
          next_bill_at: expiresAt,
          expires_at: expiresAt,
        });

        const amount = days * (strategy.price_per_day || 0);
        const memo = `sub:${sub.id}`;

        const payText = `
✅ 订阅订单已创建

策略: <b>${strategy.name || strategyId}</b>
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
        const user = this.opts.store.getUserByWallet(wallet);
        if (!user) {
          await ctx.reply('暂无活跃订阅\n查看策略: /strategies');
          return;
        }
        const subs = this.opts.store.getActiveSubscriptionsByUser(user.id);
        if (!subs?.length) {
          await ctx.reply('暂无活跃订阅\n查看策略: /strategies');
          return;
        }
        const lines = subs.map((sub) => {
          const strategy = this.opts.store.getStrategy(sub.strategy_id);
          const statusIcon = sub.status === 'active' ? '🟢' : '🔴';
          return `${statusIcon} <b>${strategy?.name || sub.strategy_id}</b>\n到期: ${sub.expires_at ? new Date(sub.expires_at).toLocaleDateString() : 'N/A'}\n`;
        });
        await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
      } catch {
        await ctx.reply('⚠️ 获取状态失败');
      }
    });

    // /signals
    this.bot.command('signals', async (ctx) => {
      try {
        const signals = this.opts.store.listSignals(undefined, 5);
        if (!signals?.length) {
          await ctx.reply('暂无最近信号');
          return;
        }
        const lines = signals.map((s) => {
          const emoji = decisionEmoji(s.decision);
          return `${emoji} <b>${s.symbol}</b> ${s.decision.toUpperCase()} · ${Math.round((s.confidence || 0) * 100)}%\n<code>${s.strategy_id}</code> · ${new Date(s.created_at).toLocaleString()}`;
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

<blockquote>策略订阅</blockquote>
/start       — 欢迎
/wallet      — 绑定/查看钱包
/strategies  — 查看策略列表
/subscribe   — 订阅策略
/status      — 查看订阅状态
/signals     — 查看最近信号
/cancel      — 取消订阅

<blockquote>铭刻系统</blockquote>
/inscribe    — 铸造铭文
/forge       — 铸造铭文（别名）
/collection  — 查看铭文收藏
/epoch       — 当前纪元信息
/leaderboard — 铭刻排行榜
/name ID 名称 — 为铭文命名

/help        — 显示本帮助
      `.trim(), { parse_mode: 'HTML' });
    });

    // ═══════════════════════════════════════════════════════
    // InscriptionForge 命令
    // ═══════════════════════════════════════════════════════

    // /inscribe 和 /forge — 开始铭刻流程
    const inscribeHandler = async (ctx: BotContext) => {
      if (!this.requireWallet(ctx)) return;

      // 显示四级选择 inline keyboard
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🥉 Bronze (21)', 'forge_tier_bronze'),
          Markup.button.callback('🥈 Silver (2,100)', 'forge_tier_silver'),
        ],
        [
          Markup.button.callback('🥇 Gold (21,000)', 'forge_tier_gold'),
          Markup.button.callback('💎 Diamond (210,000)', 'forge_tier_diamond'),
        ],
      ]);

      await ctx.reply(
        '🔨 选择铭刻等级：\n\n' +
        '🥉 Bronze  — 基础铭刻\n' +
        '🥈 Silver  — 1.5x 稀有度加成\n' +
        '🥇 Gold    — 2x 稀有度加成\n' +
        '💎 Diamond — 3x 稀有度加成',
        keyboard,
      );
    };

    this.bot.command('inscribe', inscribeHandler);
    this.bot.command('forge', inscribeHandler);

    // /collection — 查看铭文收藏
    this.bot.command('collection', async (ctx) => {
      const wallet = this.requireWallet(ctx);
      if (!wallet) return;

      const collection = this.forge.getCollection(wallet);
      if (!collection.length) {
        await ctx.reply(
          '📭 你的收藏为空\n\n' +
          '铸造你的第一枚铭文: /inscribe'
        );
        return;
      }

      const stats = this.forge.getCollectionStats(wallet);
      const page = 0;
      const pageSize = 10;
      const totalPages = Math.ceil(collection.length / pageSize);
      const pageItems = collection.slice(page * pageSize, (page + 1) * pageSize);

      const lines = pageItems.map((insc) => {
        const tierCfg = TIER_CONFIG[insc.tier];
        const elemIcon = ELEMENT_ICONS[insc.element];
        const rarIcon = RARITY_ICONS[insc.rarity];
        const nameStr = insc.name ? ` — ${insc.name}` : '';
        return `${tierCfg.icon} <code>#${insc.number}</code> | ${elemIcon} ${ELEMENT_NAMES[insc.element]} | ${rarIcon} ${RARITY_NAMES[insc.rarity]} | 🍀 ${insc.trait.name}${nameStr}`;
      });

      const header = `📦 <b>铭文收藏</b> (${stats.totalInscriptions} 枚)\n🍀 平均幸运: ${stats.luckScore}\n🏆 Legendary: ${stats.jackpots}\n`;

      const paginationRow = [];
      if (totalPages > 1) {
        if (page > 0) paginationRow.push(Markup.button.callback('⬅️ 上页', `coll_page_${page - 1}`));
        paginationRow.push(Markup.button.callback(`${page + 1}/${totalPages}`, 'coll_noop'));
        if (page + 1 < totalPages) paginationRow.push(Markup.button.callback('下页 ➡️', `coll_page_${page + 1}`));
      }

      const keyboard = paginationRow.length ? Markup.inlineKeyboard([paginationRow]) : undefined;

      await ctx.reply(header + '\n' + lines.join('\n'), {
        parse_mode: 'HTML',
        ...(keyboard ?? {}),
      });
    });

    // /epoch — 当前纪元信息
    this.bot.command('epoch', async (ctx) => {
      const epochInfo = this.forge.getCurrentEpoch();
      const bar = this.progressBar(epochInfo.progress);
      const genesisCount = this.forge.getGenesisAgentCount();
      const total = this.forge.getTotalInscriptions();

      const text = [
        `🌐 <b>Epoch ${epochInfo.epoch}: ${epochInfo.name}</b>`,
        '',
        `${bar} ${epochInfo.progress.toFixed(1)}%`,
        '',
        `📊 已填充: ${epochInfo.filledSlots} / ${epochInfo.totalSlots}`,
        `⏳ 剩余: ${epochInfo.remainingSlots} slots`,
        `🔢 全局铭文: #${epochInfo.startInscription.toLocaleString()} — #${epochInfo.endInscription.toLocaleString()}`,
        '',
        `🏆 Genesis Agents: ${genesisCount}`,
        `📜 总铸造数: ${total.toLocaleString()}`,
        '',
        '📌 里程碑:',
        '  • 100 铭文 → 解锁特殊系列',
        '  • 500 铭文 → 开放交易市场',
        '  • 1000 铭文 → Epoch 轮转',
      ].join('\n');

      await ctx.reply(text, { parse_mode: 'HTML' });
    });

    // /leaderboard — 铭刻排行榜
    this.bot.command('leaderboard', async (ctx) => {
      const entries = this.forge.getLeaderboard(10);
      if (!entries.length) {
        await ctx.reply('📊 排行榜暂无数据\n\n成为第一个铸造者: /inscribe');
        return;
      }

      const medalEmoji = (rank: number) => {
        if (rank === 1) return '🥇';
        if (rank === 2) return '🥈';
        if (rank === 3) return '🥉';
        return `#${rank}`;
      };

      const lines = entries.map((e) => {
        const medal = medalEmoji(e.rank);
        const shortWallet = `${e.wallet.slice(0, 4)}...${e.wallet.slice(-4)}`;
        return `${medal} <code>${shortWallet}</code> — 🍀 ${e.luckScore} | 📦 ${e.totalInscriptions} | 🏆 ${e.jackpots}`;
      });

      const text = [
        '🏆 <b>铭刻排行榜 TOP 10</b>',
        '',
        ...lines,
        '',
        '排名规则: Legendary 优先 → 幸运分降序',
      ].join('\n');

      await ctx.reply(text, { parse_mode: 'HTML' });
    });

    // /name <id> <name> — 为铭文命名
    this.bot.command('name', async (ctx) => {
      const wallet = this.requireWallet(ctx);
      if (!wallet) return;

      const parts = ctx.message.text.split(/\s+/).slice(1);
      if (parts.length < 2) {
        await ctx.reply('用法: /name 铭文ID 名称\n例: /name INSC-000042 龙门第一');
        return;
      }

      const inscriptionId = parts[0];
      const name = parts.slice(1).join(' ');

      if (name.length > 32) {
        await ctx.reply('❌ 名称不能超过 32 个字符');
        return;
      }

      const result = this.forge.nameInscription(inscriptionId, name, wallet);
      if (!result) {
        await ctx.reply(
          '❌ 未找到该铭文或你没有权限\n\n' +
          '查看你的收藏: /collection'
        );
        return;
      }

      const tierCfg = TIER_CONFIG[result.tier];
      await ctx.reply(
        `✅ 铭文已命名\n\n` +
        `${tierCfg.icon} <b>#${result.number}</b> → "${name}"\n` +
        `📜 Series: ${result.series}`,
        { parse_mode: 'HTML' }
      );
    });

    // ── 种子词文本捕获（当 pendingForge.step === 'seed' 时）──
    this.bot.on('text', async (ctx) => {
      const pending = ctx.session?.pendingForge;
      if (!pending || pending.step !== 'seed') return;

      const seedWord = ctx.message.text.trim();

      // 忽略命令（以 / 开头）
      if (seedWord.startsWith('/')) return;

      if (seedWord.length > 32) {
        await ctx.reply('❌ 种子词不能超过 32 个字符，请重新输入或点击 Skip');
        return;
      }

      ctx.session = { ...ctx.session, pendingForge: undefined };

      // 确认种子词并开始铸造
      const tierCfg = TIER_CONFIG[pending.tier];
      await ctx.reply(`🌿 种子词: "<b>${seedWord}</b>"\n${tierCfg.icon} 开始铸造 ${tierCfg.name}...`, { parse_mode: 'HTML' });

      await this.executeForge(ctx, pending.tier, seedWord);
    });
  }

  // ═══════════════════════════════════════════════════════
  // Action 注册（Inline Keyboard Callbacks）
  // ═══════════════════════════════════════════════════════

  private registerActions() {
    // 原有的订阅 action
    this.bot.action(/subscribe_(.+)/, async (ctx) => {
      const strategyId = ctx.match[1];
      await ctx.answerCbQuery();
      await ctx.reply(`使用命令订阅:\n/subscribe ${strategyId} 7`);
    });

    // ── 铸造等级选择 ──
    this.bot.action(/forge_tier_(.+)/, async (ctx) => {
      const tier = ctx.match[1] as InscriptionTier;
      if (!Object.values(InscriptionTier).includes(tier)) {
        await ctx.answerCbQuery('无效的等级');
        return;
      }

      await ctx.answerCbQuery();

      // 保存 session 中间状态
      ctx.session = {
        ...ctx.session,
        pendingForge: { tier, step: 'seed' },
      };

      const tierCfg = TIER_CONFIG[tier];
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('⏭️ Skip（无种子词）', `forge_seed_skip`)],
      ]);

      await ctx.editMessageText(
        `${tierCfg.icon} 已选择 <b>${tierCfg.name}</b>\n\n` +
        '🌿 输入一个种子词来影响铸造结果，或点击 Skip 跳过\n\n' +
        '种子词可以是任何有意义的词语（如星座、生肖、幸运数字等）',
        { parse_mode: 'HTML', ...keyboard }
      );
    });

    // ── 种子词跳过 ──
    this.bot.action('forge_seed_skip', async (ctx) => {
      await ctx.answerCbQuery();
      const pending = ctx.session?.pendingForge;
      if (!pending) {
        await ctx.reply('⚠️ 会话已过期，请重新开始: /inscribe');
        return;
      }

      ctx.session = { ...ctx.session, pendingForge: undefined };
      await this.executeForge(ctx, pending.tier, undefined);
    });

    // ── 收藏翻页 ──
    this.bot.action(/coll_page_(\d+)/, async (ctx) => {
      await ctx.answerCbQuery();
      const page = parseInt(ctx.match[1], 10);
      const wallet = ctx.session?.walletAddress;
      if (!wallet) return;

      const collection = this.forge.getCollection(wallet);
      const pageSize = 10;
      const totalPages = Math.ceil(collection.length / pageSize);
      const clampedPage = Math.min(page, totalPages - 1);
      const pageItems = collection.slice(clampedPage * pageSize, (clampedPage + 1) * pageSize);

      const stats = this.forge.getCollectionStats(wallet);

      const lines = pageItems.map((insc) => {
        const tierCfg = TIER_CONFIG[insc.tier];
        const elemIcon = ELEMENT_ICONS[insc.element];
        const rarIcon = RARITY_ICONS[insc.rarity];
        const nameStr = insc.name ? ` — ${insc.name}` : '';
        return `${tierCfg.icon} <code>#${insc.number}</code> | ${elemIcon} ${ELEMENT_NAMES[insc.element]} | ${rarIcon} ${RARITY_NAMES[insc.rarity]} | 🍀 ${insc.trait.name}${nameStr}`;
      });

      const header = `📦 <b>铭文收藏</b> (${stats.totalInscriptions} 枚)\n🍀 平均幸运: ${stats.luckScore}\n🏆 Legendary: ${stats.jackpots}\n`;

      const paginationRow = [];
      if (clampedPage > 0) paginationRow.push(Markup.button.callback('⬅️ 上页', `coll_page_${clampedPage - 1}`));
      paginationRow.push(Markup.button.callback(`${clampedPage + 1}/${totalPages}`, 'coll_noop'));
      if (clampedPage + 1 < totalPages) paginationRow.push(Markup.button.callback('下页 ➡️', `coll_page_${clampedPage + 1}`));

      const keyboard = Markup.inlineKeyboard([paginationRow]);

      await ctx.editMessageText(header + '\n' + lines.join('\n'), {
        parse_mode: 'HTML',
        ...keyboard,
      });
    });

    this.bot.action('coll_noop', async (ctx) => {
      await ctx.answerCbQuery();
    });

    // ── 群组中 "Try your own" 按钮 ──
    this.bot.action('try_inscribe', async (ctx) => {
      await ctx.answerCbQuery();
      // 私聊中启动铭刻流程
      if (ctx.chat?.type === 'private') {
        // 在私聊中直接触发
        const fakeCtx = ctx as unknown as BotContext;
        if (!this.requireWallet(fakeCtx)) return;
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('🥉 Bronze (21)', 'forge_tier_bronze'),
            Markup.button.callback('🥈 Silver (2,100)', 'forge_tier_silver'),
          ],
          [
            Markup.button.callback('🥇 Gold (21,000)', 'forge_tier_gold'),
            Markup.button.callback('💎 Diamond (210,000)', 'forge_tier_diamond'),
          ],
        ]);
        await ctx.reply('🔨 选择铭刻等级：', keyboard);
      } else {
        // 在群组中提示用户去私聊
        await ctx.reply('📬 请私聊我来铸造铭文: /inscribe', {
          reply_markup: {
            inline_keyboard: [[
              { text: '🔮 开始铭刻', url: `https://t.me/${(await this.bot.telegram.getMe()).username}?start=inscribe` },
            ]],
          },
        });
      }
    });

    // ── Inline 查询结果中的铭刻按钮 ──
    this.bot.action(/inline_forge_(.+)/, async (ctx) => {
      await ctx.answerCbQuery();
      const tier = ctx.match[1] as InscriptionTier;
      if (!Object.values(InscriptionTier).includes(tier)) return;

      // 只能在私聊中铸造
      if (ctx.chat?.type !== 'private') {
        await ctx.reply('📬 请私聊我来铸造铭文', {
          reply_markup: {
            inline_keyboard: [[
              { text: '🔮 开始铭刻', url: `https://t.me/${(await this.bot.telegram.getMe()).username}?start=inscribe` },
            ]],
          },
        });
        return;
      }

      const wallet = ctx.session?.walletAddress;
      if (!wallet) {
        await ctx.reply('💳 请先绑定钱包:\n<code>/wallet 你的Solana地址</code>', { parse_mode: 'HTML' });
        return;
      }

      // 直接铸造（inline 模式不走种子词步骤）
      await this.executeForge(ctx as unknown as BotContext, tier, undefined);
    });
  }

  // ═══════════════════════════════════════════════════════
  // Inline Mode 注册
  // ═══════════════════════════════════════════════════════

  private registerInline() {
    this.bot.on('inline_query', async (ctx) => {
      const query = ctx.inlineQuery.query.trim().toLowerCase();
      const userId = String(ctx.from.id);

      // 解析 tier
      const tierMap: Record<string, InscriptionTier> = {
        bronze: InscriptionTier.BRONZE,
        silver: InscriptionTier.SILVER,
        gold: InscriptionTier.GOLD,
        diamond: InscriptionTier.DIAMOND,
      };

      const results: InlineQueryResultArticle[] = [];

      if (!query || Object.keys(tierMap).includes(query)) {
        // 如果没有查询词，展示所有等级；如果指定了等级，只展示该等级
        const tiers = query && tierMap[query] ? [[query, tierMap[query]]] : Object.entries(tierMap);

        for (const [tierKey, tierValue] of tiers) {
          const tier = tierValue as InscriptionTier;
          const tierCfg = TIER_CONFIG[tier];
          results.push({
            type: 'article',
            id: `forge_${tierKey}`,
            title: `${tierCfg.icon} Forge ${tierCfg.name} Inscription`,
            description: `Tier: ${tierCfg.name} | Multiplier: ${tierCfg.multiplier}x`,
            input_message_content: {
              message_text: `🔨 <b>Forge ${tierCfg.icon} ${tierCfg.name}</b>\n\nTap the button below to start forging!`,
              parse_mode: 'HTML',
            },
            reply_markup: {
              inline_keyboard: [[
                { text: `🔥 Forge ${tierCfg.name}`, callback_data: `inline_forge_${tier}` },
              ]],
            },
          });
        }
      }

      // 加入信息查询
      results.push({
        type: 'article',
        id: 'epoch_info',
        title: '🌐 Current Epoch Info',
        description: 'View current epoch, slots, and progress',
        input_message_content: {
          message_text: this.formatEpochInline(),
          parse_mode: 'HTML',
        },
      });

      results.push({
        type: 'article',
        id: 'leaderboard',
        title: '🏆 Leaderboard',
        description: 'View top inscribers by luck score',
        input_message_content: {
          message_text: this.formatLeaderboardInline(),
          parse_mode: 'HTML',
        },
      });

      await ctx.answerInlineQuery(results, { cache_time: 10 });
    });
  }

  /** 格式化纪元信息（用于 inline mode） */
  private formatEpochInline(): string {
    const epochInfo = this.forge.getCurrentEpoch();
    const bar = this.progressBar(epochInfo.progress);
    const total = this.forge.getTotalInscriptions();
    return [
      `🌐 <b>Epoch ${epochInfo.epoch}: ${epochInfo.name}</b>`,
      '',
      `${bar} ${epochInfo.progress.toFixed(1)}%`,
      `📊 ${epochInfo.filledSlots} / ${epochInfo.totalSlots} slots`,
      `📜 Total: ${total.toLocaleString()} inscriptions`,
    ].join('\n');
  }

  /** 格式化排行榜（用于 inline mode） */
  private formatLeaderboardInline(): string {
    const entries = this.forge.getLeaderboard(5);
    if (!entries.length) return '📊 <b>Leaderboard</b>\n\nNo inscriptions yet.';

    const medalEmoji = (rank: number) => {
      if (rank === 1) return '🥇';
      if (rank === 2) return '🥈';
      if (rank === 3) return '🥉';
      return `#${rank}`;
    };

    const lines = entries.map((e) => {
      const shortWallet = `${e.wallet.slice(0, 4)}...${e.wallet.slice(-4)}`;
      return `${medalEmoji(e.rank)} <code>${shortWallet}</code> — 🍀${e.luckScore} | 📦${e.totalInscriptions} | 🏆${e.jackpots}`;
    });

    return ['🏆 <b>Leaderboard TOP 5</b>', '', ...lines].join('\n');
  }

  // ═══════════════════════════════════════════════════════
  // 铸造执行（带动画）
  // ═══════════════════════════════════════════════════════

  private async executeForge(ctx: BotContext, tier: InscriptionTier, seedWord: string | undefined) {
    const wallet = ctx.session?.walletAddress;
    if (!wallet) return;

    const tierCfg = TIER_CONFIG[tier];

    // ── 发送初始 "forging" 消息 ──
    const forgingMsg = await ctx.reply(`🔨 正在铸造 ${tierCfg.icon} ${tierCfg.name}...`);

    // ── 动画：3 次编辑消息模拟进度 ──
    const animFrames = [
      `🔨 铸造中 ${tierCfg.icon} ${tierCfg.name}...\n\n⚗️ [█░░░░░░░░░] 10% — 混合元素...`,
      `🔨 铸造中 ${tierCfg.icon} ${tierCfg.name}...\n\n⚗️ [████░░░░░░] 40% — 凝聚能量...`,
      `🔨 铸造中 ${tierCfg.icon} ${tierCfg.name}...\n\n⚗️ [███████░░░] 70% — 刻印特质...`,
    ];

    for (const frame of animFrames) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      try {
        await ctx.telegram.editMessageText(
          forgingMsg.chat.id,
          forgingMsg.message_id,
          undefined,
          frame,
        );
      } catch {
        // 消息编辑失败不阻断流程
      }
    }

    // ── 执行实际铸造 ──
    await new Promise((resolve) => setTimeout(resolve, 600));
    const inscription = this.forge.forge(tier, wallet, seedWord);

    // ── 删除 forging 动画消息 ──
    try {
      await ctx.telegram.deleteMessage(forgingMsg.chat.id, forgingMsg.message_id);
    } catch {
      // 删除失败不阻断
    }

    // ── 发送结果卡片 ──
    const card = this.formatResultCard(inscription);

    await ctx.reply(`<pre>${card}</pre>`, { parse_mode: 'HTML' });

    // ── 群组中自动发布铭刻公告 ──
    if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
      const announce = this.formatGroupAnnounce(ctx, inscription);
      const tryKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔥 Try your own!', 'try_inscribe')],
      ]);

      try {
        await ctx.telegram.sendMessage(ctx.chat.id, announce, {
          parse_mode: 'HTML',
          ...tryKeyboard,
        });
      } catch (err) {
        this.logger.warn('Failed to post group inscription announcement', { err });
      }
    }

    // ── 清除 pending state ──
    ctx.session = { ...ctx.session, pendingForge: undefined };
  }
}

// ═══════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════

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
