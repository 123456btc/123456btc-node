import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BlindboxEscrow } from "../target/types/blindbox_escrow";
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

describe("blindbox_escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.BlindboxEscrow as any;

  let mint: PublicKey;
  let creatorTokenAccount: PublicKey;
  let buyerTokenAccount: PublicKey;
  let platformTokenAccount: PublicKey;

  const creator = Keypair.generate();
  const buyer = Keypair.generate();
  const platform = Keypair.generate();

  before(async () => {
    for (const kp of [creator, buyer, platform]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    mint = await createMint(
      provider.connection,
      creator,
      creator.publicKey,
      null,
      9
    );

    creatorTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      creator,
      mint,
      creator.publicKey
    );

    buyerTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      buyer,
      mint,
      buyer.publicKey
    );

    platformTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      platform,
      mint,
      platform.publicKey
    );

    await mintTo(
      provider.connection,
      creator,
      mint,
      creatorTokenAccount,
      creator.publicKey,
      1_000_000_000_000 // 1000 BBT
    );

    await mintTo(
      provider.connection,
      creator,
      mint,
      buyerTokenAccount,
      creator.publicKey,
      1_000_000_000_000 // 1000 BBT
    );
  });

  const getBlindboxPda = (name: string) => {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("blindbox"),
        creator.publicKey.toBuffer(),
        Buffer.from(name),
      ],
      program.programId
    )[0];
  };

  const getVaultPda = () => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("blindbox_vault"), creator.publicKey.toBuffer()],
      program.programId
    )[0];
  };

  it("Creates a blindbox", async () => {
    const name = "Test BlindBox";
    const description = "A test blind box for testing";
    const amount = new anchor.BN(1_000_000_000); // 1 BBT
    const rarity = { common: {} };

    const blindboxPda = getBlindboxPda(name);
    const vaultPda = getVaultPda();

    await program.methods
      .createBlindbox(name, description, amount, rarity)
      .accounts({
        creator: creator.publicKey,
        blindbox: blindboxPda,
        creatorTokenAccount: creatorTokenAccount,
        vaultTokenAccount: vaultPda,
        bbtMint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    const blindbox = await (program as any).account.blindBox.fetch(blindboxPda);
    expect(blindbox.creator.toBase58()).to.equal(creator.publicKey.toBase58());
    expect(blindbox.name).to.equal(name);
    expect(blindbox.amount.toNumber()).to.equal(amount.toNumber());
    expect(blindbox.status).to.deep.equal({ locked: {} });

    const vaultAccount = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultAccount.amount)).to.equal(amount.toNumber());
  });

  it("Purchases a blindbox", async () => {
    const name = "Test BlindBox";
    const blindboxPda = getBlindboxPda(name);

    await program.methods
      .purchaseBlindbox()
      .accounts({
        buyer: buyer.publicKey,
        blindbox: blindboxPda,
      })
      .signers([buyer])
      .rpc();

    const blindbox = await (program as any).account.blindBox.fetch(blindboxPda);
    expect(blindbox.buyer.toBase58()).to.equal(buyer.publicKey.toBase58());
    expect(blindbox.status).to.deep.equal({ purchased: {} });
  });

  it("Reveals a blindbox", async () => {
    const name = "Test BlindBox";
    const blindboxPda = getBlindboxPda(name);
    const vaultPda = getVaultPda();

    const creatorBefore = Number((await getAccount(provider.connection, creatorTokenAccount)).amount);
    const platformBefore = Number((await getAccount(provider.connection, platformTokenAccount)).amount);

    await program.methods
      .revealBlindbox()
      .accounts({
        buyer: buyer.publicKey,
        blindbox: blindboxPda,
        vaultTokenAccount: vaultPda,
        creatorTokenAccount: creatorTokenAccount,
        platformTokenAccount: platformTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const blindbox = await (program as any).account.blindBox.fetch(blindboxPda);
    expect(blindbox.status).to.deep.equal({ revealed: {} });
    expect(blindbox.revealedAt.toNumber()).to.be.greaterThan(0);

    const creatorAfter = Number((await getAccount(provider.connection, creatorTokenAccount)).amount);
    const platformAfter = Number((await getAccount(provider.connection, platformTokenAccount)).amount);

    expect(creatorAfter).to.be.greaterThan(creatorBefore);
    expect(platformAfter).to.be.greaterThan(platformBefore);
  });

  it("Initiates and resolves a dispute", async () => {
    const name = "Dispute BlindBox";
    const description = "For dispute testing";
    const amount = new anchor.BN(2_000_000_000); // 2 BBT
    const rarity = { rare: {} };

    const blindboxPda = getBlindboxPda(name);
    const vaultPda = getVaultPda();

    await program.methods
      .createBlindbox(name, description, amount, rarity)
      .accounts({
        creator: creator.publicKey,
        blindbox: blindboxPda,
        creatorTokenAccount: creatorTokenAccount,
        vaultTokenAccount: vaultPda,
        bbtMint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    await program.methods
      .purchaseBlindbox()
      .accounts({
        buyer: buyer.publicKey,
        blindbox: blindboxPda,
      })
      .signers([buyer])
      .rpc();

    await program.methods
      .initiateDispute("Item not as described")
      .accounts({
        buyer: buyer.publicKey,
        blindbox: blindboxPda,
      })
      .signers([buyer])
      .rpc();

    let blindbox = await (program as any).account.blindBox.fetch(blindboxPda);
    expect(blindbox.status).to.deep.equal({ disputed: {} });
    expect(blindbox.disputeReason).to.equal("Item not as described");

    const arbitrator = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      arbitrator.publicKey,
      LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    const buyerBefore = Number((await getAccount(provider.connection, buyerTokenAccount)).amount);
    const creatorBefore = Number((await getAccount(provider.connection, creatorTokenAccount)).amount);

    await program.methods
      .resolveDispute(5000) // 50% refund
      .accounts({
        arbitrator: arbitrator.publicKey,
        blindbox: blindboxPda,
        vaultTokenAccount: vaultPda,
        creatorTokenAccount: creatorTokenAccount,
        buyerTokenAccount: buyerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([arbitrator])
      .rpc();

    const buyerAfter = Number((await getAccount(provider.connection, buyerTokenAccount)).amount);
    const creatorAfter = Number((await getAccount(provider.connection, creatorTokenAccount)).amount);

    expect(buyerAfter).to.be.greaterThan(buyerBefore);
    expect(creatorAfter).to.be.greaterThan(creatorBefore);

    blindbox = await (program as any).account.blindBox.fetch(blindboxPda);
    expect(blindbox.status).to.deep.equal({ settled: {} });
  });
});
