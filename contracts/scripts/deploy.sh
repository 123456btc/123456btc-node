#!/bin/bash

# 123456btc Contract Deployment Script
# Usage: ./scripts/deploy.sh [devnet|localnet]

set -e

CLUSTER=${1:-devnet}

echo "=== 123456btc Contract Deployment ==="
echo "Cluster: $CLUSTER"
echo ""

# Check dependencies
check_dependency() {
    if ! command -v $1 &> /dev/null; then
        echo "Error: $1 is not installed"
        exit 1
    fi
}

check_dependency "solana"
check_dependency "anchor"

# Check wallet
WALLET=$(solana config get | grep "Keypair Path" | awk '{print $3}')
if [ ! -f "$WALLET" ]; then
    echo "Error: Wallet not found at $WALLET"
    echo "Run: solana-keygen new"
    exit 1
fi

echo "Wallet: $WALLET"

# Check balance
BALANCE=$(solana balance --url $CLUSTER | awk '{print $1}')
echo "Balance: $BALANCE SOL"

if [ "$CLUSTER" = "devnet" ]; then
    if (( $(echo "$BALANCE < 1" | bc -l) )); then
        echo "Insufficient balance. Requesting airdrop..."
        solana airdrop 2 --url devnet
    fi
fi

# Build contracts
echo ""
echo "=== Building Contracts ==="
anchor build

# Deploy contracts
echo ""
echo "=== Deploying Contracts ==="
anchor deploy --provider.cluster $CLUSTER

# Get program IDs
echo ""
echo "=== Deployment Complete ==="
echo "Program IDs:"
echo "  BlindBox Escrow: $(solana address -k target/deploy/blindbox_escrow-keypair.json)"
echo "  Agent Registry: $(solana address -k target/deploy/agent_registry-keypair.json)"

echo ""
echo "=== Updating Anchor.toml ==="
BLINDBOX_ID=$(solana address -k target/deploy/blindbox_escrow-keypair.json)
AGENT_ID=$(solana address -k target/deploy/agent_registry-keypair.json)

# Update Anchor.toml with actual program IDs
sed -i.bak "s/blindbox_escrow = \".*\"/blindbox_escrow = \"$BLINDBOX_ID\"/" Anchor.toml
sed -i.bak "s/agent_registry = \".*\"/agent_registry = \"$AGENT_ID\"/" Anchor.toml
rm -f Anchor.toml.bak

echo ""
echo "=== Deployment Summary ==="
echo "Cluster: $CLUSTER"
echo "BlindBox Escrow: $BLINDBOX_ID"
echo "Agent Registry: $AGENT_ID"
echo ""
echo "Save these program IDs for future reference!"
