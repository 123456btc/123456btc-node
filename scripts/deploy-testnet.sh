#!/bin/bash
# BBT Bridge - 测试网一键部署脚本
# 部署到 Sepolia (Ethereum) 和 BSC Testnet

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$SCRIPT_DIR/../contracts/evm/bridge"
ENV_FILE="$BRIDGE_DIR/.env"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "============================================"
echo "  BBT Bridge - Testnet Deployment"
echo "============================================"
echo ""

# 检查 .env
if [ ! -f "$ENV_FILE" ]; then
    echo -e "${RED}ERROR: $ENV_FILE not found${NC}"
    echo "Copy .env.example to .env and fill in your keys:"
    echo "  cp $BRIDGE_DIR/.env.example $ENV_FILE"
    exit 1
fi

set -a
source "$ENV_FILE"
set +a

# 检查必要的环境变量
if [ -z "${PRIVATE_KEY:-}" ]; then
    echo -e "${RED}ERROR: PRIVATE_KEY not set in .env${NC}"
    exit 1
fi

if [ -z "${SEPOLIA_RPC_URL:-}" ]; then
    echo -e "${RED}ERROR: SEPOLIA_RPC_URL not set in .env${NC}"
    exit 1
fi

if [ -z "${BSC_TESTNET_RPC_URL:-}" ]; then
    echo -e "${RED}ERROR: BSC_TESTNET_RPC_URL not set in .env${NC}"
    exit 1
fi

echo -e "${GREEN}[✓] Environment variables loaded${NC}"

# 检查依赖
if [ ! -d "$BRIDGE_DIR/node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    cd "$BRIDGE_DIR" && npm install
fi

echo -e "${GREEN}[✓] Dependencies ready${NC}"

# 部署到 Sepolia
echo ""
echo "============================================"
echo "  Deploying to Sepolia (Ethereum Testnet)"
echo "============================================"
cd "$BRIDGE_DIR"
npx hardhat run scripts/deploy.js --network sepolia

if [ $? -eq 0 ]; then
    echo -e "${GREEN}[✓] Sepolia deployment complete${NC}"
else
    echo -e "${RED}[✗] Sepolia deployment failed${NC}"
    exit 1
fi

# 部署到 BSC Testnet
echo ""
echo "============================================"
echo "  Deploying to BSC Testnet"
echo "============================================"
cd "$BRIDGE_DIR"
npx hardhat run scripts/deploy.js --network bscTestnet

if [ $? -eq 0 ]; then
    echo -e "${GREEN}[✓] BSC Testnet deployment complete${NC}"
else
    echo -e "${RED}[✗] BSC Testnet deployment failed${NC}"
    exit 1
fi

echo ""
echo "============================================"
echo "  Deployment Summary"
echo "============================================"
echo "Check deployment info in:"
echo "  $BRIDGE_DIR/deployments/"
echo ""
echo "Next steps:"
echo "  1. Verify contracts: npx hardhat run scripts/verify.js --network sepolia"
echo "  2. Add signers: npx hardhat run scripts/add-signers.js --network sepolia"
echo "  3. Run E2E test: bash scripts/test-bridge-e2e.sh"
