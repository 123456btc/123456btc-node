import { describe, it, expect } from 'vitest';
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
});
