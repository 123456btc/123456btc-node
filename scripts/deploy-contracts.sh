#!/bin/bash
set -e

echo "=== 123456btc-node Contract Deployment ==="
echo ""

# 检查环境
command -v solana >/dev/null 2>&1 || { echo "Error: solana CLI not found"; exit 1; }
command -v anchor >/dev/null 2>&1 || { echo "Error: anchor CLI not found"; exit 1; }

# 确保是 devnet
RPC_URL=$(solana config get | grep "RPC URL" | awk '{print $3}')
if [[ "$RPC_URL" != *"devnet"* ]]; then
    echo "Switching to devnet..."
    solana config set --url devnet
fi

# 检查余额（使用 awk 避免依赖 bc）
BALANCE=$(solana balance 2>/dev/null | awk '{print $1}')
BALANCE_INT=$(echo "$BALANCE" | awk '{print int($1)}')
if [ "$BALANCE_INT" -lt 2 ]; then
    echo "Airdropping 5 SOL..."
    solana airdrop 5
fi

echo "Deployer: $(solana address)"
echo "Balance: $(solana balance)"
echo ""

# 部署 subscription_escrow
echo "[1/3] Deploying subscription_escrow..."
solana program deploy \
    contracts/target/deploy/subscription_escrow.so \
    --program-id contracts/target/deploy/subscription_escrow-keypair.json 2>/dev/null || \
solana program deploy contracts/target/deploy/subscription_escrow.so
SUB_ESCROW_ID=$(solana-keygen pubkey contracts/target/deploy/subscription_escrow-keypair.json 2>/dev/null || echo "<check-solana-program-show>")
echo "subscription_escrow: $SUB_ESCROW_ID"

# 部署 blindbox_escrow
echo ""
echo "[2/3] Deploying blindbox_escrow..."
solana program deploy \
    contracts/target/deploy/blindbox_escrow.so \
    --program-id contracts/target/deploy/blindbox_escrow-keypair.json 2>/dev/null || \
solana program deploy contracts/target/deploy/blindbox_escrow.so
BLIND_ID=$(solana-keygen pubkey contracts/target/deploy/blindbox_escrow-keypair.json 2>/dev/null || echo "<check-solana-program-show>")
echo "blindbox_escrow: $BLIND_ID"

# 部署 bridge
echo ""
echo "[3/3] Deploying bridge..."
solana program deploy \
    contracts/target/deploy/bridge.so \
    --program-id contracts/target/deploy/bridge-keypair.json 2>/dev/null || \
solana program deploy contracts/target/deploy/bridge.so
BRIDGE_ID=$(solana-keygen pubkey contracts/target/deploy/bridge-keypair.json 2>/dev/null || echo "<check-solana-program-show>")
echo "bridge: $BRIDGE_ID"

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Update your node config:"
echo "  123456btc-node config --set escrow_program_id=$SUB_ESCROW_ID"
echo ""
echo "Or set environment variable:"
echo "  export BBT_ESCROW_PROGRAM_ID=$SUB_ESCROW_ID"
