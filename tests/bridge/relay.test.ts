/**
 * 中继器测试
 * 测试跨链中继器的消息验证、转发和状态管理
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock 类型定义 ──

interface RelayMessage {
  id: string;
  sourceChain: 'SOL' | 'ETH' | 'BNB' | 'ARB';
  targetChain: 'SOL' | 'ETH' | 'BNB' | 'ARB';
  type: 'lock' | 'unlock' | 'mint' | 'burn';
  payload: {
    user: string;
    amount: number;
    sourceTxHash: string;
    targetAddress: string;
  };
  signatures: string[];
  requiredSignatures: number;
  status: 'pending' | 'verified' | 'relayed' | 'failed' | 'expired';
  createdAt: number;
  relayedAt?: number;
  expiresAt: number;
}

interface RelayConfig {
  requiredSignatures: number;
  messageExpiryMs: number;
  maxRetries: number;
  relayCooldownMs: number;
  trustedValidators: string[];
}

// ── Mock RelayService 实现 ──

class MockRelayService {
  private config: RelayConfig;
  private messages: Map<string, RelayMessage> = new Map();
  private processedHashes: Set<string> = new Set();
  private nonce: number = 0;
  private relayTimestamps: Map<string, number> = new Map(); // user -> last relay time

  constructor(config: RelayConfig) {
    this.config = { ...config };
  }

  // 接收源链消息
  receiveMessage(
    sourceChain: RelayMessage['sourceChain'],
    targetChain: RelayMessage['targetChain'],
    type: RelayMessage['type'],
    payload: RelayMessage['payload'],
  ): RelayMessage {
    // 防重放：检查 sourceTxHash
    if (this.processedHashes.has(payload.sourceTxHash)) {
      throw new Error('Duplicate transaction: already processed');
    }

    const id = `relay_${++this.nonce}_${Date.now()}`;
    const message: RelayMessage = {
      id,
      sourceChain,
      targetChain,
      type,
      payload,
      signatures: [],
      requiredSignatures: this.config.requiredSignatures,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.messageExpiryMs,
    };
    this.messages.set(id, message);
    // 在接收时即标记 sourceTxHash 为已处理，防止同一交易被重复提交
    this.processedHashes.add(payload.sourceTxHash);
    return message;
  }

  // 验证者签名
  addSignature(messageId: string, validator: string, signature: string): RelayMessage {
    const message = this.messages.get(messageId);
    if (!message) {
      throw new Error('Message not found');
    }
    if (message.status !== 'pending') {
      throw new Error(`Message already ${message.status}`);
    }
    if (Date.now() > message.expiresAt) {
      message.status = 'expired';
      throw new Error('Message expired');
    }
    if (!this.config.trustedValidators.includes(validator)) {
      throw new Error(`Untrusted validator: ${validator}`);
    }
    if (message.signatures.includes(signature)) {
      throw new Error('Duplicate signature');
    }

    message.signatures.push(signature);

    // 达到签名数自动验证
    if (message.signatures.length >= message.requiredSignatures) {
      message.status = 'verified';
    }

    return message;
  }

  // 中继消息到目标链
  relay(messageId: string): RelayMessage {
    const message = this.messages.get(messageId);
    if (!message) {
      throw new Error('Message not found');
    }
    if (message.status !== 'verified') {
      throw new Error(`Cannot relay: status is ${message.status}, need verified`);
    }
    if (Date.now() > message.expiresAt) {
      message.status = 'expired';
      throw new Error('Message expired');
    }

    // 检查冷却时间
    const user = message.payload.user;
    const lastRelay = this.relayTimestamps.get(user) || 0;
    if (Date.now() - lastRelay < this.config.relayCooldownMs) {
      throw new Error('Relay cooldown: too many requests');
    }

    // 标记为已中继
    message.status = 'relayed';
    message.relayedAt = Date.now();
    this.processedHashes.add(message.payload.sourceTxHash);
    this.relayTimestamps.set(user, Date.now());

    return message;
  }

  // 查询方法
  getMessage(id: string): RelayMessage | undefined {
    return this.messages.get(id);
  }

  getPendingMessages(): RelayMessage[] {
    return Array.from(this.messages.values()).filter((m) => m.status === 'pending');
  }

  getVerifiedMessages(): RelayMessage[] {
    return Array.from(this.messages.values()).filter((m) => m.status === 'verified');
  }

  getRelayedMessages(): RelayMessage[] {
    return Array.from(this.messages.values()).filter((m) => m.status === 'relayed');
  }

  isProcessed(sourceTxHash: string): boolean {
    return this.processedHashes.has(sourceTxHash);
  }

  getStats(): { pending: number; verified: number; relayed: number; failed: number; expired: number } {
    const all = Array.from(this.messages.values());
    return {
      pending: all.filter((m) => m.status === 'pending').length,
      verified: all.filter((m) => m.status === 'verified').length,
      relayed: all.filter((m) => m.status === 'relayed').length,
      failed: all.filter((m) => m.status === 'failed').length,
      expired: all.filter((m) => m.status === 'expired').length,
    };
  }
}

// ── 测试 ──

describe('Relay Service', () => {
  let relay: MockRelayService;
  const defaultConfig: RelayConfig = {
    requiredSignatures: 3,
    messageExpiryMs: 600_000, // 10 分钟
    maxRetries: 3,
    relayCooldownMs: 1000, // 1 秒冷却
    trustedValidators: ['validator_1', 'validator_2', 'validator_3', 'validator_4', 'validator_5'],
  };

  beforeEach(() => {
    relay = new MockRelayService(defaultConfig);
  });

  // ── 消息接收 ──

  describe('receiveMessage', () => {
    it('成功接收跨链消息', () => {
      const msg = relay.receiveMessage('SOL', 'ETH', 'lock', {
        user: 'user_001',
        amount: 1000,
        sourceTxHash: 'solana_tx_001',
        targetAddress: '0x1234567890abcdef',
      });

      expect(msg).toBeDefined();
      expect(msg.id).toContain('relay_');
      expect(msg.sourceChain).toBe('SOL');
      expect(msg.targetChain).toBe('ETH');
      expect(msg.type).toBe('lock');
      expect(msg.status).toBe('pending');
      expect(msg.signatures).toHaveLength(0);
      expect(msg.expiresAt).toBeGreaterThan(Date.now());
    });

    it('重复交易抛异常', () => {
      relay.receiveMessage('SOL', 'ETH', 'lock', {
        user: 'user_001',
        amount: 1000,
        sourceTxHash: 'same_tx_hash',
        targetAddress: '0x1234567890abcdef',
      });

      expect(() =>
        relay.receiveMessage('SOL', 'ETH', 'lock', {
          user: 'user_002',
          amount: 2000,
          sourceTxHash: 'same_tx_hash',
          targetAddress: '0xabcdef1234567890',
        }),
      ).toThrow('Duplicate transaction');
    });

    it('不同 sourceTxHash 可以接收', () => {
      relay.receiveMessage('SOL', 'ETH', 'lock', {
        user: 'user_001',
        amount: 1000,
        sourceTxHash: 'tx_001',
        targetAddress: '0x1111',
      });

      expect(() =>
        relay.receiveMessage('SOL', 'ETH', 'lock', {
          user: 'user_001',
          amount: 1000,
          sourceTxHash: 'tx_002',
          targetAddress: '0x2222',
        }),
      ).not.toThrow();
    });
  });

  // ── 签名验证 ──

  describe('addSignature', () => {
    let messageId: string;

    beforeEach(() => {
      const msg = relay.receiveMessage('SOL', 'ETH', 'lock', {
        user: 'user_001',
        amount: 1000,
        sourceTxHash: 'tx_sig_test',
        targetAddress: '0x1234',
      });
      messageId = msg.id;
    });

    it('受信验证者可签名', () => {
      const msg = relay.addSignature(messageId, 'validator_1', 'sig_v1');

      expect(msg.signatures).toContain('sig_v1');
      expect(msg.status).toBe('pending'); // 还需要更多签名
    });

    it('收集足够签名后状态变为 verified', () => {
      relay.addSignature(messageId, 'validator_1', 'sig_v1');
      relay.addSignature(messageId, 'validator_2', 'sig_v2');
      const msg = relay.addSignature(messageId, 'validator_3', 'sig_v3');

      expect(msg.status).toBe('verified');
      expect(msg.signatures).toHaveLength(3);
    });

    it('不受信验证者签名抛异常', () => {
      expect(() =>
        relay.addSignature(messageId, 'unknown_validator', 'sig_unknown'),
      ).toThrow('Untrusted validator');
    });

    it('重复签名抛异常', () => {
      relay.addSignature(messageId, 'validator_1', 'sig_v1');

      expect(() =>
        relay.addSignature(messageId, 'validator_1', 'sig_v1'),
      ).toThrow('Duplicate signature');
    });

    it('不存在的消息抛异常', () => {
      expect(() =>
        relay.addSignature('nonexistent', 'validator_1', 'sig'),
      ).toThrow('Message not found');
    });

    it('已中继的消息不能签名', () => {
      relay.addSignature(messageId, 'validator_1', 'sig_v1');
      relay.addSignature(messageId, 'validator_2', 'sig_v2');
      relay.addSignature(messageId, 'validator_3', 'sig_v3');
      relay.relay(messageId);

      expect(() =>
        relay.addSignature(messageId, 'validator_4', 'sig_v4'),
      ).toThrow('Message already relayed');
    });
  });

  // ── 消息中继 ──

  describe('relay', () => {
    let messageId: string;

    beforeEach(() => {
      const msg = relay.receiveMessage('SOL', 'ETH', 'lock', {
        user: 'user_001',
        amount: 1000,
        sourceTxHash: 'tx_relay_test',
        targetAddress: '0x1234',
      });
      messageId = msg.id;

      // 收集足够签名
      relay.addSignature(messageId, 'validator_1', 'sig_v1');
      relay.addSignature(messageId, 'validator_2', 'sig_v2');
      relay.addSignature(messageId, 'validator_3', 'sig_v3');
    });

    it('verified 消息可成功中继', () => {
      const msg = relay.relay(messageId);

      expect(msg.status).toBe('relayed');
      expect(msg.relayedAt).toBeDefined();
      expect(msg.relayedAt!).toBeGreaterThan(0);
    });

    it('中继后 sourceTxHash 被标记为已处理', () => {
      relay.relay(messageId);
      expect(relay.isProcessed('tx_relay_test')).toBe(true);
    });

    it('pending 状态不能中继', () => {
      const freshMsg = relay.receiveMessage('SOL', 'ETH', 'burn', {
        user: 'user_002',
        amount: 500,
        sourceTxHash: 'tx_pending',
        targetAddress: '0x5678',
      });

      expect(() => relay.relay(freshMsg.id)).toThrow('Cannot relay: status is pending');
    });

    it('不存在的消息抛异常', () => {
      expect(() => relay.relay('nonexistent')).toThrow('Message not found');
    });

    it('已中继的消息不能重复中继', () => {
      relay.relay(messageId);

      expect(() => relay.relay(messageId)).toThrow('Cannot relay: status is relayed');
    });
  });

  // ── 状态查询 ──

  describe('状态查询', () => {
    it('getPendingMessages 返回待处理消息', () => {
      relay.receiveMessage('SOL', 'ETH', 'lock', {
        user: 'u1',
        amount: 100,
        sourceTxHash: 'tx1',
        targetAddress: '0x1',
      });
      relay.receiveMessage('ETH', 'SOL', 'burn', {
        user: 'u2',
        amount: 200,
        sourceTxHash: 'tx2',
        targetAddress: 'sol_addr',
      });

      expect(relay.getPendingMessages()).toHaveLength(2);
    });

    it('getVerifiedMessages 返回已验证消息', () => {
      const msg = relay.receiveMessage('SOL', 'ETH', 'lock', {
        user: 'u1',
        amount: 100,
        sourceTxHash: 'tx_v',
        targetAddress: '0x1',
      });
      relay.addSignature(msg.id, 'validator_1', 'sig1');
      relay.addSignature(msg.id, 'validator_2', 'sig2');
      relay.addSignature(msg.id, 'validator_3', 'sig3');

      expect(relay.getVerifiedMessages()).toHaveLength(1);
    });

    it('getRelayedMessages 返回已中继消息', () => {
      const msg = relay.receiveMessage('SOL', 'ETH', 'lock', {
        user: 'u1',
        amount: 100,
        sourceTxHash: 'tx_r',
        targetAddress: '0x1',
      });
      relay.addSignature(msg.id, 'validator_1', 'sig1');
      relay.addSignature(msg.id, 'validator_2', 'sig2');
      relay.addSignature(msg.id, 'validator_3', 'sig3');
      relay.relay(msg.id);

      expect(relay.getRelayedMessages()).toHaveLength(1);
    });

    it('getStats 返回正确的统计', () => {
      // 创建 2 个 pending
      relay.receiveMessage('SOL', 'ETH', 'lock', {
        user: 'u1',
        amount: 100,
        sourceTxHash: 's1',
        targetAddress: '0x1',
      });
      relay.receiveMessage('ETH', 'SOL', 'burn', {
        user: 'u2',
        amount: 200,
        sourceTxHash: 's2',
        targetAddress: 'sol',
      });

      // 创建 1 个 verified
      const vMsg = relay.receiveMessage('SOL', 'BNB', 'lock', {
        user: 'u3',
        amount: 300,
        sourceTxHash: 's3',
        targetAddress: '0x3',
      });
      relay.addSignature(vMsg.id, 'validator_1', 'sig1');
      relay.addSignature(vMsg.id, 'validator_2', 'sig2');
      relay.addSignature(vMsg.id, 'validator_3', 'sig3');

      const stats = relay.getStats();
      expect(stats.pending).toBe(2);
      expect(stats.verified).toBe(1);
      expect(stats.relayed).toBe(0);
    });
  });

  // ── 跨链路径测试 ──

  describe('跨链路径', () => {
    it('SOL -> ETH 路径', () => {
      const msg = relay.receiveMessage('SOL', 'ETH', 'lock', {
        user: 'user_sol_eth',
        amount: 5000,
        sourceTxHash: 'sol_tx_001',
        targetAddress: '0xEthAddr001',
      });

      expect(msg.sourceChain).toBe('SOL');
      expect(msg.targetChain).toBe('ETH');
    });

    it('ETH -> SOL 路径', () => {
      const msg = relay.receiveMessage('ETH', 'SOL', 'burn', {
        user: 'user_eth_sol',
        amount: 3000,
        sourceTxHash: 'eth_tx_001',
        targetAddress: 'SolAddr001',
      });

      expect(msg.sourceChain).toBe('ETH');
      expect(msg.targetChain).toBe('SOL');
    });

    it('SOL -> BNB 路径', () => {
      const msg = relay.receiveMessage('SOL', 'BNB', 'lock', {
        user: 'user_sol_bnb',
        amount: 2000,
        sourceTxHash: 'sol_tx_002',
        targetAddress: '0xBnbAddr001',
      });

      expect(msg.sourceChain).toBe('SOL');
      expect(msg.targetChain).toBe('BNB');
    });

    it('BNB -> SOL 路径', () => {
      const msg = relay.receiveMessage('BNB', 'SOL', 'burn', {
        user: 'user_bnb_sol',
        amount: 1500,
        sourceTxHash: 'bnb_tx_001',
        targetAddress: 'SolAddr002',
      });

      expect(msg.sourceChain).toBe('BNB');
      expect(msg.targetChain).toBe('SOL');
    });
  });

  // ── 完整流程测试 ──

  describe('完整中继流程', () => {
    it('SOL -> ETH 完整流程: 接收 -> 签名 -> 中继', () => {
      // 1. 接收消息
      const msg = relay.receiveMessage('SOL', 'ETH', 'lock', {
        user: 'user_full_flow',
        amount: 10_000,
        sourceTxHash: 'sol_full_tx_001',
        targetAddress: '0xEthFullAddr001',
      });
      expect(msg.status).toBe('pending');

      // 2. 收集签名
      relay.addSignature(msg.id, 'validator_1', 'sig_1');
      relay.addSignature(msg.id, 'validator_2', 'sig_2');
      const signed = relay.addSignature(msg.id, 'validator_3', 'sig_3');
      expect(signed.status).toBe('verified');

      // 3. 中继
      const relayed = relay.relay(msg.id);
      expect(relayed.status).toBe('relayed');
      expect(relayed.relayedAt).toBeDefined();
      expect(relay.isProcessed('sol_full_tx_001')).toBe(true);
    });

    it('同一条源交易不能重复中继', () => {
      const msg1 = relay.receiveMessage('SOL', 'ETH', 'lock', {
        user: 'user_dup',
        amount: 1000,
        sourceTxHash: 'dup_tx_hash',
        targetAddress: '0x1',
      });
      relay.addSignature(msg1.id, 'validator_1', 's1');
      relay.addSignature(msg1.id, 'validator_2', 's2');
      relay.addSignature(msg1.id, 'validator_3', 's3');
      relay.relay(msg1.id);

      // 第二条相同 sourceTxHash 的消息
      expect(() =>
        relay.receiveMessage('SOL', 'ETH', 'lock', {
          user: 'user_dup_2',
          amount: 1000,
          sourceTxHash: 'dup_tx_hash',
          targetAddress: '0x2',
        }),
      ).toThrow('Duplicate transaction');
    });
  });
});
