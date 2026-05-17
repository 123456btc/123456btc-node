import { describe, it, expect } from 'vitest';
import { GossipAdapter } from '../../src/infra/network/GossipAdapter.js';

const stubLogger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, child: () => stubLogger } as any;

describe('GossipAdapter (libp2p-gossipsub)', () => {
  it('starts and stops without seeds', async () => {
    const adapter = new GossipAdapter(stubLogger);
    const received: any[] = [];

    await adapter.start(
      {
        nodeId: 'test_node_1',
        providerId: 'prov_test',
        port: 0, // libp2p 使用随机端口
        role: 'relay',
        seeds: [],
      },
      (msg) => received.push(msg),
    );

    const stats = adapter.getStats();
    expect(stats.started).toBe(true);
    expect(stats.nodeId).toBeTruthy();

    await adapter.stop();
    expect(adapter.getStats().started).toBe(false);
  });

  it('broadcasts a signal message', async () => {
    const adapter = new GossipAdapter(stubLogger);

    await adapter.start(
      {
        nodeId: 'test_node_2',
        providerId: 'prov_test',
        port: 0,
        role: 'provider',
        seeds: [],
      },
      () => {},
    );

    const signal = {
      schema: 'ises.strategy_signal.v1',
      signal_id: 'sig_001',
      source: { provider_id: 'prov_test' },
      strategy_id: 'strat_001',
      symbol: 'BTCUSDT',
      decision: 'enter' as const,
      confidence: 0.85,
      created_at_ms: Date.now(),
    };

    const msg = adapter.createSignalMessage(signal, 'test_node_2');
    expect(msg.type).toBe('signal');
    expect(msg.from).toBe('test_node_2');
    expect(msg.seq).toBeGreaterThan(0);

    const ok = adapter.broadcast(msg);
    expect(ok).toBe(true);

    await adapter.stop();
  });

  it('deduplicates seen messages', async () => {
    const adapter = new GossipAdapter(stubLogger);

    await adapter.start(
      {
        nodeId: 'test_node_3',
        providerId: 'prov_test',
        port: 0,
        role: 'subscriber',
        seeds: [],
      },
      () => {},
    );

    const msg = { type: 'heartbeat' as const, from: 'test_node_3', seq: 1, timestamp: Date.now() };

    expect(adapter.broadcast(msg)).toBe(true);
    expect(adapter.broadcast(msg)).toBe(false); // 重复

    const stats = adapter.getStats();
    expect(stats.seenMessages).toBe(1);

    await adapter.stop();
  });
});
