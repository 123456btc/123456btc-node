# 123456btc-node Architecture / 架构文档

> Fully decentralized strategy distribution network / 完全去中心化策略分发网络
>
> Everyone can run a node — strategy creators, subscribers, relays.
>
> 所有人都能运行节点 — 策略商、订阅者、中继者。

---

## Core Principles / 核心原则

| Principle / 原则 | Description / 说明 |
|------------------|-------------------|
| **Everyone can run / 人人可运行** | Provider produces signals, Subscriber receives, Relay forwards / Provider 生产信号，Subscriber 接收，Relay 转发 |
| **No single point of failure / 无单点故障** | Signals propagate via gossip protocol, no central server / 信号通过 Gossip 协议传播，不依赖中心服务器 |
| **On-chain settlement / 链上结算** | BBT billing and revenue sharing on Solana (SPL Token + Memo) / BBT 扣费和分账在 Solana 链上完成 |
| **Local sovereignty / 本地主权** | Each node owns its own data, Provider doesn't monopolize distribution / 每个节点拥有自己的数据 |
| **Protocol compatible / 协议兼容** | Signal format compatible with ISES v1 / 信号格式兼容 ISES v1 |

---

## Network Topology / 网络拓扑

```
                    ┌─────────────────┐
                    │   Seed Node     │
                    │   种子节点       │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼─────┐ ┌──────▼──────┐ ┌────▼─────────┐
     │   Provider   │ │    Relay    │ │  Subscriber  │
     │  (produces)  │ │ (forwards)  │ │  (receives)  │
     │   发布信号    │ │   转发信号   │ │   接收信号    │
     └───────┬──────┘ └──────┬──────┘ └───────┬──────┘
             │               │                │
             │    Gossip Protocol (WebSocket)  │
             │               │                │
     ┌───────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
     │  Subscriber  │ │  Subscriber │ │  Subscriber │
     │   (mobile)   │ │   (VPS)    │ │   (home)    │
     └──────────────┘ └─────────────┘ └─────────────┘
```

### Node Roles / 节点角色

| Role / 角色 | Function / 功能 | Who runs / 谁运行 |
|-------------|----------------|------------------|
| **Provider** | Create strategies, push signals, collect BBT / 创建策略、推送信号、收取 BBT | Strategy creators / 策略商 |
| **Subscriber** | Receive signals, local cache, HTTP polling / 接收信号、本地缓存 | Traders / 交易员 |
| **Relay** | Forward signals, expand network coverage / 转发信号、扩大网络覆盖 | Volunteers / 志愿者 |

---

## Signal Propagation (Gossip) / 信号传播

```
Provider System
       │ POST /provider/signals (Ed25519 auth)
       ▼
┌──────────────────┐
│  Provider Node   │ ── 1. Validate signal / 校验信号
│                  │ ── 2. Write to SQLite / 写入本地存储
└───────┬──────────┘ ── 3. Local WebSocket broadcast / 本地广播
        │
        │ Gossip: broadcastSignal(signal, ttl=5)
        ▼
┌──────────────────┐     ┌──────────────────┐
│   Relay Node A   │────▶│   Relay Node B   │
│  (ttl=4, forward)│     │  (ttl=3, forward)│
└───────┬──────────┘     └───────┬──────────┘
        │                         │
        ▼                         ▼
┌──────────────────┐     ┌──────────────────┐
│ Subscriber Node  │     │ Subscriber Node  │
└──────────────────┘     └──────────────────┘
```

### Gossip Message Format / Gossip 消息格式

```json
{
  "type": "signal",
  "payload": { /* ISES v1 Signal */ },
  "from": "provider_prov123_abc",
  "ttl": 5,
  "timestamp": 1778280000000,
  "sig": "hmac_sha256_hex"
}
```

### Propagation Rules / 传播规则

- **TTL** = Time To Live, decrements each hop, stops at 0 / 每转发一次减 1，为 0 停止传播
- **Deduplication / 去重** — Each node maintains `seenMessages` set / 每个节点维护已见消息集合
- **Signature verification / 签名验证** — All gossip messages carry HMAC-SHA256 / 所有消息带 HMAC-SHA256 签名
- **Dead connection cleanup / 死连接清理** — 120s no heartbeat → disconnect / 120 秒无心跳自动断开

---

## Data Model / 数据模型

### Strategies / 策略

```sql
CREATE TABLE strategies (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  symbol TEXT NOT NULL,
  market_type TEXT NOT NULL DEFAULT 'crypto',
  pricing_model TEXT NOT NULL DEFAULT 'daily_bbt',
  price_per_day REAL,
  price_per_signal REAL,
  min_bbt_tier INTEGER DEFAULT 0,
  status TEXT DEFAULT 'live',
  created_at INTEGER,
  updated_at INTEGER
);
```

