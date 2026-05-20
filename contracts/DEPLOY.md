# 123456btc Solana Contracts 部署指南

## 项目结构

```
contracts/
├── Anchor.toml                 # Anchor工作空间配置
├── Cargo.toml                  # Rust工作空间配置
├── package.json                # Node.js依赖
├── programs/
│   ├── blindbox_escrow/       # 盲盒托管合约
│   │   ├── Cargo.toml
│   │   └── src/lib.rs
│   └── agent_registry/        # Agent ID注册合约
│       ├── Cargo.toml
│       └── src/lib.rs
├── scripts/
│   ├── setup.sh               # 环境安装脚本
│   ├── deploy.sh              # 部署脚本
│   ├── deploy.ts              # TypeScript部署
│   └── verify.sh              # 验证脚本
└── tests/
    ├── blindbox.test.ts       # 盲盒测试
    └── agent.test.ts          # Agent注册测试
```

## 合约功能

### BlindBox Escrow (盲盒托管)
- **创建盲盒**: 用户锁定BBT代币创建盲盒
- **购买盲盒**: 买家支付BBT获得盲盒所有权
- **打开盲盒**: 买家揭示盲盒内容
- **争议仲裁**: 支持争议发起和解决

### Agent Registry (Agent注册)
- **注册Agent**: 创建链上Agent身份
- **更新Agent**: 修改Agent信息
- **任务提交**: 记录任务结果用于声誉计算
- **状态管理**: Active/Paused/Banned状态

## 部署步骤

### 1. 环境准备

```bash
# 运行安装脚本
./scripts/setup.sh

# 或手动安装
# 安装Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 安装Solana CLI
sh -c "$(curl -sSfL https://release.anza.xyz/v1.18.26/install)"

# 安装Anchor CLI
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install 0.30.1
avm use 0.30.1
```

### 2. 配置钱包

```bash
# 创建钱包
solana-keygen new --no-bip39-passphrase

# 切换到devnet
solana config set --url devnet

# 获取测试SOL
solana airdrop 2
```

### 3. 编译合约

```bash
cd contracts/
anchor build
```

### 4. 部署到测试网

```bash
# 使用部署脚本
./scripts/deploy.sh devnet

# 或手动部署
anchor deploy --provider.cluster devnet
```

### 5. 验证部署

```bash
# 运行验证脚本
./scripts/verify.sh devnet

# 运行测试
anchor test --provider.cluster devnet
```

## Program ID

| 合约 | Program ID |
|------|------------|
| BlindBox Escrow | `3gAkzDxzVUwF5Yfbc7LxzTMdscAHNgCDXbAxkEARZAXX` |
| Agent Registry | `6jFNXaJxVS7M9s3Fty9cQtkeiv8sNUAXtjvsd4adinTx` |

## 测试网信息

- **Network**: Solana Devnet
- **RPC**: https://api.devnet.solana.com
- **Explorer**: https://explorer.solana.com/?cluster=devnet

## 注意事项

1. 部署前确保钱包有足够SOL（至少2 SOL）
2. Program ID会在部署时自动生成并更新到Anchor.toml
3. 保存好生成的keypair文件（target/deploy/）
4. 测试网SOL无实际价值，仅用于开发测试

## 集成到Node项目

```typescript
// 在src/infra/chain/中调用合约
import { Program } from "@coral-xyz/anchor";
import { BlindboxEscrow } from "./types/blindbox_escrow";

const program = new Program<BlindboxEscrow>(IDL, programId, provider);
await program.methods
  .createBlindbox(name, description, amount, rarity)
  .accounts({ ... })
  .rpc();
```
