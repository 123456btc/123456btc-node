# 123456btc MCP Server — AI Agent Integration / AI Agent 集成

## Quick Install / 快速安装

```bash
# 1. Install node / 安装节点
npm install -g @123456btc/node

# 2. Initialize / 初始化
123456btc-node init --name "MyBot" --wallet <YOUR_SOLANA_WALLET>

# 3. Start MCP Server (for AI Agents) / 启动 MCP Server
123456btc-node mcp
```

---

## Connect AI Agents / 接入 AI Agent

### Claude Code (OpenClaude)

Add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "123456btc": {
      "command": "npx",
      "args": ["tsx", "/path/to/123456btc-node/src/mcp/server.ts"]
    }
  }
}
```

Or use global install / 或使用全局安装:

```json
{
  "mcpServers": {
    "123456btc": {
      "command": "123456btc-node",
      "args": ["mcp"]
    }
  }
}
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "123456btc": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/123456btc-node/src/mcp/server.ts"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "123456btc": {
      "command": "npx",
      "args": ["tsx", "/path/to/123456btc-node/src/mcp/server.ts"]
    }
  }
}
```

### OpenCode / Codex / Pi

```bash
# Start MCP server directly / 直接启动
123456btc-node mcp

# Or via npx
npx tsx /path/to/123456btc-node/src/mcp/server.ts
```

---

## Available Tools / 可用 Tools

| Tool | Description / 描述 |
|------|-------------------|
| `list_strategies` | List all available strategies / 列出所有可用策略 |
| `create_strategy` | Create a new strategy / 创建新策略 |
| `publish_signal` | Publish trading signal (BUY/SELL/HOLD) / 发布交易信号 |
| `get_signals` | View strategy signal history / 查看策略的历史信号 |
| `my_subscriptions` | View my subscriptions / 查看我的订阅 |
| `register_wallet` | Register wallet to node / 注册钱包到节点 |
| `node_status` | View node status / 查看节点状态 |

---

## Usage Examples / 使用示例

In Claude Code:

```
> Show me the strategies on 123456btc
→ AI calls list_strategies

> Create a BTC strategy at 10 BBT per day
→ AI calls create_strategy

> Publish a BUY signal to my strategy
→ AI calls publish_signal
```

---

## REST API (Alternative) / REST API（备选）

If your AI Agent doesn't support MCP, use the HTTP API directly:

如果不支持 MCP，也可以直接调用 HTTP API：

```bash
# List strategies / 列出策略
curl http://localhost:1119/strategies

# Publish signal (requires wallet signature) / 发布信号
curl -X POST http://localhost:1119/signals \
  -H "x-wallet: <YOUR_WALLET>" \
  -H "x-wallet-signature: <SIGNATURE>" \
  -H "x-wallet-timestamp: <TIMESTAMP>" \
  -d '{"strategy_id":"...","symbol":"BTCUSDT","decision":"BUY"}'
```
