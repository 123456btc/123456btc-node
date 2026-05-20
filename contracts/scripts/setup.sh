#!/bin/bash

# 123456btc Solana Environment Setup Script
# Installs: Rust, Solana CLI, Anchor CLI

set -e

echo "=== 123456btc Solana Environment Setup ==="
echo ""

# ── Step 1: Install Rust ──
echo "=== Step 1: Checking Rust ==="
if command -v rustc &> /dev/null; then
    echo "Rust already installed: $(rustc --version)"
else
    echo "Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
    echo "Rust installed: $(rustc --version)"
fi

# ── Step 2: Install Solana CLI ──
echo ""
echo "=== Step 2: Checking Solana CLI ==="
if command -v solana &> /dev/null; then
    echo "Solana CLI already installed: $(solana --version)"
else
    echo "Installing Solana CLI..."
    sh -c "$(curl -sSfL https://release.anza.xyz/v1.18.26/install)"
    export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
    echo "Solana CLI installed: $(solana --version)"
fi

# ── Step 3: Setup Solana wallet ──
echo ""
echo "=== Step 3: Setting up Solana wallet ==="
WALLET_PATH="$HOME/.config/solana/id.json"
if [ -f "$WALLET_PATH" ]; then
    echo "Wallet already exists at $WALLET_PATH"
    PUBKEY=$(solana address)
    echo "Public Key: $PUBKEY"
else
    echo "Creating new wallet..."
    solana-keygen new --no-bip39-passphrase -o "$WALLET_PATH"
    PUBKEY=$(solana address)
    echo "Public Key: $PUBKEY"
fi

# ── Step 4: Configure for devnet ──
echo ""
echo "=== Step 4: Configuring for devnet ==="
solana config set --url devnet
echo "Solana config:"
solana config get

# ── Step 5: Request airdrop ──
echo ""
echo "=== Step 5: Requesting SOL airdrop ==="
BALANCE=$(solana balance | awk '{print $1}')
echo "Current balance: $BALANCE SOL"

if (( $(echo "$BALANCE < 2" | bc -l) )); then
    echo "Requesting 2 SOL airdrop..."
    solana airdrop 2 --url devnet
    sleep 2
    BALANCE=$(solana balance | awk '{print $1}')
    echo "New balance: $BALANCE SOL"
fi

# ── Step 6: Install Anchor CLI ──
echo ""
echo "=== Step 6: Checking Anchor CLI ==="
if command -v anchor &> /dev/null; then
    echo "Anchor CLI already installed: $(anchor --version)"
else
    echo "Installing Anchor CLI..."
    cargo install --git https://github.com/coral-xyz/anchor avm --force
    avm install 0.30.1
    avm use 0.30.1
    echo "Anchor CLI installed: $(anchor --version)"
fi

# ── Step 7: Install Node dependencies ──
echo ""
echo "=== Step 7: Installing Node dependencies ==="
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(dirname "$SCRIPT_DIR")"
cd "$CONTRACTS_DIR"
npm install

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Environment:"
echo "  Rust:        $(rustc --version)"
echo "  Solana CLI:  $(solana --version)"
echo "  Anchor CLI:  $(anchor --version)"
echo "  Wallet:      $(solana address)"
echo "  Network:     devnet"
echo ""
echo "Next steps:"
echo "  1. cd contracts/"
echo "  2. anchor build       # Build contracts"
echo "  3. anchor test        # Run tests"
echo "  4. ./scripts/deploy.sh devnet  # Deploy to devnet"
