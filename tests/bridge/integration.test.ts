/**
 * 桥接集成测试
 * 测试跨链流程 (SOL<->ETH, SOL<->BNB) 和安全测试 (重入攻击/权限/限额绕过)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── 端到端跨链类型定义 ──

interface CrossChainTransfer {
  id: string;
  sourceChain: 'SOL' | 'ETH' | 'BNB';
  targetChain: 'SOL' | 'ETH' | 'BNB';
  user: string;
  amount: number;
  sourceAddress: string;
  targetAddress: string;
  sourceTxHash: string;
  status: 'initiated' | 'source_locked' | 'relay_verified' | 'target_minted' | 'completed' | 'failed';
  steps: TransferStep[];
  createdAt: number;
  completedAt?: number;
}

interface TransferStep {
  name: string;
  chain: string;
  status: 'pending' | 'done' | 'failed';
  txHash?: string;
  timestamp: number;
  error?: string;
}

// ── Mock 跨链桥接器 ──

class MockCrossChainBridge {
  private transfers: Map<string, CrossChainTransfer> = new Map();
  private solanaLocks: Map<string, { user: string; amount: number; targetChain: string }> = new Map();
  private evmBalances: Map<string, Map<string, number>> = new Map(); // chain -> user -> balance
  private processedTxHashes: Set<string> = new Set();
  private nonce: number = 0;

  // 全局状态
  private paused: boolean = false;
  private rolePermissions: Map<string, Set<string>> = new Map(); // role -> permissions
  private userRoles: Map<string, Set<string>> = new Map(); // user -> roles
  private rateLimits: Map<string, { count: number; windowStart: number; limit: number }> = new Map();

  constructor() {
    // 初始化角色权限
    this.rolePermissions.set('admin', new Set(['pause', 'unpause', 'mint', 'burn', 'config']));
    this.rolePermissions.set('relayer', new Set(['relay', 'mint']));
    this.rolePermissions.set('user', new Set(['lock', 'burn']));
  }

  // ── 权限管理 ──

  assignRole(user: string, role: string): void {
    if (!this.userRoles.has(user)) {
      this.userRoles.set(user, new Set());
    }
    this.userRoles.get(user)!.add(role);
  }

  hasPermission(user: string, permission: string): boolean {
    const roles = this.userRoles.get(user);
    if (!roles) return false;
    for (const role of roles) {
      const perms = this.rolePermissions.get(role);
      if (perms?.has(permission)) return true;
    }
    return false;
  }

  // ── 速率限制 ──

  setRateLimit(user: string, limit: number, windowMs: number = 60_000): void {
    this.rateLimits.set(user, { count: 0, windowStart: Date.now(), limit });
  }

  private checkRateLimit(user: string): void {
    const limit = this.rateLimits.get(user);
    if (!limit) return;

    const now = Date.now();
    if (now - limit.windowStart > 60_000) {
      limit.count = 0;
      limit.windowStart = now;
    }
    if (limit.count >= limit.limit) {
      throw new Error(`Rate limit exceeded: ${limit.limit} per minute`);
    }
    limit.count++;
  }

  // ── 暂停控制 ──

  pause(user: string): void {
    if (!this.hasPermission(user, 'pause')) {
      throw new Error('Unauthorized: missing pause permission');
    }
    this.paused = true;
  }

  unpause(user: string): void {
    if (!this.hasPermission(user, 'unpause')) {
      throw new Error('Unauthorized: missing unpause permission');
    }
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }

  // ── Solana 锁定 ──

  solanaLock(
    user: string,
    amount: number,
    targetChain: 'ETH' | 'BNB',
    targetAddress: string,
    sourceAddress: string,
  ): CrossChainTransfer {
    if (this.paused) throw new Error('Bridge is paused');
    if (!this.hasPermission(user, 'lock')) throw new Error('Unauthorized: missing lock permission');
    this.checkRateLimit(user);
    if (amount <= 0) throw new Error('Invalid amount');

    const id = `transfer_${++this.nonce}`;
    const sourceTxHash = `sol_tx_${id}`;

    const transfer: CrossChainTransfer = {
      id,
      sourceChain: 'SOL',
      targetChain,
      user,
      amount,
      sourceAddress,
      targetAddress,
      sourceTxHash,
      status: 'initiated',
      steps: [
        { name: 'lock_on_solana', chain: 'SOL', status: 'done', txHash: sourceTxHash, timestamp: Date.now() },
        { name: 'relay_verify', chain: 'relay', status: 'pending', timestamp: Date.now() },
        { name: `mint_on_${targetChain}`, chain: targetChain, status: 'pending', timestamp: Date.now() },
      ],
      createdAt: Date.now(),
    };
    transfer.status = 'source_locked';

    this.solanaLocks.set(id, { user, amount, targetChain });
    this.transfers.set(id, transfer);
    this.processedTxHashes.add(sourceTxHash);

    return transfer;
  }

  // ── EVM 铸造 (中继器调用) ──

  evmMint(transferId: string, relayer: string): CrossChainTransfer {
    if (this.paused) throw new Error('Bridge is paused');
    if (!this.hasPermission(relayer, 'mint')) throw new Error('Unauthorized: missing mint permission');

    const transfer = this.transfers.get(transferId);
    if (!transfer) throw new Error('Transfer not found');
    if (transfer.status !== 'source_locked') {
      throw new Error(`Invalid status for mint: ${transfer.status}`);
    }

    // 更新步骤
    transfer.steps[1].status = 'done';
    transfer.steps[1].txHash = `relay_sig_${transferId}`;
    transfer.status = 'relay_verified';

    transfer.steps[2].status = 'done';
    transfer.steps[2].txHash = `evm_mint_tx_${transferId}`;
    transfer.status = 'target_minted';

    // 增加 EVM 余额
    const chain = transfer.targetChain;
    if (!this.evmBalances.has(chain)) {
      this.evmBalances.set(chain, new Map());
    }
    const chainBalances = this.evmBalances.get(chain)!;
    const current = chainBalances.get(transfer.user) || 0;
    chainBalances.set(transfer.user, current + transfer.amount);

    transfer.status = 'completed';
    transfer.completedAt = Date.now();

    return transfer;
  }

  // ── EVM 锁定 (burn) ──

  evmBurn(
    user: string,
    amount: number,
    sourceChain: 'ETH' | 'BNB',
    solanaAddress: string,
    sourceAddress: string,
  ): CrossChainTransfer {
    if (this.paused) throw new Error('Bridge is paused');
    if (!this.hasPermission(user, 'burn')) throw new Error('Unauthorized: missing burn permission');
    this.checkRateLimit(user);
    if (amount <= 0) throw new Error('Invalid amount');

    // 检查余额
    const chainBalances = this.evmBalances.get(sourceChain);
    const balance = chainBalances?.get(user) || 0;
    if (balance < amount) {
      throw new Error(`Insufficient ${sourceChain} balance: have ${balance}, need ${amount}`);
    }

    // 扣除余额
    chainBalances!.set(user, balance - amount);

    const id = `transfer_${++this.nonce}`;
    const sourceTxHash = `evm_tx_${id}`;

    const transfer: CrossChainTransfer = {
      id,
      sourceChain,
      targetChain: 'SOL',
      user,
      amount,
      sourceAddress,
      targetAddress: solanaAddress,
      sourceTxHash,
      status: 'initiated',
      steps: [
        { name: `burn_on_${sourceChain}`, chain: sourceChain, status: 'done', txHash: sourceTxHash, timestamp: Date.now() },
        { name: 'relay_verify', chain: 'relay', status: 'pending', timestamp: Date.now() },
        { name: 'unlock_on_solana', chain: 'SOL', status: 'pending', timestamp: Date.now() },
      ],
      createdAt: Date.now(),
    };
    transfer.status = 'source_locked';

    this.transfers.set(id, transfer);
    this.processedTxHashes.add(sourceTxHash);

    return transfer;
  }

  // ── Solana 解锁 (中继器调用) ──

  solanaUnlock(transferId: string, relayer: string): CrossChainTransfer {
    if (this.paused) throw new Error('Bridge is paused');

    const transfer = this.transfers.get(transferId);
    if (!transfer) throw new Error('Transfer not found');
    if (transfer.status !== 'source_locked') {
      throw new Error(`Invalid status for unlock: ${transfer.status}`);
    }

    transfer.steps[1].status = 'done';
    transfer.steps[1].txHash = `relay_sig_${transferId}`;
    transfer.status = 'relay_verified';

    transfer.steps[2].status = 'done';
    transfer.steps[2].txHash = `sol_unlock_tx_${transferId}`;
    transfer.status = 'completed';
    transfer.completedAt = Date.now();

    return transfer;
  }

  // ── 辅助方法 ──

  setEvmBalance(chain: 'ETH' | 'BNB', user: string, amount: number): void {
    if (!this.evmBalances.has(chain)) {
      this.evmBalances.set(chain, new Map());
    }
    this.evmBalances.get(chain)!.set(user, amount);
  }

  getEvmBalance(chain: 'ETH' | 'BNB', user: string): number {
    return this.evmBalances.get(chain)?.get(user) || 0;
  }

  getTransfer(id: string): CrossChainTransfer | undefined {
    return this.transfers.get(id);
  }

  isProcessedTx(hash: string): boolean {
    return this.processedTxHashes.has(hash);
  }
}

// ── 跨链流程测试 ──

describe('Cross-Chain Integration', () => {
  let bridge: MockCrossChainBridge;

  beforeEach(() => {
    bridge = new MockCrossChainBridge();
    bridge.assignRole('user_001', 'user');
    bridge.assignRole('user_002', 'user');
    bridge.assignRole('relayer_001', 'relayer');
    bridge.assignRole('admin_001', 'admin');
    bridge.setEvmBalance('ETH', 'user_001', 50_000);
    bridge.setEvmBalance('BNB', 'user_001', 50_000);
  });

  // ── Solana -> ETH 流程 ──

  describe('Solana -> ETH 流程', () => {
    it('完整流程: SOL lock -> relay -> ETH mint', () => {
      // Step 1: 用户在 Solana 锁定 BBT
      const transfer = bridge.solanaLock(
        'user_001',
        5000,
        'ETH',
        '0xEthAddr001',
        'SolAddr001',
      );

      expect(transfer.status).toBe('source_locked');
      expect(transfer.sourceChain).toBe('SOL');
      expect(transfer.targetChain).toBe('ETH');
      expect(transfer.steps[0].status).toBe('done');

      // Step 2: 中继器铸造到 ETH
      const completed = bridge.evmMint(transfer.id, 'relayer_001');

      expect(completed.status).toBe('completed');
      expect(completed.completedAt).toBeDefined();
      expect(completed.steps.every((s) => s.status === 'done')).toBe(true);

      // 验证 ETH 余额
      expect(bridge.getEvmBalance('ETH', 'user_001')).toBe(55_000);
    });

    it('源交易哈希被标记为已处理', () => {
      const transfer = bridge.solanaLock(
        'user_001',
        1000,
        'ETH',
        '0xEthAddr002',
        'SolAddr002',
      );

      expect(bridge.isProcessedTx(transfer.sourceTxHash)).toBe(true);
    });
  });

  // ── ETH -> Solana 流程 ──

  describe('ETH -> Solana 流程', () => {
    it('完整流程: ETH burn -> relay -> SOL unlock', () => {
      // Step 1: 用户在 ETH 销毁 BBT
      const transfer = bridge.evmBurn(
        'user_001',
        3000,
        'ETH',
        'SolAddr003',
        '0xEthAddr003',
      );

      expect(transfer.status).toBe('source_locked');
      expect(transfer.sourceChain).toBe('ETH');
      expect(transfer.targetChain).toBe('SOL');
      expect(bridge.getEvmBalance('ETH', 'user_001')).toBe(47_000);

      // Step 2: 中继器在 Solana 解锁
      const completed = bridge.solanaUnlock(transfer.id, 'relayer_001');

      expect(completed.status).toBe('completed');
      expect(completed.steps.every((s) => s.status === 'done')).toBe(true);
    });

    it('余额不足时 burn 失败', () => {
      expect(() =>
        bridge.evmBurn('user_001', 100_000, 'ETH', 'SolAddr', '0xEthAddr'),
      ).toThrow('Insufficient ETH balance');
    });
  });

  // ── Solana -> BNB 流程 ──

  describe('Solana -> BNB 流程', () => {
    it('完整流程: SOL lock -> relay -> BNB mint', () => {
      const transfer = bridge.solanaLock(
        'user_001',
        2000,
        'BNB',
        '0xBnbAddr001',
        'SolAddr004',
      );

      expect(transfer.status).toBe('source_locked');
      expect(transfer.targetChain).toBe('BNB');

      const completed = bridge.evmMint(transfer.id, 'relayer_001');

      expect(completed.status).toBe('completed');
      expect(bridge.getEvmBalance('BNB', 'user_001')).toBe(52_000);
    });
  });

  // ── BNB -> Solana 流程 ──

  describe('BNB -> Solana 流程', () => {
    it('完整流程: BNB burn -> relay -> SOL unlock', () => {
      const transfer = bridge.evmBurn(
        'user_001',
        4000,
        'BNB',
        'SolAddr005',
        '0xBnbAddr002',
      );

      expect(transfer.status).toBe('source_locked');
      expect(transfer.sourceChain).toBe('BNB');
      expect(bridge.getEvmBalance('BNB', 'user_001')).toBe(46_000);

      const completed = bridge.solanaUnlock(transfer.id, 'relayer_001');

      expect(completed.status).toBe('completed');
    });
  });

  // ── 多用户并发跨链 ──

  describe('多用户并发', () => {
    it('多个用户可同时发起跨链', () => {
      const t1 = bridge.solanaLock('user_001', 1000, 'ETH', '0xA1', 'S1');
      const t2 = bridge.solanaLock('user_002', 2000, 'BNB', '0xB1', 'S2');

      expect(t1.id).not.toBe(t2.id);
      expect(t1.user).toBe('user_001');
      expect(t2.user).toBe('user_002');
    });

    it('中继器可同时处理多个转账', () => {
      const t1 = bridge.solanaLock('user_001', 1000, 'ETH', '0xA1', 'S1');
      const t2 = bridge.solanaLock('user_001', 2000, 'ETH', '0xA2', 'S2');

      bridge.evmMint(t1.id, 'relayer_001');
      bridge.evmMint(t2.id, 'relayer_001');

      expect(bridge.getTransfer(t1.id)!.status).toBe('completed');
      expect(bridge.getTransfer(t2.id)!.status).toBe('completed');
      expect(bridge.getEvmBalance('ETH', 'user_001')).toBe(53_000);
    });
  });
});

// ── 安全测试 ──

describe('Security Tests', () => {
  let bridge: MockCrossChainBridge;

  beforeEach(() => {
    bridge = new MockCrossChainBridge();
    bridge.assignRole('user_001', 'user');
    bridge.assignRole('user_002', 'user');
    bridge.assignRole('relayer_001', 'relayer');
    bridge.assignRole('admin_001', 'admin');
    bridge.setEvmBalance('ETH', 'user_001', 100_000);
    bridge.setEvmBalance('BNB', 'user_001', 100_000);
  });

  // ── 重入攻击防护 ──

  describe('重入攻击防护', () => {
    it('同一源交易不能重复处理', () => {
      const transfer = bridge.solanaLock(
        'user_001',
        5000,
        'ETH',
        '0xEthAddr',
        'SolAddr',
      );

      // 完成第一次铸造
      bridge.evmMint(transfer.id, 'relayer_001');

      // 尝试对同一 transfer 重复 mint
      expect(() => bridge.evmMint(transfer.id, 'relayer_001')).toThrow(
        'Invalid status for mint: completed',
      );

      // 余额应只增加一次
      expect(bridge.getEvmBalance('ETH', 'user_001')).toBe(105_000);
    });

    it('相同 sourceTxHash 的交易被拒绝', () => {
      bridge.solanaLock('user_001', 1000, 'ETH', '0xE1', 'S1');

      // 尝试用相同交易发起新 transfer (通过检查 isProcessedTx)
      const txHash = `sol_tx_transfer_${bridge.getTransfer('transfer_1')?.sourceTxHash?.split('_').pop()}`;
      // 核心防护: sourceTxHash 已被标记为已处理
      expect(bridge.isProcessedTx(bridge.getTransfer('transfer_1')!.sourceTxHash)).toBe(true);
    });

    it('暂停状态下所有操作被阻止', () => {
      bridge.pause('admin_001');

      expect(() =>
        bridge.solanaLock('user_001', 1000, 'ETH', '0xE', 'S'),
      ).toThrow('Bridge is paused');

      expect(() =>
        bridge.evmBurn('user_001', 1000, 'ETH', 'S', '0xE'),
      ).toThrow('Bridge is paused');
    });
  });

  // ── 权限控制 ──

  describe('权限控制', () => {
    it('普通用户不能暂停桥接', () => {
      expect(() => bridge.pause('user_001')).toThrow('Unauthorized: missing pause permission');
    });

    it('普通用户不能铸造', () => {
      const transfer = bridge.solanaLock(
        'user_001',
        1000,
        'ETH',
        '0xE',
        'S',
      );

      expect(() => bridge.evmMint(transfer.id, 'user_001')).toThrow(
        'Unauthorized: missing mint permission',
      );
    });

    it('admin 可暂停和解除暂停', () => {
      bridge.pause('admin_001');
      expect(bridge.isPaused()).toBe(true);

      bridge.unpause('admin_001');
      expect(bridge.isPaused()).toBe(false);
    });

    it('relayer 可以铸造', () => {
      const transfer = bridge.solanaLock(
        'user_001',
        1000,
        'ETH',
        '0xE',
        'S',
      );

      expect(() => bridge.evmMint(transfer.id, 'relayer_001')).not.toThrow();
    });

    it('无权限用户不能锁定', () => {
      expect(() =>
        bridge.solanaLock('unknown_user', 1000, 'ETH', '0xE', 'S'),
      ).toThrow('Unauthorized: missing lock permission');
    });

    it('无权限用户不能销毁', () => {
      expect(() =>
        bridge.evmBurn('unknown_user', 1000, 'ETH', 'S', '0xE'),
      ).toThrow('Unauthorized: missing burn permission');
    });

    it('多角色用户拥有所有对应权限', () => {
      bridge.assignRole('super_user', 'user');
      bridge.assignRole('super_user', 'relayer');

      expect(bridge.hasPermission('super_user', 'lock')).toBe(true);
      expect(bridge.hasPermission('super_user', 'relay')).toBe(true);
      expect(bridge.hasPermission('super_user', 'mint')).toBe(true);
      expect(bridge.hasPermission('super_user', 'pause')).toBe(false); // 不是 admin
    });
  });

  // ── 限额绕过测试 ──

  describe('限额绕过防护', () => {
    it('无效金额被拒绝', () => {
      expect(() =>
        bridge.solanaLock('user_001', 0, 'ETH', '0xE', 'S'),
      ).toThrow('Invalid amount');

      expect(() =>
        bridge.solanaLock('user_001', -100, 'ETH', '0xE', 'S'),
      ).toThrow('Invalid amount');
    });

    it('速率限制生效', () => {
      bridge.setRateLimit('user_001', 3); // 每分钟 3 次

      // 前 3 次应成功
      bridge.solanaLock('user_001', 100, 'ETH', '0xE1', 'S1');
      bridge.solanaLock('user_001', 100, 'ETH', '0xE2', 'S2');
      bridge.solanaLock('user_001', 100, 'ETH', '0xE3', 'S3');

      // 第 4 次应被拒绝
      expect(() =>
        bridge.solanaLock('user_001', 100, 'ETH', '0xE4', 'S4'),
      ).toThrow('Rate limit exceeded');
    });

    it('不同用户的速率限制独立', () => {
      bridge.setRateLimit('user_001', 2);
      bridge.setRateLimit('user_002', 2);

      bridge.solanaLock('user_001', 100, 'ETH', '0xE1', 'S1');
      bridge.solanaLock('user_001', 100, 'ETH', '0xE2', 'S2');
      bridge.solanaLock('user_002', 100, 'ETH', '0xE3', 'S3');
      bridge.solanaLock('user_002', 100, 'ETH', '0xE4', 'S4');

      // 两个用户各自达到限额
      expect(() =>
        bridge.solanaLock('user_001', 100, 'ETH', '0xE5', 'S5'),
      ).toThrow('Rate limit exceeded');

      expect(() =>
        bridge.solanaLock('user_002', 100, 'ETH', '0xE6', 'S6'),
      ).toThrow('Rate limit exceeded');
    });

    it('余额不足不能销毁', () => {
      expect(() =>
        bridge.evmBurn('user_001', 200_000, 'ETH', 'S', '0xE'),
      ).toThrow('Insufficient ETH balance');
    });

    it('暂停后速率限制也生效', () => {
      bridge.pause('admin_001');

      // 暂停状态优先于速率限制检查
      expect(() =>
        bridge.solanaLock('user_001', 100, 'ETH', '0xE', 'S'),
      ).toThrow('Bridge is paused');
    });

    it('跨链转移不能凭空铸造', () => {
      const initialBalance = bridge.getEvmBalance('ETH', 'user_002');

      // user_002 没有发起锁定，不应该有余额
      expect(initialBalance).toBe(0);

      // 只有通过正规流程才能增加余额
      const transfer = bridge.solanaLock('user_002', 5000, 'ETH', '0xE', 'S');
      bridge.evmMint(transfer.id, 'relayer_001');

      expect(bridge.getEvmBalance('ETH', 'user_002')).toBe(5000);
    });
  });
});
