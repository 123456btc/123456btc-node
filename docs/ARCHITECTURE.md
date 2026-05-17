# 123456btc-node Architecture

> 完全去中心化策略分发网络
> **所有圈成员都可以运行节点** — 策略商、订阅者、中继者，人人可部署。

---

## 1. 核心原则

| 原则 | 说明 |
|------|------|
| **人人可运行** | Provider 跑生产节点，订阅者跑接收节点，大户跑中继节点 |
| **无单点故障** | 信号通过 gossip 协议在圈内传播，不依赖任何中心服务器 |
| **链上结算** | BBT 扣费、分账全部在 Solana 链上完成（SPL Token Transfer + Memo） |
| **本地主权** | 每个节点完全拥有自己的数据，Provider 不垄断信号分发 |
| **协议兼容** | 信号格式兼容 ISES v1 和 BBT Signal Protocol v1，可与平台生态互通 |

---

## 2. 网络拓扑

```
                    ┌─────────────────┐
                    │   种子节点 A      │
                    │  (VPS / 家用)    │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼─────┐ ┌──────▼──────┐ ┌────▼─────────┐
     │ Provider 节点 │ │ Relay 节点  │ │ Subscriber 节点│
     │  (生产信号)   │ │  (信号中继)  │ │  (接收信号)   │
     └───────┬──────┘ └──────┬──────┘ └───────┬──────┘
             │               │                │
             │    Gossip Protocol (WebSocket) │
             │               │                │
     ┌───────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
     │ Subscriber   │ │ Subscriber  │ │ Subscriber  │
     │ 节点 (手机)   │ │ 节点 (VPS)  │ │ 节点 (家用)  │
     └──────────────┘ └─────────────┘ └─────────────┘
```

### 节点角色

| 角色 | 功能 | 谁运行 |
|------|------|--------|
| **Provider** | 创建策略、推送信号、收取 BBT | 策略商/量化团队 |
| **Subscriber** | 接收信号、本地缓存、HTTP 轮询 | 普通用户/交易员 |
| **Relay** | 转发信号、提高网络覆盖率 | 大户/志愿者/社区 KOL |

---

## 3. 信号传播流程 (Gossip)

```
Provider 量化系统
       │ POST /provider/signals (HMAC 认证)
       ▼
┌──────────────────┐
│  Provider 节点    │ ── 1. 校验信号
│                  │ ── 2. 写入本地 SQLite
└───────┬──────────┘ ── 3. 本地 WebSocket 广播
        │
        │ Gossip: broadcastSignal(signal, ttl=5)
        ▼
┌──────────────────┐     ┌──────────────────┐
│   Relay 节点 A    │────▶│   Relay 节点 B    │
│  (ttl=4 → 转发)   │     │  (ttl=3 → 转发)   │
└───────┬──────────┘     └───────┬──────────┘
        │                         │
        ▼                         ▼
┌──────────────────┐     ┌──────────────────┐
│ Subscriber 节点   │     │ Subscriber 节点   │
│ (本地广播给用户)   │     │ (本地广播给用户)   │
└──────────────────┘     └──────────────────┘
```

### Gossip 消息格式

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

### 传播规则
- **ttl** = Time To Live，每转发一次减 1，ttl=0 停止传播
- **去重**：每个节点维护 `seenMessages` 集合，已处理过的消息不再转发
- **签名验证**：所有 gossip 消息带 HMAC-SHA256 签名，防止伪造
- **死连接清理**：120 秒无心跳的连接自动断开

---

## 4. 数据模型

### 4.1 策略 (strategies)
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

### 4.2 用户/订阅者 (users)
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

### 4.3 订阅 (subscriptions)
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

### 4.4 信号历史 (signals)
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

### 4.5 账单 (billing_records)
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

## 5. 链上结算设计 (SettlementEngine)

### 5.1 BBT 代币参数
- Mint Address: `7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU` (主网)
- Decimals: 6

### 5.2 扣费模式

**日订阅模式 (`daily_bbt`)**
1. 用户创建订阅，节点返回付款信息（Provider 钱包 + 金额 + Memo）
2. 用户向 Provider 钱包转账 `price_per_day` BBT
3. Memo 格式: `BBT-SUB|{subscription_id}|{strategy_id}|{user_wallet}`
4. 节点通过 `SettlementEngine.pollIncomingPayments()` 监听链上入账
5. 匹配 Memo 后自动激活/续费订阅

