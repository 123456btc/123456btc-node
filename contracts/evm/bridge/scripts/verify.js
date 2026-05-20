const hre = require("hardhat");
const { ethers } = hre;

/**
 * 验证已部署的合约源代码
 * 使用: npx hardhat run scripts/verify.js --network <network>
 */

async function main() {
  const network = await ethers.provider.getNetwork();
  console.log("Verifying contracts on:", network.name, `(Chain ID: ${network.chainId})`);

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
    console.error("Run deploy.js first");
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  const { BBTToken, BBTBridge } = deployment.contracts;

  console.log("\nBBTToken:", BBTToken);
  console.log("BBTBridge:", BBTBridge);

  // 验证 BBTToken
  console.log("\n[1/2] Verifying BBTToken...");
  try {
    await hre.run("verify:verify", {
      address: BBTToken,
      constructorArguments: ["Wrapped BBT", "wBBT", deployment.deployer],
    });
    console.log("✅ BBTToken verified");
  } catch (e) {
    if (e.message.includes("Already Verified")) {
      console.log("✅ BBTToken already verified");
    } else {
      console.error("❌ BBTToken verification failed:", e.message);
    }
  }

  // 验证 BBTBridge
  console.log("\n[2/2] Verifying BBTBridge...");
  try {
    await hre.run("verify:verify", {
      address: BBTBridge,
      constructorArguments: [
        ethers.ZeroAddress, // bbtToken (none on target chain)
        BBTToken,           // wrappedBBT
        deployment.config.requiredConfirmations,
        deployment.config.singleTxLimit,
        deployment.config.dailyLimit,
        deployment.config.weeklyLimit,
      ],
    });
    console.log("✅ BBTBridge verified");
  } catch (e) {
    if (e.message.includes("Already Verified")) {
      console.log("✅ BBTBridge already verified");
    } else {
      console.error("❌ BBTBridge verification failed:", e.message);
    }
  }

  console.log("\n✅ Verification complete!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
