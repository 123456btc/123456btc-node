# 123456btc-node

> **[English](README.md)** | [中文](README_zh.md) | [فارسی](README_fa.md) | [မြန်မာ](README_my.md) | [العربية](README_ar.md) | [Français](README_fr.md)

> **Decentralized Strategy Distribution Network**
>
> Run your own node. Set your own price. Build your own circle.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![Solana](https://img.shields.io/badge/Solana-Devnet%20%7C%20Mainnet-9945FF.svg)](https://solana.com)

---

## What is this?

A fully decentralized P2P network for trading signal distribution. Deploy your own node, publish strategies, and collect BBT token subscriptions — no central server, no platform cut.

**How it works:**

1. You deploy a **Provider node**
2. You create strategies and set prices in BBT
3. Users discover your node in private communities
4. Users subscribe by sending BBT to your wallet
5. Your system pushes signals, they receive in real-time
6. You manage your BBT according to your own needs

**Three product layers:**

- **Blind Boxes** — Fixed denominations (1 / 10 / 100 / 1K / 10K USDT), unbox to get strategy subscription NFTs
- **Strategy Subscriptions** — Daily, per-signal, or free
- **Node Network** — Run your own node, set your own pricing

---

## Network Architecture

```
                         ┌─────────────────┐
                         │   Seed Node     │
                         └────────┬────────┘
                                  │
                   ┌──────────────┼──────────────┐
                   │              │              │
          ┌────────▼─────┐ ┌──────▼──────┐ ┌────▼─────────┐
          │   Provider   │ │    Relay    │ │  Subscriber  │
          └───────┬──────┘ └──────┬──────┘ └───────┬──────┘
                  │   Gossip Protocol (libp2p)      │
                  │               │                 │
          ┌───────▼──────┐ ┌──────▼──────┐ ┌───────▼──────┐
          │  Subscriber  │ │  Subscriber │ │ Telegram Bot │
          └──────────────┘ └─────────────┘ └──────────────┘
```

### Node Roles

| Role | What you do | Who runs it |
|------|------------|-------------|
| **Provider** | Create strategies, publish signals, collect BBT | Quant teams |
| **Subscriber** | Receive signals, manage subscriptions | Traders |
| **Relay** | Forward signals, expand coverage | Community volunteers |

### Signal Propagation

1. Provider pushes signal via REST API (Ed25519 wallet signature)
2. Node validates, persists to SQLite, broadcasts locally via WebSocket
3. Signal propagates via libp2p GossipSub (TTL=5 hops)
4. Each node deduplicates + verifies HMAC signature

---

## Blind Box Series

Fixed denomination blind boxes. Unbox to get strategy subscription NFTs, tradable on secondary market.

| Series | Value (USDT) | BBT | Fee |
|--------|-------------|-----|-----|
| Bronze | 1 | 100 | 3% |
| Silver | 10 | 1,000 | 2.5% |
| Gold | 100 | 10,000 | 2% |
| Platinum | 1,000 | 100,000 | 1.5% |
| Diamond | 10,000 | 1,000,000 | 1% |

### What's inside

| Rarity | Content | Probability | Market Ref |
|--------|---------|-------------|------------|
| White | 1-day trial | 40% | 10 BBT |
| Green | 7-day subscription | 30% | 50 BBT |
| Blue | 30-day subscription | 15% | 200 BBT |
| Purple | 90-day subscription | 10% | 800 BBT |
| Orange | 365-day subscription | 4% | 3,000 BBT |
| Hidden | Permanent + private invite | 1% | 10,000+ BBT |

**Synthesis:** 5 White -> 1 Green, 3 Green -> 1 Blue. Creates burn scenarios.

---

## Quick Start

### Docker

```bash
git clone <repo-url> && cd 123456btc-node
cp .env.example .env
# Edit .env with your wallet and settings
docker compose up -d
curl http://localhost:1119/health
```

### Local

```bash
npm ci && npm run build

# Initialize
123456btc-node init --name "MyNode" --wallet "YOUR_SOLANA_WALLET" --rpc "https://api.devnet.solana.com"

# Create strategy
123456btc-node strategy:create --name "BTC Alpha" --symbol "BTCUSDT" --pricing daily_bbt --price-day 100

# Start
123456btc-node serve
```

---

## CLI Commands

### Node

```bash
123456btc-node init              # Initialize node
123456btc-node config            # View/update config
123456btc-node serve             # Start node
123456btc-node emergency-wipe    # DESTROY all data (irreversible)
```

### Strategies

```bash
123456btc-node strategy:create   # Create strategy
123456btc-node strategy:list     # List strategies
123456btc-node strategy bind     # Bind Agent to strategy
123456btc-node strategy bundles  # View bundles
123456btc-node strategy bundle   # Purchase bundle
```

### Agent Identity

```bash
123456btc-node agent register    # Register Agent (Ed25519)
123456btc-node agent status      # View reputation
```

### Blind Boxes

```bash
123456btc-node blindbox create   # Create blind box
123456btc-node blindbox list     # Market listings
123456btc-node blindbox buy      # Buy blind box
123456btc-node blindbox stats    # Market stats
```

### MCP Server

```bash
123456btc-node mcp               # Start MCP server for AI Agents
```

---

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/strategies` | List strategies |
| `POST` | `/strategies` | Create strategy |
| `POST` | `/signals` | Publish signal |
| `GET` | `/signals/:strategyId` | Signal history |
| `POST` | `/subscriptions` | Create subscription |
| `GET` | `/subscriptions` | List subscriptions |
| `POST` | `/users/register` | Register wallet |
| `GET` | `/user/balance` | On-chain balance |
| `GET` | `/admin/earnings` | Earnings dashboard |

### WebSocket

| Path | Description |
|------|-------------|
| `ws://host:port` | Real-time signal push |
| `ws://host:port/peer` | P2P gossip mesh |

### Auth Example

```bash
curl -X POST http://localhost:1119/signals \
  -H "x-wallet: <WALLET>" \
  -H "x-wallet-signature: <ED25519_SIG>" \
  -H "x-wallet-timestamp: <TIMESTAMP>" \
  -d '{"strategy_id":"...","symbol":"BTCUSDT","decision":"BUY","confidence":0.85}'
```

---

## BBT Token

**Mint:** `3s4AK2x2nGkKP8ZADbcKuhdPr3coSuh1XnwZEzWgpump` | **Decimals:** 6 | **Chain:** Solana

### Why BBT

- **Standardized** — 1 BBT = 1 BBT, no exchange rate complexity
- **Divisible** — 6 decimal places, any amount
- **Transparent but contextual** — On-chain verifiable, every tx has a business reason
- **Global** — 24/7, no SWIFT, no banking hours

### Burn Mechanism

| Scenario | Burn % |
|----------|--------|
| Blind box purchase | 30% |
| Strategy subscription | 20% |
| NFT resale | 5% |
| Node service fee | 10% |
| Protocol revenue | 50% buyback & burn |

Total supply: 1 billion, no minting.

---

## Subscription & Settlement

### Billing Models

| Model | Description |
|-------|-------------|
| `daily_bbt` | Daily subscription, user sends BBT per day |
| `per_signal_bbt` | Per-signal deduction from pre-deposited balance |
| `free` | Free, no billing |

### Settlement Flow

1. User selects strategy, creates subscription
2. Node returns: Provider wallet + amount + Memo
3. User sends BBT with Memo: `BBT-SUB|{sub_id}|{strategy_id}|{wallet}`
4. BillingCron polls chain every 60s, matches Memo, activates subscription

---

## Agent Identity System

- **Register** — Ed25519 wallet signature, unique on-chain identity
- **Reputation** — Trade win rate, signal accuracy, uptime, stake weight
- **NFT** — Bot ID NFT minting, on-chain verifiable
- **Binding** — Agent -> Strategy, set execution mode (auto/semi_auto/manual) and fee share
- **Bundles** — Strategy NFT + Blind Box combo products

---

## Security

- **Wallet auth** — Ed25519 signatures, no username/password
- **Message signing** — HMAC-SHA256, anti-forgery, anti-replay
- **Data encryption** — AES-256 on sensitive fields, keys not on server
- **Log policy** — Auto-scrubbed, 7-day rotation & destruction
- **Emergency wipe** — `kill -USR1 <pid>` zeroes & deletes database, logs, config
- **Docker non-root** — UID 1001, minimal privileges
- **P2P encryption** — libp2p noise protocol, E2E encrypted gossip

Full checklist: [SECURITY.md](SECURITY.md)

---

## Telegram Bot

Enable by setting `TELEGRAM_BOT_TOKEN` in `.env`.

| Command | Description |
|---------|-------------|
| `/wallet <address>` | Bind wallet |
| `/strategies` | List strategies |
| `/subscribe <id> <days>` | Subscribe |
| `/signals` | Recent signals |
| `/status` | Subscription status |

---

## MCP Integration

Built-in MCP Server for AI Agents (Claude Code, Cursor, etc.).

```json
{
  "mcpServers": {
    "123456btc": {
      "command": "npx",
      "args": ["tsx", "/path/to/src/mcp/server.ts"]
    }
  }
}
```

| Tool | Description |
|------|-------------|
| `list_strategies` | List strategies |
| `create_strategy` | Create strategy |
| `publish_signal` | Publish signal |
| `get_signals` | Signal history |
| `my_subscriptions` | My subscriptions |
| `register_wallet` | Register wallet |
| `node_status` | Node status |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BBT_PROVIDER_ID` | (required) | Provider ID |
| `BBT_WALLET_ADDRESS` | (required) | Your Solana wallet |
| `BBT_NODE_PORT` | `1119` | Port |
| `BBT_SOLANA_RPC` | mainnet | Solana RPC |
| `BBT_SETTLEMENT_MODE` | `memo` | Settlement mode |
| `BBT_SEEDS` | (empty) | Seed peer URLs |
| `TELEGRAM_BOT_TOKEN` | (empty) | Telegram Bot |
| `ENABLE_AUTO_EXECUTION` | `false` | Auto-execution via Jupiter |
| `BBT_LOG_LEVEL` | `info` | Log level |

Full list: [.env.example](.env.example)

---

## Tech Stack

Node.js 20+ / TypeScript / SQLite / Solana / libp2p GossipSub / Commander / Pino / Telegraf / tsyringe / Jupiter / MCP

---

## Documentation

| Doc | Content |
|-----|---------|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Network topology, signal propagation, data model |
| [SIGNAL_STANDARD.md](docs/SIGNAL_STANDARD.md) | ISES v1 signal standard |
| [MCP-INTEGRATION.md](docs/MCP-INTEGRATION.md) | AI Agent integration |
| [DEPLOY.md](DEPLOY.md) | Docker, HTTPS, backup |
| [SECURITY.md](SECURITY.md) | Security audit checklist |

---

## Test

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run lint          # Lint
```

---

## License

Apache License 2.0
