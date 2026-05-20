#!/bin/bash
set -e

NODE="npx tsx src/cli.ts"
PROVIDER_DIR="/tmp/bbt-flow-provider"
PROVIDER_PORT=1119

rm -rf "$PROVIDER_DIR" && mkdir -p "$PROVIDER_DIR"

HOME="$PROVIDER_DIR" $NODE init \
  --provider-name "FlowProvider" \
  --wallet "3s4AK2x2nGkKP8ZADbcKuhdPr3coSuh1XnwZEzWgpump" \
  --role provider \
  --port "$PROVIDER_PORT" >/dev/null 2>&1

PROVIDER_CONFIG_FILE="$PROVIDER_DIR/.123456btc-node/config.json"
PROVIDER_ID=$(python3 -c "import json; print(json.load(open('$PROVIDER_CONFIG_FILE'))['provider_id'])")
PROVIDER_SECRET=$(python3 -c "import json; print(json.load(open('$PROVIDER_CONFIG_FILE'))['provider_secret'])")
ADMIN_KEY=$(python3 -c "import json; print(json.load(open('$PROVIDER_CONFIG_FILE'))['admin_api_key'])")

echo "Provider ID: ${PROVIDER_ID:0:20}..."
echo "Admin key: ${ADMIN_KEY:0:10}..."

HOME="$PROVIDER_DIR" $NODE serve --port "$PROVIDER_PORT" >"$PROVIDER_DIR/serve.log" 2>&1 &
PROVIDER_PID=$!

for i in {1..30}; do
  if curl -sf "http://127.0.0.1:$PROVIDER_PORT/health" >/dev/null 2>&1; then
    echo "Provider ready"
    break
  fi
  sleep 1
  if [ "$i" -eq 30 ]; then
    echo "Provider failed to start"
    tail -20 "$PROVIDER_DIR/serve.log"
    exit 1
  fi
done

STRAT_RES=$(curl -s -X POST "http://127.0.0.1:$PROVIDER_PORT/admin/strategies" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Api-Key: $ADMIN_KEY" \
  -d '{"name":"BTC Momentum","symbol":"BTCUSDT","market_type":"crypto","pricing_model":"free","min_bbt_tier":0}' 2>/dev/null)
STRAT_ID=$(echo "$STRAT_RES" | python3 -c "import sys,json; print(json.load(sys.stdin)['strategy']['id'])" 2>/dev/null || echo "")
echo "Strategy created: $STRAT_ID"

USER_WALLET="DemoUserWallet1234567890123456789012345678"
curl -s -X POST "http://127.0.0.1:$PROVIDER_PORT/users/register" \
  -H "Content-Type: application/json" \
  -d "{\"wallet_address\":\"$USER_WALLET\"}" >/dev/null 2>&1 || true

curl -s -X POST "http://127.0.0.1:$PROVIDER_PORT/subscriptions" \
  -H "Content-Type: application/json" \
  -d "{\"wallet_address\":\"$USER_WALLET\",\"strategy_id\":\"$STRAT_ID\",\"duration_days\":7}" >/dev/null 2>&1 || true

echo "--- Pushing signal ---"
TIMESTAMP=$(date +%s)000
SIG=$(echo -n "${PROVIDER_ID}:${TIMESTAMP}" | openssl dgst -sha256 -hmac "$PROVIDER_SECRET" | sed 's/^.* //')
PUSH_RES=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "http://127.0.0.1:$PROVIDER_PORT/provider/signals" \
  -H "Content-Type: application/json" \
  -H "X-Provider-Id: $PROVIDER_ID" \
  -H "X-Provider-Timestamp: $TIMESTAMP" \
  -H "X-Provider-Signature: $SIG" \
  -d "{
    \"schema\": \"ises.strategy_signal.v1\",
    \"source\": { \"strategy_id\": \"$STRAT_ID\", \"strategy_name\": \"BTC Momentum\" },
    \"scope\": { \"symbol\": \"BTCUSDT\", \"market_type\": \"crypto\" },
    \"decision\": { \"action\": \"enter\", \"confidence\": 0.92 },
    \"market_context\": { \"price\": \"65000\" },
    \"rationale\": { \"summary\": \"Local flow test\" }
  }" 2>/dev/null || true)
echo "Push result: $PUSH_RES"

echo ""
echo "--- Provider log tail ---"
tail -30 "$PROVIDER_DIR/serve.log"

kill "$PROVIDER_PID" 2>/dev/null || true
wait "$PROVIDER_PID" 2>/dev/null || true
