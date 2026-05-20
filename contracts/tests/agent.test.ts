import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AgentRegistry } from "../target/types/agent_registry";
import {
    PublicKey,
    Keypair,
    SystemProgram,
    LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { expect } from "chai";

describe("Agent Registry", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.AgentRegistry as Program<AgentRegistry>;

    const agentOwner = Keypair.generate();
    const admin = provider.wallet;

    before(async () => {
        // Airdrop SOL to test account
        const airdrop = await provider.connection.requestAirdrop(
            agentOwner.publicKey,
            2 * LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(airdrop);
    });

    it("Registers an agent", async () => {
        const name = "Test Agent";
        const description = "A test agent for testing";
        const endpoint = "https://api.test-agent.com";
        const capabilities = ["trading", "analysis", "alerts"];

        const [agentPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("agent"), agentOwner.publicKey.toBuffer()],
            program.programId
        );

        await program.methods
            .registerAgent(name, description, endpoint, capabilities)
            .accounts({
                owner: agentOwner.publicKey,
                agent: agentPda,
                systemProgram: SystemProgram.programId,
            })
            .signers([agentOwner])
            .rpc();

        const agent = await program.account.agent.fetch(agentPda);
        expect(agent.owner.toBase58()).to.equal(agentOwner.publicKey.toBase58());
        expect(agent.name).to.equal(name);
        expect(agent.description).to.equal(description);
        expect(agent.endpoint).to.equal(endpoint);
        expect(agent.capabilities).to.deep.equal(capabilities);
        expect(agent.status).to.deep.equal({ active: {} });
        expect(agent.reputationScore.toNumber()).to.equal(0);
    });

    it("Updates agent information", async () => {
        const newEndpoint = "https://api.updated-agent.com";

        const [agentPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("agent"), agentOwner.publicKey.toBuffer()],
            program.programId
        );

        await program.methods
            .updateAgent(null, null, newEndpoint, null)
            .accounts({
                owner: agentOwner.publicKey,
                agent: agentPda,
            })
            .signers([agentOwner])
            .rpc();

        const agent = await program.account.agent.fetch(agentPda);
        expect(agent.endpoint).to.equal(newEndpoint);
    });

    it("Submits task result", async () => {
        const [agentPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("agent"), agentOwner.publicKey.toBuffer()],
            program.programId
        );

        // Submit successful task
        await program.methods
            .submitTaskResult(true)
            .accounts({
                owner: agentOwner.publicKey,
                agent: agentPda,
            })
            .signers([agentOwner])
            .rpc();

        const agent = await program.account.agent.fetch(agentPda);
        expect(agent.totalTasks.toNumber()).to.equal(1);
        expect(agent.successfulTasks.toNumber()).to.equal(1);
        expect(agent.reputationScore.toNumber()).to.equal(100);
    });

    it("Updates agent status", async () => {
        const [agentPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("agent"), agentOwner.publicKey.toBuffer()],
            program.programId
        );

        await program.methods
            .updateStatus({ paused: {} })
            .accounts({
                owner: agentOwner.publicKey,
                admin: agentOwner.publicKey, // owner is also admin in this test
                agent: agentPda,
            })
            .signers([agentOwner])
            .rpc();

        const agent = await program.account.agent.fetch(agentPda);
        expect(agent.status).to.deep.equal({ paused: {} });
    });
});
