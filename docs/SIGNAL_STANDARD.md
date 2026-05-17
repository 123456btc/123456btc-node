# 123456btc-node 策略信号标准

> 兼容 ISES v1 (Institutional Signal Execution Standard)
>
> Provider 量化系统推送的信号必须符合此标准，节点才能正确解析和广播。

---

## 1. 标准信号格式 (ISES v1 精简版)

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

## 2. 最小可用格式 (BBT 兼容简化版)

如果你的量化系统不想实现完整 ISES，可以使用**最小可用格式**：

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

**必填字段**：
- `schema`: 必须是 `"ises.strategy_signal.v1"`
- `signal_id`: 唯一信号 ID
- `created_at_ms`: 毫秒时间戳
- `source.strategy_id`: 策略 ID（必须在节点上已注册）
- `scope.symbol`: 交易对
- `decision.action`: `enter` | `exit` | `reduce` | `hold` | `cancel`
- `market_context.price`: 当前价格
- `market_context.data_quality`: `ok` | `degraded` | `degraded-but-allowed` | `bad`

---

## 3. 决策类型 (decision.action)

| action | 含义 | 适用场景 |
|--------|------|----------|
| `enter` | 开仓 | 新开多/空仓 |
| `exit` | 平仓 | 完全退出持仓 |
| `reduce` | 减仓 | 部分止盈/止损 |
| `hold` | 持有 | 无操作，保持当前仓位 |
| `cancel` | 取消 | 撤销之前未执行的信号 |

---

## 4. 推送示例

### curl 推送 (完整 ISES)

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
      "environment": "live",
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
      "summary": "Test signal from bot"
    }
  }'
```

---

## 5. 节点响应

### 成功
```json
{
  "success": true,
  "signal_id": "sig_xxx",
  "dispatched": 3
}
```

### 失败
```json
{
  "error": "Strategy not found"
}
```

---

## 6. 信号生命周期

```
Provider 量化系统
    │
    │ POST /provider/signals
    ▼
Provider 节点
    │ 1. 校验格式 (ISES v1)
    │ 2. 验证策略归属
    │ 3. 写入 SQLite
    │ 4. 本地 WebSocket 广播
    │ 5. Gossip 广播到网络
    ▼
Relay 节点 ──→ Subscriber 节点 ──→ 用户客户端
    │
    │ (per_signal_bbt 模式)
    ▼
BillingCron 扣费
```
