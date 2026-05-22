# Escrow 模式部署指南

> 基于链上托管（Escrow）的订阅结算模式，替代传统的 Memo 转账模式。用户资金锁定在程序派生的 PDA 中，平台按周期结算。

## 前置条件

- Solana CLI (`>= 1.17.0`)
- Anchor CLI (`>= 0.29.0`)
- Node.js 20+
- BBT Token Mint（已在主网/测试网存在）
- 充足的 SOL 用于部署和交易手续费

## 1. 编译合约

### subscription_escrow（原生 Solana Program）

```bash
cd programs/subscription_escrow
cargo build-sbf
# 编译产物位于 target/deploy/subscription_escrow.so
cd ../..
```

### blindbox_escrow & bridge（Anchor 程序）

```bash
cd contracts
anchor build
# 编译产物位于 target/deploy/
cd ..
```

## 2. 部署合约

### subscription_escrow

```bash
cd programs/subscription_escrow
solana program deploy target/deploy/subscription_escrow.so
# 记录输出的 Program ID，如：
# Program Id: EscrowProgramID111111111111111111111111111
```

### blindbox_escrow

```bash
cd contracts
anchor deploy --program-name blindbox_escrow
# 记录 Program ID
```

### bridge

```bash
cd contracts
anchor deploy --program-name bridge
# 记录 Program ID
```

> **提示：** 建议将部署的 Program ID 保存到 `.env` 或配置文件中，方便后续使用。

## 3. 更新节点配置

使用 CLI 初始化或更新节点，指定 `--settlement-mode escrow`：

```bash
123456btc-node init \
  --name "AlphaQuant" \
  --wallet <Provider_Wallet> \
  --settlement-mode escrow \
  --escrow-program-id <DEPLOYED_PROGRAM_ID>
```

或在 `.env` 中设置：

```env
BBT_SETTLEMENT_MODE=escrow
BBT_ESCROW_PROGRAM_ID=<DEPLOYED_PROGRAM_ID>
```

## 4. 准备 Provider Keypair

Provider 需要一个链上 Keypair 用于签署链上交易：

```bash
# 将 keypair 数组写入文件
mkdir -p ~/.123456btc-node
echo '[1,2,3,...]' > ~/.123456btc-node/provider-keypair.json

# 设置到节点配置
123456btc-node config --set provider_keypair_path=/Users/<you>/.123456btc-node/provider-keypair.json
```

> **安全提示：** `provider-keypair.json` 包含私钥，请妥善保管，不要提交到代码仓库。

## 5. 启动节点

```bash
123456btc-node serve
```

启动后节点会自动检测 escrow 模式并启用链上交互：
- 监听订阅请求
- 调用 `create_subscription` / `renew_subscription` / `cancel_subscription` 等指令
- 管理 `vault_authority` PDA 和代币托管

## 6. 验证

### 创建订阅（用户端）

```bash
curl -X POST http://localhost:1119/subscriptions \
  -H "X-Wallet: <USER_WALLET_ADDRESS>" \
  -d '{
    "strategy_id": "<STRATEGY_ID>",
    "escrow": true,
    "amount": 1000,
    "duration_days": 30
  }'
```

### 查询链上状态

```bash
123456btc-node escrow status --pda <SUBSCRIPTION_PDA>
```

### 健康检查

```bash
curl http://localhost:1119/health
```

## 注意事项

1. **vault_authority PDA** 由程序根据 `subscription_escrow` 的 `program_id` 和固定种子自动推导，无需手动创建。
2. **用户 ATA** — 所有用户在创建订阅前需要提前创建 BBT ATA（Associated Token Account），否则代币转账会失败。
3. **platform_wallet** — 用于接收 5% 平台费，需在部署合约时正确配置。
4. **RPC 节点** — Escrow 模式需要频繁查询链上状态，建议使用高可用 RPC（如 Helius、QuickNode）。
5. **交易确认** — 主网建议等待 `confirmed` 级别确认后再更新本地订阅状态。

## 故障排查

| 问题 | 原因 | 解决 |
|------|------|------|
| `AccountNotFound` | PDA 未创建或 Program ID 错误 | 检查 `--escrow-program-id` 是否与部署的一致 |
| `InsufficientFunds` | 用户 BBT 余额不足 | 提醒用户充值 BBT |
| `TokenAccountNotFound` | 用户没有 BBT ATA | 先调用 `create_associated_token_account` |
| `ConstraintViolation` | 平台钱包配置错误 | 检查合约初始化时的 `platform_wallet` |

## 相关文档

- [ARCHITECTURE.md](ARCHITECTURE.md) — 网络拓扑与数据模型
- [DEPLOY.md](../DEPLOY.md) — Docker、HTTPS、备份指南
- [MCP-INTEGRATION.md](MCP-INTEGRATION.md) — AI Agent 集成
