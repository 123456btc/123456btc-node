# 123456btc-node

> **[English](README.md)** | [中文](README_zh.md) | [فارسی](README_fa.md) | [မြန်မာ](README_my.md) | [العربية](README_ar.md) | [Français](README_fr.md)

> **ဗဟိုမှ ခွဲထွက်သော မဟာဗျူဟာဖြန့်ဝေရေး ကွန်ရက်**
>
> သင်ကိုယ်တိုင် Node ကို run ပါ။ သင့်ကိုယ်ပိုင် ဈေးနှုန်းကို သတ်မှတ်ပါ။ သင့်ကိုယ်ပိုင် အသိုင်းအဝိုင်းကို တည်ဆောက်ပါ။

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![Solana](https://img.shields.io/badge/Solana-Devnet%20%7C%20Mainnet-9945FF.svg)](https://solana.com)

---

## ဒါက ဘာလဲ?

ကုန်သွယ်မှု အချက်ပြမှုများကို ဖြန့်ဝေရန် ဗဟိုမှ အပြည့်အဝ ခွဲထွက်ထားသော P2P ကွန်ရက်။ သင့်ကိုယ်ပိုင် Node ကို deploy လုပ်ပါ၊ မဟာဗျူဟာများကို ထုတ်ဝေပါ၊ BBT token subscription များကို ကောက်ခံပါ — ဗဟို server မရှိ၊ ပလက်ဖောင်း ခုတ်ယူမှု မရှိ။

**အလုပ်လုပ်ပုံ:**

1. သင်သည် **Provider node** တစ်ခုကို deploy လုပ်ပါ
2. သင်သည် မဟာဗျူဟာများကို ဖန်တီးပြီး BBT ဖြင့် ဈေးနှုန်းများကို သတ်မှတ်ပါ
3. သုံးစွဲသူများသည် သင့် node ကို ပုဂ္ဂလိက အသိုင်းအဝိုင်းများတွင် ရှာဖွေတွေ့ရှိပါ
4. သုံးစွဲသူများသည် သင့် wallet သို့ BBT ပို့ခြင်းဖြင့် subscribe လုပ်ပါ
5. သင့်စနစ်သည် အချက်ပြမှုများကို push လုပ်ပြီး ၎င်းတို့သည် real-time တွင် လက်ခံရရှိပါ
6. သင်သည် သင့် BBT ကို သင့်ကိုယ်ပိုင် လိုအပ်ချက်အတိုင်း စီမံခန့်ခွဲပါ

**ထုတ်ကုန် အလွှာ သုံးခု:**

- **Blind Boxes** — သတ်မှတ်ထားသော တန်ဖိုးများ (1 / 10 / 100 / 1K / 10K USDT)၊ ဖွင့်လိုက်သောအခါ မဟာဗျူဟာ subscription NFT များကို ရရှိပါ
- **Strategy Subscriptions** — နေ့စဉ်၊ အချက်ပြတစ်ခုချင်းစီ သို့မဟုတ် အခမဲ့
- **Node Network** — သင့်ကိုယ်ပိုင် node ကို run ပြီး သင့်ကိုယ်ပိုင် ဈေးနှုန်းကို သတ်မှတ်ပါ

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

| Role | လုပ်ဆောင်ချက် | ဘယ်သူ run လဲ |
|------|------------|-------------|
| **Provider** | မဟာဗျူဟာများ ဖန်တီး၊ အချက်ပြမှုများ ထုတ်ဝေ၊ BBT ကောက်ခံ | Quant teams |
| **Subscriber** | အချက်ပြမှုများ လက်ခံ၊ subscriptions စီမံ | Traders |
| **Relay** | အချက်ပြမှုများ ပို့ဆောင်၊ အကျယ်ချဲ့ | Community volunteers |

### Signal Propagation

1. Provider သည် REST API (Ed25519 wallet signature) ဖြင့် အချက်ပြမှုကို push လုပ်
2. Node သည် စိစစ်ပြီး SQLite တွင် သိမ်းဆည်းကာ WebSocket ဖြင့် local broadcast လုပ်
3. အချက်ပြမှုသည် libp2p GossipSub (TTL=5 hops) ဖြင့် ပျံ့နှံ့
4. Node တစ်ခုချင်းစီသည် deduplicate + HMAC signature ကို verify လုပ်

---

## Blind Box Series

သတ်မှတ်ထားသော တန်ဖိုးရှိ blind boxes။ ဖွင့်လိုက်သောအခါ မဟာဗျူဟာ subscription NFT များကို ရရှိပြီး secondary market တွင် ရောင်းဝယ်နိုင်ပါသည်။

| Series | Value (USDT) | BBT | Fee |
|--------|-------------|-----|-----|
| Bronze | 1 | 100 | 3% |
| Silver | 10 | 1,000 | 2.5% |
| Gold | 100 | 10,000 | 2% |
| Platinum | 1,000 | 100,000 | 1.5% |
| Diamond | 10,000 | 1,000,000 | 1% |

### ဘာတွေ ပါလဲ

| Rarity | Content | ဖြစ်နိုင်ခြေ | Market Ref |
|--------|---------|-------------|------------|
| White | 1-ရက် စမ်းသုံး | 40% | 10 BBT |
| Green | 7-ရက် subscription | 30% | 50 BBT |
| Blue | 30-ရက် subscription | 15% | 200 BBT |
| Purple | 90-ရက် subscription | 10% | 800 BBT |
| Orange | 365-ရက် subscription | 4% | 3,000 BBT |
| Hidden | အမြဲတမ်း + ပုဂ္ဂလိကဖိတ်ခေါ်မှု | 1% | 10,000+ BBT |

**Synthesis:** White 5 → Green 1, Green 3 → Blue 1။ Burn scenarios ဖန်တီးပေးပါသည်။

---

## အမြန် စတင်ခြင်း

### Docker

```bash
git clone <repo-url> && cd 123456btc-node
cp .env.example .env
# .env ကို edit လုပ်ပြီး သင့် wallet နှင့် settings ဖြည့်ပါ
docker compose up -d
curl http://localhost:1119/health
```

### Local

```bash
npm ci && npm run build

# စတင်ခြင်း
123456btc-node init --name "MyNode" --wallet "YOUR_SOLANA_WALLET" --rpc "https://api.devnet.solana.com"

# မဟာဗျူဟာ ဖန်တီးခြင်း
123456btc-node strategy:create --name "BTC Alpha" --symbol "BTCUSDT" --pricing daily_bbt --price-day 100

# စတင် run ခြင်း
123456btc-node serve
```

---

## CLI Commands

### Node

```bash
123456btc-node init              # Node စတင်ခြင်း
123456btc-node config            # Config ကြည့်/ပြင်
123456btc-node serve             # Node စတင် run ခြင်း
123456btc-node emergency-wipe    # ဒေတာအားလုံးကို ဖျက်ဆီးခြင်း (ပြန်မရနိုင်)
```

### Strategies

```bash
123456btc-node strategy:create   # မဟာဗျူဟာ ဖန်တီးခြင်း
123456btc-node strategy:list     # မဟာဗျူဟာများ စာရင်းပြခြင်း
123456btc-node strategy bind     # Agent ကို မဟာဗျူဟာသို့ ချိတ်ဆက်ခြင်း
123456btc-node strategy bundles  # Bundles ကြည့်ခြင်း
123456btc-node strategy bundle   # Bundle ဝယ်ယူခြင်း
```

### Agent Identity

```bash
123456btc-node agent register    # Agent မှတ်ပုံတင်ခြင်း (Ed25519)
123456btc-node agent status      # ဂုဏ်သတင်း ကြည့်ခြင်း
```

### Blind Boxes

```bash
123456btc-node blindbox create   # Blind box ဖန်တီးခြင်း
123456btc-node blindbox list     # Market listings ကြည့်ခြင်း
123456btc-node blindbox buy      # Blind box ဝယ်ယူခြင်း
123456btc-node blindbox stats    # Market stats ကြည့်ခြင်း
```

### MCP Server

```bash
123456btc-node mcp               # AI Agents အတွက် MCP server စတင်ခြင်း
```

---

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/strategies` | မဟာဗျူဟာများ စာရင်းပြခြင်း |
| `POST` | `/strategies` | မဟာဗျူဟာ ဖန်တီးခြင်း |
| `POST` | `/signals` | အချက်ပြမှု ထုတ်ဝေခြင်း |
| `GET` | `/signals/:strategyId` | အချက်ပြမှု မှတ်တမ်း |
| `POST` | `/subscriptions` | Subscription ဖန်တီးခြင်း |
| `GET` | `/subscriptions` | Subscriptions စာရင်း |
| `POST` | `/users/register` | Wallet မှတ်ပုံတင်ခြင်း |
| `GET` | `/user/balance` | On-chain လက်ကျန်ငွေ |
| `GET` | `/admin/earnings` | ဝင်ငွေ dashboard |

### WebSocket

| Path | Description |
|------|-------------|
| `ws://host:port` | Real-time အချက်ပြ push |
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

### BBT ကို ဘာကြောင့် သုံးလဲ

- **စံချိန်စံညွှန်း** — 1 BBT = 1 BBT၊ exchange rate ရှုပ်ထွေးမှု မရှိ
- **ခွဲခြမ်းနိုင်** — ဒသမ 6 နေရာ၊ မည်သည့်ပမာဏမဆို
- **ပွင့်လင်းသော်လည်း အကြောင်းအရာရှိ** — On-chain verify လုပ်နိုင်၊ tx တိုင်းတွင် စီးပွားရေး အကြောင်းပြချက်ရှိ
- **ကမ္ဘာလုံးဆိုင်ရာ** — 24/7၊ SWIFT မလို၊ ဘဏ်ချိန် မလို

### Burn Mechanism

| Scenario | Burn % |
|----------|--------|
| Blind box ဝယ်ယူမှု | 30% |
| Strategy subscription | 20% |
| NFT ပြန်ရောင်း | 5% |
| Node service fee | 10% |
| Protocol revenue | 50% buyback & burn |

စုစုပေါင်း supply: 1 billion၊ minting မလုပ်ပါ။

---

## Subscription & Settlement

### Billing Models

| Model | Description |
|-------|-------------|
| `daily_bbt` | နေ့စဉ် subscription၊ သုံးစွဲသူသည် နေ့စဉ် BBT ပို့ |
| `per_signal_bbt` | ကြိုတင်သွင်းထားသော လက်ကျန်မှ အချက်ပြတစ်ခုချင်းစီ နုတ်ယူ |
| `free` | အခမဲ့၊ billing မရှိ |

### Settlement Flow

1. သုံးစွဲသူသည် မဟာဗျူဟာကို ရွေးပြီး subscription ဖန်တီး
2. Node သည် ပြန်ပေး: Provider wallet + amount + Memo
3. သုံးစွဲသူသည် BBT ကို Memo ဖြင့် ပို့: `BBT-SUB|{sub_id}|{strategy_id}|{wallet}`
4. BillingCron သည် chain ကို 60 စက္ကန့်တိုင်း poll လုပ်ပြီး Memo ကိုက်ညီပါက subscription ကို activate လုပ်

---

## Agent Identity System

- **မှတ်ပုံတင်ခြင်း** — Ed25519 wallet signature၊ on-chain တွင် တစ်ခုတည်းသော identity
- **ဂုဏ်သတင်း** — ကုန်သွယ်မှု အောင်နှုန်း၊ အချက်ပြ တိကျမှု၊ uptime၊ stake weight
- **NFT** — Bot ID NFT minting၊ on-chain verify လုပ်နိုင်
- **Binding** — Agent -> Strategy၊ execution mode (auto/semi_auto/manual) နှင့် fee share သတ်မှတ်
- **Bundles** — Strategy NFT + Blind Box combo ထုတ်ကုန်များ

---

## Security

- **Wallet auth** — Ed25519 signatures၊ username/password မလို
- **Message signing** — HMAC-SHA256၊ အတုလုပ်ခြင်း ကာကွယ်၊ replay ကာကွယ်
- **Data encryption** — AES-256 sensitive fields အတွက်၊ keys server တွင် မရှိ
- **Log policy** — Auto-scrubbed၊ 7-ရက် rotation & destruction
- **Emergency wipe** — `kill -USR1 <pid>` database၊ logs၊ config ကို zero လုပ်ပြီး ဖျက်
- **Docker non-root** — UID 1001၊ အနည်းဆုံး အခွင့်အရေး
- **P2P encryption** — libp2p noise protocol၊ E2E encrypted gossip

ပြည့်စုံသော စစ်ဆေးရန်: [SECURITY.md](SECURITY.md)

---

## Telegram Bot

`.env` တွင် `TELEGRAM_BOT_TOKEN` သတ်မှတ်ခြင်းဖြင့် activate လုပ်ပါ။

| Command | Description |
|---------|-------------|
| `/wallet <address>` | Wallet ချိတ်ဆက်ခြင်း |
| `/strategies` | မဟာဗျူဟာများ စာရင်း |
| `/subscribe <id> <days>` | Subscribe လုပ်ခြင်း |
| `/signals` | လတ်တလော အချက်ပြမှုများ |
| `/status` | Subscription အခြေအနေ |

---

## MCP Integration

AI Agents (Claude Code, Cursor စသည်) အတွက် built-in MCP Server။

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
| `list_strategies` | မဟာဗျူဟာများ စာရင်းပြခြင်း |
| `create_strategy` | မဟာဗျူဟာ ဖန်တီးခြင်း |
| `publish_signal` | အချက်ပြမှု ထုတ်ဝေခြင်း |
| `get_signals` | အချက်ပြမှု မှတ်တမ်း |
| `my_subscriptions` | ကျွန်ုပ်၏ subscriptions |
| `register_wallet` | Wallet မှတ်ပုံတင်ခြင်း |
| `node_status` | Node အခြေအနေ |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BBT_PROVIDER_ID` | (required) | Provider ID |
| `BBT_WALLET_ADDRESS` | (required) | သင့် Solana wallet |
| `BBT_NODE_PORT` | `1119` | Port |
| `BBT_SOLANA_RPC` | mainnet | Solana RPC |
| `BBT_SETTLEMENT_MODE` | `memo` | Settlement mode |
| `BBT_SEEDS` | (empty) | Seed peer URLs |
| `TELEGRAM_BOT_TOKEN` | (empty) | Telegram Bot |
| `ENABLE_AUTO_EXECUTION` | `false` | Jupiter ဖြင့် auto-execution |
| `BBT_LOG_LEVEL` | `info` | Log level |

ပြည့်စုံသော စာရင်း: [.env.example](.env.example)

---

## Tech Stack

Node.js 20+ / TypeScript / SQLite / Solana / libp2p GossipSub / Commander / Pino / Telegraf / tsyringe / Jupiter / MCP

---

## Documentation

| Doc | Content |
|-----|---------|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Network topology၊ signal propagation၊ data model |
| [SIGNAL_STANDARD.md](docs/SIGNAL_STANDARD.md) | ISES v1 signal standard |
| [MCP-INTEGRATION.md](docs/MCP-INTEGRATION.md) | AI Agent integration |
| [DEPLOY.md](DEPLOY.md) | Docker၊ HTTPS၊ backup |
| [SECURITY.md](SECURITY.md) | Security audit checklist |

---

## Test

```bash
npm test              # Test အားလုံး run ခြင်း
npm run test:watch    # Watch mode
npm run lint          # Lint
```

---

## License

Apache License 2.0
