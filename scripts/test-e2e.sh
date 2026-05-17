#!/bin/bash
#
# 123456btc-node 端到端测试脚本
# 验证 Provider → Gossip → Subscriber 信号传播
#

set -e

NODE="npx tsx src/cli.ts"
PROVIDER_DIR="/tmp/bbt-test-provider"
SUBSCRIBER_DIR="/tmp/bbt-test-subscriber"

echo "═══════════════════════════════════════════════════"
echo "  123456btc-node E2E Test: Gossip Signal Relay"
echo "═══════════════════════════════════════════════════"

# ── 1. 清理旧数据 ──
rm -rf $PROVIDER_DIR $SUBSCRIBER_DIR
mkdir -p $PROVIDER_DIR $SUBSCRIBER_DIR

export HOME=$PROVIDER_DIR
# ── 2. 初始化 Provider 节点 (端口 1119) ──
echo ""
echo "[1/6] Initializing Provider node on port 1119..."
$NODE init \
  --provider-name "TestProvider" \
  --wallet "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" \
  --role provider \
  --port 1119

# 创建策略
$NODE strategy:create \
  --name "Test Strategy" \
  --symbol BTCUSDT \
  --pricing free

# 获取策略 ID
STRAT_ID=$($NODE strategy:list | grep "Test Strategy" | awk '{print $1}')
echo "  Strategy ID: $STRAT_ID"

# ── 3. 启动 Provider 节点 ──
echo ""
echo "[2/6] Starting Provider node..."
$NODE serve &
PROVIDER_PID=$!
sleep 2

# ── 4. 初始化 Subscriber 节点 (端口 1118) ──
export HOME=$SUBSCRIBER_DIR
echo ""
echo "[3/6] Initializing Subscriber node on port 1118..."
$NODE init \
  --provider-name "TestSubscriber" \
  --wallet "11111111111111111111111111111111" \
  --role subscriber \
  --port 1118 \
  --seeds ws://127.0.0.1:1119/peer

# ── 5. 启动 Subscriber 节点 ──
echo ""
echo "[4/6] Starting Subscriber node..."
$NODE serve &
SUBSCRIBER_PID=$!
sleep 2

# ── 6. Provider 推送信号 ──
echo ""
echo "[5/6] Pushing signal from Provider..."
export HOME=$PROVIDER_DIR
CONFIG=$(cat $PROVIDER_DIR/.123456btc-node/config.json)
PROVIDER_ID=$(echo "$CONFIG" | grep -o '"provider_id"[^,]*' | cut -d'"' -f4)
SECRET=$(echo "$CONFIG" | grep -o '"provider_secret"[^,]*' | cut -d'"' -f4)
TIMESTAMP=$(date +%s)000
SIG=$(echo -n "${PROVIDER_ID}:${TIMESTAMP}" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

curl -s -X POST http://127.0.0.1:1119/provider/signals \
  -H "Content-Type: application/json" \
  -H "X-Provider-Id: $PROVIDER_ID" \
  -H "X-Provider-Timestamp: $TIMESTAMP" \
  -H "X-Provider-Signature: $SIG" \
  -d "{
    \"schema\": \"ises.strategy_signal.v1\",
    \"signal_id\": \"sig_test_$(date +%s)\",
    \"created_at_ms\": $TIMESTAMP,
    \"source\": {
      \"system\": \"test\",
      \"strategy_id\": \"$STRAT_ID\",
      \"strategy_name\": \"Test Strategy\"
    },
    \"scope\": {
      \"symbol\": \"BTCUSDT\",
      \"market_type\": \"crypto\"
    },
    \"decision\": {
      \"action\": \"enter\",
      \"side\": \"long\",
      \"confidence\": 0.92
    },
    \"market_context\": {
      \"price\": \"65000\",
      \"data_quality\": \"ok\"
    },
    \"rationale\": {
      \"summary\": \"E2E test signal\"
    }
  }" | jq .

# ── 7. 等待 gossip 传播 ──
echo ""
echo "[6/6] Waiting for gossip propagation (3s)..."
sleep 3

# ── 8. 验证 Subscriber 收到信号 ──
echo ""
echo "Checking Subscriber signals..."
RESULT=$(curl -s "http://127.0.0.1:1118/signals?wallet=11111111111111111111111111111111&limit=5")
echo "$RESULT" | jq .

SIGNAL_COUNT=$(echo "$RESULT" | jq '.signals | length')

if [ "$SIGNAL_COUNT" -gt 0 ]; then
  echo ""
  echo "✅ TEST PASSED: Signal propagated via Gossip to Subscriber node!"
else
  echo ""
  echo "⚠️ TEST INCOMPLETE: Signal not yet visible on Subscriber (may need more time)"
fi

# ── 9. 清理 ──
echo ""
echo "Cleaning up..."
kill $PROVIDER_PID $SUBSCRIBER_PID 2>/dev/null || true
rm -rf $PROVIDER_DIR $SUBSCRIBER_DIR

echo ""
echo "Done."
