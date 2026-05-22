#!/usr/bin/env node
/**
 * 123456btc-node CLI
 * 完全去中心化策略服务节点
 */

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomBytes } from 'crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createHttpServer } from './api/http.js';
import { createWebSocketServer } from './api/ws.js';
import { SubscriptionStore } from './core/SubscriptionStore.js';
import { registerDependencies, container } from './container/container.js';
import { AuthManager } from './core/AuthManager.js';
import { SignalHub } from './core/SignalHub.js';
import { SettlementEngine } from './core/SettlementEngine.js';
import { BillingCron } from './core/BillingCron.js';
import { PeerNetwork, type NodeRole } from './core/PeerNetwork.js';
import { GossipAdapter } from './infra/network/GossipAdapter.js';
import { Logger } from './infra/logger/Logger.js';
import { TelegramBotService } from './bot/telegram.js';
import { AutoExecutionEngine } from './core/AutoExecutionEngine.js';
import { BlindBoxEngine } from './core/BlindBoxEngine.js';
import { JupiterClient } from './infra/chain/JupiterClient.js';
import { AgentIDManager, type AgentRegistrationInput } from './agent/AgentIDManager.js';
import { BlindBoxOTC, BlindBoxTier } from './blindbox/BlindBoxOTC.js';
import { InscriptionForge, InscriptionTier, Rarity, type Inscription } from './blindbox/InscriptionForge.js';
import { ELEMENT_ICONS, ELEMENT_NAMES, RARITY_ICONS, RARITY_NAMES, TIER_CONFIG } from './blindbox/InscriptionForge.js';
import { StrategyEngine } from './strategy/StrategyEngine.js';
import type { ProviderConfig } from './types/index.js';
import readline from 'readline';

const CONFIG_DIR = path.join(os.homedir(), '.123456btc-node');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const DATA_DIR = path.join(CONFIG_DIR, 'data');

// ── Interactive prompt helper ──
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptSelect(question: string, choices: { label: string; value: string }[]): Promise<string> {
  console.log(question);
  choices.forEach((c, i) => console.log(`  ${i + 1}) ${c.label}`));
  return prompt('Enter number: ').then((answer) => {
    const idx = parseInt(answer, 10) - 1;
    return idx >= 0 && idx < choices.length ? choices[idx].value : choices[0].value;
  });
}

const program = new Command();

program
  .name('123456btc-node')
  .description('Decentralized strategy service node for 123456btc')
  .version('0.1.0');

// ── init ──
program
  .command('init')
  .description('Initialize a new node')
  .requiredOption('--name <name>', 'Node display name')
  .requiredOption('--wallet <address>', 'Your Solana wallet address (this is your identity)')
  .option('--treasury-wallet <address>', 'Platform treasury wallet (defaults to your wallet)')
  .option('--rpc <url>', 'Solana RPC endpoint', 'https://api.mainnet-beta.solana.com')
  .option('--bbt-mint <mint>', 'BBT token mint address', '3s4AK2x2nGkKP8ZADbcKuhdPr3coSuh1XnwZEzWgpump')
  .option('--port <port>', 'Node HTTP/WebSocket port', '1119')
  .option('--p2p-port <port>', 'libp2p P2P port (0 = random)', '0')
  .option('--seeds <urls>', 'Comma-separated seed peer URLs')
  .option('--settlement-mode <mode>', 'Settlement mode: memo | escrow', 'memo')
  .option('--escrow-program-id <id>', 'SubscriptionEscrow Program ID (for escrow mode)')
  .option('--provider-keypair <path>', 'Path to provider keypair JSON file (for escrow mode)')
  .option('--platform-wallet <address>', 'Platform treasury wallet (for escrow fee distribution)')
  .action((opts) => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const config = {
      provider_id: opts.wallet,  // 兼容字段：用钱包地址作为 provider_id
      provider_secret: '',       // 去中心化模式不再需要 provider_secret
      name: opts.name,
      wallet_address: opts.wallet,
      treasury_wallet: opts.treasuryWallet || opts.wallet,
      solana_rpc: opts.rpc,
      bbt_mint: opts.bbtMint,
      burn_rate: 0,
      node_port: parseInt(opts.port, 10),
      p2p_port: parseInt(opts.p2pPort, 10),
      admin_api_key: randomBytes(24).toString('base64url'),
      role: 'peer' as NodeRole,
      seeds: opts.seeds ? String(opts.seeds).split(',') : [],
      settlement_mode: opts.settlementMode as 'memo' | 'escrow',
      escrow_program_id: opts.escrowProgramId || '',
      provider_keypair_path: opts.providerKeypair || '',
      platform_wallet: opts.platformWallet || '',
    };

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

    console.log('✓ Node initialized (peer mode)');
    console.log(`  Wallet:         ${config.wallet_address}`);
    console.log(`  Name:           ${config.name}`);
    console.log(`  Role:           ${config.role}`);
    console.log(`  RPC:            ${config.solana_rpc}`);
    console.log(`  Port:           ${config.node_port}`);
    console.log(`  P2P Port:       ${config.p2p_port}`);
    console.log(`  Seeds:          ${config.seeds.join(', ') || 'none'}`);
    console.log(`  Settlement:     ${config.settlement_mode}`);
    if (config.settlement_mode === 'escrow') {
      console.log(`  Escrow Program: ${config.escrow_program_id || 'not set'}`);
      console.log(`  Provider KP:    ${config.provider_keypair_path || 'not set'}`);
      console.log(`  Platform Wallet: ${config.platform_wallet || 'not set'}`);
    }
    console.log(`  Config:         ${CONFIG_PATH}`);
    console.log('');
    console.log('⚠️  Save your admin API key securely:');
    console.log(`  Admin API Key:   ${config.admin_api_key.slice(0, 4)}****${config.admin_api_key.slice(-4)}`);
    console.log('');
    console.log('You can now:');
    console.log('  - Create strategies: POST /strategies (wallet signature auth)');
    console.log('  - Publish signals:   POST /signals (wallet signature auth)');
    console.log('  - Subscribe:         POST /subscriptions (wallet signature auth)');
  });

