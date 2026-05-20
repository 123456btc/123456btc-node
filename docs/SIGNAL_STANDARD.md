# 123456btc-node Signal Standard / 策略信号标准

> Compatible with ISES v1 (Institutional Signal Execution Standard)
>
> 兼容 ISES v1（机构信号执行标准）

---

## Standard Signal Format (ISES v1) / 标准信号格式

```json
{
  "schema": "ises.strategy_signal.v1",
  "signal_id": "sig_20260509_BTC_001",
  "parent_signal_id": null,
  "created_at_ms": 1778280000000,
  "source": {
    "system": "alphaquant_bot",
    "environment": "live",
    "strategy_id": "strat_xxx",
    "strategy_name": "BTC Momentum V2",
    "strategy_version": "2026.05.09-001"
  },
  "scope": {
    "exchange": "Binance",
    "market_type": "perp",
    "symbol": "BTCUSDT",
    "base_asset": "BTC",
    "quote_asset": "USDT",
    "allowed_venues": ["Binance", "OKX"],
    "allowed_symbols": ["BTCUSDT"],
    "allowed_direction": "long_short"
  },
  "decision": {
    "action": "enter",
    "side": "long",
    "intent": "open_position",
    "confidence": 0.85,
    "priority": "normal",
    "time_horizon": "intraday",
    "valid_from_ms": 1778280000000,
    "expires_at_ms": 1778280060000
  },
  "market_context": {
    "price": "65000.50",
    "regime": "trending_bull",
    "regime_confidence": 0.78,
    "composite_score": 0.62,
    "funding_bps": "0.12",
    "premium_bps": "-2.19",
    "open_interest": "555266.73",
    "spread_bps": "0.44",
    "book_imbalance": "-0.18",
    "data_quality": "ok"
  },
  "levels": {
    "reference_price": "65000.50",
    "entry_price": "65050.00",
    "stop_loss": "63500.00",
    "take_profit": "68000.00",
    "trailing_stop": null,
    "invalidation_price": "63200.00"
  },
  "sizing": {
    "risk_pct": "0.005",
    "target_notional_usd": "5000",
    "max_notional_usd": "8000",
    "estimated_qty": "0.0768",
    "leverage": "2.0"
  },
  "rationale": {
    "summary": "Bull trend regime with EMA14 crossover, volume confirmation above 20d average.",
    "factor_scores": [
      { "name": "trend", "score": 0.88, "weight": 1.0 },
      { "name": "momentum", "score": 0.72, "weight": 0.8 },
      { "name": "volume", "score": 0.65, "weight": 0.6 }
    ]
  }
}
```

---

## Minimal Format / 最小可用格式

If your system doesn't need full ISES, use the minimal format / 如果不需要完整 ISES，使用最小格式：

```json
{
  "schema": "ises.strategy_signal.v1",
  "signal_id": "sig_001",
  "created_at_ms": 1778280000000,
  "source": {
    "system": "bot",
    "strategy_id": "strat_xxx",
    "strategy_name": "Strategy Name"
  },
  "scope": {
    "symbol": "BTCUSDT",
    "market_type": "crypto"
  },
  "decision": {
    "action": "enter",
    "side": "long",
    "confidence": 0.85
  },
  "market_context": {
    "price": "65000",
    "data_quality": "ok"
  },
  "levels": {
    "stop_loss": "63500",
    "take_profit": "68000"
  },
  "rationale": {
    "summary": "Bullish breakout"
  }
}
```

### Required Fields / 必填字段

- `schema` — Must be `"ises.strategy_signal.v1"` / 必须为 `"ises.strategy_signal.v1"`
- `signal_id` — Unique signal ID / 唯一信号 ID
- `created_at_ms` — Millisecond timestamp / 毫秒时间戳
- `source.strategy_id` — Strategy ID (must be registered on node) / 策略 ID
- `scope.symbol` — Trading pair / 交易对
- `decision.action` — `enter` | `exit` | `reduce` | `hold` | `cancel`
- `market_context.price` — Current price / 当前价格
- `market_context.data_quality` — `ok` | `degraded` | `degraded-but-allowed` | `bad`

---

## Decision Types / 决策类型

| Action | Meaning / 含义 | Use case / 适用场景 |
|--------|---------------|-------------------|
| `enter` | Open position / 开仓 | New long/short / 新开多/空仓 |
| `exit` | Close position / 平仓 | Full exit / 完全退出持仓 |
| `reduce` | Reduce position / 减仓 | Partial take profit/stop loss / 部分止盈/止损 |
| `hold` | Hold / 持有 | No action, maintain position / 保持当前仓位 |
| `cancel` | Cancel / 取消 | Revoke unexecuted signal / 撤销未执行的信号 |

---

## Push Example / 推送示例

### curl (HMAC Auth)

```bash
PROVIDER_ID="prov_xxx"
PROVIDER_SECRET="your_secret"
TIMESTAMP=$(date +%s)000
PAYLOAD="${PROVIDER_ID}:${TIMESTAMP}"
SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$PROVIDER_SECRET" | sed 's/^.* //')

curl -X POST http://localhost:1119/provider/signals \
  -H "Content-Type: application/json" \
  -H "X-Provider-Id: $PROVIDER_ID" \
  -H "X-Provider-Timestamp: $TIMESTAMP" \
  -H "X-Provider-Signature: $SIGNATURE" \
  -d '{
    "schema": "ises.strategy_signal.v1",
    "signal_id": "sig_'$(date +%s)'",
    "created_at_ms": '$(date +%s)000',
    "source": {
      "system": "test_bot",
      "strategy_id": "strat_xxx",
      "strategy_name": "BTC Momentum V2"
    },
    "scope": {
      "symbol": "BTCUSDT",
      "market_type": "crypto"
    },
    "decision": {
      "action": "enter",
      "side": "long",
      "confidence": 0.92
    },
    "market_context": {
      "price": "65000",
      "data_quality": "ok"
    },
    "rationale": {
      "summary": "Test signal"
    }
  }'
```

---

## Node Response / 节点响应

### Success / 成功

```json
{
  "success": true,
  "signal_id": "sig_xxx",
  "dispatched": 3
}
```

### Failure / 失败

```json
{
  "error": "Strategy not found"
}
```

---

## Signal Lifecycle / 信号生命周期

```
Provider System
    │
    │ POST /provider/signals
    ▼
Provider Node
    │ 1. Validate format (ISES v1) / 校验格式
    │ 2. Verify strategy ownership / 验证策略归属
    │ 3. Write to SQLite / 写入存储
    │ 4. Local WebSocket broadcast / 本地广播
    │ 5. Gossip broadcast to network / Gossip 广播
    ▼
Relay Nodes ──▶ Subscriber Nodes ──▶ User Client
```
