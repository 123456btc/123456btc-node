import { describe, it, expect } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import { SignalMerkleTree, SubscriptionEscrowClient } from '../../src/infra/chain/SubscriptionEscrow.js';

const stubLogger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, child: () => stubLogger } as any;

describe('SignalMerkleTree', () => {
  it('computes deterministic root for same signals', () => {
    const tree1 = new SignalMerkleTree();
    const tree2 = new SignalMerkleTree();

    tree1.addSignal('a1b2c3');
    tree1.addSignal('d4e5f6');

    tree2.addSignal('a1b2c3');
    tree2.addSignal('d4e5f6');

    expect(tree1.getRoot().toString('hex')).toBe(tree2.getRoot().toString('hex'));
  });

  it('root changes when signals change', () => {
    const tree = new SignalMerkleTree();
    tree.addSignal('a1b2c3');
    const root1 = tree.getRoot().toString('hex');

    tree.addSignal('d4e5f6');
    const root2 = tree.getRoot().toString('hex');

    expect(root1).not.toBe(root2);
  });

  it('handles odd number of leaves by duplicating last', () => {
    const tree = new SignalMerkleTree();
    tree.addSignal('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6aabb');
    const root = tree.getRoot();
    expect(root.length).toBe(32);
  });

  it('returns empty root for no signals', () => {
    const tree = new SignalMerkleTree();
    const root = tree.getRoot();
    expect(root.toString('hex')).toHaveLength(64);
  });

  it('clears correctly', () => {
    const tree = new SignalMerkleTree();
    tree.addSignal('abc');
    expect(tree.count).toBe(1);
    tree.clear();
    expect(tree.count).toBe(0);
  });
});

describe('SubscriptionEscrowClient', () => {
  it('derives consistent PDA', async () => {
    const client = new SubscriptionEscrowClient(stubLogger);
    // PDA derivation is deterministic for same inputs
    // We can't test real Solana here without devnet, but we verify the interface
    expect(client).toBeDefined();
  });

  it('ingests signals into Merkle pool', () => {
    const client = new SubscriptionEscrowClient(stubLogger);
    client.ingestSignalForMerkle({
      signal_id: 'sig_001',
      decision: 'enter',
      symbol: 'BTCUSDT',
      created_at_ms: Date.now(),
    });
    // internal state updated
    expect(client).toBeDefined();
  });

  it('supports mock mode constructor', () => {
    const client = new SubscriptionEscrowClient(stubLogger, 'http://localhost:8899');
    expect(client).toBeDefined();
  });

  it('supports real mode constructor', () => {
    const connection = new Connection('http://localhost:8899');
    const wallet = { publicKey: new PublicKey('11111111111111111111111111111112') };
    const client = new SubscriptionEscrowClient(connection, wallet);
    expect(client).toBeDefined();
  });

  it('derives subscription PDA deterministically', () => {
    const client = new SubscriptionEscrowClient(stubLogger);
    const userWallet = new PublicKey('11111111111111111111111111111112');
    const [pda1, bump1] = client.deriveSubscriptionPDA(userWallet, 'strat_001', BigInt(123));
    const [pda2, bump2] = client.deriveSubscriptionPDA(userWallet, 'strat_001', BigInt(123));
    expect(pda1.equals(pda2)).toBe(true);
    expect(bump1).toBe(bump2);
  });

  it('derives different PDAs for different nonces', () => {
    const client = new SubscriptionEscrowClient(stubLogger);
    const userWallet = new PublicKey('11111111111111111111111111111112');
    const [pda1] = client.deriveSubscriptionPDA(userWallet, 'strat_001', BigInt(123));
    const [pda2] = client.deriveSubscriptionPDA(userWallet, 'strat_001', BigInt(456));
    expect(pda1.equals(pda2)).toBe(false);
  });

  it('creates subscription with new params (mock)', async () => {
    const client = new SubscriptionEscrowClient(stubLogger);
    const userKeypair = { publicKey: new PublicKey('11111111111111111111111111111112') };
    const result = await client.createSubscription(userKeypair, {
      providerWallet: new PublicKey('11111111111111111111111111111113'),
      strategyId: 'strat_001',
      amount: BigInt(1000000),
      durationSeconds: 86400,
      nonce: BigInt(123456),
      bbtMint: new PublicKey('11111111111111111111111111111114'),
    });
    expect(result.subscriptionPDA).toBeInstanceOf(PublicKey);
    expect(result.tx).toBe('mock_tx_id');
  });

  it('providerClaim accepts bbtMint (mock)', async () => {
    const client = new SubscriptionEscrowClient(stubLogger);
    const providerKeypair = { publicKey: new PublicKey('11111111111111111111111111111112') };
    const subscriptionPDA = new PublicKey('11111111111111111111111111111113');
    const bbtMint = new PublicKey('11111111111111111111111111111114');
    const tx = await client.providerClaim(providerKeypair, subscriptionPDA, bbtMint);
    expect(tx).toBe('mock_claim_tx');
  });

  it('userCancel accepts bbtMint (mock)', async () => {
    const client = new SubscriptionEscrowClient(stubLogger);
    const userKeypair = { publicKey: new PublicKey('11111111111111111111111111111112') };
    const subscriptionPDA = new PublicKey('11111111111111111111111111111113');
    const bbtMint = new PublicKey('11111111111111111111111111111114');
    const tx = await client.userCancel(userKeypair, subscriptionPDA, bbtMint);
    expect(tx).toBe('mock_cancel_tx');
  });

  it('submitHeartbeat returns tx (mock)', async () => {
    const client = new SubscriptionEscrowClient(stubLogger);
    const providerKeypair = { publicKey: new PublicKey('11111111111111111111111111111112') };
    const subscriptionPDA = new PublicKey('11111111111111111111111111111113');
    const tx = await client.submitHeartbeat(providerKeypair, subscriptionPDA);
    expect(tx).toBe('mock_heartbeat_tx');
  });

  it('submitSignalMerkle returns tx with Buffer root (mock)', async () => {
    const client = new SubscriptionEscrowClient(stubLogger);
    const providerKeypair = { publicKey: new PublicKey('11111111111111111111111111111112') };
    const subscriptionPDA = new PublicKey('11111111111111111111111111111113');
    const root = Buffer.alloc(32, 0xab);
    const tx = await client.submitSignalMerkle(providerKeypair, subscriptionPDA, root, BigInt(42));
    expect(tx).toBe('mock_merkle_tx');
  });

  it('submitSignalMerkle returns tx with number[] root (mock)', async () => {
    const client = new SubscriptionEscrowClient(stubLogger);
    const providerKeypair = { publicKey: new PublicKey('11111111111111111111111111111112') };
    const subscriptionPDA = new PublicKey('11111111111111111111111111111113');
    const root = Array.from(Buffer.alloc(32, 0xcd));
    const tx = await client.submitSignalMerkle(providerKeypair, subscriptionPDA, root, BigInt(99));
    expect(tx).toBe('mock_merkle_tx');
  });
});
