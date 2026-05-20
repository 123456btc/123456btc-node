# BBT Bridge — 测试网部署与测试指南

## 前置条件

### 1. 获取测试币

| 链 | 水龙头 | 说明 |
|---|---|---|
| Sepolia (ETH) | https://sepoliafaucet.com | 需要 Alchemy 账户 |
| Sepolia (ETH) | https://sepolia-faucet.pk910.de | PoW 挖矿获取 |
| BSC Testnet | https://testnet.bnbchain.org | 需要 GitHub 账户 |

每个网络至少需要 **0.1 ETH/BNB** 用于部署和测试。

### 2. 获取 RPC URL

| 服务 | URL | 免费额度 |
|---|---|---|
| Alchemy | https://www.alchemy.com | 300M compute units/月 |
| Infura | https://infura.io | 100K 请求/天 |
| QuickNode | https://www.quicknode.com | 10M API 调用/月 |

### 3. 获取区块浏览器 API Key

- **Etherscan**: https://etherscan.io/apis (用于 Sepolia 合约验证)
- **BSCScan**: https://bscscan.com/apis (用于 BSC Testnet 合约验证)

## 环境变量配置

```bash
cd contracts/evm/bridge
cp .env.example .env
```

编辑 `.env` 文件：

```env
# 部署者私钥（不含0x前缀）
PRIVATE_KEY=your_private_key_here

# RPC URLs
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/your_key
BSC_TESTNET_RPC_URL=https://data-seed-prebsc-1-s1.binance.org:8545/

# 区块浏览器 API Keys
ETHERSCAN_API_KEY=your_etherscan_key
BSCSCAN_API_KEY=your_bscscan_key
```

## 部署步骤

### 一键部署到两个测试网

```bash
# 从项目根目录
./scripts/deploy-testnet.sh
```

部署脚本会：
1. 检查环境变量
2. 安装依赖（如需要）
3. 编译合约
4. 部署到 Sepolia
5. 部署到 BSC Testnet
6. 验证合约源代码（如有 API Key）
7. 保存部署信息到 `deployments/` 目录

### 单独部署

```bash
cd contracts/evm/bridge

# 仅部署到 Sepolia
npx hardhat run scripts/deploy.js --network sepolia

# 仅部署到 BSC Testnet
npx hardhat run scripts/deploy.js --network bscTestnet
```

### 验证合约

```bash
# 验证 Sepolia 合约
npx hardhat run scripts/verify.js --network sepolia

# 验证 BSC Testnet 合约
npx hardhat run scripts/verify.js --network bscTestnet
```

### 添加多签签名者

编辑 `scripts/add-signers.js`，填入签名者地址，然后运行：

```bash
npx hardhat run scripts/add-signers.js --network sepolia
npx hardhat run scripts/add-signers.js --network bscTestnet
```

## 测试步骤

### 端到端桥接测试

```bash
# 从项目根目录
./scripts/test-bridge-e2e.sh
```

测试流程：
1. 检查 Sepolia BBT 余额
2. 在 Sepolia 锁定 BBT
3. 等待中继器处理（最多 5 分钟）
4. 检查 BSC Testnet wBBT 余额
5. 在 BSC Testnet 销毁 wBBT（反向桥接）

### 自定义测试参数

```bash
# 测试金额（wei，默认 1 BBT = 1e18 wei）
TEST_AMOUNT=5000000000000000000 ./scripts/test-bridge-e2e.sh
```

### 手动测试

```bash
cd contracts/evm/bridge

# 查看 Sepolia 部署信息
cat deployments/sepolia-*.json

# 查询余额
npx hardhat run --network sepolia -e "
  const token = await ethers.getContractAt('BBTToken', 'TOKEN_ADDR');
  console.log(await token.balanceOf('YOUR_ADDR'));
"
```

## 中继器配置

桥接需要中继器服务来监听和转发事件。配置中继器环境变量：

```bash
# 在项目根目录的 .env 中添加
BRIDGE_SOLANA_RPC=https://api.devnet.solana.com
BRIDGE_SOLANA_PROGRAM=YOUR_SOLANA_BRIDGE_PROGRAM
BRIDGE_SOLANA_KEYPAIR=~/.config/solana/id.json

BRIDGE_EVM_RPC=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
BRIDGE_EVM_CONTRACT=YOUR_SEPOLIA_BRIDGE_ADDRESS
BRIDGE_EVM_PRIVATE_KEY=YOUR_RELAYER_PRIVATE_KEY
BRIDGE_EVM_CHAIN_ID=11155111

BRIDGE_REDIS_URL=redis://localhost:6379
BRIDGE_PG_URL=postgresql://localhost:5432/bridge_relay

BRIDGE_REQUIRED_SIGS=2
BRIDGE_RELAYER_PEERS=peer1,peer2,peer3
```

启动中继器：

```bash
npm run bridge:start
```

## 区块浏览器链接

| 网络 | Bridge 合约 | wBBT Token |
|---|---|---|
| Sepolia | https://sepolia.etherscan.io/address/BRIDGE_ADDR | https://sepolia.etherscan.io/address/TOKEN_ADDR |
| BSC Testnet | https://testnet.bscscan.com/address/BRIDGE_ADDR | https://testnet.bscscan.com/address/TOKEN_ADDR |

## 故障排除

### 部署失败

```
Error: insufficient funds for intrinsic transaction cost
```
→ 需要更多测试币。使用水龙头获取。

```
Error: nonce too low
```
→ 等待几秒后重试，或手动设置 nonce。

### 合约验证失败

```
Error: Contract source code already verified
```
→ 合约已验证，无需重复操作。

```
Error: Unable to verify: contract not deployed
```
→ 检查合约地址是否正确，确认网络匹配。

### 测试超时

```
中继器超时未检测到跨链事件
```
→ 检查中继器是否正在运行
→ 检查中继器日志是否有错误
→ 确认 RPC URL 可访问
→ 确认合约地址配置正确

### Gas 估算失败

```
Error: cannot estimate gas
```
→ 可能是合约暂停或权限不足
→ 检查合约状态：`bridge.paused()`
→ 检查调用者角色

## 安全提醒

- **测试网私钥**与主网私钥**必须分开**
- 不要在 `.env` 中填入主网私钥
- 部署后立即检查合约权限配置
- 小额测试后再进行大额操作
