const hre = require("hardhat");
const { ethers } = hre;

/**
 * BBT桥接合约部署脚本
 *
 * 部署流程：
 * 1. 部署BBTToken（wrapped BBT）
 * 2. 部署BBTBridge
 * 3. 配置权限
 */

// 配置参数
const CONFIG = {
  // Wrapped BBT代币信息
  tokenName: "Wrapped BBT",
  tokenSymbol: "wBBT",

  // 多签确认数
  requiredConfirmations: 2,

  // 限额（单位：wei，18位小数）
  singleTxLimit: ethers.parseEther("10000"), // 1万BBT
  dailyLimit: ethers.parseEther("100000"), // 10万BBT
  weeklyLimit: ethers.parseEther("500000"), // 50万BBT
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("=".repeat(60));
  console.log("BBT Bridge Deployment");
  console.log("=".repeat(60));
  console.log("Network:", network.name, `(Chain ID: ${network.chainId})`);
  console.log("Deployer:", deployer.address);
  console.log(
    "Balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH/BNB"
  );
  console.log("=".repeat(60));

  // Step 1: 部署BBTToken（wrapped BBT）
  console.log("\n[1/3] Deploying BBTToken (wrapped BBT)...");
  const BBTToken = await ethers.getContractFactory("BBTToken");
  const bbtToken = await BBTToken.deploy(
    CONFIG.tokenName,
    CONFIG.tokenSymbol,
    deployer.address
  );
  await bbtToken.waitForDeployment();
  const bbtTokenAddress = await bbtToken.getAddress();
  console.log("BBTToken deployed to:", bbtTokenAddress);

  // Step 2: 部署BBTBridge
  console.log("\n[2/3] Deploying BBTBridge...");

  // 根据链ID确定BBT代币地址
  // 对于目标链（ETH/BNB），源链BBT地址为address(0)（因为这里只有wrapped BBT）
  // 对于源链（Solana），wrapped BBT地址为address(0)
  const bbtTokenAddr = ethers.ZeroAddress; // 目标链没有原生BBT
  const wrappedBBTAddr = bbtTokenAddress;

  const BBTBridge = await ethers.getContractFactory("BBTBridge");
  const bridge = await BBTBridge.deploy(
    bbtTokenAddr,
    wrappedBBTAddr,
    CONFIG.requiredConfirmations,
    CONFIG.singleTxLimit,
    CONFIG.dailyLimit,
    CONFIG.weeklyLimit
  );
  await bridge.waitForDeployment();
  const bridgeAddress = await bridge.getAddress();
  console.log("BBTBridge deployed to:", bridgeAddress);

  // Step 3: 配置权限
  console.log("\n[3/3] Configuring permissions...");

  // 授予Bridge合约MINTER_ROLE
  console.log("Granting MINTER_ROLE to bridge...");
  const MINTER_ROLE = await bbtToken.MINTER_ROLE();
  await bbtToken.grantMinter(bridgeAddress);
  console.log("MINTER_ROLE granted");

  // 授予Bridge合约BURNER_ROLE
  console.log("Granting BURNER_ROLE to bridge...");
  const BURNER_ROLE = await bbtToken.BURNER_ROLE();
  await bbtToken.grantBurner(bridgeAddress);
  console.log("BURNER_ROLE granted");

  // 部署完成
  console.log("\n" + "=".repeat(60));
  console.log("Deployment Complete!");
  console.log("=".repeat(60));
  console.log("BBTToken (wBBT):", bbtTokenAddress);
  console.log("BBTBridge:", bridgeAddress);
  console.log("=".repeat(60));
  console.log("\nNext steps:");
  console.log("1. Verify contracts on block explorer");
  console.log("2. Add signers for multi-sig");
  console.log("3. Configure relayer operator role");
  console.log("4. Test with small amounts first");

  // 保存部署信息到文件
  const deploymentInfo = {
    network: network.name,
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    contracts: {
      BBTToken: bbtTokenAddress,
      BBTBridge: bridgeAddress,
    },
    config: {
      requiredConfirmations: CONFIG.requiredConfirmations,
      singleTxLimit: CONFIG.singleTxLimit.toString(),
      dailyLimit: CONFIG.dailyLimit.toString(),
      weeklyLimit: CONFIG.weeklyLimit.toString(),
    },
    timestamp: new Date().toISOString(),
  };

  const fs = require("fs");
  const path = require("path");
  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  const deploymentFile = path.join(
    deploymentsDir,
    `${network.name}-${network.chainId}.json`
  );
  fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));
  console.log(`\nDeployment info saved to: ${deploymentFile}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
