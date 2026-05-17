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
import { createHttpServer } from './api/http.js';
import { createWebSocketServer } from './api/ws.js';
import { SubscriptionStore } from './core/SubscriptionStore.js';
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
import type { ProviderConfig } from './types/index.js';

const CONFIG_DIR = path.join(os.homedir(), '.123456btc-node');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const DATA_DIR = path.join(CONFIG_DIR, 'data');

const program = new Command();

program
  .name('123456btc-node')
  .description('Decentralized strategy service node for 123456btc')
  .version('0.1.0');

// ── init ──
program
  .command('init')
  .description('Initialize a new node')
  .requiredOption('--provider-name <name>', 'Provider display name')
  .requiredOption('--wallet <address>', 'Provider Solana wallet address')
  .option('--treasury-wallet <address>', 'Platform treasury wallet (defaults to provider wallet)')
  .option('--role <role>', 'Node role: provider | subscriber | relay', 'provider')
  .option('--rpc <url>', 'Solana RPC endpoint', 'https://api.mainnet-beta.solana.com')
  .option('--bbt-mint <mint>', 'BBT token mint address', '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')
  .option('--port <port>', 'Node HTTP/WebSocket port', '1119')
  .option('--seeds <urls>', 'Comma-separated seed peer URLs')
  .action((opts) => {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const config = {
      provider_id: `prov_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`,
      provider_secret: randomBytes(32).toString('hex'),
      name: opts.providerName,
      wallet_address: opts.wallet,
      treasury_wallet: opts.treasuryWallet || opts.wallet,
      solana_rpc: opts.rpc,
      bbt_mint: opts.bbtMint,
      burn_rate: 0,
      node_port: parseInt(opts.port, 10),
      admin_api_key: randomBytes(24).toString('base64url'),
      role: opts.role as NodeRole,
      seeds: opts.seeds ? String(opts.seeds).split(',') : [],
    };

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

    console.log('✓ Node initialized');
    console.log(`  Provider ID:    ${config.provider_id}`);
    console.log(`  Role:           ${config.role}`);
    console.log(`  Wallet:         ${config.wallet_address}`);
    console.log(`  RPC:            ${config.solana_rpc}`);
    console.log(`  Port:           ${config.node_port}`);
    console.log(`  Seeds:          ${config.seeds.join(', ') || 'none'}`);
    console.log(`  Config:         ${CONFIG_PATH}`);
    console.log('');
    console.log('⚠️  Save your provider secret and admin API key securely:');
    console.log(`  Provider Secret: ${config.provider_secret}`);
    console.log(`  Admin API Key:   ${config.admin_api_key}`);
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
      (config as Record<string, unknown>)[key] =
        key === 'node_port' || key === 'burn_rate' ? parseFloat(value) : value;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log(`Updated ${key} = ${value}`);
    } else {
      console.log(JSON.stringify(config, null, 2));
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
      provider_id: config.provider_id,
      name: opts.name,
      description: opts.description,
      symbol: opts.symbol,
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
    const config = loadConfig();
    const port = opts.port ? parseInt(opts.port, 10) : config.node_port;
    const role = (config.role || 'provider') as NodeRole;

    const store = await SubscriptionStore.create(path.join(DATA_DIR, 'node.db'));
    const auth = new AuthManager(config as ProviderConfig);
    const hub = new SignalHub(store, auth);
    const settlement = new SettlementEngine(config as ProviderConfig, store);
    await settlement.init();

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

    const httpServer = createHttpServer(config as ProviderConfig, store, auth, hub, settlement, billing, autoExecution, blindBox);
    const wsServer = createWebSocketServer({ server: httpServer, path: '/ws' }, hub, store, auth);

    // 启动 P2P 网络（libp2p-gossipsub + WebSocket 兼容层）
    const gossipAdapter = new GossipAdapter(logger);
    const peerNetwork = new PeerNetwork(role, config.provider_id, port, hub, config.seeds || [], gossipAdapter);
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
        peerNetwork.broadcastSignal(result.signal);
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

// ── Helpers ──

function loadConfig(): ProviderConfig & { role: NodeRole; seeds: string[] } {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('Node not initialized. Run: 123456btc-node init');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as ProviderConfig & { role: NodeRole; seeds: string[] };
}

program.parse();
