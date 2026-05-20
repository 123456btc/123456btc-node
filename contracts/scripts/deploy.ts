import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint, createAccount, mintTo } from "@solana/spl-token";

// Program IDs (will be updated after deployment)
const BLINDBOX_PROGRAM_ID = new PublicKey("BBox11111111111111111111111111111111111111111");
const AGENT_REGISTRY_PROGRAM_ID = new PublicKey("Agent11111111111111111111111111111111111111111");

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    console.log("=== 123456btc Contract Deployment ===");
    console.log("Cluster:", provider.connection.rpcEndpoint);
    console.log("Wallet:", provider.wallet.publicKey.toBase58());

    // Load programs
    const blindboxProgram = anchor.workspace.BlindboxEscrow;
    const agentRegistryProgram = anchor.workspace.AgentRegistry;

    console.log("\n=== Programs Loaded ===");
    console.log("BlindBox Escrow:", blindboxProgram.programId.toBase58());
    console.log("Agent Registry:", agentRegistryProgram.programId.toBase58());

    // Create BBT token mint (for testing)
    console.log("\n=== Creating BBT Token ===");
    const mint = await createMint(
        provider.connection,
        provider.wallet.payer,
        provider.wallet.publicKey,
        null,
        9 // decimals
    );
    console.log("BBT Mint:", mint.toBase58());

    // Create token accounts
    const userTokenAccount = await createAccount(
        provider.connection,
        provider.wallet.payer,
        mint,
        provider.wallet.publicKey
    );
    console.log("User Token Account:", userTokenAccount.toBase58());

    // Mint some BBT for testing
    await mintTo(
        provider.connection,
        provider.wallet.payer,
        mint,
        userTokenAccount,
        provider.wallet.publicKey,
        1000000000000 // 1000 BBT
    );
    console.log("Minted 1000 BBT to user");

    console.log("\n=== Deployment Complete ===");
    console.log("Save these addresses:");
    console.log("  BBT Mint:", mint.toBase58());
    console.log("  BlindBox Program:", blindboxProgram.programId.toBase58());
    console.log("  Agent Registry Program:", agentRegistryProgram.programId.toBase58());
}

main().catch(console.error);
