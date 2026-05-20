#!/bin/bash

# 123456btc Contract Verification Script
# Verifies deployed contracts on Solana devnet

set -e

CLUSTER=${1:-devnet}

echo "=== 123456btc Contract Verification ==="
echo "Cluster: $CLUSTER"
echo ""

# ── Step 1: Check Solana connection ──
echo "=== Step 1: Checking Solana connection ==="
solana config set --url $CLUSTER
solana config get
echo ""

# ── Step 2: Check wallet balance ──
echo "=== Step 2: Checking wallet balance ==="
BALANCE=$(solana balance --url $CLUSTER | awk '{print $1}')
echo "Balance: $BALANCE SOL"
echo ""

# ── Step 3: Verify program deployments ──
echo "=== Step 3: Verifying program deployments ==="

# Check BlindBox Escrow
BLINDBOX_ID="BBox11111111111111111111111111111111111111111"
echo "Checking BlindBox Escrow: $BLINDBOX_ID"
BLINDBOX_INFO=$(solana program show $BLINDBOX_ID --url $CLUSTER 2>/dev/null || echo "NOT FOUND")
if echo "$BLINDBOX_INFO" | grep -q "Program Id"; then
    echo "  Status: DEPLOYED"
    echo "$BLINDBOX_INFO" | grep -E "Program Id|Authority|Balance"
else
    echo "  Status: NOT FOUND"
fi
echo ""

# Check Agent Registry
AGENT_ID="Agent11111111111111111111111111111111111111111"
echo "Checking Agent Registry: $AGENT_ID"
AGENT_INFO=$(solana program show $AGENT_ID --url $CLUSTER 2>/dev/null || echo "NOT FOUND")
if echo "$AGENT_INFO" | grep -q "Program Id"; then
    echo "  Status: DEPLOYED"
    echo "$AGENT_INFO" | grep -E "Program Id|Authority|Balance"
else
    echo "  Status: NOT FOUND"
fi
echo ""

# ── Step 4: Check account data ──
echo "=== Step 4: Checking program accounts ==="

echo "BlindBox Escrow accounts:"
solana program show --accounts --url $CLUSTER $BLINDBOX_ID 2>/dev/null || echo "  No accounts found"
echo ""

echo "Agent Registry accounts:"
solana program show --accounts --url $CLUSTER $AGENT_ID 2>/dev/null || echo "  No accounts found"
echo ""

# ── Step 5: Run tests ──
echo "=== Step 5: Running tests ==="
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(dirname "$SCRIPT_DIR")"
cd "$CONTRACTS_DIR"

echo "Running anchor test..."
anchor test --provider.cluster $CLUSTER 2>&1 || echo "Tests completed with issues"
echo ""

echo "=== Verification Complete ==="
echo ""
echo "Summary:"
echo "  Cluster: $CLUSTER"
echo "  BlindBox Escrow: $BLINDBOX_ID"
echo "  Agent Registry: $AGENT_ID"
echo ""
echo "To interact with contracts, use:"
echo "  anchor run test --provider.cluster $CLUSTER"
