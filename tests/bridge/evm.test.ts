/**
 * EVM 桥接测试
 * 测试 lockBBT / unlockBBT / mintBBT / burnBBT / 限额控制
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock 类型定义 ──

interface EVMBridgeConfig {
  chainId: number;
  chainName: 'ETH' | 'BNB' | 'ARB';
  bbtTokenAddress: string;
  bridgeContractAddress: string;
  relayerAddress: string;
  dailyMintLimit: number;
  dailyBurnLimit: number;
  maxSingleMint: number;
  maxSingleBurn: number;
  minAmount: number;
  paused: boolean;
}

interface BridgeTransaction {
  id: string;
  type: 'lock' | 'unlock' | 'mint' | 'burn';
  user: string;
  amount: number;
  sourceChain: string;
  targetChain: string;
  sourceTxHash: string;
  status: 'pending' | 'confirmed' | 'failed';
  timestamp: number;
}

interface DailyUsage {
  date: string;
  minted: number;
  burned: number;
}

// ── Mock EVMBridge 实现 ──

class MockEVMBridge {
  private config: EVMBridgeConfig;
  private transactions: Map<string, BridgeTransaction> = new Map();
  private balances: Map<string, number> = new Map();
  private allowances: Map<string, Map<string, number>> = new Map();
  private dailyUsage: DailyUsage = { date: this.today(), minted: 0, burned: 0 };
  private nonce: number = 0;

  constructor(config: EVMBridgeConfig) {
    this.config = { ...config };
  }

  private today(): string {
    return new Date().toISOString().split('T')[0];
  }

  private checkAndUpdateDaily(): void {
    const today = this.today();
    if (this.dailyUsage.date !== today) {
      this.dailyUsage = { date: today, minted: 0, burned: 0 };
    }
  }

  // lockBBT: 用户在 EVM 链上锁定 BBT
  lockBBT(user: string, amount: number, targetChain: string, targetAddress: string): BridgeTransaction {
    if (this.config.paused) {
      throw new Error('Bridge is paused');
    }
    if (amount < this.config.minAmount) {
      throw new Error(`Amount below minimum: ${this.config.minAmount}`);
    }

    const balance = this.balances.get(user) || 0;
    if (balance < amount) {
      throw new Error(`Insufficient balance: have ${balance}, need ${amount}`);
    }

    // 扣除余额
    this.balances.set(user, balance - amount);

    const id = `evm_lock_${++this.nonce}`;
    const tx: BridgeTransaction = {
      id,
      type: 'lock',
      user,
      amount,
      sourceChain: this.config.chainName,
      targetChain,
      sourceTxHash: `0x${id}`,
      status: 'confirmed',
      timestamp: Date.now(),
    };
    this.transactions.set(id, tx);
    return tx;
  }

  // unlockBBT: 解锁从其他链跨过来的 BBT
  unlockBBT(user: string, amount: number, sourceChain: string, proof: string): BridgeTransaction {
    if (this.config.paused) {
      throw new Error('Bridge is paused');
    }
    if (amount < this.config.minAmount) {
      throw new Error(`Amount below minimum: ${this.config.minAmount}`);
    }
    if (!proof || proof.length < 10) {
      throw new Error('Invalid proof');
    }

    const id = `evm_unlock_${++this.nonce}`;
    const tx: BridgeTransaction = {
      id,
      type: 'unlock',
      user,
      amount,
      sourceChain,
      targetChain: this.config.chainName,
      sourceTxHash: proof,
      status: 'confirmed',
      timestamp: Date.now(),
    };
    this.transactions.set(id, tx);

    // 增加余额
    const balance = this.balances.get(user) || 0;
    this.balances.set(user, balance + amount);

    return tx;
  }

  // mintBBT: 中继器铸造 BBT (从 Solana 跨链过来)
  mintBBT(user: string, amount: number, sourceTxHash: string): BridgeTransaction {
    if (this.config.paused) {
      throw new Error('Bridge is paused');
    }
    if (amount > this.config.maxSingleMint) {
      throw new Error(`Amount exceeds max single mint: ${this.config.maxSingleMint}`);
    }

    this.checkAndUpdateDaily();
    if (this.dailyUsage.minted + amount > this.config.dailyMintLimit) {
      throw new Error(
        `Daily mint limit exceeded: limit=${this.config.dailyMintLimit}, used=${this.dailyUsage.minted}, requested=${amount}`,
      );
    }

    const id = `evm_mint_${++this.nonce}`;
    const tx: BridgeTransaction = {
      id,
      type: 'mint',
      user,
      amount,
      sourceChain: 'SOL',
      targetChain: this.config.chainName,
      sourceTxHash,
      status: 'confirmed',
      timestamp: Date.now(),
    };
    this.transactions.set(id, tx);

    // 增加余额 + 更新日用量
    const balance = this.balances.get(user) || 0;
    this.balances.set(user, balance + amount);
    this.dailyUsage.minted += amount;

    return tx;
  }

  // burnBBT: 用户销毁 BBT (跨链回 Solana)
  burnBBT(user: string, amount: number, solanaAddress: string): BridgeTransaction {
    if (this.config.paused) {
      throw new Error('Bridge is paused');
    }
    if (amount > this.config.maxSingleBurn) {
      throw new Error(`Amount exceeds max single burn: ${this.config.maxSingleBurn}`);
    }
    if (amount < this.config.minAmount) {
      throw new Error(`Amount below minimum: ${this.config.minAmount}`);
    }

    this.checkAndUpdateDaily();
    if (this.dailyUsage.burned + amount > this.config.dailyBurnLimit) {
      throw new Error(
        `Daily burn limit exceeded: limit=${this.config.dailyBurnLimit}, used=${this.dailyUsage.burned}, requested=${amount}`,
      );
    }

    const balance = this.balances.get(user) || 0;
    if (balance < amount) {
      throw new Error(`Insufficient balance: have ${balance}, need ${amount}`);
    }

    // 扣除余额
    this.balances.set(user, balance - amount);

    const id = `evm_burn_${++this.nonce}`;
    const tx: BridgeTransaction = {
      id,
      type: 'burn',
      user,
      amount,
      sourceChain: this.config.chainName,
      targetChain: 'SOL',
      sourceTxHash: `0x${id}`,
      status: 'confirmed',
      timestamp: Date.now(),
    };
    this.transactions.set(id, tx);
    this.dailyUsage.burned += amount;

    return tx;
  }

  // 授权
  approve(owner: string, spender: string, amount: number): void {
    if (!this.allowances.has(owner)) {
      this.allowances.set(owner, new Map());
    }
    this.allowances.get(owner)!.set(spender, amount);
  }

  getAllowance(owner: string, spender: string): number {
    return this.allowances.get(owner)?.get(spender) || 0;
  }

  // 设置余额 (测试辅助)
  setBalance(user: string, amount: number): void {
    this.balances.set(user, amount);
  }

  getBalance(user: string): number {
    return this.balances.get(user) || 0;
  }

  getTransaction(id: string): BridgeTransaction | undefined {
    return this.transactions.get(id);
  }

  getUserTransactions(user: string): BridgeTransaction[] {
    return Array.from(this.transactions.values()).filter((tx) => tx.user === user);
  }

  getDailyUsage(): DailyUsage {
    this.checkAndUpdateDaily();
    return { ...this.dailyUsage };
  }

  isPaused(): boolean {
    return this.config.paused;
  }

  pause(): void {
    this.config.paused = true;
  }

  unpause(): void {
    this.config.paused = false;
  }

  getConfig(): EVMBridgeConfig {
    return { ...this.config };
  }
}

// ── 测试 ──

describe('EVM Bridge', () => {
  let bridge: MockEVMBridge;
  const defaultConfig: EVMBridgeConfig = {
    chainId: 1,
    chainName: 'ETH',
    bbtTokenAddress: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    bridgeContractAddress: '0x1111111111111111111111111111111111111111',
    relayerAddress: '0xRELAYER00000000000000000000000000000000',
    dailyMintLimit: 100_000,
    dailyBurnLimit: 100_000,
    maxSingleMint: 10_000,
    maxSingleBurn: 10_000,
    minAmount: 1,
    paused: false,
  };

  beforeEach(() => {
    bridge = new MockEVMBridge(defaultConfig);
    bridge.setBalance('user_001', 50_000);
    bridge.setBalance('user_002', 30_000);
  });

  // ── lockBBT ──

  describe('lockBBT', () => {
    it('成功锁定 BBT', () => {
      const tx = bridge.lockBBT('user_001', 1000, 'SOL', 'SolanaAddress11111111111');

      expect(tx).toBeDefined();
      expect(tx.type).toBe('lock');
      expect(tx.amount).toBe(1000);
      expect(tx.sourceChain).toBe('ETH');
      expect(tx.targetChain).toBe('SOL');
      expect(tx.status).toBe('confirmed');
    });

    it('锁定后余额减少', () => {
      const before = bridge.getBalance('user_001');
      bridge.lockBBT('user_001', 5000, 'SOL', 'SolanaAddress11111111111');
      const after = bridge.getBalance('user_001');

      expect(after).toBe(before - 5000);
    });

    it('余额不足抛异常', () => {
      expect(() =>
        bridge.lockBBT('user_001', 100_000, 'SOL', 'SolanaAddress11111111111'),
      ).toThrow('Insufficient balance');
    });

    it('金额低于最小值抛异常', () => {
      expect(() =>
        bridge.lockBBT('user_001', 0, 'SOL', 'SolanaAddress11111111111'),
      ).toThrow('Amount below minimum');
    });

    it('暂停时锁定抛异常', () => {
      bridge.pause();
      expect(() =>
        bridge.lockBBT('user_001', 100, 'SOL', 'SolanaAddress11111111111'),
      ).toThrow('Bridge is paused');
    });
  });

  // ── unlockBBT ──

  describe('unlockBBT', () => {
    it('成功解锁 BBT', () => {
      const tx = bridge.unlockBBT('user_001', 2000, 'SOL', 'proof_valid_1234567890');

      expect(tx).toBeDefined();
      expect(tx.type).toBe('unlock');
      expect(tx.amount).toBe(2000);
      expect(tx.sourceChain).toBe('SOL');
      expect(tx.status).toBe('confirmed');
    });

    it('解锁后余额增加', () => {
      const before = bridge.getBalance('user_001');
      bridge.unlockBBT('user_001', 3000, 'SOL', 'proof_valid_1234567890');
      const after = bridge.getBalance('user_001');

      expect(after).toBe(before + 3000);
    });

    it('无效 proof 抛异常', () => {
      expect(() => bridge.unlockBBT('user_001', 100, 'SOL', '')).toThrow('Invalid proof');
      expect(() => bridge.unlockBBT('user_001', 100, 'SOL', 'short')).toThrow('Invalid proof');
    });

    it('金额低于最小值抛异常', () => {
      expect(() => bridge.unlockBBT('user_001', 0, 'SOL', 'proof_valid_1234567890')).toThrow(
        'Amount below minimum',
      );
    });

    it('暂停时解锁抛异常', () => {
      bridge.pause();
      expect(() =>
        bridge.unlockBBT('user_001', 100, 'SOL', 'proof_valid_1234567890'),
      ).toThrow('Bridge is paused');
    });
  });

  // ── mintBBT ──

  describe('mintBBT', () => {
    it('成功铸造 BBT', () => {
      const tx = bridge.mintBBT('user_001', 5000, 'solana_tx_hash_1234567890');

      expect(tx).toBeDefined();
      expect(tx.type).toBe('mint');
      expect(tx.sourceChain).toBe('SOL');
      expect(tx.targetChain).toBe('ETH');
      expect(tx.status).toBe('confirmed');
    });

    it('铸造后余额增加', () => {
      const before = bridge.getBalance('user_001');
      bridge.mintBBT('user_001', 2000, 'solana_tx_hash_1234567890');
      const after = bridge.getBalance('user_001');

      expect(after).toBe(before + 2000);
    });

    it('超过单次铸造上限抛异常', () => {
      expect(() =>
        bridge.mintBBT('user_001', 20_000, 'solana_tx_hash_1234567890'),
      ).toThrow('Amount exceeds max single mint');
    });

    it('超过每日铸造限额抛异常', () => {
      // 先铸造接近限额 (每次不超过 maxSingleMint=10_000)
      for (let i = 0; i < 10; i++) {
        bridge.mintBBT('user_001', 10_000, `tx_daily_${i}`);
      }
      // dailyUsage.minted = 100_000 = dailyMintLimit, 再铸造应触发日限额
      expect(() => bridge.mintBBT('user_001', 1, 'tx_daily_overflow')).toThrow('Daily mint limit exceeded');
    });

    it('暂停时铸造抛异常', () => {
      bridge.pause();
      expect(() => bridge.mintBBT('user_001', 100, 'tx')).toThrow('Bridge is paused');
    });
  });

  // ── burnBBT ──

  describe('burnBBT', () => {
    it('成功销毁 BBT', () => {
      const tx = bridge.burnBBT('user_001', 5000, 'SolanaAddress11111111111');

      expect(tx).toBeDefined();
      expect(tx.type).toBe('burn');
      expect(tx.sourceChain).toBe('ETH');
      expect(tx.targetChain).toBe('SOL');
      expect(tx.status).toBe('confirmed');
    });

    it('销毁后余额减少', () => {
      const before = bridge.getBalance('user_001');
      bridge.burnBBT('user_001', 3000, 'SolanaAddress11111111111');
      const after = bridge.getBalance('user_001');

      expect(after).toBe(before - 3000);
    });

    it('余额不足时销毁抛异常', () => {
      // balance = 50_000, 但 maxSingleBurn = 10_000, 所以用 10_000 不会触发余额不足
      // 先把余额消耗到很低
      bridge.setBalance('user_001', 200);
      expect(() =>
        bridge.burnBBT('user_001', 5000, 'SolanaAddress11111111111'),
      ).toThrow('Insufficient balance');
    });

    it('超过单次销毁上限抛异常', () => {
      expect(() =>
        bridge.burnBBT('user_001', 20_000, 'SolanaAddress11111111111'),
      ).toThrow('Amount exceeds max single burn');
    });

    it('超过每日销毁限额抛异常', () => {
      // 先给用户足够的余额
      bridge.setBalance('user_001', 200_000);
      // 先销毁接近限额 (每次不超过 maxSingleBurn=10_000)
      for (let i = 0; i < 10; i++) {
        bridge.burnBBT('user_001', 10_000, `addr_daily_${i}`);
      }
      // dailyUsage.burned = 100_000 = dailyBurnLimit, 再销毁应触发日限额
      expect(() => bridge.burnBBT('user_001', 1, 'addr_daily_overflow')).toThrow(
        'Daily burn limit exceeded',
      );
    });

    it('金额低于最小值抛异常', () => {
      expect(() => bridge.burnBBT('user_001', 0, 'SolanaAddress11111111111')).toThrow(
        'Amount below minimum',
      );
    });

    it('暂停时销毁抛异常', () => {
      bridge.pause();
      expect(() =>
        bridge.burnBBT('user_001', 100, 'SolanaAddress11111111111'),
      ).toThrow('Bridge is paused');
    });
  });

  // ── 限额控制 ──

  describe('限额控制', () => {
    it('每日铸造限额正确跟踪', () => {
      bridge.mintBBT('user_001', 10_000, 'tx1');
      bridge.mintBBT('user_001', 10_000, 'tx2');

      const usage = bridge.getDailyUsage();
      expect(usage.minted).toBe(20_000);
    });

    it('每日销毁限额正确跟踪', () => {
      bridge.burnBBT('user_001', 10_000, 'addr1');
      bridge.burnBBT('user_002', 5000, 'addr2');

      const usage = bridge.getDailyUsage();
      expect(usage.burned).toBe(15_000);
    });

    it('单次限额与日限额独立', () => {
      // maxSingleMint = 10_000, dailyMintLimit = 100_000
      // 10 次 10_000 应该成功 (100_000 = dailyMintLimit)
      for (let i = 0; i < 10; i++) {
        expect(() => bridge.mintBBT('user_001', 10_000, `tx_${i}`)).not.toThrow();
      }

      // 第 11 次应触发日限额
      expect(() => bridge.mintBBT('user_001', 10_000, 'tx_11')).toThrow(
        'Daily mint limit exceeded',
      );
    });

    it('不同用户共享每日限额', () => {
      // 每次不超过 maxSingleMint=10_000
      for (let i = 0; i < 5; i++) {
        bridge.mintBBT('user_001', 10_000, `tx_shared_${i}`);
      }
      // user_001 已用 50_000
      for (let i = 0; i < 5; i++) {
        bridge.mintBBT('user_002', 10_000, `tx_shared2_${i}`);
      }
      // 两人共用 100_000 = dailyMintLimit
      expect(() => bridge.mintBBT('user_002', 1, 'tx_shared_overflow')).toThrow(
        'Daily mint limit exceeded',
      );
    });
  });

  // ── 授权管理 ──

  describe('授权管理', () => {
    it('设置授权后可查询', () => {
      bridge.approve('user_001', 'bridge', 10_000);
      expect(bridge.getAllowance('user_001', 'bridge')).toBe(10_000);
    });

    it('未设置授权默认为 0', () => {
      expect(bridge.getAllowance('user_001', 'unknown')).toBe(0);
    });

    it('授权可更新', () => {
      bridge.approve('user_001', 'bridge', 10_000);
      bridge.approve('user_001', 'bridge', 20_000);
      expect(bridge.getAllowance('user_001', 'bridge')).toBe(20_000);
    });
  });

  // ── 交易记录 ──

  describe('交易记录', () => {
    it('每笔交易有唯一 ID', () => {
      const tx1 = bridge.lockBBT('user_001', 100, 'SOL', 'addr1');
      const tx2 = bridge.lockBBT('user_001', 200, 'SOL', 'addr2');

      expect(tx1.id).not.toBe(tx2.id);
    });

    it('可查询用户的所有交易', () => {
      bridge.lockBBT('user_001', 100, 'SOL', 'addr1');
      bridge.lockBBT('user_001', 200, 'SOL', 'addr2');
      bridge.lockBBT('user_002', 300, 'SOL', 'addr3');

      const user1Txs = bridge.getUserTransactions('user_001');
      const user2Txs = bridge.getUserTransactions('user_002');

      expect(user1Txs).toHaveLength(2);
      expect(user2Txs).toHaveLength(1);
    });

    it('可查询单笔交易详情', () => {
      const tx = bridge.mintBBT('user_001', 5000, 'source_tx');
      const fetched = bridge.getTransaction(tx.id);

      expect(fetched).toBeDefined();
      expect(fetched!.amount).toBe(5000);
      expect(fetched!.type).toBe('mint');
    });
  });
});

// ── BNB 链专用测试 ──

describe('EVM Bridge (BNB Chain)', () => {
  let bridge: MockEVMBridge;

  beforeEach(() => {
    const bnbConfig: EVMBridgeConfig = {
      chainId: 56,
      chainName: 'BNB',
      bbtTokenAddress: '0xBBBBNB0000000000000000000000000000000000',
      bridgeContractAddress: '0x1111BNB00000000000000000000000000000000',
      relayerAddress: '0xRELAYER_BNB_00000000000000000000000000',
      dailyMintLimit: 50_000,
      dailyBurnLimit: 50_000,
      maxSingleMint: 5000,
      maxSingleBurn: 5000,
      minAmount: 1,
      paused: false,
    };
    bridge = new MockEVMBridge(bnbConfig);
    bridge.setBalance('user_001', 100_000);
  });

  it('BNB 链独立限额', () => {
    // BNB 的 maxSingleMint = 5000
    expect(() => bridge.mintBBT('user_001', 6000, 'tx1')).toThrow(
      'Amount exceeds max single mint',
    );
  });

  it('BNB 链 lock -> Solana', () => {
    const tx = bridge.lockBBT('user_001', 1000, 'SOL', 'SolanaAddr1111111111111');

    expect(tx.sourceChain).toBe('BNB');
    expect(tx.targetChain).toBe('SOL');
  });

  it('BNB 链 mint 从 Solana', () => {
    const tx = bridge.mintBBT('user_001', 3000, 'solana_proof_hash_12345');

    expect(tx.sourceChain).toBe('SOL');
    expect(tx.targetChain).toBe('BNB');
  });
});
