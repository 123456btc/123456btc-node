import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SubscriptionEscrow } from "../target/types/subscription_escrow";
import {
  Keypair,
  PublicKey,
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

describe("subscription_escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SubscriptionEscrow as any;

  let mint: PublicKey;
  let user: Keypair;
  let providerWallet: Keypair;
  let arbitrator: Keypair;
  let platform: Keypair;

  let userATA: PublicKey;
  let providerATA: PublicKey;
  let platformATA: PublicKey;
  let vaultAuthority: PublicKey;
  let vaultATA: PublicKey;

  before(async () => {
    user = Keypair.generate();
    providerWallet = Keypair.generate();
    arbitrator = Keypair.generate();
    platform = Keypair.generate();

    for (const kp of [user, providerWallet, arbitrator, platform]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    mint = await createMint(
      provider.connection,
      user,
      user.publicKey,
      null,
      9
    );

    userATA = await createAssociatedTokenAccount(
      provider.connection,
      user,
      mint,
      user.publicKey
    );
    providerATA = await createAssociatedTokenAccount(
      provider.connection,
      providerWallet,
      mint,
      providerWallet.publicKey
    );
    platformATA = await createAssociatedTokenAccount(
      provider.connection,
      platform,
      mint,
      platform.publicKey
    );

    [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority")],
      program.programId
    );
    vaultATA = getAssociatedTokenAddressSync(mint, vaultAuthority, true);

    await mintTo(
      provider.connection,
      user,
      mint,
      userATA,
      user.publicKey,
      1_000_000_000_000 // 1000 BBT
    );
  });

  const createSubscription = async (
    strategyId: string,
    amount: anchor.BN,
    duration: number,
    nonce: number
  ) => {
    const [subscriptionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("subscription"),
        user.publicKey.toBuffer(),
        Buffer.from(strategyId),
        new anchor.BN(nonce).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    await program.methods
      .createSubscription(strategyId, amount, new anchor.BN(duration), new anchor.BN(nonce))
      .accounts({
        user: user.publicKey,
        provider: providerWallet.publicKey,
        subscription: subscriptionPda,
        userTokenAccount: userATA,
        vaultTokenAccount: vaultATA,
        vaultAuthority: vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        strategyIdInfo: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    return subscriptionPda;
  };

  it("Creates a subscription", async () => {
    const amount = new anchor.BN(1_000_000_000); // 1 BBT
    const subscriptionPda = await createSubscription("strategy_1", amount, 10, 0);

    const sub = await (program as any).account.subscription.fetch(subscriptionPda);
    expect(sub.user.toBase58()).to.equal(user.publicKey.toBase58());
    expect(sub.provider.toBase58()).to.equal(providerWallet.publicKey.toBase58());
    expect(sub.strategyId).to.equal("strategy_1");
    expect(sub.amountDeposited.toNumber()).to.equal(amount.toNumber());
    expect(sub.status).to.deep.equal({ active: {} });

    const vaultAccount = await getAccount(provider.connection, vaultATA);
    expect(Number(vaultAccount.amount)).to.equal(amount.toNumber());
  });

  it("Provider claims earned portion", async () => {
    const amount = new anchor.BN(1_000_000_000);
    const subscriptionPda = await createSubscription("strategy_claim", amount, 10, 1);

    await new Promise((r) => setTimeout(r, 3000));

    const providerBefore = Number((await getAccount(provider.connection, providerATA)).amount);
    const platformBefore = Number((await getAccount(provider.connection, platformATA)).amount);

    await program.methods
      .providerClaim()
      .accounts({
        provider: providerWallet.publicKey,
        subscription: subscriptionPda,
        vaultTokenAccount: vaultATA,
        providerTokenAccount: providerATA,
        platformTokenAccount: platformATA,
        vaultAuthority: vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([providerWallet])
      .rpc();

    const providerAfter = Number((await getAccount(provider.connection, providerATA)).amount);
    const platformAfter = Number((await getAccount(provider.connection, platformATA)).amount);

    expect(providerAfter).to.be.greaterThan(providerBefore);
    expect(platformAfter).to.be.greaterThan(platformBefore);

    const sub = await (program as any).account.subscription.fetch(subscriptionPda);
    expect(sub.amountClaimed.toNumber()).to.be.greaterThan(0);
  });

  it("User cancels and gets refund", async () => {
    const amount = new anchor.BN(1_000_000_000);
    const subscriptionPda = await createSubscription("strategy_cancel", amount, 10, 2);

    await new Promise((r) => setTimeout(r, 2000));

    const userBefore = Number((await getAccount(provider.connection, userATA)).amount);
    const providerBefore = Number((await getAccount(provider.connection, providerATA)).amount);

    await program.methods
      .userCancel()
      .accounts({
        user: user.publicKey,
        subscription: subscriptionPda,
        vaultTokenAccount: vaultATA,
        userTokenAccount: userATA,
        providerTokenAccount: providerATA,
        vaultAuthority: vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const userAfter = Number((await getAccount(provider.connection, userATA)).amount);
    const providerAfter = Number((await getAccount(provider.connection, providerATA)).amount);

    expect(userAfter).to.be.greaterThan(userBefore);
    expect(providerAfter).to.be.greaterThanOrEqual(providerBefore);

    const sub = await (program as any).account.subscription.fetch(subscriptionPda);
    expect(sub.status).to.deep.equal({ cancelled: {} });
  });

  it("Heartbeat and merkle submission", async () => {
    const amount = new anchor.BN(1_000_000_000);
    const subscriptionPda = await createSubscription("strategy_hb", amount, 10, 3);

    await program.methods
      .submitHeartbeat()
      .accounts({
        provider: providerWallet.publicKey,
        subscription: subscriptionPda,
      })
      .signers([providerWallet])
      .rpc();

    let sub = await (program as any).account.subscription.fetch(subscriptionPda);
    expect(sub.lastHeartbeat.toNumber()).to.be.greaterThan(0);

    const merkleRoot = Array.from(Buffer.alloc(32, 1));
    await program.methods
      .submitSignalMerkle(merkleRoot as any, new anchor.BN(1))
      .accounts({
        provider: providerWallet.publicKey,
        subscription: subscriptionPda,
      })
      .signers([providerWallet])
      .rpc();

    sub = await (program as any).account.subscription.fetch(subscriptionPda);
    expect(sub.signalSequence.toNumber()).to.equal(1);
    expect(Buffer.from(sub.merkleRoot).equals(Buffer.alloc(32, 1))).to.be.true;
  });

  it("Dispute and resolution", async () => {
    const amount = new anchor.BN(1_000_000_000);
    const subscriptionPda = await createSubscription("strategy_dispute", amount, 10, 4);

    await program.methods
      .initiateDispute("Service not delivered")
      .accounts({
        user: user.publicKey,
        subscription: subscriptionPda,
      })
      .signers([user])
      .rpc();

    let sub = await (program as any).account.subscription.fetch(subscriptionPda);
    expect(sub.status).to.deep.equal({ disputed: {} });

    const userBefore = Number((await getAccount(provider.connection, userATA)).amount);

    await program.methods
      .resolveDispute(5000) // 50% refund
      .accounts({
        arbitrator: arbitrator.publicKey,
        subscription: subscriptionPda,
        vaultTokenAccount: vaultATA,
        userTokenAccount: userATA,
        providerTokenAccount: providerATA,
        vaultAuthority: vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([arbitrator])
      .rpc();

    const userAfter = Number((await getAccount(provider.connection, userATA)).amount);
    expect(userAfter).to.be.greaterThan(userBefore);

    sub = await (program as any).account.subscription.fetch(subscriptionPda);
    expect(sub.status).to.deep.equal({ settled: {} });
  });

  it("Auto settle after expiry", async () => {
    const amount = new anchor.BN(1_000_000_000);
    const subscriptionPda = await createSubscription("strategy_settle", amount, 2, 5);

    await new Promise((r) => setTimeout(r, 3000));

    const providerBefore = Number((await getAccount(provider.connection, providerATA)).amount);

    await program.methods
      .autoSettle()
      .accounts({
        caller: providerWallet.publicKey,
        subscription: subscriptionPda,
        vaultTokenAccount: vaultATA,
        providerTokenAccount: providerATA,
        platformTokenAccount: platformATA,
        vaultAuthority: vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([providerWallet])
      .rpc();

    const providerAfter = Number((await getAccount(provider.connection, providerATA)).amount);
    expect(providerAfter).to.be.greaterThan(providerBefore);

    const sub = await (program as any).account.subscription.fetch(subscriptionPda);
    expect(sub.status).to.deep.equal({ settled: {} });
  });
});