**按信号模式 (`per_signal_bbt`)**
1. 用户预存 BBT 到 Provider 钱包（或每次信号单独转账）
2. 信号触发时，节点自动扣除 `price_per_signal` BBT
3. 余额不足时信号仍广播但标记 "unpaid"，用户补款后解锁

**免费模式 (`free`)**
- 不扣费，直接广播

### 5.3 收益归属
- **100% 收益归 Provider**（节点运营者）
- 平台不参与分账（去中心化模式下无平台抽成）
- Provider 可自行决定 burn 比例，通过链上 burn 交易完成

---

## 6. 认证体系

### 6.1 Provider 认证（推送信号）
- 本地配置文件 `~/.123456btc-node/config.json`
- HTTP Header: `X-Provider-Id` + `X-Provider-Signature` (HMAC-SHA256)
- 防重放：`X-Provider-Timestamp` 必须在 60 秒内

### 6.2 用户认证（接收信号）
- 钱包签名认证（Solana Ed25519）
- WebSocket 连接时传入 `?wallet={address}&signature={sig}&timestamp={ts}`
- 节点验证签名后建立连接

### 6.3 节点间认证（Gossip）
- 基于 Provider Secret 派生的 HMAC
- 所有 gossip 消息带签名，伪造消息会被丢弃

### 6.4 Admin 认证（管理节点）
- 本地 CLI 直接操作 SQLite
- 远程管理通过 `X-Admin-Api-Key` HTTP Header

---

## 7. 私域流量运营闭环

```
┌─────────────────────────────────────────────────────────────────┐
│                        私域运营流程                               │
│                                                                  │
│  1. 策略商部署 Provider 节点 (VPS / 家用电脑)                      │
│       └─ 创建策略，设置 BBT 价格                                   │
│                                                                  │
│  2. 策略商在私域群 (微信/DC/TG) 分享节点地址                        │
│       └─ "添加我的节点: ws://node.alphaquant.io:1119"            │
│                                                                  │
│  3. 用户运行 Subscriber 节点 或直接 WebSocket 连接                 │
│       └─ 钱包签名认证 → 查看策略列表 → 选择订阅                      │
│                                                                  │
│  4. 用户按指引转账 BBT 到 Provider 钱包                            │
│       └─ Memo: BBT-SUB|sub_xxx|strat_xxx|wallet_xxx              │
│                                                                  │
│  5. 节点自动确认收款，激活订阅                                     │
│       └─ BillingCron 轮询链上 → 匹配 Memo → 更新 SQLite            │
│                                                                  │
│  6. 信号通过 Gossip 传播到所有在线节点                              │
│       └─ Provider → Relay → Subscriber → 用户手机                  │
│                                                                  │
│  7. 每日续费提醒 / 按信号扣费 / 欠费暂停                            │
│       └─ BillingCron 自动处理                                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 8. 与 123456btc 平台的关系

| 模式 | 说明 |
|------|------|
| **完全独立** | 节点自成生态，不连接平台，适合纯私域 |
| **信号互通** | Provider 节点可把信号 **推送** 到平台，让平台用户也收到 |
| **数据同步** | 可选把策略表现数据回同步到平台，用于排行榜/信誉 |
| **平台 fallback** | 如果私域节点宕机，用户可通过平台 API 继续接收信号 |

---

## 9. 部署模式

### Provider 节点（策略商）
```bash
123456btc-node init \
  --provider-name "AlphaQuant" \
  --wallet <Provider_Solana_Wallet> \
  --role provider \
  --port 1119

123456btc-node strategy:create --name "BTC V2" --symbol BTCUSDT --pricing daily_bbt --price-day 100
123456btc-node serve
```

### Subscriber 节点（普通用户）
```bash
123456btc-node init \
  --provider-name "MyReceiver" \
  --wallet <My_Solana_Wallet> \
  --role subscriber \
  --port 1118 \
  --seeds ws://provider-node.com:1119/peer

123456btc-node serve
```

### Relay 节点（社区志愿者）
```bash
123456btc-node init \
  --provider-name "CommunityRelay" \
  --wallet <Relay_Wallet> \
  --role relay \
  --port 1118 \
  --seeds ws://provider-node.com:1119/peer,ws://another-relay.com:1118/peer

123456btc-node serve
```

---

## 10. 技术栈

| 组件 | 选型 |
|------|------|
| Runtime | Node.js 20+ |
| Database | SQLite (better-sqlite3) |
| HTTP / WS | Node.js http + ws |
| Blockchain | @solana/web3.js + @solana/spl-token |
| CLI | commander |
| P2P | 自定义 Gossip over WebSocket |
| Language | TypeScript |
