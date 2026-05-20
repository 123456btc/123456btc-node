# 123456btc-node

> **[English](README.md)** | [中文](README_zh.md) | [فارسی](README_fa.md) | [မြန်မာ](README_my.md) | [العربية](README_ar.md) | [Français](README_fr.md)

> **去中心化策略分发网络**
>
> 运营你自己的节点，设定你自己的价格，构建你自己的圈子。

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![Solana](https://img.shields.io/badge/Solana-Devnet%20%7C%20Mainnet-9945FF.svg)](https://solana.com)

---

## 这是什么？

完全去中心化的交易信号 P2P 分发网络。部署自己的节点，发布策略，收取 BBT 代币订阅费 — 无中心服务器，无平台抽成。

**运作方式：**

1. 你部署一个 **Provider 节点**
2. 你创建策略并用 BBT 定价
3. 用户在私域社群发现你的节点
4. 用户向你的钱包发送 BBT 订阅
5. 你的系统推送信号，用户实时接收
6. 你按自己的需求处理 BBT

**三层产品：**

- **盲盒** — 固定面值（1 / 10 / 100 / 1K / 10K USDT），开盒即得策略订阅券 NFT
- **策略订阅** — 按日、按信号、免费
- **节点网络** — 运营自己的节点，自主定价

---

## 网络架构

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
          │   发布信号    │ │   转发信号   │ │   接收信号    │
          └───────┬──────┘ └──────┬──────┘ └───────┬──────┘
                  │   Gossip Protocol (libp2p)      │
                  │               │                 │
          ┌───────▼──────┐ ┌──────▼──────┐ ┌───────▼──────┐
          │  Subscriber  │ │  Subscriber │ │ Telegram Bot │
          └──────────────┘ └─────────────┘ └──────────────┘
```

### 节点角色

| 角色 | 职责 | 谁来跑 |
|------|------|--------|
| **Provider** | 创建策略、发布信号、收取 BBT | 量化团队 |
| **Subscriber** | 接收信号、管理订阅 | 交易员 |
| **Relay** | 转发信号、扩大覆盖 | 社区志愿者 |

### 信号传播

1. Provider 通过 REST API 推送信号（Ed25519 钱包签名）
2. 节点校验、存储到 SQLite、通过 WebSocket 本地广播
3. 信号通过 libp2p GossipSub 传播（TTL=5 跳）
4. 每个节点去重 + HMAC 签名验证

---

## 盲盒系列

固定面值盲盒。开盒即得策略订阅券 NFT，可在二级市场流转。

| 系列 | 面值 (USDT) | BBT | 手续费 |
|------|-------------|-----|--------|
| Bronze | 1 | 100 | 3% |
| Silver | 10 | 1,000 | 2.5% |
| Gold | 100 | 10,000 | 2% |
| Platinum | 1,000 | 100,000 | 1.5% |
| Diamond | 10,000 | 1,000,000 | 1% |

### 盒内内容

| 稀有度 | 内容 | 概率 | 二级参考 |
|--------|------|------|----------|
| 白 | 1 天体验 | 40% | 10 BBT |
| 绿 | 7 天订阅 | 30% | 50 BBT |
| 蓝 | 30 天订阅 | 15% | 200 BBT |
| 紫 | 90 天订阅 | 10% | 800 BBT |
| 橙 | 365 天订阅 | 4% | 3,000 BBT |
| 隐藏款 | 永久订阅 + 私域邀请 | 1% | 10,000+ BBT |

**合成：** 5 白 -> 1 绿，3 绿 -> 1 蓝。创造销毁场景。

---

## 快速开始

### Docker 部署

```bash
git clone <repo-url> && cd 123456btc-node
cp .env.example .env
# 编辑 .env 填写你的钱包和配置
docker compose up -d
curl http://localhost:1119/health
```

### 本地运行

```bash
npm ci && npm run build

# 初始化
123456btc-node init --name "MyNode" --wallet "YOUR_SOLANA_WALLET" --rpc "https://api.devnet.solana.com"

# 创建策略
123456btc-node strategy:create --name "BTC Alpha" --symbol "BTCUSDT" --pricing daily_bbt --price-day 100

# 启动
123456btc-node serve
```

---

## CLI 命令

### 节点管理

```bash
123456btc-node init              # 初始化节点
123456btc-node config            # 查看/修改配置
123456btc-node serve             # 启动节点
123456btc-node emergency-wipe    # 销毁所有数据（不可逆）
```

### 策略

```bash
123456btc-node strategy:create   # 创建策略
123456btc-node strategy:list     # 列出策略
123456btc-node strategy bind     # 绑定 Agent 到策略
123456btc-node strategy bundles  # 查看套餐
123456btc-node strategy bundle   # 购买套餐
```

### Agent 身份

```bash
123456btc-node agent register    # 注册 Agent（Ed25519）
123456btc-node agent status      # 查看信誉
```

### 盲盒

```bash
123456btc-node blindbox create   # 创建盲盒
123456btc-node blindbox list     # 查看市场
123456btc-node blindbox buy      # 购买盲盒
123456btc-node blindbox stats    # 市场统计
```

### MCP Server

```bash
123456btc-node mcp               # 启动 MCP Server
```

---

## REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `GET` | `/strategies` | 列出策略 |
| `POST` | `/strategies` | 创建策略 |
| `POST` | `/signals` | 发布信号 |
| `GET` | `/signals/:strategyId` | 历史信号 |
| `POST` | `/subscriptions` | 创建订阅 |
| `GET` | `/subscriptions` | 订阅列表 |
| `POST` | `/users/register` | 注册钱包 |
| `GET` | `/user/balance` | 链上余额 |
| `GET` | `/admin/earnings` | 收益面板 |

### WebSocket

| 路径 | 说明 |
|------|------|
| `ws://host:port` | 实时信号推送 |
| `ws://host:port/peer` | 节点间 Gossip 组网 |

### 认证示例

```bash
curl -X POST http://localhost:1119/signals \
  -H "x-wallet: <WALLET>" \
  -H "x-wallet-signature: <ED25519_SIG>" \
  -H "x-wallet-timestamp: <TIMESTAMP>" \
  -d '{"strategy_id":"...","symbol":"BTCUSDT","decision":"BUY","confidence":0.85}'
```

---

## BBT 代币

**Mint:** `3s4AK2x2nGkKP8ZADbcKuhdPr3coSuh1XnwZEzWgpump` | **精度:** 6 位 | **链:** Solana

### 为什么用 BBT

- **标准化** — 1 BBT = 1 BBT，无汇率复杂性
- **可分割** — 精确到小数点后 6 位
- **透明可解释** — 链上可验证，每笔交易有商业理由
- **全球流通** — 24/7，不受 SWIFT 限制

### 通缩机制

| 场景 | 销毁比例 |
|------|----------|
| 盲盒购买 | 30% |
| 策略订阅 | 20% |
| NFT 转售 | 5% |
| 节点服务费 | 10% |
| 协议收入 | 50% 回购销毁 |

总量 10 亿，永不增发。

---

## 订阅与结算

### 计费模式

| 模式 | 说明 |
|------|------|
| `daily_bbt` | 日订阅，用户按天发送 BBT |
| `per_signal_bbt` | 按信号从预存余额扣费 |
| `free` | 免费 |

### 结算流程

1. 用户选择策略，创建订阅
2. 节点返回：Provider 钱包 + 金额 + Memo
3. 用户发送 BBT 并填写 Memo：`BBT-SUB|{sub_id}|{strategy_id}|{wallet}`
4. BillingCron 每 60 秒轮询链上，匹配后激活

---

## Agent 身份系统

- **注册** — Ed25519 钱包签名，链上唯一身份
- **信誉** — 交易胜率、信号准确率、在线时长、质押权重
- **NFT** — Bot ID NFT 铸造，链上可验证
- **绑定** — Agent 绑定策略，设置执行模式（auto/semi_auto/manual）和分成比例
- **套餐** — 策略 NFT + 盲盒组合产品

---

## 安全

- **钱包认证** — Ed25519 签名，无账号密码
- **消息签名** — HMAC-SHA256，防伪造防重放
- **数据加密** — AES-256 加密敏感字段，密钥不在服务器
- **日志策略** — 自动脱敏，7 天轮转销毁
- **紧急销毁** — `kill -USR1 <pid>` 清零覆写后删除数据库、日志、配置
- **Docker non-root** — UID 1001，最小权限
- **P2P 加密** — libp2p noise 协议，端到端加密

完整清单：[SECURITY.md](SECURITY.md)

---

## Telegram Bot

在 `.env` 中设置 `TELEGRAM_BOT_TOKEN` 启用。

| 命令 | 说明 |
|------|------|
| `/wallet <address>` | 绑定钱包 |
| `/strategies` | 策略列表 |
| `/subscribe <id> <days>` | 订阅 |
| `/signals` | 近期信号 |
| `/status` | 订阅状态 |

---

## MCP 集成

内置 MCP Server，支持 AI Agent（Claude Code、Cursor 等）直接操作节点。

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

| 工具 | 说明 |
|------|------|
| `list_strategies` | 列出策略 |
| `create_strategy` | 创建策略 |
| `publish_signal` | 发布信号 |
| `get_signals` | 历史信号 |
| `my_subscriptions` | 我的订阅 |
| `register_wallet` | 注册钱包 |
| `node_status` | 节点状态 |

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BBT_PROVIDER_ID` | （必填） | Provider ID |
| `BBT_WALLET_ADDRESS` | （必填） | 你的 Solana 钱包 |
| `BBT_NODE_PORT` | `1119` | 端口 |
| `BBT_SOLANA_RPC` | mainnet | Solana RPC |
| `BBT_SETTLEMENT_MODE` | `memo` | 结算模式 |
| `BBT_SEEDS` | （空） | 种子节点 URL |
| `TELEGRAM_BOT_TOKEN` | （空） | Telegram Bot |
| `ENABLE_AUTO_EXECUTION` | `false` | 自动跟单执行 |
| `BBT_LOG_LEVEL` | `info` | 日志级别 |

完整列表：[.env.example](.env.example)

---

## 技术栈

Node.js 20+ / TypeScript / SQLite / Solana / libp2p GossipSub / Commander / Pino / Telegraf / tsyringe / Jupiter / MCP

---

## 文档

| 文档 | 内容 |
|------|------|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 网络拓扑、信号传播、数据模型 |
| [SIGNAL_STANDARD.md](docs/SIGNAL_STANDARD.md) | ISES v1 信号标准 |
| [MCP-INTEGRATION.md](docs/MCP-INTEGRATION.md) | AI Agent 集成 |
| [DEPLOY.md](DEPLOY.md) | Docker 部署、HTTPS、备份 |
| [SECURITY.md](SECURITY.md) | 安全审计清单 |

---

## 测试

```bash
npm test              # 运行全部测试
npm run test:watch    # 监听模式
npm run lint          # 代码检查
```

---

## 许可证

Apache License 2.0
