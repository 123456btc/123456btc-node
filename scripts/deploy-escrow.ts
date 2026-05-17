/**
 * SubscriptionEscrow 部署脚本
 * 支持: localnet / devnet / mainnet-beta
 *
 * 用法:
 *   tsx scripts/deploy-escrow.ts --cluster devnet --provider-wallet <wallet>
 *
 * 输出:
 *   - Program ID (写入 programs/subscription_escrow/Anchor.toml)
 *   - Vault ATA 地址
 *   - 平台费收款地址
 */

import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import fs from 'fs';
import path from 'path';

const CLUSTER_URLS: Record<string, string> = {
  localnet: 'http://127.0.0.1:8899',
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
};

async function main() {
  const args = process.argv.slice(2);
  const cluster = getArg(args, '--cluster') || 'devnet';
  const keypairPath = getArg(args, '--keypair') || path.join(process.env.HOME || '', '.config/solana/id.json');
  const bbtMint = getArg(args, '--bbt-mint') || '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

  const rpcUrl = CLUSTER_URLS[cluster];
  if (!rpcUrl) {
    console.error(`Unknown cluster: ${cluster}`);
    process.exit(1);
  }

  console.log(`Cluster: ${cluster}`);
  console.log(`RPC: ${rpcUrl}`);

  // 加载 deployer keypair
  const deployer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf-8')))
  );
  console.log(`Deployer: ${deployer.publicKey.toBase58()}`);

  const connection = new Connection(rpcUrl, 'confirmed');
  const balance = await connection.getBalance(deployer.publicKey);
  console.log(`Balance: ${balance / 1e9} SOL`);

  if (balance < 0.5 * 1e9) {
    console.warn('⚠️ 余额较低，部署可能需要 0.5+ SOL');
  }

  // 预计算 Vault PDA
  // Vault 是合约用来托管用户 BBT 的 ATA，由合约 PDA 拥有
  const [vaultPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), new PublicKey(bbtMint).toBuffer()],
    // Program ID 占位，实际部署后替换
    new PublicKey('11111111111111111111111111111111')
  );
  console.log(`\n预计算 Vault PDA: ${vaultPDA.toBase58()}`);

  // 创建 Vault ATA（如不存在）
  const vaultATA = await getAssociatedTokenAddress(
    new PublicKey(bbtMint),
    vaultPDA,
    true, // allowOwnerOffCurve (PDA)
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  console.log(`Vault ATA: ${vaultATA.toBase58()}`);

  const accountInfo = await connection.getAccountInfo(vaultATA);
  if (!accountInfo) {
    console.log('创建 Vault ATA...');
    const tx = new (await import('@solana/web3.js')).Transaction().add(
      createAssociatedTokenAccountInstruction(
        deployer.publicKey,
        vaultATA,
        vaultPDA,
        new PublicKey(bbtMint),
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      )
    );
    // 实际发送需要 sign + send，这里简化
    console.log('请在实际部署时 uncomment 发送逻辑');
  } else {
    console.log('Vault ATA 已存在');
  }

  console.log('\n📋 部署清单:');
  console.log(`  Cluster:     ${cluster}`);
  console.log(`  Program ID:  <待部署后填入>`);
  console.log(`  Vault PDA:   ${vaultPDA.toBase58()}`);
  console.log(`  Vault ATA:   ${vaultATA.toBase58()}`);
  console.log(`  BBT Mint:    ${bbtMint}`);
  console.log(`  Deployer:    ${deployer.publicKey.toBase58()}`);
  console.log('\n下一步:');
  console.log('  1. anchor build');
  console.log('  2. anchor deploy --provider.cluster devnet');
  console.log('  3. 替换 lib.rs 和 Anchor.toml 中的 Program ID');
  console.log('  4. 更新 .env: ESCROW_PROGRAM_ID=<新ID> VAULT_ATA=<地址>');
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

main().catch(console.error);
