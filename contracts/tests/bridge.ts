import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Bridge } from "../target/types/bridge";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("bridge", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Bridge as any;

  let mint: PublicKey;
  let userTokenAccount: PublicKey;
  let platformTokenAccount: PublicKey;

  const authority = Keypair.generate();
  const signer1 = Keypair.generate();
  const signer2 = Keypair.generate();
  const signer3 = Keypair.generate();
  const user = Keypair.generate();
  const relayer = Keypair.generate();
  const platform = Keypair.generate();

  const configPda = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  )[0];

  const multisigPda = PublicKey.findProgramAddressSync(
    [Buffer.from("multisig")],
    program.programId
  )[0];

  const vaultPda = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    program.programId
  )[0];

  before(async () => {
    for (const kp of [authority, signer1, signer2, signer3, user, relayer, platform]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    mint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      9
    );

    userTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      user,
      mint,
      user.publicKey
    );

    platformTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      platform,
      mint,
      platform.publicKey
    );

    await mintTo(
      provider.connection,
      authority,
      mint,
      userTokenAccount,
      authority.publicKey,
      1_000_000_000_000 // 1000 BBT
    );
  });

  it("Initializes the bridge", async () => {
    const signers = [signer1.publicKey, signer2.publicKey, signer3.publicKey];
    const threshold = 2;
    const feeBps = 100; // 1%

    await program.methods
      .initialize(signers, threshold, new anchor.BN(feeBps))
      .accounts({
        authority: authority.publicKey,
        config: configPda,
        multisig: multisigPda,
        vaultTokenAccount: vaultPda,
        bbtMint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const config = await (program as any).account.bridgeConfig.fetch(configPda);
    expect(config.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(config.vault.toBase58()).to.equal(vaultPda.toBase58());
    expect(config.feeBps.toNumber()).to.equal(feeBps);
    expect(config.paused).to.be.false;

    const multisig = await (program as any).account.multisig.fetch(multisigPda);
    expect(multisig.signers.map((s: PublicKey) => s.toBase58())).to.deep.equal(
      signers.map((s) => s.toBase58())
    );
    expect(multisig.threshold).to.equal(threshold);
  });

  it("Locks BBT", async () => {
    const amount = new anchor.BN(500_000_000); // 0.5 BBT

    const configBefore = await (program as any).account.bridgeConfig.fetch(configPda);
    const nonce = configBefore.nonce.toNumber();

    const txPda = PublicKey.findProgramAddressSync(
      [
        Buffer.from("tx"),
        user.publicKey.toBuffer(),
        new anchor.BN(nonce + 1).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];

    await program.methods
      .lockBbt(amount, "ethereum", "0x1234567890abcdef")
      .accounts({
        user: user.publicKey,
        config: configPda,
        crossChainTx: txPda,
        userTokenAccount: userTokenAccount,
        vaultTokenAccount: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const configAfter = await (program as any).account.bridgeConfig.fetch(configPda);
    expect(configAfter.totalLocked.toNumber()).to.equal(amount.toNumber());
    expect(configAfter.nonce.toNumber()).to.equal(nonce + 1);

    const tx = await (program as any).account.crossChainTx.fetch(txPda);
    expect(tx.user.toBase58()).to.equal(user.publicKey.toBase58());
    expect(tx.amount.toNumber()).to.equal(amount.toNumber());
    expect(tx.status).to.deep.equal({ pending: {} });
  });

  it("Creates and approves a proposal", async () => {
    const multisig = await (program as any).account.multisig.fetch(multisigPda);
    const proposalIndex = multisig.proposalCount.toNumber();

    const proposalPda = PublicKey.findProgramAddressSync(
      [
        Buffer.from("proposal"),
        new anchor.BN(proposalIndex).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];

    await program.methods
      .createProposal("ethereum", "0xabc123", new anchor.BN(100_000_000), user.publicKey)
      .accounts({
        signer: signer1.publicKey,
        multisig: multisigPda,
        proposal: proposalPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([signer1])
      .rpc();

    let proposal = await (program as any).account.proposal.fetch(proposalPda);
    expect(proposal.creator.toBase58()).to.equal(signer1.publicKey.toBase58());
    expect(proposal.status).to.deep.equal({ pending: {} });
    expect(proposal.approvals.length).to.equal(1);

    await program.methods
      .approveProposal()
      .accounts({
        signer: signer2.publicKey,
        multisig: multisigPda,
        proposal: proposalPda,
      })
      .signers([signer2])
      .rpc();

    proposal = await (program as any).account.proposal.fetch(proposalPda);
    expect(proposal.status).to.deep.equal({ approved: {} });
    expect(proposal.approvals.length).to.equal(2);
  });

  it("Unlocks BBT via proposal", async () => {
    const multisig = await (program as any).account.multisig.fetch(multisigPda);
    const proposalIndex = multisig.proposalCount.toNumber() - 1;

    const proposalPda = PublicKey.findProgramAddressSync(
      [
        Buffer.from("proposal"),
        new anchor.BN(proposalIndex).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];

    const configBefore = await (program as any).account.bridgeConfig.fetch(configPda);
    const nonce = configBefore.nonce.toNumber();

    const txPda = PublicKey.findProgramAddressSync(
      [
        Buffer.from("tx"),
        user.publicKey.toBuffer(),
        new anchor.BN(nonce + 1).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];

    const userBefore = Number((await getAccount(provider.connection, userTokenAccount)).amount);

    await program.methods
      .unlockBbt("ethereum", "0xabc123", new anchor.BN(100_000_000))
      .accounts({
        relayer: relayer.publicKey,
        config: configPda,
        multisig: multisigPda,
        proposal: proposalPda,
        crossChainTx: txPda,
        user: user.publicKey,
        userTokenAccount: userTokenAccount,
        vaultTokenAccount: vaultPda,
        platformTokenAccount: platformTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([relayer])
      .rpc();

    const userAfter = Number((await getAccount(provider.connection, userTokenAccount)).amount);
    expect(userAfter).to.be.greaterThan(userBefore);

    const proposal = await (program as any).account.proposal.fetch(proposalPda);
    expect(proposal.executed).to.be.true;
    expect(proposal.status).to.deep.equal({ executed: {} });

    const configAfter = await (program as any).account.bridgeConfig.fetch(configPda);
    expect(configAfter.nonce.toNumber()).to.equal(nonce + 1);
  });

  it("Replay unlock fails", async () => {
    const multisig = await (program as any).account.multisig.fetch(multisigPda);
    const proposalIndex = multisig.proposalCount.toNumber() - 1;

    const proposalPda = PublicKey.findProgramAddressSync(
      [
        Buffer.from("proposal"),
        new anchor.BN(proposalIndex).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];

    const txPda = PublicKey.findProgramAddressSync(
      [
        Buffer.from("tx"),
        user.publicKey.toBuffer(),
        new anchor.BN(999).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];

    try {
      await program.methods
        .unlockBbt("ethereum", "0xabc123", new anchor.BN(100_000_000))
        .accounts({
          relayer: relayer.publicKey,
          config: configPda,
          multisig: multisigPda,
          proposal: proposalPda,
          crossChainTx: txPda,
          user: user.publicKey,
          userTokenAccount: userTokenAccount,
          vaultTokenAccount: vaultPda,
          platformTokenAccount: platformTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([relayer])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.toString()).to.include("AlreadyExecuted");
    }
  });

  it("Pauses and unpauses bridge", async () => {
    await program.methods
      .pauseBridge()
      .accounts({
        authority: authority.publicKey,
        config: configPda,
      })
      .signers([authority])
      .rpc();

    let config = await (program as any).account.bridgeConfig.fetch(configPda);
    expect(config.paused).to.be.true;

    await program.methods
      .unpauseBridge()
      .accounts({
        authority: authority.publicKey,
        config: configPda,
      })
      .signers([authority])
      .rpc();

    config = await (program as any).account.bridgeConfig.fetch(configPda);
    expect(config.paused).to.be.false;
  });
});
