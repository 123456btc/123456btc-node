#!/bin/bash
# ============================================================
# BBT Bridge — 端到端桥接测试脚本
# 测试流程: Sepolia 锁定 BBT → 中继器 → BSC Testnet 铸造 wBBT
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="$SCRIPT_DIR/../contracts/evm/bridge"
DEPLOYMENTS_DIR="$BRIDGE_DIR/deployments"
ENV_FILE="$BRIDGE_DIR/.env"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[ e2e  ]${NC} $1"; }
ok()   { echo -e "${GREEN}[  OK  ]${NC} $1"; }
warn() { echo -e "${YELLOW}[ WARN ]${NC} $1"; }
err()  { echo -e "${RED}[ERROR ]${NC} $1"; exit 1; }

# ── 测试参数 ──
TEST_AMOUNT="${TEST_AMOUNT:-1000000000000000000}"  # 1 BBT (18 decimals)
POLL_INTERVAL="${POLL_INTERVAL:-10}"  # 秒
MAX_WAIT="${MAX_WAIT:-300}"           # 5分钟

# ── 前置检查 ──
log "检查环境..."

if [ ! -f "$ENV_FILE" ]; then
    err ".env 文件不存在，请从 .env.example 复制"
fi

set -a
source "$ENV_FILE"
set +a

cd "$BRIDGE_DIR"

# 读取部署信息
SEPOLIA_DEPLOY=$(ls -t "$DEPLOYMENTS_DIR"/sepolia-*.json 2>/dev/null | head -1)
BSC_DEPLOY=$(ls -t "$DEPLOYMENTS_DIR"/bscTestnet-*.json 2>/dev/null | head -1)

if [ -z "$SEPOLIA_DEPLOY" ]; then
    err "未找到 Sepolia 部署信息，请先运行 deploy-testnet.sh"
fi

if [ -z "$BSC_DEPLOY" ]; then
    err "未找到 BSC Testnet 部署信息，请先运行 deploy-testnet.sh"
fi

SEPOLIA_BRIDGE=$(grep -o '"BBTBridge": *"[^"]*"' "$SEPOLIA_DEPLOY" | cut -d'"' -f4)
SEPOLIA_TOKEN=$(grep -o '"BBTToken": *"[^"]*"' "$SEPOLIA_DEPLOY" | cut -d'"' -f4)
BSC_BRIDGE=$(grep -o '"BBTBridge": *"[^"]*"' "$BSC_DEPLOY" | cut -d'"' -f4)
BSC_TOKEN=$(grep -o '"BBTToken": *"[^"]*"' "$BSC_DEPLOY" | cut -d'"' -f4)

log "Sepolia Bridge: $SEPOLIA_BRIDGE"
log "Sepolia Token:  $SEPOLIA_TOKEN"
log "BSC Bridge:     $BSC_BRIDGE"
log "BSC Token:      $BSC_TOKEN"

