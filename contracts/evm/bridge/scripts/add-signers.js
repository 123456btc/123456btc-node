const hre = require("hardhat");
const { ethers } = hre;

/**
 * 添加多签签名者到桥接合约
 * 使用 AccessControl 的 grantRole(SIGNER_ROLE, addr)
 * 使用: npx hardhat run scripts/add-signers.js --network <network>
 */

// 配置：要添加的签名者地址
const SIGNERS = [
  // "0x...", // Relayer 1
  // "0x...", // Relayer 2
  // "0x...", // Relayer 3
];

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("Network:", network.name, `(Chain ID: ${network.chainId})`);
  console.log("Deployer:", deployer.address);

  // 读取部署信息
  const fs = require("fs");
  const path = require("path");
  const deploymentFile = path.join(
    __dirname,
    "../deployments",
    `${network.name}-${network.chainId}.json`
  );

  if (!fs.existsSync(deploymentFile)) {
    console.error("Deployment file not found:", deploymentFile);
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  const bridgeAddress = deployment.contracts.BBTBridge;
  console.log("Bridge:", bridgeAddress);

  const bridge = await ethers.getContractAt("BBTBridge", bridgeAddress);
  const SIGNER_ROLE = await bridge.SIGNER_ROLE();
  console.log("SIGNER_ROLE:", SIGNER_ROLE);

  // 过滤有效地址
  const signers = SIGNERS.filter(s => s && s !== "" && !s.startsWith("//"));

  if (signers.length === 0) {
    console.log("\nNo signers configured. Edit SIGNERS array in this script.");
    console.log("\nCurrent signers (from events):");
    const filter = bridge.filters.RoleGranted(SIGNER_ROLE);
    const events = await bridge.queryFilter(filter, -10000);
    if (events.length === 0) {
      console.log("  (none)");
    } else {
      const seen = new Set();
      for (const e of events) {
        if (!seen.has(e.args.account)) {
          seen.add(e.args.account);
          console.log(" ", e.args.account);
        }
      }
    }
    return;
  }

  // 添加签名者
  for (const signerAddr of signers) {
    console.log(`\nAdding signer: ${signerAddr}...`);
    try {
      const hasRole = await bridge.hasRole(SIGNER_ROLE, signerAddr);
      if (hasRole) {
        console.log(`  Already a signer, skipping`);
        continue;
      }
      const tx = await bridge.grantRole(SIGNER_ROLE, signerAddr);
      await tx.wait();
      console.log(`  Signer added! TX: ${tx.hash}`);
    } catch (e) {
      console.error(`  Failed:`, e.message);
    }
  }

  // 显示当前签名者
  console.log("\n--- Current Signers ---");
  const filter = bridge.filters.RoleGranted(SIGNER_ROLE);
  const events = await bridge.queryFilter(filter, -10000);
  const seen = new Set();
  for (const e of events) {
    if (!seen.has(e.args.account)) {
      seen.add(e.args.account);
      console.log(`  ${e.args.account}`);
    }
  }

  const required = await bridge.requiredConfirmations();
  console.log(`\nRequired confirmations: ${required}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
