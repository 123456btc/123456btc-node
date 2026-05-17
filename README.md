# 123456btc-node

> **完全去中心化策略分发网络**
>
> 所有圈成员都可以运行节点 — 策略商、订阅者、中继者，人人可部署。

---

## 核心特性

- **人人可运行节点** — Provider 生产信号，Subscriber 接收信号，Relay 扩大覆盖
- **Gossip 组网** — 信号通过 P2P 协议在圈内自动传播，无单点故障
- **链上结算** — BBT 扣费、续费、收益全部在 Solana 链上完成
- **本地主权** — 每个节点完全独立，Provider 不垄断信号分发
- **私域运营** — 策略商服务自己的圈子，用 BBT 收费，无需平台介入
- **协议兼容** — 信号格式兼容 ISES v1，可与 123456btc 平台生态互通

---

## 快速开始

### 安装

```bash
git clone <repo>
cd 123456btc-node
npm install
npm run build
```

### 1. Provider 节点（策略商）

```bash
# 初始化
npx 123456btc-node init \
  --provider-name "AlphaQuant" \
  --wallet <你的Solana钱包地址> \
  --role provider \
  --port 1119

# 创建策略
npx 123456btc-node strategy:create \
  --name "BTC Momentum V2" \
  --symbol BTCUSDT \
  --pricing daily_bbt \
  --price-day 100

# 启动
npx 123456btc-node serve
```

### 2. Subscriber 节点（用户）

```bash
npx 123456btc-node init \
  --provider-name "MyNode" \
  --wallet <你的Solana钱包地址> \
  --role subscriber \
  --port 1118 \
  --seeds ws://provider-ip:1119/peer

npx 123456btc-node serve
```

### 3. Relay 节点（社区志愿者）

```bash
npx 123456btc-node init \
  --provider-name "RelayNode" \
  --wallet <你的Solana钱包地址> \
  --role relay \
  --port 1118 \
  --seeds ws://provider-ip:1119/peer

npx 123456btc-node serve
```

---

## 私域运营完整流程

### Step 1: 策略商创建策略

```bash
npx 123456btc-node strategy:create \
  --name "BTC Momentum V2" \
  --symbol BTCUSDT \
  --pricing daily_bbt \
  --price-day 100
```

### Step 2: 用户在私域群收到节点地址

> "添加我的策略节点: `ws://node.alphaquant.io:1119`"

### Step 3: 用户注册并订阅

```bash
curl -X POST http://node.alphaquant.io:1119/users/register \
  -d '{"wallet_address": "你的Solana钱包", "display_name": "TraderA"}'

curl -X POST http://node.alphaquant.io:1119/subscriptions \
  -d '{"wallet_address": "你的Solana钱包", "strategy_id": "strat_xxx"}'
```

返回付款信息：
```json
{
  "subscription_id": "sub_xxx",
  "payment": {
    "provider_wallet": "Provider钱包地址",
    "amount_bbt": 100,
    "memo": "BBT-SUB|sub_xxx|strat_xxx|你的钱包",
    "instruction": "请转账 100 BBT，Memo 填写: BBT-SUB|sub_xxx|strat_xxx|你的钱包"
  }
}
```

### Step 4: 用户转账 BBT

通过 Phantom / OKX 等钱包向 Provider 钱包转账，**必须填写 Memo**。

### Step 5: 节点自动确认，开始接收信号

节点 `BillingCron` 每 60 秒轮询链上收款，匹配 Memo 后自动激活订阅。

信号通过 Gossip 传播到用户节点，实时推送到用户手机/电脑。

---

## 三种节点角色

| 角色 | 功能 | 适合谁 |
|------|------|--------|
| **Provider** | 创建策略、推送信号、收取 BBT、 gossip 广播 | 策略商 / 量化团队 |
| **Subscriber** | 接收信号、本地缓存、HTTP 轮询、gossip 接收 | 普通交易员 |
| **Relay** | 转发信号、提高网络覆盖率、不生产信号 | 大户 / KOL / 志愿者 |

---

## 网络架构

```
Provider 节点 (生产信号)
    │
    │ Gossip (WebSocket)
    ▼
Relay 节点 A ←────→ Relay 节点 B
    │                   │
    ▼                   ▼
Subscriber 节点      Subscriber 节点
    │                   │
    ▼                   ▼
  用户手机           用户电脑
```

- 每个节点启动时连接 **种子节点** (`--seeds`)
- 信号通过 **Gossip 协议** 传播，ttl=5 跳
- 所有消息带 **HMAC 签名**，防止伪造
- 120 秒无心跳的连接自动清理

---

## CLI 命令

| 命令 | 说明 |
|------|------|
| `init` | 初始化节点（选择 role: provider/subscriber/relay） |
| `config` | 查看/修改配置 |
| `strategy:create` | 创建策略（Provider） |
| `strategy:list` | 列出策略 |
| `serve` | 启动节点（HTTP + WebSocket + Gossip） |
| `user:add` | 手动添加用户（测试用） |

---

## HTTP API

### 用户端
- `POST /users/register` — 注册钱包
- `POST /subscriptions` — 创建订阅（返回付款信息）
- `GET /subscriptions?wallet=xxx` — 查询订阅状态
- `GET /strategies` — 公开策略列表
- `GET /signals?wallet=xxx` — 信号历史（HTTP 轮询）
- `GET /user/balance?wallet=xxx` — 链上 BBT 余额

### Provider 端
- `POST /provider/signals` — 推送信号（HMAC 认证）

### Admin 端
- `POST /admin/strategies` — 创建策略
- `GET /admin/earnings` — 收益面板
- `GET /admin/subscribers` — 订阅者列表

### WebSocket
- `ws://host:port` — 用户实时接收信号
- `ws://host:port/peer` — 节点间 Gossip 组网

---

## 与 123456btc 平台的关系

| 模式 | 说明 |
|------|------|
| **完全独立** | 不连接平台，纯私域运营 |
| **信号互通** | Provider 可把信号推送到平台，平台用户也能收到 |
| **数据同步** | 可选把策略表现回同步到平台，用于排行榜 |

---

## 技术栈

- **Runtime**: Node.js 20+
- **Database**: SQLite (better-sqlite3)
- **WebSocket**: ws
- **Blockchain**: @solana/web3.js + @solana/spl-token
- **P2P**: 自定义 Gossip over WebSocket
- **CLI**: commander
- **Language**: TypeScript

---

## License

MIT