### Users / 用户

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  wallet_address TEXT UNIQUE NOT NULL,
  display_name TEXT,
  chain_bbt_balance REAL DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at INTEGER
);
```

### Subscriptions / 订阅

```sql
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  billing_model TEXT,
  next_bill_at INTEGER,
  created_at INTEGER,
  UNIQUE(user_id, strategy_id)
);
```

### Signals / 信号

```sql
CREATE TABLE signals (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  decision TEXT NOT NULL,
  confidence REAL,
  price REAL,
  stop_loss REAL,
  take_profit REAL,
  reasoning TEXT,
  raw_payload TEXT,
  created_at INTEGER
);
```

### Billing Records / 账单

```sql
CREATE TABLE billing_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount_bbt REAL NOT NULL,
  tx_signature TEXT,
  status TEXT DEFAULT 'pending',
  created_at INTEGER
);
```

---

## On-Chain Settlement / 链上结算

### BBT Token

- Mint Address: `3s4AK2x2nGkKP8ZADbcKuhdPr3coSuh1XnwZEzWgpump` (mainnet)
- Decimals: 6

### Billing Models / 计费模式

**Daily subscription / 日订阅 (`daily_bbt`)**

1. User creates subscription, node returns payment info (Provider wallet + amount + Memo) / 用户创建订阅，节点返回付款信息
2. User sends `price_per_day` BBT to Provider wallet / 用户向 Provider 钱包转账
3. Memo format: `BBT-SUB|{subscription_id}|{strategy_id}|{user_wallet}`
4. `BillingCron.pollIncomingPayments()` monitors on-chain incoming payments / 节点监听链上入账
5. Match Memo → auto-activate/renew subscription / 匹配后自动激活/续费

**Per-signal / 按信号 (`per_signal_bbt`)**

1. User pre-deposits BBT to Provider wallet / 用户预存 BBT
2. Signal triggers, node auto-deducts `price_per_signal` BBT / 信号触发时自动扣费
3. Insufficient balance → signal still broadcast but marked "unpaid" / 余额不足时信号标记未付费

**Free / 免费 (`free`)**

- No billing, direct broadcast / 不扣费，直接广播

### Revenue Attribution / 收益归属

- **100% revenue goes to Provider** / 收益全部归 Provider
- No platform cut in decentralized mode / 去中心化模式无平台抽成

---

## Authentication / 认证体系

### Provider Auth (push signals) / Provider 认证

- Config file: `~/.123456btc-node/config.json`
- HTTP Header: `X-Provider-Id` + `X-Provider-Signature` (HMAC-SHA256)
- Anti-replay: `X-Provider-Timestamp` must be within 60 seconds / 防重放：时间戳必须在 60 秒内

### User Auth (receive signals) / 用户认证

- Wallet signature (Solana Ed25519) / 钱包签名认证
- WebSocket: `?wallet={address}&signature={sig}&timestamp={ts}`
- Node verifies signature before establishing connection / 验证签名后建立连接

### Inter-node Auth (Gossip) / 节点间认证

- HMAC derived from Provider Secret / 基于 Provider Secret 派生的 HMAC
- All gossip messages carry signature, forged messages are dropped / 伪造消息会被丢弃

### Admin Auth / Admin 认证

- Local CLI: direct SQLite access / 本地 CLI 直接操作
- Remote: `X-Admin-Api-Key` HTTP Header

---

## Deployment Modes / 部署模式

### Provider Node / Provider 节点

```bash
123456btc-node init --name "AlphaQuant" --wallet <WALLET> --port 1119
123456btc-node strategy:create --name "BTC V2" --symbol BTCUSDT --pricing daily_bbt --price-day 100
123456btc-node serve
```

### Subscriber Node / Subscriber 节点

```bash
123456btc-node init --name "MyReceiver" --wallet <WALLET> --port 1118 --seeds ws://provider-node.com:1119/peer
123456btc-node serve
```

### Relay Node / Relay 节点

```bash
123456btc-node init --name "CommunityRelay" --wallet <WALLET> --port 1118 --seeds ws://provider.com:1119/peer,ws://relay.com:1118/peer
123456btc-node serve
```

---

## Tech Stack / 技术栈

| Component / 组件 | Choice / 选型 |
|------------------|--------------|
| Runtime | Node.js 20+ |
| Database | SQLite (better-sqlite3) |
| HTTP / WS | Node.js http + ws |
| Blockchain | @solana/web3.js + @solana/spl-token |
| CLI | commander |
| P2P | Custom Gossip over WebSocket / 自定义 Gossip |
| Language | TypeScript |
