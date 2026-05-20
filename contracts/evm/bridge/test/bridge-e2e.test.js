const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BBT Bridge E2E (Local)", function () {
  let deployer, user1, relayer1, relayer2;
  let tokenA, bridgeA; // Source chain (native BBT)
  let tokenB, bridgeB; // Target chain (wrapped BBT)

  const REQUIRED_SIGS = 2;
  const SINGLE_LIMIT = ethers.parseEther("10000");
  const DAILY_LIMIT = ethers.parseEther("100000");
  const WEEKLY_LIMIT = ethers.parseEther("500000");
  const BRIDGE_AMOUNT = ethers.parseEther("100");

  beforeEach(async function () {
    [deployer, user1, relayer1, relayer2] = await ethers.getSigners();

    const BBTToken = await ethers.getContractFactory("BBTToken");
    const BBTBridge = await ethers.getContractFactory("BBTBridge");

    // Source chain: native BBT exists
    tokenA = await BBTToken.deploy("BBT Token", "BBT", deployer.address);
    await tokenA.waitForDeployment();
    bridgeA = await BBTBridge.deploy(
      await tokenA.getAddress(), ethers.ZeroAddress,
      REQUIRED_SIGS, SINGLE_LIMIT, DAILY_LIMIT, WEEKLY_LIMIT
    );
    await bridgeA.waitForDeployment();

    // Target chain: wrapped BBT only
    tokenB = await BBTToken.deploy("Wrapped BBT", "wBBT", deployer.address);
    await tokenB.waitForDeployment();
    bridgeB = await BBTBridge.deploy(
      ethers.ZeroAddress, await tokenB.getAddress(),
      REQUIRED_SIGS, SINGLE_LIMIT, DAILY_LIMIT, WEEKLY_LIMIT
    );
    await bridgeB.waitForDeployment();

    const bridgeAAddr = await bridgeA.getAddress();
    const bridgeBAddr = await bridgeB.getAddress();

    // Roles
    await tokenA.grantMinter(deployer.address);
    await tokenB.grantMinter(bridgeBAddr);
    await tokenB.grantBurner(bridgeBAddr);

    const SIGNER_ROLE = await bridgeA.SIGNER_ROLE();
    const OPERATOR_ROLE = await bridgeA.OPERATOR_ROLE();
    for (const b of [bridgeA, bridgeB]) {
      await b.grantRole(SIGNER_ROLE, relayer1.address);
      await b.grantRole(SIGNER_ROLE, relayer2.address);
      await b.grantRole(OPERATOR_ROLE, relayer1.address);
    }

    // Give user native BBT on source chain
    await tokenA.mint(user1.address, ethers.parseEther("1000"));
  });

  // Helper: simulate relayer flow (lock on A → mint on B)
  async function forwardBridge(amount) {
    const bridgeAAddr = await bridgeA.getAddress();
    const bridgeBAddr = await bridgeB.getAddress();
    const targetAddr = ethers.zeroPadValue(user1.address, 32);

    // User locks BBT on source chain
    await tokenA.connect(user1).approve(bridgeAAddr, amount);
    const lockTx = await bridgeA.connect(user1).lockBBT(amount, 97, targetAddr);
    const receipt = await lockTx.wait();

    // Parse BBTLocked event for sourceTxHash
    const lockEvent = receipt.logs.find(log => {
      try { return bridgeA.interface.parseLog(log)?.name === "BBTLocked"; } catch { return false; }
    });
    const args = bridgeA.interface.parseLog(lockEvent).args;

    // Relayer mints wBBT on target chain
    await bridgeB.connect(relayer1).mintBBT(
      user1.address, amount, 31337, receipt.hash
    );

    return receipt;
  }

  // Helper: simulate relayer flow (burn on B → unlock on A)
  // NOTE: Both bridges run on same Hardhat chain (31337), so we use a fake
  // sourceChain (97) to pass the "same chain not allowed" check.
  async function reverseBridge(amount) {
    const bridgeAAddr = await bridgeA.getAddress();
    const bridgeBAddr = await bridgeB.getAddress();

    // User burns wBBT on target chain
    await tokenB.connect(user1).approve(bridgeBAddr, amount);
    const burnTx = await bridgeB.connect(user1).burnBBT(amount);
    const receipt = await burnTx.wait();

    // Relayer unlocks BBT on source chain (sourceChain=97 to differ from local 31337)
    await bridgeA.connect(relayer1).unlockBBT(
      user1.address, amount, 97, receipt.hash
    );

    return receipt;
  }

  describe("Forward: Lock on A → Mint on B", function () {
    it("should lock BBT and emit BBTLocked", async function () {
      const bridgeAAddr = await bridgeA.getAddress();
      const targetAddr = ethers.zeroPadValue(user1.address, 32);

      await tokenA.connect(user1).approve(bridgeAAddr, BRIDGE_AMOUNT);

      await expect(
        bridgeA.connect(user1).lockBBT(BRIDGE_AMOUNT, 97, targetAddr)
      ).to.emit(bridgeA, "BBTLocked");

      expect(await tokenA.balanceOf(user1.address)).to.equal(ethers.parseEther("900"));
    });

    it("should mint wBBT on target chain", async function () {
      await forwardBridge(BRIDGE_AMOUNT);

      expect(await tokenB.balanceOf(user1.address)).to.equal(BRIDGE_AMOUNT);
    });

    it("should deduct BBT from user on source chain", async function () {
      const before = await tokenA.balanceOf(user1.address);
      await forwardBridge(BRIDGE_AMOUNT);
      const after = await tokenA.balanceOf(user1.address);

      expect(before - after).to.equal(BRIDGE_AMOUNT);
    });
  });

  describe("Reverse: Burn on B → Unlock on A", function () {
    beforeEach(async function () {
      await forwardBridge(BRIDGE_AMOUNT);
    });

    it("should burn wBBT and emit BBTBurned", async function () {
      const bridgeBAddr = await bridgeB.getAddress();
      await tokenB.connect(user1).approve(bridgeBAddr, BRIDGE_AMOUNT);

      await expect(
        bridgeB.connect(user1).burnBBT(BRIDGE_AMOUNT)
      ).to.emit(bridgeB, "BBTBurned");

      expect(await tokenB.balanceOf(user1.address)).to.equal(0);
    });

    it("should unlock BBT on source chain", async function () {
      const before = await tokenA.balanceOf(user1.address);
      await reverseBridge(BRIDGE_AMOUNT);
      const after = await tokenA.balanceOf(user1.address);

      expect(after - before).to.equal(BRIDGE_AMOUNT);
    });

    it("should emit BBTUnlocked", async function () {
      const bridgeBAddr = await bridgeB.getAddress();

      await tokenB.connect(user1).approve(bridgeBAddr, BRIDGE_AMOUNT);
      const burnTx = await bridgeB.connect(user1).burnBBT(BRIDGE_AMOUNT);
      const burnReceipt = await burnTx.wait();

      await expect(
        bridgeA.connect(relayer1).unlockBBT(
          user1.address, BRIDGE_AMOUNT, 97, burnReceipt.hash
        )
      ).to.emit(bridgeA, "BBTUnlocked");
    });
  });

  describe("Full Round Trip", function () {
    it("A→B→A: lock, mint, burn, unlock preserves total supply", async function () {
      const initialA = await tokenA.balanceOf(user1.address);

      // Forward
      await forwardBridge(BRIDGE_AMOUNT);
      expect(await tokenB.balanceOf(user1.address)).to.equal(BRIDGE_AMOUNT);

      // Reverse
      await reverseBridge(BRIDGE_AMOUNT);
      expect(await tokenB.balanceOf(user1.address)).to.equal(0);
      expect(await tokenA.balanceOf(user1.address)).to.equal(initialA);
    });
  });

  describe("Security", function () {
    it("should reject replay attack", async function () {
      const sourceTxHash = ethers.keccak256(ethers.toUtf8Bytes("tx-1"));

      await bridgeB.connect(relayer1).mintBBT(user1.address, BRIDGE_AMOUNT, 31337, sourceTxHash);

      await expect(
        bridgeB.connect(relayer1).mintBBT(user1.address, BRIDGE_AMOUNT, 31337, sourceTxHash)
      ).to.be.revertedWith("BBTBridge: tx already processed");
    });

    it("should enforce single tx limit", async function () {
      const bridgeAAddr = await bridgeA.getAddress();
      const targetAddr = ethers.zeroPadValue(user1.address, 32);
      const tooMuch = ethers.parseEther("20000");

      await tokenA.connect(user1).approve(bridgeAAddr, tooMuch);

      await expect(
        bridgeA.connect(user1).lockBBT(tooMuch, 97, targetAddr)
      ).to.be.revertedWith("BBTBridge: exceeds single tx limit");
    });

    it("should reject non-operator mint", async function () {
      await expect(
        bridgeB.connect(user1).mintBBT(user1.address, BRIDGE_AMOUNT, 31337, ethers.ZeroHash)
      ).to.be.revertedWith("BBTBridge: not operator");
    });

    it("should reject zero amount", async function () {
      const targetAddr = ethers.zeroPadValue(user1.address, 32);
      await tokenA.connect(user1).approve(await bridgeA.getAddress(), 0);

      await expect(
        bridgeA.connect(user1).lockBBT(0, 97, targetAddr)
      ).to.be.revertedWith("BBTBridge: zero amount");
    });

    it("should pause and resume", async function () {
      const targetAddr = ethers.zeroPadValue(user1.address, 32);

      await bridgeA.pauseBridge();

      await tokenA.connect(user1).approve(await bridgeA.getAddress(), BRIDGE_AMOUNT);
      await expect(
        bridgeA.connect(user1).lockBBT(BRIDGE_AMOUNT, 97, targetAddr)
      ).to.be.reverted; // OZ v5 Pausable custom error

      await bridgeA.unpauseBridge();

      await expect(
        bridgeA.connect(user1).lockBBT(BRIDGE_AMOUNT, 97, targetAddr)
      ).to.emit(bridgeA, "BBTLocked");
    });

    it("should reject same-chain bridge", async function () {
      const targetAddr = ethers.zeroPadValue(user1.address, 32);
      const chainId = (await ethers.provider.getNetwork()).chainId;

      await tokenA.connect(user1).approve(await bridgeA.getAddress(), BRIDGE_AMOUNT);

      await expect(
        bridgeA.connect(user1).lockBBT(BRIDGE_AMOUNT, chainId, targetAddr)
      ).to.be.revertedWith("BBTBridge: same chain not allowed");
    });
  });
});
