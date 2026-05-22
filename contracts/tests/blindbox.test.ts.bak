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
    createAccount,
    mintTo,
    getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("BlindBox Escrow", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.BlindboxEscrow as Program<BlindboxEscrow>;

    let mint: PublicKey;
    let creatorTokenAccount: PublicKey;
    let buyerTokenAccount: PublicKey;
    let vaultTokenAccount: PublicKey;
    let platformTokenAccount: PublicKey;

    const creator = Keypair.generate();
    const buyer = Keypair.generate();
    const platform = provider.wallet;

    before(async () => {
        // Airdrop SOL to test accounts
        const airdropCreator = await provider.connection.requestAirdrop(
            creator.publicKey,
            2 * LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(airdropCreator);

        const airdropBuyer = await provider.connection.requestAirdrop(
            buyer.publicKey,
            2 * LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(airdropBuyer);

        // Create BBT token mint
        mint = await createMint(
            provider.connection,
            creator,
            creator.publicKey,
            null,
            9
        );

        // Create token accounts
        creatorTokenAccount = await createAccount(
            provider.connection,
            creator,
            mint,
            creator.publicKey
        );

        buyerTokenAccount = await createAccount(
            provider.connection,
            buyer,
            mint,
            buyer.publicKey
        );

        vaultTokenAccount = await createAccount(
            provider.connection,
            creator,
            mint,
            creator.publicKey
        );

        platformTokenAccount = await createAccount(
            provider.connection,
            platform.payer,
            mint,
            platform.publicKey
        );

        // Mint BBT to creator and buyer
        await mintTo(
            provider.connection,
            creator,
            mint,
            creatorTokenAccount,
            creator.publicKey,
            100000000000 // 100 BBT
        );

        await mintTo(
            provider.connection,
            creator,
            mint,
            buyerTokenAccount,
            creator.publicKey,
            100000000000 // 100 BBT
        );
    });

    it("Creates a blindbox", async () => {
        const name = "Test BlindBox";
        const description = "A test blind box for testing";
        const amount = new anchor.BN(1000000000); // 1 BBT
        const rarity = { common: {} };

        const [blindboxPda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("blindbox"),
                creator.publicKey.toBuffer(),
                Buffer.from(name),
            ],
            program.programId
        );

        await program.methods
            .createBlindbox(name, description, amount, rarity)
            .accounts({
                creator: creator.publicKey,
                blindbox: blindboxPda,
                creatorTokenAccount: creatorTokenAccount,
                vaultTokenAccount: vaultTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([creator])
            .rpc();

        const blindbox = await program.account.blindbox.fetch(blindboxPda);
        expect(blindbox.creator.toBase58()).to.equal(creator.publicKey.toBase58());
        expect(blindbox.name).to.equal(name);
        expect(blindbox.amount.toNumber()).to.equal(amount.toNumber());
        expect(blindbox.status).to.deep.equal({ locked: {} });
    });

    it("Purchases a blindbox", async () => {
        const name = "Test BlindBox";

        const [blindboxPda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("blindbox"),
                creator.publicKey.toBuffer(),
                Buffer.from(name),
            ],
            program.programId
        );

        await program.methods
            .purchaseBlindbox()
            .accounts({
                buyer: buyer.publicKey,
                blindbox: blindboxPda,
            })
            .signers([buyer])
            .rpc();

        const blindbox = await program.account.blindbox.fetch(blindboxPda);
        expect(blindbox.buyer.toBase58()).to.equal(buyer.publicKey.toBase58());
        expect(blindbox.status).to.deep.equal({ purchased: {} });
    });

    it("Reveals a blindbox", async () => {
        const name = "Test BlindBox";

        const [blindboxPda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("blindbox"),
                creator.publicKey.toBuffer(),
                Buffer.from(name),
            ],
            program.programId
        );

        await program.methods
            .revealBlindbox()
            .accounts({
                buyer: buyer.publicKey,
                blindbox: blindboxPda,
                vaultTokenAccount: vaultTokenAccount,
                creatorTokenAccount: creatorTokenAccount,
                platformTokenAccount: platformTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([buyer])
            .rpc();

        const blindbox = await program.account.blindbox.fetch(blindboxPda);
        expect(blindbox.status).to.deep.equal({ revealed: {} });
        expect(blindbox.revealedAt.toNumber()).to.be.greaterThan(0);
    });
});