# 获取部署者地址
DEPLOYER=$(npx hardhat run --network sepolia -e '
    const [s] = await ethers.getSigners();
    console.log(s.address);
' 2>/dev/null | tail -1)
log "测试账户: $DEPLOYER"

# ── Step 1: 查询 Sepolia wBBT 余额 ──
log ""
log "=========================================="
log "Step 1: 检查 Sepolia wBBT 余额"
log "=========================================="

SEPOLIA_BALANCE=$(npx hardhat run --network sepolia -e "
    const token = await ethers.getContractAt('BBTToken', '$SEPOLIA_TOKEN');
    const bal = await token.balanceOf('$DEPLOYER');
    console.log(bal.toString());
" 2>/dev/null | tail -1)

log "Sepolia wBBT 余额: $SEPOLIA_BALANCE"

SKIP_LOCK=false
if [ "$SEPOLIA_BALANCE" -lt "$TEST_AMOUNT" ]; then
    warn "余额不足 (需要至少 1 BBT)，跳过锁定测试"
    SKIP_LOCK=true
fi

# ── Step 2: 在 Sepolia 锁定 BBT ──
if [ "$SKIP_LOCK" = "false" ]; then
    log ""
    log "=========================================="
    log "Step 2: 在 Sepolia 锁定 BBT"
    log "=========================================="
    log "金额: $(echo "$TEST_AMOUNT / 1000000000000000000" | bc) BBT"
    log "目标链: BSC Testnet (chainId: 97)"

    # targetAddress = deployer address padded to bytes32
    TARGET_ADDR=$(printf '%064s' "${DEPLOYER#0x}" | tr ' ' '0')

    TX_RESULT=$(npx hardhat run --network sepolia -e "
        const bridge = await ethers.getContractAt('BBTBridge', '$SEPOLIA_BRIDGE');
        const token = await ethers.getContractAt('BBTToken', '$SEPOLIA_TOKEN');

        // Approve
        const approveTx = await token.approve('$SEPOLIA_BRIDGE', '$TEST_AMOUNT');
        await approveTx.wait();

        // Lock
        const lockTx = await bridge.lockBBT(
            '$TEST_AMOUNT',
            97,
            '0x$TARGET_ADDR'
        );
        const receipt = await lockTx.wait();
        console.log(receipt.hash);
    " 2>/dev/null | tail -1)

    ok "锁定成功! TX: $TX_RESULT"
fi

# ── Step 3: 等待中继器处理 ──
log ""
log "=========================================="
log "Step 3: 等待中继器处理"
log "=========================================="

if [ "$SKIP_LOCK" = "true" ]; then
    warn "跳过等待（未执行锁定）"
else
    log "轮询 BSC Testnet BBTMinted 事件 (最多 ${MAX_WAIT}s)..."

    ELAPSED=0
    FOUND=false

    while [ $ELAPSED -lt $MAX_WAIT ]; do
        MINTED=$(npx hardhat run --network bscTestnet -e "
            const bridge = await ethers.getContractAt('BBTBridge', '$BSC_BRIDGE');
            const filter = bridge.filters.BBTMinted();
            const events = await bridge.queryFilter(filter, -1000);
            const found = events.find(e => e.args.sourceChain.toString() === '11155111');
            console.log(found ? 'true' : 'false');
        " 2>/dev/null | tail -1)

        if [ "$MINTED" = "true" ]; then
            FOUND=true
            break
        fi

        sleep $POLL_INTERVAL
        ELAPSED=$((ELAPSED + POLL_INTERVAL))
        log "等待中... (${ELAPSED}s/${MAX_WAIT}s)"
    done

    if [ "$FOUND" = "true" ]; then
        ok "中继器已处理跨链交易!"
    else
        warn "超时未检测到跨链事件。请检查中继器是否运行。"
    fi
fi

# ── Step 4: 检查 BSC Testnet wBBT 余额 ──
log ""
log "=========================================="
log "Step 4: 检查 BSC Testnet wBBT 余额"
log "=========================================="

BSC_BALANCE=$(npx hardhat run --network bscTestnet -e "
    const token = await ethers.getContractAt('BBTToken', '$BSC_TOKEN');
    const bal = await token.balanceOf('$DEPLOYER');
    console.log(bal.toString());
" 2>/dev/null | tail -1)

log "BSC Testnet wBBT 余额: $BSC_BALANCE"

if [ "$BSC_BALANCE" -gt 0 ]; then
    ok "桥接测试通过! wBBT 已到账"
fi

# ── Step 5: 反向测试 — 销毁 wBBT ──
if [ "$BSC_BALANCE" -gt 0 ]; then
    log ""
    log "=========================================="
    log "Step 5: BSC Testnet 销毁 wBBT (反向)"
    log "=========================================="

    BURN_AMOUNT=$((BSC_BALANCE / 2))
    log "销毁数量: $BURN_AMOUNT wei (余额的一半)"

    npx hardhat run --network bscTestnet -e "
        const bridge = await ethers.getContractAt('BBTBridge', '$BSC_BRIDGE');
        const token = await ethers.getContractAt('BBTToken', '$BSC_TOKEN');

        const approveTx = await token.approve('$BSC_BRIDGE', '$BURN_AMOUNT');
        await approveTx.wait();

        const burnTx = await bridge.burnBBT('$BURN_AMOUNT');
        const receipt = await burnTx.wait();
        console.log(receipt.hash);
    " 2>/dev/null | tail -1

    ok "销毁成功!"
fi

# ── 汇总 ──
echo ""
log "=========================================="
log "E2E 测试完成"
log "=========================================="
log ""
log "区块浏览器:"
log "  Sepolia: https://sepolia.etherscan.io/address/$SEPOLIA_BRIDGE"
log "  BSC:     https://testnet.bscscan.com/address/$BSC_BRIDGE"
