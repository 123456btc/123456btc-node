/**
 * Solana 桥接测试
 * 测试 lock_bbt / unlock_bbt / 紧急暂停 / 多签验证
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock 类型定义 ──

interface SolanaBridgeConfig {
  programId: string;
  bbtMint: string;
  treasuryWallet: string;
  requiredSignatures: number;
  maxLockAmount: number;
  minLockAmount: number;
  paused: boolean;
}

interface LockRecord {
  id: string;
  user: string;
  amount: number;
  targetChain: 'ETH' | 'BNB' | 'ARB';
  targetAddress: string;
  timestamp: number;
  status: 'pending' | 'confirmed' | 'released';
  signatures: string[];
}

interface MultisigProposal {
  id: string;
  action: 'lock' | 'unlock' | 'pause' | 'unpause' | 'update_config';
  data: Record<string, unknown>;
  proposer: string;
  signatures: string[];
  required: number;
  executed: boolean;
  createdAt: number;
}

// ── Mock SolanaBridge 实现 ──

class MockSolanaBridge {
  private config: SolanaBridgeConfig;
  private locks: Map<string, LockRecord> = new Map();
  private proposals: Map<string, MultisigProposal> = new Map();
  private nonce: number = 0;

  constructor(config: SolanaBridgeConfig) {
    this.config = { ...config };
  }

  // lock_bbt: 用户锁定 BBT 用于跨链
  lock_bbt(
    user: string,
    amount: number,
    targetChain: 'ETH' | 'BNB' | 'ARB',
    targetAddress: string,
  ): LockRecord {
    if (this.config.paused) {
      throw new Error('Bridge is paused');
    }
    if (amount < this.config.minLockAmount) {
      throw new Error(`Amount below minimum: ${this.config.minLockAmount}`);
    }
    if (amount > this.config.maxLockAmount) {
      throw new Error(`Amount exceeds maximum: ${this.config.maxLockAmount}`);
    }
    if (!targetAddress || targetAddress.length < 10) {
      throw new Error('Invalid target address');
    }

    const id = `lock_${++this.nonce}_${Date.now()}`;
    const record: LockRecord = {
      id,
      user,
      amount,
      targetChain,
      targetAddress,
      timestamp: Date.now(),
      status: 'pending',
      signatures: [],
    };
    this.locks.set(id, record);
    return record;
  }

  // unlock_bbt: 解锁跨链回来的 BBT
  unlock_bbt(lockId: string, signatures: string[]): LockRecord {
    if (this.config.paused) {
      throw new Error('Bridge is paused');
    }

    const record = this.locks.get(lockId);
    if (!record) {
      throw new Error('Lock record not found');
    }
    if (record.status !== 'pending') {
      throw new Error(`Lock already ${record.status}`);
    }
    if (signatures.length < this.config.requiredSignatures) {
      throw new Error(
        `Insufficient signatures: need ${this.config.requiredSignatures}, got ${signatures.length}`,
      );
    }

    // 验证签名唯一性
    const uniqueSigs = new Set(signatures);
    if (uniqueSigs.size !== signatures.length) {
      throw new Error('Duplicate signatures detected');
    }

    record.status = 'released';
    record.signatures = signatures;
    return record;
  }

  // 紧急暂停
  emergencyPause(adminSignature: string): void {
    if (!adminSignature) {
      throw new Error('Admin signature required');
    }
    this.config.paused = true;
  }

  // 解除暂停 (需要多签)
  unpause(signatures: string[]): void {
    if (signatures.length < this.config.requiredSignatures) {
      throw new Error('Insufficient signatures for unpause');
    }
    this.config.paused = false;
  }

  // 创建多签提案
  createProposal(
    proposer: string,
    action: MultisigProposal['action'],
    data: Record<string, unknown>,
  ): MultisigProposal {
    const id = `prop_${++this.nonce}_${Date.now()}`;
    const proposal: MultisigProposal = {
      id,
      action,
      data,
      proposer,
      signatures: [proposer], // 提案者自动签名
      required: this.config.requiredSignatures,
      executed: false,
      createdAt: Date.now(),
    };
    this.proposals.set(id, proposal);
    return proposal;
  }

  // 签署提案
  signProposal(proposalId: string, signer: string): MultisigProposal {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error('Proposal not found');
    }
    if (proposal.executed) {
      throw new Error('Proposal already executed');
    }
    if (proposal.signatures.includes(signer)) {
      throw new Error('Signer already signed');
    }

    proposal.signatures.push(signer);

    // 达到签名数自动执行
    if (proposal.signatures.length >= proposal.required) {
      this.executeProposal(proposal);
    }

    return proposal;
  }

  // 执行提案
  private executeProposal(proposal: MultisigProposal): void {
    switch (proposal.action) {
      case 'pause':
        this.config.paused = true;
        break;
      case 'unpause':
        this.config.paused = false;
        break;
      case 'update_config':
        Object.assign(this.config, proposal.data);
        break;
      case 'lock':
      case 'unlock':
        // lock/unlock 通过单独的函数处理
        break;
    }
    proposal.executed = true;
  }

  // 查询方法
  getLock(id: string): LockRecord | undefined {
    return this.locks.get(id);
  }

  getProposal(id: string): MultisigProposal | undefined {
    return this.proposals.get(id);
  }

  isPaused(): boolean {
    return this.config.paused;
  }

  getConfig(): SolanaBridgeConfig {
    return { ...this.config };
  }

  getUserLocks(user: string): LockRecord[] {
    return Array.from(this.locks.values()).filter((l) => l.user === user);
  }
}

// ── 测试 ──

describe('Solana Bridge', () => {
  let bridge: MockSolanaBridge;
  const defaultConfig: SolanaBridgeConfig = {
    programId: 'AavU4EhjPx9y5kB1dxuHMeyUd9Va1doMwmkSd5ADkjpv',
    bbtMint: 'BBBToken1111111111111111111111111111111111111',
    treasuryWallet: 'Treasury111111111111111111111111111111111111',
    requiredSignatures: 3,
    maxLockAmount: 1_000_000,
    minLockAmount: 1,
    paused: false,
  };

  beforeEach(() => {
    bridge = new MockSolanaBridge(defaultConfig);
  });

  // ── lock_bbt ──

  describe('lock_bbt', () => {
    it('成功锁定 BBT 并返回 LockRecord', () => {
      const record = bridge.lock_bbt('user_001', 1000, 'ETH', '0x1234567890abcdef1234567890abcdef12345678');

      expect(record).toBeDefined();
      expect(record.id).toContain('lock_');
      expect(record.user).toBe('user_001');
      expect(record.amount).toBe(1000);
      expect(record.targetChain).toBe('ETH');
      expect(record.status).toBe('pending');
      expect(record.signatures).toHaveLength(0);
    });

    it('锁定金额低于最小值抛异常', () => {
      expect(() =>
        bridge.lock_bbt('user_001', 0, 'ETH', '0x1234567890abcdef1234567890abcdef12345678'),
      ).toThrow('Amount below minimum');
    });

    it('锁定金额超过最大值抛异常', () => {
      expect(() =>
        bridge.lock_bbt('user_001', 2_000_000, 'ETH', '0x1234567890abcdef1234567890abcdef12345678'),
      ).toThrow('Amount exceeds maximum');
    });

    it('无效目标地址抛异常', () => {
      expect(() => bridge.lock_bbt('user_001', 100, 'ETH', '')).toThrow('Invalid target address');
      expect(() => bridge.lock_bbt('user_001', 100, 'ETH', 'short')).toThrow(
        'Invalid target address',
      );
    });

    it('暂停状态下锁定抛异常', () => {
      bridge.emergencyPause('admin_sig');
      expect(() =>
        bridge.lock_bbt('user_001', 100, 'ETH', '0x1234567890abcdef1234567890abcdef12345678'),
      ).toThrow('Bridge is paused');
    });

    it('支持多条目标链', () => {
      const ethLock = bridge.lock_bbt(
        'user_001',
        100,
        'ETH',
        '0x1234567890abcdef1234567890abcdef12345678',
      );
      const bnbLock = bridge.lock_bbt(
        'user_002',
        200,
        'BNB',
        '0xabcdef1234567890abcdef1234567890abcdef12',
      );
      const arbLock = bridge.lock_bbt(
        'user_003',
        300,
        'ARB',
        '0x9876543210abcdef1234567890abcdef12345678',
      );

      expect(ethLock.targetChain).toBe('ETH');
      expect(bnbLock.targetChain).toBe('BNB');
      expect(arbLock.targetChain).toBe('ARB');
    });

    it('多个用户可独立锁定', () => {
      bridge.lock_bbt('user_001', 100, 'ETH', '0x1234567890abcdef1234567890abcdef12345678');
      bridge.lock_bbt('user_002', 200, 'ETH', '0xabcdef1234567890abcdef1234567890abcdef12');

      const locks1 = bridge.getUserLocks('user_001');
      const locks2 = bridge.getUserLocks('user_002');

      expect(locks1).toHaveLength(1);
      expect(locks2).toHaveLength(1);
      expect(locks1[0].amount).toBe(100);
      expect(locks2[0].amount).toBe(200);
    });
  });

  // ── unlock_bbt ──

  describe('unlock_bbt', () => {
    let lockId: string;

    beforeEach(() => {
      const record = bridge.lock_bbt(
        'user_001',
        1000,
        'ETH',
        '0x1234567890abcdef1234567890abcdef12345678',
      );
      lockId = record.id;
    });

    it('多签验证成功后解锁', () => {
      const sigs = ['sig_validator_1', 'sig_validator_2', 'sig_validator_3'];
      const result = bridge.unlock_bbt(lockId, sigs);

      expect(result.status).toBe('released');
      expect(result.signatures).toEqual(sigs);
    });

    it('签名数量不足抛异常', () => {
      const sigs = ['sig_validator_1', 'sig_validator_2'];
      expect(() => bridge.unlock_bbt(lockId, sigs)).toThrow('Insufficient signatures');
    });

    it('重复签名抛异常', () => {
      const sigs = ['sig_validator_1', 'sig_validator_1', 'sig_validator_2'];
      expect(() => bridge.unlock_bbt(lockId, sigs)).toThrow('Duplicate signatures');
    });

    it('不存在的 lockId 抛异常', () => {
      expect(() => bridge.unlock_bbt('nonexistent', ['a', 'b', 'c'])).toThrow(
        'Lock record not found',
      );
    });

    it('已释放的记录不能重复解锁', () => {
      const sigs = ['sig_1', 'sig_2', 'sig_3'];
      bridge.unlock_bbt(lockId, sigs);

      expect(() => bridge.unlock_bbt(lockId, ['sig_4', 'sig_5', 'sig_6'])).toThrow(
        'Lock already released',
      );
    });

    it('暂停状态下解锁抛异常', () => {
      bridge.emergencyPause('admin_sig');
      expect(() => bridge.unlock_bbt(lockId, ['sig_1', 'sig_2', 'sig_3'])).toThrow(
        'Bridge is paused',
      );
    });
  });

  // ── 紧急暂停 ──

  describe('紧急暂停', () => {
    it('admin 可暂停桥接', () => {
      bridge.emergencyPause('admin_signature');
      expect(bridge.isPaused()).toBe(true);
    });

    it('暂停后所有操作被阻止', () => {
      bridge.emergencyPause('admin_signature');

      expect(() =>
        bridge.lock_bbt('user', 100, 'ETH', '0x1234567890abcdef1234567890abcdef12345678'),
      ).toThrow('Bridge is paused');
    });

    it('暂停需要管理员签名', () => {
      expect(() => bridge.emergencyPause('')).toThrow('Admin signature required');
    });

    it('多签后可解除暂停', () => {
      bridge.emergencyPause('admin_sig');
      expect(bridge.isPaused()).toBe(true);

      bridge.unpause(['sig_1', 'sig_2', 'sig_3']);
      expect(bridge.isPaused()).toBe(false);
    });

    it('解除暂停需要足够签名', () => {
      bridge.emergencyPause('admin_sig');
      expect(() => bridge.unpause(['sig_1', 'sig_2'])).toThrow('Insufficient signatures');
    });
  });

  // ── 多签验证 ──

  describe('多签验证', () => {
    it('创建提案并记录提案者签名', () => {
      const proposal = bridge.createProposal('signer_1', 'pause', {});

      expect(proposal).toBeDefined();
      expect(proposal.id).toContain('prop_');
      expect(proposal.proposer).toBe('signer_1');
      expect(proposal.signatures).toContain('signer_1');
      expect(proposal.required).toBe(3);
      expect(proposal.executed).toBe(false);
    });

    it('收集足够签名后自动执行', () => {
      const proposal = bridge.createProposal('signer_1', 'pause', {});
      expect(proposal.executed).toBe(false);

      bridge.signProposal(proposal.id, 'signer_2');
      expect(proposal.executed).toBe(false);

      bridge.signProposal(proposal.id, 'signer_3');
      expect(proposal.executed).toBe(true);
    });

    it('已执行的提案不能重复签署', () => {
      const proposal = bridge.createProposal('signer_1', 'pause', {});
      bridge.signProposal(proposal.id, 'signer_2');
      bridge.signProposal(proposal.id, 'signer_3');

      expect(() => bridge.signProposal(proposal.id, 'signer_4')).toThrow(
        'Proposal already executed',
      );
    });

    it('同一签名者不能重复签署', () => {
      const proposal = bridge.createProposal('signer_1', 'pause', {});
      bridge.signProposal(proposal.id, 'signer_2');

      expect(() => bridge.signProposal(proposal.id, 'signer_2')).toThrow(
        'Signer already signed',
      );
    });

    it('不存在的提案抛异常', () => {
      expect(() => bridge.signProposal('nonexistent', 'signer')).toThrow('Proposal not found');
    });

    it('pause 提案执行后桥接暂停', () => {
      const proposal = bridge.createProposal('signer_1', 'pause', {});
      bridge.signProposal(proposal.id, 'signer_2');
      bridge.signProposal(proposal.id, 'signer_3');

      expect(bridge.isPaused()).toBe(true);
    });

    it('unpause 提案执行后桥接恢复', () => {
      bridge.emergencyPause('admin');
      const proposal = bridge.createProposal('signer_1', 'unpause', {});
      bridge.signProposal(proposal.id, 'signer_2');
      bridge.signProposal(proposal.id, 'signer_3');

      expect(bridge.isPaused()).toBe(false);
    });

    it('update_config 提案可更新配置', () => {
      const proposal = bridge.createProposal('signer_1', 'update_config', {
        maxLockAmount: 500_000,
      });
      bridge.signProposal(proposal.id, 'signer_2');
      bridge.signProposal(proposal.id, 'signer_3');

      expect(proposal.executed).toBe(true);
      expect(bridge.getConfig().maxLockAmount).toBe(500_000);
    });
  });
});
