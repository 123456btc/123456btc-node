# Escrow 合约部署指南

> 基于链上托管（Escrow）的订阅结算模式，替代传统的 Memo 转账模式。用户资金锁定在程序派生的 PDA 中，平台按周期结算。

## 前置要求

| 工具 | 版本 | 安装命令 |
|------|------|---------|
| Solana CLI | >= 1.18 | `sh -c "$(curl -sSfL https://release.solana.com/v1.18.0/install)"` |
| Anchor CLI | >= 0.29 | `cargo install --git https://github.com/coral-xyz/anchor avm && avm install latest && avm use latest` |
| Node.js | >= 20 | 官网下载或用 nvm |
| Rust | >= 1.75 | `rustup default stable` |

## 环境准备

### 1. 配置 Solana CLI
```bash
solana config set --url devnet
solana-keygen new --outfile ~/.config/solana/id.json
solana address  # 记录部署者地址
```

### 2. 领水（Devnet）
```bash
solana airdrop 5
solana balance  # 应 >= 3 SOL
```
如果 airdrop 失败，去 https://faucet.solana.com/ 手动领取。

### 3. 准备 BBT Token Mint
Escrow 合约需要 BBT token 的 Mint 地址。如果还没有：
```bash
# 创建 SPL Token（devnet 测试用）
spl-token create-token
# 记录 Token Address
```

## 合约部署

### 快速部署（推荐）
```bash
cd /path/to/123456btc-node
chmod +x scripts/deploy-contracts.sh
./scripts/deploy-contracts.sh
```

### 手动部署
```bash
cd contracts

# subscription_escrow
solana program deploy target/deploy/subscription_escrow.so
# 记录输出的 Program ID

# blindbox_escrow
solana program deploy target/deploy/blindbox_escrow.so

# bridge
solana program deploy target/deploy/bridge.so
```

### 更新 Program ID
```bash
# 方法1：自动更新
npx tsx scripts/update-program-ids.ts <subscription_id> [blindbox_id] [bridge_id]

# 方法2：手动配置
123456btc-node config --set escrow_program_id=<subscription_id>
export BBT_ESCROW_PROGRAM_ID=<subscription_id>
```

## 节点启动

### 配置 Provider Keypair
```bash
# 生成或导入 Provider keypair
solana-keygen new --outfile ~/.123456btc-node/provider-keypair.json

# 配置节点
123456btc-node init \
  --name "AlphaQuant" \
  --wallet <Provider_Solana_Address> \
  --settlement-mode escrow \
  --escrow-program-id <DEPLOYED_PROGRAM_ID> \
  --provider-keypair ~/.123456btc-node/provider-keypair.json

# 启动
123456btc-node serve
```

## 故障排查

### 1. `cargo build-sbf` 失败：`edition2024` 不支持
**原因**：Rust 工具链版本过旧。
**解决**：
```bash
rustup update
rustup component add rust-src
```

### 2. `anchor build` 失败：`source_file()` 方法缺失
**原因**：anchor-syn 与 proc_macro2 版本不兼容。
**解决**：使用 `cargo build-sbf` 代替 `anchor build` 编译合约。IDL 已手写提供，无需生成。

### 3. `solana program deploy` 报 `insufficient funds`
**原因**：devnet SOL 不足。
**解决**：多领几次水或去 faucet 网站。

### 4. `Entrypoint out of bounds`
**原因**：Solana CLI 版本与 validator 版本不兼容，或 `.so` 编译目标版本不匹配。
**解决**：
```bash
solana-install update
agave-install update
```

### 5. Airdrop 失败 / RPC 超时
**原因**：网络限制或 devnet 拥堵。
**解决**：
- 使用 VPN 或代理
- 使用备用 RPC：`solana config set --url https://devnet.helius-rpc.com/?api-key=<your_key>`
- 手动去 faucet 网站领取

### 6. 合约部署成功但调用失败
**原因**：
- vault_authority PDA 未正确推导
- Token Account（ATA）未提前创建
- 权限检查失败（provider/user 不匹配）

**解决**：
```bash
# 确保用户已创建 BBT ATA
spl-token create-account <BBT_MINT>

# 确保 Provider 已创建 BBT ATA
spl-token create-account <BBT_MINT> --owner <Provider_Wallet>
```

## 验证部署

```bash
# 检查程序是否在线
solana program show <PROGRAM_ID>

# 创建订阅（示例）
curl -X POST http://localhost:1119/subscriptions \
  -H "Content-Type: application/json" \
  -H "X-Wallet: <User_Wallet>" \
  -d '{"strategy_id": "strat_xxx", "escrow": true}'

# 查询链上状态
123456btc-node escrow status --pda <Subscription_PDA>
```

## 注意事项

1. **vault_authority PDA** 由程序根据 `subscription_escrow` 的 `program_id` 和固定种子自动推导，无需手动创建。
2. **用户 ATA** — 所有用户在创建订阅前需要提前创建 BBT ATA（Associated Token Account），否则代币转账会失败。
3. **platform_wallet** — 用于接收 5% 平台费，需在部署合约时正确配置。
4. **RPC 节点** — Escrow 模式需要频繁查询链上状态，建议使用高可用 RPC（如 Helius、QuickNode）。
5. **交易确认** — 主网建议等待 `confirmed` 级别确认后再更新本地订阅状态。

## 相关文档

- [ARCHITECTURE.md](ARCHITECTURE.md) — 网络拓扑与数据模型
- [DEPLOY.md](../DEPLOY.md) — Docker、HTTPS、备份指南
- [MCP-INTEGRATION.md](MCP-INTEGRATION.md) — AI Agent 集成