// ── config ──
program
  .command('config')
  .description('Show or update configuration')
  .option('--set <key=value>', 'Set a config value')
  .action((opts) => {
    if (!fs.existsSync(CONFIG_PATH)) {
      console.error('Node not initialized. Run: 123456btc-node init');
      process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as ProviderConfig;

    if (opts.set) {
      const [key, value] = opts.set.split('=');
      if (!key || value === undefined) {
        console.error('Invalid format. Use: --set key=value');
        process.exit(1);
      }
      (config as unknown as Record<string, unknown>)[key] =
        key === 'node_port' || key === 'burn_rate' ? parseFloat(value) : value;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log(`Updated ${key} = ${value}`);
    } else {
      const safe = { ...config } as Record<string, unknown>;
      if (typeof safe.provider_secret === 'string') safe.provider_secret = `${(safe.provider_secret as string).slice(0, 4)}****${(safe.provider_secret as string).slice(-4)}`;
      if (typeof safe.admin_api_key === 'string') safe.admin_api_key = `${(safe.admin_api_key as string).slice(0, 4)}****${(safe.admin_api_key as string).slice(-4)}`;
      console.log(JSON.stringify(safe, null, 2));
    }
  });

// ── strategy create ──
program
  .command('strategy:create')
  .description('Create a new strategy')
  .requiredOption('--name <name>', 'Strategy name')
  .requiredOption('--symbol <symbol>', 'Trading symbol, e.g. BTCUSDT')
  .option('--description <desc>', 'Strategy description')
  .option('--pricing <model>', 'Pricing model: daily_bbt | per_signal_bbt | free', 'daily_bbt')
  .option('--price-day <amount>', 'Daily price in BBT')
  .option('--price-signal <amount>', 'Per-signal price in BBT')
  .option('--min-bbt <amount>', 'Minimum BBT tier', '0')
  .action(async (opts) => {
    const config = loadConfig();
    const store = await SubscriptionStore.create(path.join(DATA_DIR, 'node.db'));

    const strategy = store.createStrategy({
      provider_id: config.wallet_address,
      creator_wallet: config.wallet_address,
      name: opts.name,
      description: opts.description,
      symbol: opts.symbol,
      market_type: 'crypto',
      pricing_model: opts.pricing,
      price_per_day: opts.priceDay ? parseFloat(opts.priceDay) : undefined,
      price_per_signal: opts.priceSignal ? parseFloat(opts.priceSignal) : undefined,
      min_bbt_tier: parseInt(opts.minBbt, 10),
      status: 'live',
    });

    console.log('✓ Strategy created');
    console.log(`  ID:     ${strategy.id}`);
    console.log(`  Name:   ${strategy.name}`);
    console.log(`  Symbol: ${strategy.symbol}`);
    console.log(`  Price:  ${strategy.pricing_model}`);
    store.close();
  });

// ── strategy list ──
program
  .command('strategy:list')
  .description('List all strategies')
  .action(async () => {
    const config = loadConfig();
    const store = await SubscriptionStore.create(path.join(DATA_DIR, 'node.db'));
    const strategies = store.listStrategies(config.provider_id);

    console.log(`Strategies (${strategies.length}):`);
    for (const s of strategies) {
      console.log(`  ${s.id} [${s.status}] ${s.name} (${s.symbol}) — ${s.pricing_model}`);
    }
    store.close();
  });

// ── serve ──
program
  .command('serve')
  .description('Start the node server')
  .option('--port <port>', 'Override port')
  .action(async (opts) => {
    // 注册 DI 容器依赖（渐进式迁移：先注册容器，后续逐步将直接实例化改为 container.resolve）
    registerDependencies(true);

    const config = loadConfig();
    const port = opts.port ? parseInt(opts.port, 10) : config.node_port;
    const p2pPort = config.p2p_port ?? 0;
    const role = (config.role || 'provider') as NodeRole;

    const store = await SubscriptionStore.create(path.join(DATA_DIR, 'node.db'));
    const auth = new AuthManager(config as ProviderConfig);
    const hub = new SignalHub(store, auth);
    const settlement = new SettlementEngine(config as ProviderConfig, store);
    await settlement.init();
    settlement.mode = (config.settlement_mode || 'memo') as 'memo' | 'escrow';

    if (config.settlement_mode === 'escrow' && config.provider_keypair_path) {
      const keypairData = JSON.parse(fs.readFileSync(config.provider_keypair_path, 'utf-8'));
      const providerKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
      const programId = config.escrow_program_id ? new PublicKey(config.escrow_program_id) : undefined;
      settlement.enableEscrowMode(providerKeypair, programId);
    }

    const logger = new Logger();

    // 自动执行引擎（可选）
    let autoExecution: AutoExecutionEngine | undefined;
    if (process.env.ENABLE_AUTO_EXECUTION === 'true') {
      const jupiter = new JupiterClient(logger);
      autoExecution = new AutoExecutionEngine(logger, jupiter, {
        rpcUrl: config.solana_rpc,
        bbtMint: config.bbt_mint,
        maxSlippageBps: 100,
        minUsdcForExecution: 5,
        defaultUsdcPerTrade: 20,
      });
      hub.setAutoExecution(autoExecution);
    }

    // 盲盒引擎（默认启用）
    const blindBox = new BlindBoxEngine(logger, store);

    const billing = new BillingCron(
      store,
      settlement,
      { providerWallet: config.wallet_address, providerId: config.provider_id },
      (sub) => {
        console.log(`[Billing] Renewal due: subscription=${sub.id}`);
      },
    );
    billing.start();

    const httpServer = createHttpServer(config as ProviderConfig, store, auth, hub, settlement, billing, autoExecution, blindBox, blindBox);
    const wsServer = createWebSocketServer({ server: httpServer, path: '/ws' }, hub, store, auth);

    // 启动 P2P 网络（libp2p-gossipsub + WebSocket 兼容层）
    const gossipAdapter = new GossipAdapter(logger);
    const peerNetwork = new PeerNetwork(role, config.provider_id, port, hub, config.seeds || [], gossipAdapter, p2pPort);
    await peerNetwork.start(httpServer);

    // 启动 Telegram Bot（如配置了 TOKEN）
    let tgBot: TelegramBotService | undefined;
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    if (tgToken) {
      tgBot = new TelegramBotService({
        token: tgToken,
        store,
        settlement,
        hub,
        providerId: config.provider_id,
        providerWallet: config.wallet_address,
        providerName: config.name,
        nodeHttpUrl: `http://localhost:${port}`,
      });
      await tgBot.start();
    }

    // Provider 节点推送信号时，同时广播到 P2P 网络
    const originalIngest = hub.ingestSignal.bind(hub);
    hub.ingestSignal = async (raw, providerId) => {
      const result = await originalIngest(raw, providerId);
      if (result.ok && result.signal) {
        try {
          peerNetwork.broadcastSignal(result.signal);
        } catch (e) {
          console.error('[P2P] broadcastSignal failed (non-fatal):', (e as Error).message);
        }
      }
      return result;
    };

    httpServer.listen(port, () => {
      console.log('');
      console.log('╔════════════════════════════════════════════╗');
      console.log('║     123456btc-node is running              ║');
      console.log('╠════════════════════════════════════════════╣');
      console.log(`║ Role:     ${role.padEnd(34)} ║`);
      console.log(`║ Provider: ${config.name.padEnd(34)} ║`);
      console.log(`║ Port:     ${String(port).padEnd(34)} ║`);
      console.log(`║ P2P Port: ${String(p2pPort || 'random').padEnd(34)} ║`);
      console.log(`║ Peers:    ${String(peerNetwork.getPeerCount()).padEnd(34)} ║`);
      console.log(`║ Wallet:   ${config.wallet_address.slice(0, 20).padEnd(34)} ║`);
      console.log('╚════════════════════════════════════════════╝');
      console.log('');
      console.log('Endpoints:');
      console.log(`  HTTP:       http://localhost:${port}`);
      console.log(`  WebSocket:  ws://localhost:${port}`);
      console.log(`  Peer:       ws://localhost:${port}/peer`);
      console.log(`  Health:     http://localhost:${port}/health`);
      console.log('');
    });

    process.on('SIGUSR1', () => {
      console.log('\n[EMERGENCY] SIGUSR1 received, wiping...');
      // 1. 删除数据库
      try {
        const dbPath = path.join(DATA_DIR, 'node.db');
        for (const ext of ['', '-wal', '-shm']) {
          if (fs.existsSync(dbPath + ext)) fs.unlinkSync(dbPath + ext);
        }
        console.log('[EMERGENCY] Database deleted');
      } catch {}
      // 2. 安全删除日志
      try {
        const logsDir = path.join(CONFIG_DIR, 'logs');
        if (fs.existsSync(logsDir)) {
          for (const f of fs.readdirSync(logsDir)) {
            const fp = path.join(logsDir, f);
            const size = fs.statSync(fp).size;
            fs.writeFileSync(fp, Buffer.alloc(size).fill(0));
            fs.unlinkSync(fp);
          }
        }
        console.log('[EMERGENCY] Logs purged');
      } catch {}
      // 3. 删除配置
      try {
        if (fs.existsSync(CONFIG_PATH)) {
          fs.writeFileSync(CONFIG_PATH, Buffer.alloc(1024).fill(0));
          fs.unlinkSync(CONFIG_PATH);
          console.log('[EMERGENCY] Config deleted');
        }
      } catch {}
      console.log('[EMERGENCY] Done. Exiting.');
      process.exit(1);
    });

    const shutdown = () => {
      console.log('\n[Shutdown] Closing node...');
      tgBot?.stop();
      billing.stop();
      peerNetwork.stop();
      wsServer.close();
      httpServer.close(() => {
        store.close();
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

// ── mcp ──
program
  .command('mcp')
  .description('Start MCP server for AI Agent integration (Claude Code, Cursor, OpenCode, etc.)')
  .action(async () => {
    const { spawn } = await import('child_process');
    const mcpPath = path.join(__dirname, 'mcp', 'server.js');
    const mcp = spawn('npx', ['tsx', mcpPath], {
      stdio: 'inherit',
    });
    mcp.on('exit', (code) => process.exit(code || 0));
  });

// ── user add ──
program
  .command('user:add')
  .description('Manually add a user (for testing)')
  .requiredOption('--wallet <address>', 'Solana wallet address')
  .option('--name <name>', 'Display name')
  .action(async (opts) => {
    const store = await SubscriptionStore.create(path.join(DATA_DIR, 'node.db'));
    const user = store.createUser({
      wallet_address: opts.wallet,
      display_name: opts.name || opts.wallet.slice(0, 8),
      chain_bbt_balance: 0,
      status: 'active',
    });
    console.log(`✓ User added: ${user.id} (${user.wallet_address})`);
    store.close();
  });

// ── emergency-wipe ──
program
  .command('emergency-wipe')
  .description('EMERGENCY: Wipe all data, logs, keys. IRREVERSIBLE.')
  .option('--confirm', 'Skip confirmation')
  .action((opts) => {
    if (!opts.confirm) {
      console.log('WARNING: This will permanently delete ALL data.');
      console.log('Run with --confirm to proceed.');
      return;
    }
    console.log('[EMERGENCY] Starting wipe...');
    // 1. 删除数据库
    try {
      const dbPath = path.join(DATA_DIR, 'node.db');
      for (const ext of ['', '-wal', '-shm']) {
        if (fs.existsSync(dbPath + ext)) fs.unlinkSync(dbPath + ext);
      }
      console.log('[EMERGENCY] Database deleted');
    } catch {}
    // 2. 安全删除日志
    try {
      const logsDir = path.join(CONFIG_DIR, 'logs');
      if (fs.existsSync(logsDir)) {
        for (const f of fs.readdirSync(logsDir)) {
          const fp = path.join(logsDir, f);
          const size = fs.statSync(fp).size;
          fs.writeFileSync(fp, Buffer.alloc(size).fill(0));
          fs.unlinkSync(fp);
        }
        fs.rmdirSync(logsDir);
      }
      console.log('[EMERGENCY] Logs purged');
    } catch {}
    // 3. 安全删除配置
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        fs.writeFileSync(CONFIG_PATH, Buffer.alloc(1024).fill(0));
        fs.unlinkSync(CONFIG_PATH);
        console.log('[EMERGENCY] Config deleted');
      }
    } catch {}
    console.log('[EMERGENCY] Wipe complete. All data destroyed.');
  });

// ══════════════════════════════════════════════════════════════
// ── agent register ──
// ══════════════════════════════════════════════════════════════

const agentCmd = program
  .command('agent')
  .description('Agent identity management (AgentIDManager)');

agentCmd
  .command('register')
  .description('Register a new Agent with Ed25519 wallet')
  .requiredOption('--wallet <address>', 'Solana wallet address')
  .option('--name <name>', 'Agent display name')
  .option('--capabilities <list>', 'Capabilities (comma-separated)', 'trader')
  .option('--agent-version <ver>', 'Agent version', '1.0.0')
  .option('--endpoint <url>', 'Node API endpoint URL')
  .action(async (opts) => {
    const logger = new Logger();
    const store = await SubscriptionStore.create(path.join(DATA_DIR, 'node.db'));
    const manager = new AgentIDManager(logger, undefined, store);

    let displayName = opts.name;
    if (!displayName) {
      displayName = await prompt('Agent display name (2-64 chars): ');
    }
    if (!displayName || displayName.length < 2) {
      console.error('Error: Display name must be 2-64 characters');
      process.exit(1);
    }

    const capabilities = opts.capabilities.split(',').map((c: string) => c.trim());

    const input: AgentRegistrationInput = {
      wallet_address: opts.wallet,
      display_name: displayName,
      metadata: {
        name: displayName,
        description: `Agent ${displayName}`,
        capabilities,
        version: opts.agentVersion || '1.0.0',
        endpoint_url: opts.endpoint,
      },
      signature: 'cli_bypass',  // CLI 模式跳过签名验证（实际生产环境需要钱包签名）
      timestamp: Date.now(),
    };

    try {
      const agent = manager.register(input);
      console.log('');
      console.log('Agent registered successfully');
      console.log('  Agent ID:      ' + agent.agent_id);
      console.log('  Display Name:  ' + agent.display_name);
      console.log('  Wallet:        ' + agent.wallet_address);
      console.log('  Status:        ' + agent.status);
      console.log('  Reputation:    ' + agent.reputation_score);
      console.log('  Capabilities:  ' + capabilities.join(', '));
      if (agent.metadata_uri) {
        console.log('  Metadata URI:  ' + agent.metadata_uri);
      }
      console.log('');
      console.log('Next steps:');
      console.log('  1. Mint Bot ID NFT (on-chain) to activate');
      console.log('  2. Bind agent to strategies: 123456btc-node strategy bind');
    } catch (err) {
      console.error('Registration failed:', (err as Error).message);
      process.exit(1);
    } finally {
      store.close();
    }
  });

// ── agent status ──
agentCmd
  .command('status')
  .description('View Agent status and reputation')
  .option('--id <agentId>', 'Agent ID')
  .option('--wallet <address>', 'Lookup by wallet address')
  .action(async (opts) => {
    const logger = new Logger();
    const store = await SubscriptionStore.create(path.join(DATA_DIR, 'node.db'));
    const manager = new AgentIDManager(logger, undefined, store);

    let agent;
    if (opts.id) {
      agent = manager.getAgent(opts.id);
    } else if (opts.wallet) {
      agent = manager.getAgentByWallet(opts.wallet);
    }

    if (!agent) {
      // If no ID/wallet given, show stats overview
      const stats = manager.getStats();
      console.log('');
      console.log('Agent Registry Stats');
      console.log('  Total agents:     ' + stats.total);
      console.log('  Active:           ' + stats.active);
      console.log('  Suspended:        ' + stats.suspended);
      console.log('  Banned:           ' + stats.banned);
      console.log('  Pending:          ' + stats.pending);
      console.log('  With NFT:         ' + stats.with_nft);
      console.log('  Avg reputation:   ' + stats.avg_reputation);
      console.log('  Total staked BBT: ' + stats.total_staked);
      console.log('');
      if (!opts.id && !opts.wallet) {
        console.log('Tip: Use --id <agentId> or --wallet <address> to view a specific agent.');
      }
      return;
    }

    console.log('');
    console.log('Agent Status');
    console.log('  Agent ID:       ' + agent.agent_id);
    console.log('  Display Name:   ' + agent.display_name);
    console.log('  Wallet:         ' + agent.wallet_address);
    console.log('  Status:         ' + agent.status);
    console.log('  Reputation:     ' + agent.reputation_score + ' / 1000');
    console.log('  Trades:         ' + agent.successful_trades + ' / ' + agent.total_trades);
    console.log('  Signals:        ' + agent.accurate_signals + ' / ' + agent.total_signals);
    console.log('  Uptime (hrs):   ' + agent.uptime_hours);
    console.log('  BBT Staked:     ' + agent.bbt_staked);
    console.log('  Bot NFT Mint:   ' + (agent.bot_nft_mint || 'none'));
    console.log('  Created:        ' + new Date(agent.created_at).toISOString());
    console.log('  Last Active:    ' + new Date(agent.last_active_at).toISOString());

    // Show reputation factors
    const factors = manager.getReputationFactors(agent.agent_id);
    if (factors) {
      console.log('');
      console.log('  Reputation Factors:');
      console.log('    Trade success rate: ' + factors.trade_success_rate + '%');
      console.log('    Signal accuracy:    ' + factors.signal_accuracy + '%');
      console.log('    Uptime score:       ' + factors.uptime_score + '%');
      console.log('    Stake weight:       ' + factors.stake_weight + '%');
      console.log('    Age bonus:          ' + factors.age_bonus + '%');
    }
    console.log('');
    store.close();
  });

// ══════════════════════════════════════════════════════════════
// ── blindbox create ──
// ══════════════════════════════════════════════════════════════

const blindboxCmd = program
  .command('blindbox')
  .description('BlindBox OTC marketplace operations');

blindboxCmd
  .command('create')
  .description('Create a new blind box (seller locks BBT)')
  .requiredOption('--wallet <address>', 'Seller wallet address')
  .option('--tier <tier>', 'BlindBox tier: bronze | silver | gold | platinum | diamond')
  .action(async (opts) => {
    const logger = new Logger();
    const otc = new BlindBoxOTC(logger);

    let tierStr = opts.tier;
    if (!tierStr) {
      tierStr = await promptSelect('Select blind box tier:', [
        { label: 'Bronze (1 USDT / 100 BBT)', value: 'bronze' },
        { label: 'Silver (10 USDT / 1,000 BBT)', value: 'silver' },
        { label: 'Gold (100 USDT / 10,000 BBT)', value: 'gold' },
        { label: 'Platinum (1,000 USDT / 100,000 BBT)', value: 'platinum' },
        { label: 'Diamond (10,000 USDT / 1,000,000 BBT)', value: 'diamond' },
      ]);
    }

    const tier = tierStr as BlindBoxTier;
    const tierConfig = otc.getTierConfig(tier);
    if (!tierConfig) {
      console.error('Invalid tier. Choose: bronze, silver, gold, platinum, diamond');
      process.exit(1);
    }

    try {
      const { box, lockTransaction } = await otc.createBox(opts.wallet, tier);

      console.log('');
      console.log('BlindBox created');
      console.log('  Box ID:      ' + box.id);
      console.log('  Tier:        ' + tierConfig.name + ' ' + tierConfig.icon);
      console.log('  USDT Value:  ' + box.usdtValue);
      console.log('  BBT Locked:  ' + box.bbtAmount);
      console.log('  Fee (bps):   ' + tierConfig.platformFeeBps);
      console.log('  Status:      ' + box.status);
      console.log('  Expires:     ' + new Date(box.expiresAt).toISOString());
      console.log('  Nonce:       ' + box.nonce);
      console.log('');
      console.log('Box Secret (save this, share with buyer after fiat payment):');
      console.log('  ' + box.boxSecret);
      console.log('');
      console.log('Next steps:');
      console.log('  1. Sign and submit the lock transaction on-chain');
      console.log('  2. Call confirmLock with the tx signature');
      console.log('  3. List the box: 123456btc-node blindbox list');
      console.log('  4. Wait for buyer to reserve and pay fiat');
    } catch (err) {
      console.error('Create failed:', (err as Error).message);
      process.exit(1);
    }
  });

// ── blindbox list ──
blindboxCmd
  .command('list')
  .description('List market blind boxes')
  .option('--tier <tier>', 'Filter by tier: bronze | silver | gold | platinum | diamond')
  .action((opts) => {
    const logger = new Logger();
    const otc = new BlindBoxOTC(logger);

    const tier = opts.tier as BlindBoxTier | undefined;
    const listings = otc.getMarketListings(tier);

    // Also show tier configs for reference
    const tiers = otc.getTierConfigs();

    console.log('');
    console.log('Available Tiers:');
    for (const t of tiers) {
      console.log('  ' + t.icon + ' ' + t.name.padEnd(12) + ' — ' + t.usdtValue + ' USDT / ' + t.bbtRequired.toLocaleString() + ' BBT (fee: ' + (t.platformFeeBps / 100) + '%)');
    }

    console.log('');
    console.log('Market Listings (' + listings.length + '):');
    if (listings.length === 0) {
      console.log('  No blind boxes currently listed.');
      console.log('  Create one with: 123456btc-node blindbox create');
    } else {
      for (const box of listings) {
        const tc = otc.getTierConfig(box.tier);
        console.log('  ' + (tc?.icon || '?') + ' ' + box.id + ' | ' + box.usdtValue + ' USDT | ' + box.bbtAmount.toLocaleString() + ' BBT | ' + box.status + ' | Seller: ' + box.sellerWallet.slice(0, 8) + '...');
      }
    }
    console.log('');
  });

// ── blindbox buy ──
blindboxCmd
  .command('buy')
  .description('Reserve and buy a blind box')
  .requiredOption('--box-id <id>', 'BlindBox ID to buy')
  .requiredOption('--wallet <address>', 'Buyer wallet address')
  .option('--payment-ref <ref>', 'Fiat payment reference (bank ref number)')
  .action(async (opts) => {
    const logger = new Logger();
    const otc = new BlindBoxOTC(logger);

    try {
      // Step 1: Reserve
      const box = otc.reserveBox(opts.boxId, opts.wallet);
      console.log('');
      console.log('BlindBox reserved');
      console.log('  Box ID:     ' + box.id);
      console.log('  Tier:       ' + box.tier);
      console.log('  USDT Value: ' + box.usdtValue);
      console.log('  Status:     ' + box.status);
      console.log('  Expires:    ' + new Date(box.expiresAt).toISOString());

      // Step 2: Fiat payment confirmation
      let paymentRef = opts.paymentRef;
      if (!paymentRef) {
        console.log('');
        console.log('Please complete fiat payment of ' + box.usdtValue + ' USDT to the seller.');
        paymentRef = await prompt('Enter payment reference (bank txn ID): ');
      }

      if (!paymentRef) {
        console.log('');
        console.log('Reservation saved. Complete payment and re-run with --payment-ref to confirm.');
        return;
      }

      otc.confirmFiatPayment(box.id, opts.wallet, paymentRef);
      console.log('');
      console.log('Fiat payment confirmed');
      console.log('  Box ID:      ' + box.id);
      console.log('  Payment Ref: ' + paymentRef.slice(0, 12) + '...');
      console.log('  Status:      paid');
      console.log('');
      console.log('Waiting for seller to confirm receipt and release BBT.');
      console.log('Buyer will receive the box secret after both parties confirm.');
    } catch (err) {
      console.error('Buy failed:', (err as Error).message);
      process.exit(1);
    }
  });

// ── blindbox stats ──
blindboxCmd
  .command('stats')
  .description('Show BlindBox OTC marketplace statistics')
  .action(() => {
    const logger = new Logger();
    const otc = new BlindBoxOTC(logger);
    const stats = otc.getStats();

    console.log('');
    console.log('BlindBox OTC Stats');
    console.log('  Total boxes:      ' + stats.totalBoxes);
    console.log('  Active boxes:     ' + stats.activeBoxes);
    console.log('  Completed trades: ' + stats.completedTrades);
    console.log('  Total volume:     ' + stats.totalVolumeUsdt + ' USDT');
    console.log('  Open disputes:    ' + stats.openDisputes);
    console.log('  Arbitrators:      ' + stats.totalArbitrators);
    console.log('');
  });

// ══════════════════════════════════════════════════════════════
// ── strategy bind ──
// ══════════════════════════════════════════════════════════════

const strategyCmd = program
  .command('strategy')
  .description('Strategy engine: agent binding, NFT subscriptions, bundles');

strategyCmd
  .command('bind')
  .description('Bind an AI Agent to a strategy')
  .requiredOption('--strategy-id <id>', 'Strategy ID')
  .requiredOption('--agent-id <id>', 'Agent ID')
  .requiredOption('--wallet <address>', 'Agent wallet address (receives execution rewards)')
  .option('--type <type>', 'Agent type: ai_llm | rule_based | hybrid', 'ai_llm')
  .option('--mode <mode>', 'Execution mode: auto | semi_auto | manual', 'auto')
  .option('--fee-share <bps>', 'Agent fee share in bps (e.g., 500 = 5%)', '100')
  .action(async (opts) => {
    const logger = new Logger();
    const store = await SubscriptionStore.create(path.join(DATA_DIR, 'node.db'));
    const engine = new StrategyEngine(logger, store);

    try {
      const binding = engine.bindAgent(
        opts.strategyId,
        opts.agentId,
        opts.wallet,
        {
          agentType: opts.type as 'ai_llm' | 'rule_based' | 'hybrid',
          executionMode: opts.mode as 'auto' | 'semi_auto' | 'manual',
          feeShareBps: parseInt(opts.feeShare, 10),
        },
      );

      console.log('');
      console.log('Agent bound to strategy');
      console.log('  Binding ID:     ' + binding.id);
      console.log('  Agent ID:       ' + binding.agent_id);
      console.log('  Strategy ID:    ' + binding.strategy_id);
      console.log('  Agent Wallet:   ' + binding.agent_wallet);
      console.log('  Agent Type:     ' + binding.agent_type);
      console.log('  Execution Mode: ' + binding.execution_mode);
      console.log('  Fee Share:      ' + (binding.fee_share_bps / 100) + '%');
      console.log('  Status:         ' + binding.status);
      console.log('');
    } catch (err) {
      console.error('Bind failed:', (err as Error).message);
      process.exit(1);
    } finally {
      store.close();
    }
  });

// ── strategy agents ──
strategyCmd
  .command('agents')
  .description('List agents bound to a strategy')
  .requiredOption('--strategy-id <id>', 'Strategy ID')
  .action(async (opts) => {
    const logger = new Logger();
    const store = await SubscriptionStore.create(path.join(DATA_DIR, 'node.db'));
    const engine = new StrategyEngine(logger, store);

    const agents = engine.getStrategyAgents(opts.strategyId);

    console.log('');
    console.log('Agents for strategy ' + opts.strategyId + ' (' + agents.length + '):');
    if (agents.length === 0) {
      console.log('  No agents bound. Use: 123456btc-node strategy bind');
    } else {
      for (const a of agents) {
        console.log('  ' + a.agent_id + ' | ' + a.agent_type + ' | ' + a.execution_mode + ' | fee: ' + (a.fee_share_bps / 100) + '% | ' + a.status);
      }
    }
    console.log('');
    store.close();
  });

// ── strategy bundles ──
strategyCmd
  .command('bundles')
  .description('List available bundle products')
  .action(async () => {
    const logger = new Logger();
    const store = await SubscriptionStore.create(path.join(DATA_DIR, 'node.db'));
    const engine = new StrategyEngine(logger, store);

    const bundles = engine.getBundleProducts();

    console.log('');
    console.log('Available Bundles (' + bundles.length + '):');
    if (bundles.length === 0) {
      console.log('  No bundles available.');
    } else {
      for (const b of bundles) {
        console.log('');
        console.log('  ' + b.name + ' [' + b.id + ']');
        console.log('    ' + b.description);
        console.log('    BlindBoxes: ' + b.blindbox_count + ' | Bonus days: ' + b.bonus_days + ' | NFT tier: ' + b.nft_tier);
        console.log('    Price: ' + b.price_sol + ' SOL / ' + b.price_bbt + ' BBT');
        console.log('    Supply: ' + (b.max_supply === 0 ? 'unlimited' : b.sold_count + ' / ' + b.max_supply));
        console.log('    Strategies: ' + (b.strategy_ids.length > 0 ? b.strategy_ids.join(', ') : 'none'));
      }
    }
    console.log('');
    store.close();
  });

// ── strategy bundle (purchase) ──
strategyCmd
  .command('bundle')
  .description('Purchase a bundle product')
  .requiredOption('--bundle-id <id>', 'Bundle ID')
  .requiredOption('--wallet <address>', 'Buyer wallet address')
  .requiredOption('--user-id <id>', 'User ID for subscription')
  .option('--payment <method>', 'Payment method: sol | bbt', 'bbt')
  .option('--tx <signature>', 'On-chain transaction signature (if already paid)')
  .action(async (opts) => {
    const logger = new Logger();
    const store = await SubscriptionStore.create(path.join(DATA_DIR, 'node.db'));
    const engine = new StrategyEngine(logger, store);

    try {
      const result = await engine.purchaseBundle(
        opts.bundleId,
        opts.wallet,
        opts.userId,
        opts.payment as 'sol' | 'bbt',
        opts.tx,
      );

      if (!result.success) {
        console.error('Purchase failed:', result.error);
        process.exit(1);
      }

      console.log('');
      console.log('Bundle purchased successfully');
      if (result.nft) {
        console.log('  NFT ID:     ' + result.nft.id);
        console.log('  NFT Mint:   ' + result.nft.mint_address);
        console.log('  Tier:       ' + result.nft.tier);
        console.log('  Days:       ' + result.nft.subscription_days);
        console.log('  Expires:    ' + (result.nft.expires_at === 0 ? 'Never' : new Date(result.nft.expires_at).toISOString()));
      }
      console.log('  BlindBox credits: ' + (result.blindboxCredits || 0));
      if (result.subscriptions && result.subscriptions.length > 0) {
        console.log('  Subscriptions: ' + result.subscriptions.join(', '));
      }
      console.log('');
    } catch (err) {
      console.error('Purchase failed:', (err as Error).message);
      process.exit(1);
    } finally {
      store.close();
    }
  });

// ══════════════════════════════════════════════════════════════
// ── inscribe (InscriptionForge 铭文铸造系统)
// ══════════════════════════════════════════════════════════════

const inscribeCmd = program
  .command('inscribe')
  .description('InscriptionForge - Bitcoin inscription minting system');

// ── inscribe (interactive forge) ──
inscribeCmd
  .description('Forge a new inscription interactively')
  .option('--tier <tier>', 'Inscription tier: bronze | silver | gold | diamond')
  .option('--seed <word>', 'Seed word to influence the forging result')
  .option('--wallet <address>', 'Wallet address (defaults to config wallet)')
  .action(async (opts) => {
    const forge = new InscriptionForge();

    // 获取钱包地址
    let wallet = opts.wallet;
    if (!wallet) {
      try {
        const config = loadConfig();
        wallet = config.wallet_address;
      } catch {
        wallet = await prompt('Enter your wallet address: ');
      }
    }
    if (!wallet) {
      console.error('Error: Wallet address is required');
      process.exit(1);
    }

    // 选择铭刻等级
    let tierStr = opts.tier;
    if (!tierStr) {
      tierStr = await promptSelect('Select inscription tier:', [
        { label: '🥉 Bronze  — Entry level', value: 'bronze' },
        { label: '🥈 Silver  — Mid tier', value: 'silver' },
        { label: '🥇 Gold    — Premium', value: 'gold' },
        { label: '💎 Diamond — Legendary', value: 'diamond' },
      ]);
    }

    const tier = tierStr as InscriptionTier;
    if (!TIER_CONFIG[tier]) {
      console.error('Invalid tier. Choose: bronze, silver, gold, diamond');
      process.exit(1);
    }

    // 可选种子词
    let seedWord = opts.seed;
    if (!seedWord) {
      const useSeed = await prompt('Enter a seed word (optional, press Enter to skip): ');
      if (useSeed) seedWord = useSeed;
    }

    // 铸造动画
    console.log('');
    console.log('═══════════════════════════════════════');
    console.log('  InscriptionForge — Forging...');
    console.log('═══════════════════════════════════════');
    console.log('');

    const frames = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
    const stages = [
      'Preparing forge materials...',
      'Heating the inscription matrix...',
      'Channeling elemental forces...',
      'Imbuing cryptographic entropy...',
      'Sealing the inscription...',
    ];

    for (let s = 0; s < stages.length; s++) {
      process.stdout.write(`  ${frames[0]} ${stages[s]}`);
      for (let f = 0; f < 8; f++) {
        await new Promise(r => setTimeout(r, 100));
        process.stdout.write(`\r  ${frames[f % frames.length]} ${stages[s]}`);
      }
      console.log(`\r  ✓ ${stages[s]}`);
    }

    console.log('');

    // 执行铸造
    const inscription = forge.forge(tier, wallet, seedWord);

    // 显示结果
    const tierCfg = TIER_CONFIG[inscription.tier];
    const elemIcon = ELEMENT_ICONS[inscription.element];
    const elemName = ELEMENT_NAMES[inscription.element];
    const rarityIcon = RARITY_ICONS[inscription.rarity];
    const rarityName = RARITY_NAMES[inscription.rarity];

    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║          INSCRIPTION FORGED SUCCESSFULLY         ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  ID:       ${inscription.id.padEnd(38)}║`);
    console.log(`║  Number:   #${String(inscription.number).padEnd(37)}║`);
    console.log(`║  Tier:     ${tierCfg.icon} ${tierCfg.name.padEnd(35)}║`);
    console.log(`║  Element:  ${elemIcon} ${elemName.padEnd(35)}║`);
    console.log(`║  Rarity:   ${rarityIcon} ${rarityName.padEnd(35)}║`);
    console.log(`║  Trait:    ${inscription.trait.name.padEnd(38)}║`);
    console.log(`║  Series:   ${inscription.series.padEnd(38)}║`);
    console.log(`║  Epoch:    ${String(inscription.epoch).padEnd(38)}║`);
    console.log(`║  Luck:     ${String(inscription.luckScore).padEnd(38)}║`);
    if (seedWord) {
      console.log(`║  Seed:     ${seedWord.padEnd(38)}║`);
    }
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  ${inscription.trait.description}`);
    console.log('');
    console.log('  Next steps:');
    console.log(`    • Name it:    123456btc-node inscribe name ${inscription.id} <name>`);
    console.log(`    • Collection: 123456btc-node inscribe collection --wallet ${wallet.slice(0, 12)}...`);
    console.log(`    • Epoch info: 123456btc-node inscribe epoch`);
    console.log('');
  });

// ── inscribe status ──
inscribeCmd
  .command('status')
  .description('Show current epoch and slot info')
  .action(() => {
    const forge = new InscriptionForge();
    const epoch = forge.getCurrentEpoch();

    // 进度条
    const barWidth = 30;
    const filled = Math.round((epoch.progress / 100) * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

    console.log('');
    console.log('InscriptionForge Status');
    console.log('═══════════════════════════════════════');
    console.log(`  Epoch:     ${epoch.epoch} — ${epoch.name}`);
    console.log(`  Slots:     ${epoch.filledSlots} / ${epoch.totalSlots} filled`);
    console.log(`  Remaining: ${epoch.remainingSlots}`);
    console.log(`  Progress:  [${bar}] ${epoch.progress.toFixed(1)}%`);
    console.log(`  Range:     #${epoch.startInscription} — #${epoch.endInscription}`);
    console.log(`  Started:   ${new Date(epoch.startedAt).toISOString()}`);
    console.log('');
    console.log('  Upcoming Milestones:');
    const nextHundred = Math.ceil(forge.getTotalInscriptions() / 100) * 100;
    for (let m = nextHundred; m < epoch.endInscription; m += 100) {
      const remaining = m - forge.getTotalInscriptions();
      console.log(`    #${m} — in ${remaining} inscriptions`);
    }
    console.log('');
  });

// ── inscribe collection ──
inscribeCmd
  .command('collection')
  .description('View your inscription collection')
  .option('--wallet <address>', 'Wallet address (defaults to config wallet)')
  .action((opts) => {
    const forge = new InscriptionForge();

    let wallet = opts.wallet;
    if (!wallet) {
      try {
        const config = loadConfig();
        wallet = config.wallet_address;
      } catch {
        console.error('Error: Wallet address required. Use --wallet or run init first.');
        process.exit(1);
      }
    }

    const stats = forge.getCollectionStats(wallet);
    const collection = forge.getCollection(wallet);

    console.log('');
    console.log('═══════════════════════════════════════');
    console.log('  InscriptionForge — Your Collection');
    console.log('═══════════════════════════════════════');
    console.log('');
    console.log(`  Wallet:     ${wallet}`);
    console.log(`  Total:      ${stats.totalInscriptions} inscriptions`);
    console.log(`  Luck Score: ${stats.luckScore} / 100`);
    console.log(`  Jackpots:   ${stats.jackpots} (Legendary)`);
    console.log('');

    // 稀有度分布
    console.log('  Rarity Distribution:');
    for (const rarity of [Rarity.LEGENDARY, Rarity.EPIC, Rarity.RARE, Rarity.UNCOMMON, Rarity.COMMON]) {
      const count = stats.rarityDistribution[rarity];
      if (count > 0) {
        console.log(`    ${RARITY_ICONS[rarity]} ${RARITY_NAMES[rarity].padEnd(12)} ${count}`);
      }
    }
    console.log('');

    // 等级分布
    console.log('  Tier Distribution:');
    for (const tier of [InscriptionTier.DIAMOND, InscriptionTier.GOLD, InscriptionTier.SILVER, InscriptionTier.BRONZE]) {
      const count = stats.tierDistribution[tier];
      if (count > 0) {
        const cfg = TIER_CONFIG[tier];
        console.log(`    ${cfg.icon} ${cfg.name.padEnd(12)} ${count}`);
      }
    }
    console.log('');

    // 铭文列表（最近 10 个）
    if (collection.length > 0) {
      console.log('  Recent Inscriptions:');
      const recent = collection.slice(-10).reverse();
      for (const i of recent) {
        const rIcon = RARITY_ICONS[i.rarity];
        const eIcon = ELEMENT_ICONS[i.element];
        const name = i.name ? ` "${i.name}"` : '';
        console.log(`    ${rIcon} ${i.id}${name} | ${eIcon} ${ELEMENT_NAMES[i.element]} | ${i.trait.name} | Luck: ${i.luckScore}`);
      }
      if (collection.length > 10) {
        console.log(`    ... and ${collection.length - 10} more`);
      }
    }
    console.log('');
  });

// ── inscribe leaderboard ──
inscribeCmd
  .command('leaderboard')
  .description('View the inscription leaderboard')
  .option('--limit <n>', 'Number of entries to show', '10')
  .action((opts) => {
    const forge = new InscriptionForge();
    const limit = parseInt(opts.limit, 10) || 10;
    const entries = forge.getLeaderboard(limit);

    console.log('');
    console.log('═══════════════════════════════════════');
    console.log('  InscriptionForge — Leaderboard');
    console.log('═══════════════════════════════════════');
    console.log('');

    if (entries.length === 0) {
      console.log('  No inscriptions yet. Be the first!');
      console.log('  Run: 123456btc-node inscribe');
      console.log('');
      return;
    }

    console.log('  Rank  Wallet              Luck  Total  Jackpots');
    console.log('  ────  ─────────────────── ────  ─────  ────────');

    for (const entry of entries) {
      const rankIcon = entry.rank <= 3 ? ['🥇', '🥈', '🥉'][entry.rank - 1] : '  ';
      const walletShort = entry.wallet.length > 18
        ? entry.wallet.slice(0, 8) + '..' + entry.wallet.slice(-8)
        : entry.wallet.padEnd(18);
      const jackpotStr = entry.jackpots > 0 ? `💎 ${entry.jackpots}` : '  -';

      console.log(`  ${rankIcon} ${String(entry.rank).padStart(3)}  ${walletShort}  ${String(entry.luckScore).padStart(4)}  ${String(entry.totalInscriptions).padStart(5)}  ${jackpotStr}`);
    }

    console.log('');
    const totalInscriptions = forge.getTotalInscriptions();
    console.log(`  Total inscriptions forged: ${totalInscriptions}`);
    console.log('');
  });

// ── inscribe name ──
inscribeCmd
  .command('name <id> <name>')
  .description('Name an inscription')
  .option('--wallet <address>', 'Wallet address (defaults to config wallet)')
  .action((id: string, name: string, opts) => {
    const forge = new InscriptionForge();

    let wallet = opts.wallet;
    if (!wallet) {
      try {
        const config = loadConfig();
        wallet = config.wallet_address;
      } catch {
        console.error('Error: Wallet address required. Use --wallet or run init first.');
        process.exit(1);
      }
    }

    const result = forge.nameInscription(id, name, wallet);
    if (!result) {
      console.error(`Error: Inscription ${id} not found or does not belong to your wallet.`);
      process.exit(1);
    }

    console.log('');
    console.log(`  ✓ Inscription ${id} named: "${name}"`);
    console.log(`    Number: #${result.number}`);
    console.log(`    Rarity: ${RARITY_ICONS[result.rarity]} ${RARITY_NAMES[result.rarity]}`);
    console.log('');
  });

// ── inscribe epoch ──
inscribeCmd
  .command('epoch')
  .description('Show detailed epoch information')
  .action(() => {
    const forge = new InscriptionForge();
    const current = forge.getCurrentEpoch();
    const allEpochs = forge.getAllEpochs();
    const genesisCount = forge.getGenesisAgentCount();

    // 进度条
    const barWidth = 30;
    const filled = Math.round((current.progress / 100) * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

    console.log('');
    console.log('═══════════════════════════════════════');
    console.log('  InscriptionForge — Epoch Details');
    console.log('═══════════════════════════════════════');
    console.log('');
    console.log(`  Current Epoch: ${current.epoch} — ${current.name}`);
    console.log(`  Progress:      [${bar}] ${current.progress.toFixed(1)}%`);
    console.log(`  Slots:         ${current.filledSlots} / ${current.totalSlots}`);
    console.log(`  Total Forged:  ${forge.getTotalInscriptions()}`);
    console.log(`  Genesis Agents: ${genesisCount} (Epoch 0 Legendary)`);
    console.log('');

    // 所有纪元历史
    console.log('  Epoch History:');
    console.log('  ┌─────────┬────────────┬───────┬──────────┬───────────┐');
    console.log('  │ Epoch   │ Name       │ Filled│ Progress │ Range     │');
    console.log('  ├─────────┼────────────┼───────┼──────────┼───────────┤');

    for (const e of allEpochs) {
      const epochStr = String(e.epoch).padStart(5);
      const nameStr = e.name.padEnd(10);
      const filledStr = `${e.filledSlots}/${e.totalSlots}`.padStart(5);
      const progStr = `${e.progress.toFixed(1)}%`.padStart(6);
      const rangeStr = `#${e.startInscription}-#${e.endInscription}`.padEnd(9);
      const marker = e.epoch === current.epoch ? ' ◄' : '  ';
      console.log(`  │ ${epochStr} │ ${nameStr} │ ${filledStr} │ ${progStr} │ ${rangeStr} │${marker}`);
    }

    console.log('  └─────────┴────────────┴───────┴──────────┴───────────┘');
    console.log('');
  });

// ── escrow ──
const escrowCmd = program.command('escrow').description('Escrow mode operations');

escrowCmd
  .command('status')
  .description('Query escrow subscription status')
  .requiredOption('--pda <pda>', 'Subscription PDA')
  .action(async (opts) => {
    const config = loadConfig();
    const store = await SubscriptionStore.create(path.join(DATA_DIR, 'node.db'));
    const settlement = new SettlementEngine(config as ProviderConfig, store);
    await settlement.init();
    const state = await settlement.getEscrowState(new PublicKey(opts.pda));
    console.log(state);
    store.close();
  });

escrowCmd
  .command('claim')
  .description('Provider claim earned BBT from escrow')
  .requiredOption('--pda <pda>', 'Subscription PDA')
  .requiredOption('--keypair <path>', 'Provider keypair path')
  .action(async (opts) => {
    const keypairData = JSON.parse(fs.readFileSync(opts.keypair, 'utf-8'));
    const providerKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
    const config = loadConfig();
    const store = await SubscriptionStore.create(path.join(DATA_DIR, 'node.db'));
    const settlement = new SettlementEngine(config as ProviderConfig, store);
    await settlement.init();
    const tx = await settlement.providerClaim(new PublicKey(opts.pda), providerKeypair);
    console.log('Claim tx:', tx);
    store.close();
  });

// ── Helpers ──

function loadConfig(): ProviderConfig & { role: NodeRole; seeds: string[] } {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('Node not initialized. Run: 123456btc-node init');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as ProviderConfig & { role: NodeRole; seeds: string[] };
}

program.parse();
