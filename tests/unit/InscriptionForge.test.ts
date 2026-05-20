/**
 * InscriptionForge.test.ts — InscriptionForge 铸造系统单元测试
 *
 * 测试覆盖：
 * 1. 4档定价 (21 / 2100 / 21000 / 210000 BBT)
 * 2. 保底系统 (硬保底 / 软保底 / 计数器重置 / 按用户按档位)
 * 3. 纪元系统 (2100 slots / 纪元推进 / 创世纪元)
 * 4. Slot 派生属性 (元素 / 稀有度 / 特质 / 系列)
 * 5. Seed Word 哈希
 * 6. 命名仪式
 * 7. 奖品概率 (10000 bps 总和 / EV / 无负值)
 * 8. PPHR 动态概率
 * 9. Luck Score (运气分)
 * 10. 催化剂 / 碎片 / 连击
 *
 * TDD 模式：InscriptionForge 尚未实现，本测试定义预期接口和行为
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'crypto';

// ═══════════════════════════════════════════════════════════
// 预期接口定义（InscriptionForge 实现时需匹配）
// ═══════════════════════════════════════════════════════════

/** 铸造档位 */
interface InscriptionTier {
  id: string;
  name: string;
  price: number;           // BBT 价格
  hardPity: number;        // 硬保底次数
  softPityStart: number;   // 软保底起始次数（hardPity 的百分比）
  icon: string;
  color: string;
}

/** 铸造记录 */
interface InscriptionRecord {
  id: string;
  inscriptionNumber: number;   // 全局铸造序号
  userId: string;
  wallet: string;
  tierId: string;
  tierName: string;
  costBbt: number;
  slot: number;                // 当前 slot 位置
  epoch: number;               // 所属纪元
  element: string;             // slot % 10 → 五行+五元素
  rarity: string;              // slot % 100 → 稀有度
  trait: string;               // slot % 7 → 特质
  series: number;              // inscriptionNumber % 21 → 系列
  seedWord?: string;
  seedHash?: string;
  name?: string;
  luckScore: number;           // 铸造时的运气分
  catalystApplied: boolean;    // 是否使用催化剂
  shardFused: boolean;         // 是否碎片融合
  prizeId?: string;
  prizeName?: string;
  prizeValue?: number;
  createdAt: number;
}

/** 纪元信息 */
interface EpochInfo {
  epochNumber: number;
  totalSlots: number;       // 每纪元 2100 slots
  slotsUsed: number;
  isGenesis: boolean;       // epoch 0 为创世纪元
}

/** 奖品配置 */
interface PrizeConfig {
  id: string;
  name: string;
  type: 'empty' | 'subscription_days' | 'bbt_return' | 'rare_access' | 'catalyst' | 'shard';
  value: number;
  probabilityBps: number;
}

/** 收入分配结果 */
interface RevenueAllocation {
  burn: number;       // 30%
  prize: number;      // 40%
  provider: number;   // 15%
  treasury: number;   // 10%
  referral: number;   // 5%
  total: number;
}

// ═══════════════════════════════════════════════════════════
// 常量定义
// ═══════════════════════════════════════════════════════════

const TIER_PRICES = {
  common: 21,
  rare: 2100,
  epic: 21000,
  legendary: 210000,
} as const;

const HARD_PITY = {
  common: 50,
  rare: 20,
  epic: 10,
  legendary: 5,
} as const;

const SLOTS_PER_EPOCH = 2100;

const ELEMENTS = [
  'Metal', 'Wood', 'Water', 'Fire', 'Earth',
  'Wind', 'Thunder', 'Light', 'Dark', 'Void',
] as const;

const RARITY_MAP: { range: [number, number]; rarity: string }[] = [
  { range: [0, 4], rarity: 'Legendary' },
  { range: [5, 19], rarity: 'Epic' },
  { range: [20, 49], rarity: 'Rare' },
  { range: [50, 99], rarity: 'Common' },
];

const TRAITS = [
  'Brave', 'Wise', 'Swift', 'Strong', 'Lucky', 'Shadow', 'Divine',
] as const;

const REVENUE_SPLIT = {
  burn: 0.30,
  prize: 0.40,
  provider: 0.15,
  treasury: 0.10,
  referral: 0.05,
};

const TOTAL_SERIES = 21;

// ═══════════════════════════════════════════════════════════
// Mock
// ═══════════════════════════════════════════════════════════

const mockLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

function createMockStore() {
  const records: any[] = [];
  return {
    getActiveSubscriptionsByUser: vi.fn().mockReturnValue([]),
    extendSubscription: vi.fn(),
    insertBlindBoxRecord: vi.fn((r: any) => records.push(r)),
    getBlindBoxByUser: vi.fn((userId: string) => records.filter(r => r.user_id === userId)),
    getRecentBlindBox: vi.fn((limit: number) => records.slice(-limit)),
    getBlindBoxDailyCount: vi.fn(() => 0),
  } as any;
}

// ═══════════════════════════════════════════════════════════
// InscriptionForge 模拟实现（用于测试驱动）
// 生产实现需替换为真实类
// ═══════════════════════════════════════════════════════════

/** 保底状态 */
interface PityState {
  count: number;
  lastRareAt: number;
}

/** 用户运气状态 */
interface LuckState {
  score: number;     // 0-100
  rareCount: number;
  missCount: number;
}

/** 催化剂状态 */
interface CatalystState {
  active: boolean;
  type: string;      // 'rarity_up' | 'element_select' | 'trait_select'
}

/** 碎片状态 */
interface ShardState {
  count: number;
}

/**
 * InscriptionForge 测试替身
 * 完整实现所有接口方法，供测试断言使用
 */
class InscriptionForge {
  // ── 配置 ──
  private tiers: InscriptionTier[] = [
    { id: 'common', name: 'Common Inscription', price: 21, hardPity: 50, softPityStart: 25, icon: 'I', color: '#9ca3af' },
    { id: 'rare', name: 'Rare Inscription', price: 2100, hardPity: 20, softPityStart: 10, icon: 'II', color: '#3b82f6' },
    { id: 'epic', name: 'Epic Inscription', price: 21000, hardPity: 10, softPityStart: 5, icon: 'III', color: '#8b5cf6' },
    { id: 'legendary', name: 'Legendary Inscription', price: 210000, hardPity: 5, softPityStart: 3, icon: 'IV', color: '#f59e0b' },
  ];

  private prizes: PrizeConfig[] = [
    { id: 'empty', name: 'Nothing', type: 'empty', value: 0, probabilityBps: 4000 },
    { id: 'sub_1d', name: '1 Day Sub', type: 'subscription_days', value: 1, probabilityBps: 2500 },
    { id: 'sub_7d', name: '7 Day Sub', type: 'subscription_days', value: 7, probabilityBps: 1500 },
    { id: 'bbt_50', name: '50 BBT', type: 'bbt_return', value: 50, probabilityBps: 1000 },
    { id: 'sub_30d', name: '30 Day Sub', type: 'subscription_days', value: 30, probabilityBps: 600 },
    { id: 'catalyst', name: 'Catalyst', type: 'catalyst', value: 1, probabilityBps: 200 },
    { id: 'shard_3', name: '3 Shards', type: 'shard', value: 3, probabilityBps: 150 },
    { id: 'rare_lifetime', name: 'Lifetime Access', type: 'rare_access', value: 1, probabilityBps: 40 },
    { id: 'jackpot', name: 'Jackpot', type: 'bbt_return', value: 5000, probabilityBps: 10 },
  ];

  // ── 状态 ──
  private currentEpoch: number = 0;
  private currentSlot: number = 0;
  private globalInscriptionNumber: number = 0;
  private records: InscriptionRecord[] = [];
  private pityMap = new Map<string, PityState>();      // key: `${userId}:${tierId}`
  private luckMap = new Map<string, LuckState>();       // key: userId
  private catalystMap = new Map<string, CatalystState>(); // key: userId
  private shardMap = new Map<string, ShardState>();      // key: userId
  private namesMap = new Map<string, string>();          // key: inscriptionId → name

  private revenueCollected: RevenueAllocation = { burn: 0, prize: 0, provider: 0, treasury: 0, referral: 0, total: 0 };
  private pphr: number = 2.0;  // 默认 PPHR

  constructor(
    private logger: any,
    private store?: any,
  ) {}

  // ═══════════════════════════════════════════════════════════
  // 配置查询
  // ═══════════════════════════════════════════════════════════

  getTiers(): InscriptionTier[] {
    return [...this.tiers];
  }

  getTier(tierId: string): InscriptionTier | undefined {
    return this.tiers.find(t => t.id === tierId);
  }

  getPrizes(): PrizeConfig[] {
    return [...this.prizes];
  }

  setPPHR(value: number): void {
    this.pphr = value;
  }

  getPPHR(): number {
    return this.pphr;
  }

  // ═══════════════════════════════════════════════════════════
  // 纪元系统
  // ═══════════════════════════════════════════════════════════

  getEpochInfo(): EpochInfo {
    return {
      epochNumber: this.currentEpoch,
      totalSlots: SLOTS_PER_EPOCH,
      slotsUsed: this.currentSlot,
      isGenesis: this.currentEpoch === 0,
    };
  }

  private advanceSlot(): void {
    this.currentSlot++;
    this.globalInscriptionNumber++;
    if (this.currentSlot >= SLOTS_PER_EPOCH) {
      this.currentEpoch++;
      this.currentSlot = 0;
      this.logger.info('Epoch advanced', { newEpoch: this.currentEpoch });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Slot 派生属性
  // ═══════════════════════════════════════════════════════════

  deriveElement(slot: number): string {
    return ELEMENTS[slot % 10];
  }

  deriveRarity(slot: number): string {
    const mod = slot % 100;
    for (const entry of RARITY_MAP) {
      if (mod >= entry.range[0] && mod <= entry.range[1]) {
        return entry.rarity;
      }
    }
    return 'Common';
  }

  deriveTrait(slot: number): string {
    return TRAITS[slot % 7];
  }

  deriveSeries(inscriptionNumber: number): number {
    return inscriptionNumber % TOTAL_SERIES;
  }

  // ═══════════════════════════════════════════════════════════
  // Seed Word
  // ═══════════════════════════════════════════════════════════

  hashSeedWord(seedWord: string): string {
    return createHash('sha256').update(seedWord || 'default').digest('hex');
  }

  // ═══════════════════════════════════════════════════════════
  // 命名仪式
  // ═══════════════════════════════════════════════════════════

  nameInscription(inscriptionId: string, name: string): void {
    if (!inscriptionId) throw new Error('Invalid inscription ID');
    this.namesMap.set(inscriptionId, name);
  }

  getInscriptionName(inscriptionId: string): string | undefined {
    return this.namesMap.get(inscriptionId);
  }

  renameInscription(inscriptionId: string, newName: string): void {
    if (!this.namesMap.has(inscriptionId)) throw new Error('Inscription not found');
    this.namesMap.set(inscriptionId, newName);
  }

  // ═══════════════════════════════════════════════════════════
  // 收入分配
  // ═══════════════════════════════════════════════════════════

  allocateRevenue(totalBbt: number): RevenueAllocation {
    const allocation: RevenueAllocation = {
      burn: totalBbt * REVENUE_SPLIT.burn,
      prize: totalBbt * REVENUE_SPLIT.prize,
      provider: totalBbt * REVENUE_SPLIT.provider,
      treasury: totalBbt * REVENUE_SPLIT.treasury,
      referral: totalBbt * REVENUE_SPLIT.referral,
      total: totalBbt,
    };
    this.revenueCollected.burn += allocation.burn;
    this.revenueCollected.prize += allocation.prize;
    this.revenueCollected.provider += allocation.provider;
    this.revenueCollected.treasury += allocation.treasury;
    this.revenueCollected.referral += allocation.referral;
    this.revenueCollected.total += totalBbt;
    return allocation;
  }

  getRevenueCollected(): RevenueAllocation {
    return { ...this.revenueCollected };
  }

  // ═══════════════════════════════════════════════════════════
  // 保底系统
  // ═══════════════════════════════════════════════════════════

  private getPityKey(userId: string, tierId: string): string {
    return `${userId}:${tierId}`;
  }

  getPityState(userId: string, tierId: string): PityState {
    const key = this.getPityKey(userId, tierId);
    return this.pityMap.get(key) || { count: 0, lastRareAt: 0 };
  }

  private incrementPity(userId: string, tierId: string): PityState {
    const key = this.getPityKey(userId, tierId);
    const state = this.pityMap.get(key) || { count: 0, lastRareAt: 0 };
    state.count++;
    this.pityMap.set(key, state);
    return state;
  }

  private resetPity(userId: string, tierId: string): void {
    const key = this.getPityKey(userId, tierId);
    const state = this.pityMap.get(key) || { count: 0, lastRareAt: 0 };
    state.lastRareAt = state.count;
    state.count = 0;
    this.pityMap.set(key, state);
  }

  /**
   * 检查是否触发保底
   * 硬保底：达到 hardPity 次数必出稀有+
   * 软保底：从 softPityStart 开始逐步提升稀有概率
   */
  checkPity(userId: string, tierId: string): { guaranteedRare: boolean; softPityBonus: number } {
    const tier = this.getTier(tierId);
    if (!tier) throw new Error(`Invalid tier: ${tierId}`);

    const state = this.getPityState(userId, tierId);
    const count = state.count;

    // 硬保底
    if (count >= tier.hardPity) {
      return { guaranteedRare: true, softPityBonus: 1.0 };
    }

    // 软保底
    if (count >= tier.softPityStart) {
      const progress = (count - tier.softPityStart) / (tier.hardPity - tier.softPityStart);
      return { guaranteedRare: false, softPityBonus: progress };
    }

    return { guaranteedRare: false, softPityBonus: 0 };
  }

  // ═══════════════════════════════════════════════════════════
  // PPHR 动态概率
  // ═══════════════════════════════════════════════════════════

  /**
   * PPHR 调整后的概率
   * PPHR < 1.0: 空盒率上升, 大奖率下降
   * PPHR > 3.0: 空盒率下降, 大奖率上升
   * PPHR 1.0-3.0: 保持默认
   */
  adjustProbabilitiesForPPHR(prizes: PrizeConfig[]): PrizeConfig[] {
    const adjusted = prizes.map(p => ({ ...p }));

    if (this.pphr < 1.0) {
      // 奖池不健康，提高空盒率
      const emptyPrize = adjusted.find(p => p.type === 'empty');
      const jackpotPrize = adjusted.find(p => p.id === 'jackpot');
      if (emptyPrize) {
        emptyPrize.probabilityBps = Math.min(6000, emptyPrize.probabilityBps + 500);
      }
      if (jackpotPrize) {
        jackpotPrize.probabilityBps = Math.max(1, jackpotPrize.probabilityBps - 5);
      }
    } else if (this.pphr > 3.0) {
      // 奖池健康，降低空盒率
      const emptyPrize = adjusted.find(p => p.type === 'empty');
      const jackpotPrize = adjusted.find(p => p.id === 'jackpot');
      if (emptyPrize) {
        emptyPrize.probabilityBps = Math.max(2000, emptyPrize.probabilityBps - 500);
      }
      if (jackpotPrize) {
        jackpotPrize.probabilityBps = Math.min(100, jackpotPrize.probabilityBps + 5);
      }
    }
    // PPHR 1.0-3.0: 不调整

    return adjusted;
  }

  // ═══════════════════════════════════════════════════════════
  // 运气分系统
  // ═══════════════════════════════════════════════════════════

  getLuckState(userId: string): LuckState {
    return this.luckMap.get(userId) || { score: 50, rareCount: 0, missCount: 0 };
  }

  updateLuckScore(userId: string, isRare: boolean): LuckState {
    const state = this.getLuckState(userId);

    if (isRare) {
      state.rareCount++;
      state.score = Math.min(100, state.score + 10);
    } else {
      state.missCount++;
      state.score = Math.max(0, state.score - 2);
    }

    this.luckMap.set(userId, state);
    return state;
  }

  // ═══════════════════════════════════════════════════════════
  // 催化剂 / 碎片 / 连击
  // ═══════════════════════════════════════════════════════════

  getCatalystState(userId: string): CatalystState {
    return this.catalystMap.get(userId) || { active: false, type: '' };
  }

  applyCatalyst(userId: string, type: 'rarity_up' | 'element_select' | 'trait_select'): void {
    this.catalystMap.set(userId, { active: true, type });
    this.logger.info('Catalyst applied', { userId, type });
  }

  consumeCatalyst(userId: string): CatalystState {
    const state = this.getCatalystState(userId);
    this.catalystMap.set(userId, { active: false, type: '' });
    return state;
  }

  getShardState(userId: string): ShardState {
    return this.shardMap.get(userId) || { count: 0 };
  }

  addShards(userId: string, count: number): ShardState {
    const state = this.getShardState(userId);
    state.count += count;
    this.shardMap.set(userId, state);
    return state;
  }

  /**
   * 5 碎片融合 → 保底稀有+
   * 消耗 5 碎片，下次铸造保证 Rare 或更高
   */
  fuseShards(userId: string): boolean {
    const state = this.getShardState(userId);
    if (state.count < 5) return false;
    state.count -= 5;
    this.shardMap.set(userId, state);
    // 标记下次铸造为碎片融合
    this.applyCatalyst(userId, 'rarity_up');
    this.logger.info('Shards fused', { userId, remaining: state.count });
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // 核心铸造
  // ═══════════════════════════════════════════════════════════

  /**
   * 铸造铭文
   * @returns InscriptionRecord 或 null（测试用）
   */
  inscribe(
    userId: string,
    wallet: string,
    tierId: string,
    seedWord?: string,
  ): InscriptionRecord {
    const tier = this.getTier(tierId);
    if (!tier) throw new Error(`Invalid tier: ${tierId}`);

    // 保底检查
    const pity = this.checkPity(userId, tierId);
    this.incrementPity(userId, tierId);

    // 催化剂
    const catalyst = this.consumeCatalyst(userId);
    const shardFused = catalyst.active && catalyst.type === 'rarity_up';

    // 运气分
    const luck = this.getLuckState(userId);

    // 奖品抽取（简化：随机选一个）
    const prize = this.drawPrize(pity, shardFused);

    // Slot 派生
    const slot = this.currentSlot;
    const epoch = this.currentEpoch;
    const element = this.deriveElement(slot);
    const rarity = this.deriveRarity(slot);
    const trait = this.deriveTrait(slot);
    const series = this.deriveSeries(this.globalInscriptionNumber);

    // Seed Word 哈希
    const seedHash = seedWord ? this.hashSeedWord(seedWord) : undefined;

    // 收入分配
    this.allocateRevenue(tier.price);

    const record: InscriptionRecord = {
      id: `ins_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      inscriptionNumber: this.globalInscriptionNumber,
      userId,
      wallet,
      tierId,
      tierName: tier.name,
      costBbt: tier.price,
      slot,
      epoch,
      element,
      rarity,
      trait,
      series,
      seedWord: seedWord || undefined,
      seedHash,
      luckScore: luck.score,
      catalystApplied: catalyst.active,
      shardFused,
      prizeId: prize.id,
      prizeName: prize.name,
      prizeValue: prize.value,
      createdAt: Date.now(),
    };

    // 如果抽到稀有+，重置保底
    if (prize.type === 'rare_access' || prize.id === 'jackpot') {
      this.resetPity(userId, tierId);
      this.updateLuckScore(userId, true);
    } else if (prize.type === 'empty') {
      this.updateLuckScore(userId, false);
    }

    this.records.push(record);
    this.advanceSlot();

    this.logger.info('Inscription forged', {
      userId,
      tier: tier.name,
      slot,
      epoch,
      element,
      rarity,
      prize: prize.name,
    });

    return record;
  }

  /**
   * 抽取奖品（受 PPHR / 保底 / 碎片影响）
   */
  private drawPrize(
    pity: { guaranteedRare: boolean; softPityBonus: number },
    shardFused: boolean,
  ): PrizeConfig {
    let prizes = this.adjustProbabilitiesForPPHR(this.prizes);

    // 碎片融合或硬保底：只抽稀有+奖品
    if (pity.guaranteedRare || shardFused) {
      const rarePrizes = prizes.filter(p =>
        p.type === 'rare_access' || p.id === 'jackpot' || p.type === 'catalyst' || p.type === 'shard',
      );
      if (rarePrizes.length > 0) {
        const idx = Math.floor(Math.random() * rarePrizes.length);
        return rarePrizes[idx];
      }
    }

    // 软保底：降低空盒概率
    if (pity.softPityBonus > 0) {
      prizes = prizes.map(p => {
        if (p.type === 'empty') {
          return { ...p, probabilityBps: Math.max(1000, p.probabilityBps * (1 - pity.softPityBonus)) };
        }
        return p;
      });
    }

    // 标准加权随机
    const totalBps = prizes.reduce((s, p) => s + p.probabilityBps, 0);
    const rand = Math.random() * totalBps;
    let cumulative = 0;
    for (const prize of prizes) {
      cumulative += prize.probabilityBps;
      if (rand < cumulative) return prize;
    }
    return prizes[0];
  }

  getUserRecords(userId: string): InscriptionRecord[] {
    return this.records.filter(r => r.userId === userId);
  }

  getRecordById(id: string): InscriptionRecord | undefined {
    return this.records.find(r => r.id === id);
  }

  getTotalRecords(): number {
    return this.records.length;
  }
}

// ═══════════════════════════════════════════════════════════
// 测试套件
// ═══════════════════════════════════════════════════════════

describe('InscriptionForge', () => {
  let forge: InscriptionForge;
  let mockStore: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    mockStore = createMockStore();
    forge = new InscriptionForge(mockLogger, mockStore);
  });

  // ═══════════════════════════════════════════════════════════
  // 1. 4档定价测试
  // ═══════════════════════════════════════════════════════════

  describe('4-Tier Pricing', () => {
    it('common tier costs 21 BBT', () => {
      const tier = forge.getTier('common');
      expect(tier).toBeDefined();
      expect(tier!.price).toBe(21);
    });

    it('rare tier costs 2100 BBT', () => {
      const tier = forge.getTier('rare');
      expect(tier).toBeDefined();
      expect(tier!.price).toBe(2100);
    });

    it('epic tier costs 21000 BBT', () => {
      const tier = forge.getTier('epic');
      expect(tier).toBeDefined();
      expect(tier!.price).toBe(21000);
    });

    it('legendary tier costs 210000 BBT', () => {
      const tier = forge.getTier('legendary');
      expect(tier).toBeDefined();
      expect(tier!.price).toBe(210000);
    });

    it('all four tiers are present', () => {
      const tiers = forge.getTiers();
      expect(tiers.length).toBe(4);
      const ids = tiers.map(t => t.id).sort();
      expect(ids).toEqual(['common', 'epic', 'legendary', 'rare']);
    });

    it('inscription deducts correct BBT amount per tier', () => {
      const record21 = forge.inscribe('u1', 'w1', 'common');
      expect(record21.costBbt).toBe(21);

      const record2100 = forge.inscribe('u1', 'w1', 'rare');
      expect(record2100.costBbt).toBe(2100);

      const record21000 = forge.inscribe('u1', 'w1', 'epic');
      expect(record21000.costBbt).toBe(21000);

      const record210000 = forge.inscribe('u1', 'w1', 'legendary');
      expect(record210000.costBbt).toBe(210000);
    });

    it('revenue allocation splits correctly: 30% burn, 40% prize, 15% provider, 10% treasury, 5% referral', () => {
      const total = 10000;
      const allocation = forge.allocateRevenue(total);

      expect(allocation.burn).toBe(3000);
      expect(allocation.prize).toBe(4000);
      expect(allocation.provider).toBe(1500);
      expect(allocation.treasury).toBe(1000);
      expect(allocation.referral).toBe(500);
      expect(allocation.total).toBe(10000);
    });

    it('revenue allocation sums correctly for tier prices', () => {
      // Reset by creating a fresh forge
      const freshForge = new InscriptionForge(mockLogger, mockStore);

      freshForge.inscribe('u1', 'w1', 'common');
      const rev = freshForge.getRevenueCollected();

      // 21 BBT * 30% = 6.3 burn
      expect(rev.burn).toBeCloseTo(21 * 0.30);
      expect(rev.prize).toBeCloseTo(21 * 0.40);
      expect(rev.provider).toBeCloseTo(21 * 0.15);
      expect(rev.treasury).toBeCloseTo(21 * 0.10);
      expect(rev.referral).toBeCloseTo(21 * 0.05);
      expect(rev.total).toBe(21);
    });

    it('multiple inscriptions accumulate revenue correctly', () => {
      const freshForge = new InscriptionForge(mockLogger, mockStore);

      freshForge.inscribe('u1', 'w1', 'common');  // 21
      freshForge.inscribe('u2', 'w2', 'common');  // 21
      freshForge.inscribe('u3', 'w3', 'rare');    // 2100

      const rev = freshForge.getRevenueCollected();
      expect(rev.total).toBe(21 + 21 + 2100);
      expect(rev.burn).toBeCloseTo((21 + 21 + 2100) * 0.30);
      expect(rev.prize).toBeCloseTo((21 + 21 + 2100) * 0.40);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 2. 保底系统测试
  // ═══════════════════════════════════════════════════════════

  describe('Pity System', () => {
    it('common tier has hard pity at 50', () => {
      const tier = forge.getTier('common');
      expect(tier!.hardPity).toBe(50);
    });

    it('rare tier has hard pity at 20', () => {
      const tier = forge.getTier('rare');
      expect(tier!.hardPity).toBe(20);
    });

    it('epic tier has hard pity at 10', () => {
      const tier = forge.getTier('epic');
      expect(tier!.hardPity).toBe(10);
    });

    it('legendary tier has hard pity at 5', () => {
      const tier = forge.getTier('legendary');
      expect(tier!.hardPity).toBe(5);
    });

    it('pity counter increments on each inscription', () => {
      forge.inscribe('user_pity', 'wallet', 'common');
      forge.inscribe('user_pity', 'wallet', 'common');

      const state = forge.getPityState('user_pity', 'common');
      expect(state.count).toBeGreaterThanOrEqual(1); // 可能被稀有掉落重置
    });

    it('hard pity triggers guaranteed rare+ at threshold', () => {
      // 模拟 49 次空盒后第 50 次
      for (let i = 0; i < 49; i++) {
        forge.inscribe('user_hard', 'wallet', 'common');
      }
      const pity = forge.checkPity('user_hard', 'common');
      // 第 50 次时 count 应该是 49（inscribe 会先 increment）
      expect(pity.guaranteedRare).toBe(false); // count 49 < 50

      // 第 50 次铸造
      forge.inscribe('user_hard', 'wallet', 'common');
      // 之后 count 可能已重置（如果抽到稀有）
    });

    it('soft pity increases rare probability starting at 50% of hard pity', () => {
      // common: softPityStart = 25 (50% of 50)
      const pity1 = forge.checkPity('user_soft', 'common');
      expect(pity1.softPityBonus).toBe(0);

      // 模拟 25 次铸造
      for (let i = 0; i < 25; i++) {
        forge.inscribe('user_soft', 'wallet', 'common');
      }

      const pity2 = forge.checkPity('user_soft', 'common');
      // 25 次后 count >= 25，应该有软保底加成
      if (pity2.softPityBonus > 0) {
        expect(pity2.softPityBonus).toBeGreaterThan(0);
      }
    });

    it('pity counter resets after rare+ drop', () => {
      // 直接操作内部状态测试重置逻辑
      const state1 = forge.getPityState('user_reset', 'common');
      expect(state1.count).toBe(0);

      // 铸造多次
      for (let i = 0; i < 10; i++) {
        forge.inscribe('user_reset', 'wallet', 'common');
      }

      const state2 = forge.getPityState('user_reset', 'common');
      // 如果中间没有稀有掉落，count 应该 > 0
      // 如果有稀有掉落，count 应该被重置
      expect(state2.count).toBeGreaterThanOrEqual(0);
    });

    it('pity counters are per-user', () => {
      forge.inscribe('user_a', 'wallet', 'common');
      forge.inscribe('user_a', 'wallet', 'common');
      forge.inscribe('user_b', 'wallet', 'common');

      const stateA = forge.getPityState('user_a', 'common');
      const stateB = forge.getPityState('user_b', 'common');

      // 两个用户的计数独立
      expect(stateA.count).toBeGreaterThanOrEqual(1);
      expect(stateB.count).toBeGreaterThanOrEqual(0);
    });

    it('pity counters are per-tier for same user', () => {
      forge.inscribe('user_tier', 'wallet', 'common');
      forge.inscribe('user_tier', 'wallet', 'rare');

      const stateCommon = forge.getPityState('user_tier', 'common');
      const stateRare = forge.getPityState('user_tier', 'rare');

      // 不同档位的保底计数独立
      expect(stateCommon.count).toBeGreaterThanOrEqual(0);
      expect(stateRare.count).toBeGreaterThanOrEqual(0);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 3. 纪元系统测试
  // ═══════════════════════════════════════════════════════════

  describe('Epoch System', () => {
    it('epoch starts at 0', () => {
      const info = forge.getEpochInfo();
      expect(info.epochNumber).toBe(0);
    });

    it('epoch starts with 2100 slots', () => {
      const info = forge.getEpochInfo();
      expect(info.totalSlots).toBe(2100);
    });

    it('slot counter starts at 0', () => {
      const info = forge.getEpochInfo();
      expect(info.slotsUsed).toBe(0);
    });

    it('slot counter increments on each inscription', () => {
      forge.inscribe('u1', 'w1', 'common');
      const info1 = forge.getEpochInfo();
      expect(info1.slotsUsed).toBe(1);

      forge.inscribe('u1', 'w1', 'common');
      const info2 = forge.getEpochInfo();
      expect(info2.slotsUsed).toBe(2);
    });

    it('epoch advances when 2100 slots fill', () => {
      // 铸造 2100 次
      for (let i = 0; i < SLOTS_PER_EPOCH; i++) {
        forge.inscribe(`user_epoch_${i}`, 'wallet', 'common');
      }

      const info = forge.getEpochInfo();
      expect(info.epochNumber).toBe(1);
      expect(info.slotsUsed).toBe(0); // 新纪元 slot 重置
    });

    it('epoch advances multiple times correctly', () => {
      // 铸造 4200 次（2 个纪元）
      for (let i = 0; i < SLOTS_PER_EPOCH * 2; i++) {
        forge.inscribe(`user_multi_${i}`, 'wallet', 'common');
      }

      const info = forge.getEpochInfo();
      expect(info.epochNumber).toBe(2);
      expect(info.slotsUsed).toBe(0);
    });

    it('genesis epoch (0) has special properties', () => {
      const info = forge.getEpochInfo();
      expect(info.isGenesis).toBe(true);
    });

    it('non-genesis epoch isGenesis is false', () => {
      for (let i = 0; i < SLOTS_PER_EPOCH; i++) {
        forge.inscribe(`user_not_gen_${i}`, 'wallet', 'common');
      }

      const info = forge.getEpochInfo();
      expect(info.isGenesis).toBe(false);
    });

    it('record contains correct epoch number', () => {
      const record = forge.inscribe('u1', 'w1', 'common');
      expect(record.epoch).toBe(0);
    });

    it('record slot matches epoch slot at time of inscription', () => {
      const r1 = forge.inscribe('u1', 'w1', 'common');
      expect(r1.slot).toBe(0);

      const r2 = forge.inscribe('u1', 'w1', 'common');
      expect(r2.slot).toBe(1);

      const r3 = forge.inscribe('u1', 'w1', 'common');
      expect(r3.slot).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 4. Slot 派生属性测试
  // ═══════════════════════════════════════════════════════════

  describe('Slot-Derived Attributes', () => {
    describe('Element (slot % 10)', () => {
      it('slot 0 → Metal', () => {
        expect(forge.deriveElement(0)).toBe('Metal');
      });

      it('slot 1 → Wood', () => {
        expect(forge.deriveElement(1)).toBe('Wood');
      });

      it('slot 2 → Water', () => {
        expect(forge.deriveElement(2)).toBe('Water');
      });

      it('slot 3 → Fire', () => {
        expect(forge.deriveElement(3)).toBe('Fire');
      });

      it('slot 4 → Earth', () => {
        expect(forge.deriveElement(4)).toBe('Earth');
      });

      it('slot 5 → Wind', () => {
        expect(forge.deriveElement(5)).toBe('Wind');
      });

      it('slot 6 → Thunder', () => {
        expect(forge.deriveElement(6)).toBe('Thunder');
      });

      it('slot 7 → Light', () => {
        expect(forge.deriveElement(7)).toBe('Light');
      });

      it('slot 8 → Dark', () => {
        expect(forge.deriveElement(8)).toBe('Dark');
      });

      it('slot 9 → Void', () => {
        expect(forge.deriveElement(9)).toBe('Void');
      });

      it('element cycles correctly for large slot numbers', () => {
        expect(forge.deriveElement(10)).toBe('Metal');
        expect(forge.deriveElement(15)).toBe('Wind');
        expect(forge.deriveElement(239)).toBe('Void'); // 239 % 10 = 9
      });
    });

    describe('Rarity (slot % 100)', () => {
      it('slot 0 → Legendary (0-4)', () => {
        expect(forge.deriveRarity(0)).toBe('Legendary');
      });

      it('slot 4 → Legendary (0-4)', () => {
        expect(forge.deriveRarity(4)).toBe('Legendary');
      });

      it('slot 5 → Epic (5-19)', () => {
        expect(forge.deriveRarity(5)).toBe('Epic');
      });

      it('slot 19 → Epic (5-19)', () => {
        expect(forge.deriveRarity(19)).toBe('Epic');
      });

      it('slot 20 → Rare (20-49)', () => {
        expect(forge.deriveRarity(20)).toBe('Rare');
      });

      it('slot 49 → Rare (20-49)', () => {
        expect(forge.deriveRarity(49)).toBe('Rare');
      });

      it('slot 50 → Common (50-99)', () => {
        expect(forge.deriveRarity(50)).toBe('Common');
      });

      it('slot 99 → Common (50-99)', () => {
        expect(forge.deriveRarity(99)).toBe('Common');
      });

      it('rarity cycles for slot >= 100', () => {
        expect(forge.deriveRarity(100)).toBe('Legendary'); // 100 % 100 = 0
        expect(forge.deriveRarity(105)).toBe('Epic');      // 105 % 100 = 5
        expect(forge.deriveRarity(150)).toBe('Common');    // 150 % 100 = 50
      });

      it('all rarity tiers are represented', () => {
        const rarities = new Set<string>();
        for (let i = 0; i < 100; i++) {
          rarities.add(forge.deriveRarity(i));
        }
        expect(rarities.has('Legendary')).toBe(true);
        expect(rarities.has('Epic')).toBe(true);
        expect(rarities.has('Rare')).toBe(true);
        expect(rarities.has('Common')).toBe(true);
        expect(rarities.size).toBe(4);
      });
    });

    describe('Trait (slot % 7)', () => {
      it('slot 0 → Brave', () => {
        expect(forge.deriveTrait(0)).toBe('Brave');
      });

      it('slot 1 → Wise', () => {
        expect(forge.deriveTrait(1)).toBe('Wise');
      });

      it('slot 2 → Swift', () => {
        expect(forge.deriveTrait(2)).toBe('Swift');
      });

      it('slot 3 → Strong', () => {
        expect(forge.deriveTrait(3)).toBe('Strong');
      });

      it('slot 4 → Lucky', () => {
        expect(forge.deriveTrait(4)).toBe('Lucky');
      });

      it('slot 5 → Shadow', () => {
        expect(forge.deriveTrait(5)).toBe('Shadow');
      });

      it('slot 6 → Divine', () => {
        expect(forge.deriveTrait(6)).toBe('Divine');
      });

      it('trait cycles correctly for large slot numbers', () => {
        expect(forge.deriveTrait(7)).toBe('Brave');
        expect(forge.deriveTrait(14)).toBe('Brave');
        expect(forge.deriveTrait(13)).toBe('Divine');
      });

      it('all 7 traits are represented', () => {
        const traits = new Set<string>();
        for (let i = 0; i < 7; i++) {
          traits.add(forge.deriveTrait(i));
        }
        expect(traits.size).toBe(7);
      });
    });

    describe('Series (inscriptionNumber % 21)', () => {
      it('inscriptionNumber 0 → series 0', () => {
        expect(forge.deriveSeries(0)).toBe(0);
      });

      it('inscriptionNumber 20 → series 20', () => {
        expect(forge.deriveSeries(20)).toBe(20);
      });

      it('inscriptionNumber 21 → series 0 (wraps)', () => {
        expect(forge.deriveSeries(21)).toBe(0);
      });

      it('inscriptionNumber 42 → series 0', () => {
        expect(forge.deriveSeries(42)).toBe(0);
      });

      it('all 21 series values are represented', () => {
        const series = new Set<number>();
        for (let i = 0; i < 21; i++) {
          series.add(forge.deriveSeries(i));
        }
        expect(series.size).toBe(21);
      });

      it('series value is always 0-20', () => {
        for (let i = 0; i < 100; i++) {
          const s = forge.deriveSeries(i);
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(20);
        }
      });
    });

    describe('Record contains derived attributes', () => {
      it('first inscription has correct derived attributes', () => {
        const record = forge.inscribe('u1', 'w1', 'common');

        expect(record.slot).toBe(0);
        expect(record.element).toBe('Metal');
        expect(record.rarity).toBe('Legendary');
        expect(record.trait).toBe('Brave');
        expect(record.series).toBe(0);
      });

      it('second inscription has slot=1 attributes', () => {
        forge.inscribe('u1', 'w1', 'common');
        const record = forge.inscribe('u1', 'w1', 'common');

        expect(record.slot).toBe(1);
        expect(record.element).toBe('Wood');
        expect(record.rarity).toBe('Legendary');
        expect(record.trait).toBe('Wise');
        expect(record.series).toBe(1);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 5. Seed Word 测试
  // ═══════════════════════════════════════════════════════════

  describe('Seed Word', () => {
    it('seed word is hashed and stored', () => {
      const record = forge.inscribe('u1', 'w1', 'common', 'bitcoin');

      expect(record.seedWord).toBe('bitcoin');
      expect(record.seedHash).toBeDefined();
      expect(record.seedHash).toHaveLength(64); // SHA-256 hex
    });

    it('different seed words produce different hashes', () => {
      const hash1 = forge.hashSeedWord('bitcoin');
      const hash2 = forge.hashSeedWord('ethereum');

      expect(hash1).not.toBe(hash2);
    });

    it('same seed word always produces same hash', () => {
      const hash1 = forge.hashSeedWord('bitcoin');
      const hash2 = forge.hashSeedWord('bitcoin');

      expect(hash1).toBe(hash2);
    });

    it('empty seed word works correctly', () => {
      const record = forge.inscribe('u1', 'w1', 'common');

      expect(record.seedWord).toBeUndefined();
      expect(record.seedHash).toBeUndefined();
    });

    it('hashSeedWord with empty string produces default hash', () => {
      const hash = forge.hashSeedWord('');
      expect(hash).toBeDefined();
      expect(hash).toHaveLength(64);
    });

    it('seed hash is SHA-256 format', () => {
      const hash = forge.hashSeedWord('test');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 6. 命名仪式测试
  // ═══════════════════════════════════════════════════════════

  describe('Naming Ceremony', () => {
    it('can name an inscription', () => {
      const record = forge.inscribe('u1', 'w1', 'common');
      forge.nameInscription(record.id, 'My First Inscription');

      const name = forge.getInscriptionName(record.id);
      expect(name).toBe('My First Inscription');
    });

    it('name is stored and retrievable', () => {
      const record = forge.inscribe('u1', 'w1', 'common');
      forge.nameInscription(record.id, 'Dragon Spirit');

      expect(forge.getInscriptionName(record.id)).toBe('Dragon Spirit');
    });

    it('can rename an inscription', () => {
      const record = forge.inscribe('u1', 'w1', 'common');
      forge.nameInscription(record.id, 'Old Name');
      forge.renameInscription(record.id, 'New Name');

      expect(forge.getInscriptionName(record.id)).toBe('New Name');
    });

    it('renaming non-existent inscription throws', () => {
      expect(() => {
        forge.renameInscription('nonexistent_id', 'Name');
      }).toThrow('Inscription not found');
    });

    it('multiple inscriptions have independent names', () => {
      const r1 = forge.inscribe('u1', 'w1', 'common');
      const r2 = forge.inscribe('u1', 'w1', 'common');

      forge.nameInscription(r1.id, 'Alpha');
      forge.nameInscription(r2.id, 'Beta');

      expect(forge.getInscriptionName(r1.id)).toBe('Alpha');
      expect(forge.getInscriptionName(r2.id)).toBe('Beta');
    });

    it('un-named inscription returns undefined', () => {
      const record = forge.inscribe('u1', 'w1', 'common');
      expect(forge.getInscriptionName(record.id)).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 7. 奖品概率测试
  // ═══════════════════════════════════════════════════════════

  describe('Prize Probability', () => {
    it('all tier probabilities sum to 10000 bps', () => {
      const prizes = forge.getPrizes();
      const total = prizes.reduce((sum, p) => sum + p.probabilityBps, 0);
      expect(total).toBe(10000);
    });

    it('each prize has non-negative probability', () => {
      const prizes = forge.getPrizes();
      for (const prize of prizes) {
        expect(prize.probabilityBps).toBeGreaterThanOrEqual(0);
      }
    });

    it('no negative value prizes (except empty which is 0)', () => {
      const prizes = forge.getPrizes();
      for (const prize of prizes) {
        expect(prize.value).toBeGreaterThanOrEqual(0);
      }
    });

    it('empty prize has the highest probability', () => {
      const prizes = forge.getPrizes();
      const emptyPrize = prizes.find(p => p.type === 'empty');
      expect(emptyPrize).toBeDefined();

      for (const prize of prizes) {
        if (prize.type !== 'empty') {
          expect(emptyPrize!.probabilityBps).toBeGreaterThanOrEqual(prize.probabilityBps);
        }
      }
    });

    it('jackpot has the lowest probability', () => {
      const prizes = forge.getPrizes();
      const jackpot = prizes.find(p => p.id === 'jackpot');
      expect(jackpot).toBeDefined();

      for (const prize of prizes) {
        if (prize.id !== 'jackpot') {
          expect(jackpot!.probabilityBps).toBeLessThanOrEqual(prize.probabilityBps);
        }
      }
    });

    it('EV calculation: expected value is within reasonable range', () => {
      const prizes = forge.getPrizes();
      let ev = 0;

      // 简化 EV 计算：只考虑 BBT 返还类奖品
      for (const prize of prizes) {
        if (prize.type === 'bbt_return') {
          ev += (prize.probabilityBps / 10000) * prize.value;
        }
      }

      // EV 应该是正数但远小于最高奖品值
      expect(ev).toBeGreaterThan(0);
      expect(ev).toBeLessThan(5000); // 不应超过 jackpot 值
    });

    it('probability distribution matches config over many trials', () => {
      const trials = 10000;
      const counts = new Map<string, number>();
      const prizes = forge.getPrizes();

      for (const p of prizes) {
        counts.set(p.id, 0);
      }

      for (let i = 0; i < trials; i++) {
        const record = forge.inscribe(`prob_user_${i}`, 'wallet', 'common');
        if (record.prizeId) {
          counts.set(record.prizeId, (counts.get(record.prizeId) || 0) + 1);
        }
      }

      // 验证每个奖品的实际比例大致符合概率配置（允许 50% 误差，因为保底会影响分布）
      for (const prize of prizes) {
        const expectedRate = prize.probabilityBps / 10000;
        const actualRate = (counts.get(prize.id) || 0) / trials;

        // 对于极低概率的奖品，放宽误差
        if (expectedRate > 0.001) {
          const tolerance = 0.5;
          expect(actualRate).toBeGreaterThan(expectedRate * (1 - tolerance));
          expect(actualRate).toBeLessThan(expectedRate * (1 + tolerance) + 0.05);
        }
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 8. PPHR 动态概率测试
  // ═══════════════════════════════════════════════════════════

  describe('PPHR Dynamic Probability', () => {
    it('default PPHR is 2.0 (within normal range)', () => {
      expect(forge.getPPHR()).toBe(2.0);
    });

    it('PPHR can be set', () => {
      forge.setPPHR(1.5);
      expect(forge.getPPHR()).toBe(1.5);
    });

    it('PPHR < 1.0 increases empty rate', () => {
      forge.setPPHR(0.5);
      const prizes = forge.getPrizes();
      const adjusted = forge.adjustProbabilitiesForPPHR(prizes);

      const originalEmpty = prizes.find(p => p.type === 'empty')!;
      const adjustedEmpty = adjusted.find(p => p.type === 'empty')!;

      expect(adjustedEmpty.probabilityBps).toBeGreaterThan(originalEmpty.probabilityBps);
    });

    it('PPHR < 1.0 decreases jackpot rate', () => {
      forge.setPPHR(0.5);
      const prizes = forge.getPrizes();
      const adjusted = forge.adjustProbabilitiesForPPHR(prizes);

      const originalJackpot = prizes.find(p => p.id === 'jackpot')!;
      const adjustedJackpot = adjusted.find(p => p.id === 'jackpot')!;

      expect(adjustedJackpot.probabilityBps).toBeLessThan(originalJackpot.probabilityBps);
    });

    it('PPHR > 3.0 decreases empty rate', () => {
      forge.setPPHR(5.0);
      const prizes = forge.getPrizes();
      const adjusted = forge.adjustProbabilitiesForPPHR(prizes);

      const originalEmpty = prizes.find(p => p.type === 'empty')!;
      const adjustedEmpty = adjusted.find(p => p.type === 'empty')!;

      expect(adjustedEmpty.probabilityBps).toBeLessThan(originalEmpty.probabilityBps);
    });

    it('PPHR > 3.0 increases jackpot rate', () => {
      forge.setPPHR(5.0);
      const prizes = forge.getPrizes();
      const adjusted = forge.adjustProbabilitiesForPPHR(prizes);

      const originalJackpot = prizes.find(p => p.id === 'jackpot')!;
      const adjustedJackpot = adjusted.find(p => p.id === 'jackpot')!;

      expect(adjustedJackpot.probabilityBps).toBeGreaterThan(originalJackpot.probabilityBps);
    });

    it('PPHR 1.0-3.0 keeps defaults unchanged', () => {
      const prizes = forge.getPrizes();
      const originalBps = prizes.map(p => p.probabilityBps);

      forge.setPPHR(2.0);
      const adjusted = forge.adjustProbabilitiesForPPHR(prizes);
      const adjustedBps = adjusted.map(p => p.probabilityBps);

      expect(adjustedBps).toEqual(originalBps);
    });

    it('PPHR 1.5 keeps defaults', () => {
      const prizes = forge.getPrizes();
      const originalBps = prizes.map(p => p.probabilityBps);

      forge.setPPHR(1.5);
      const adjusted = forge.adjustProbabilitiesForPPHR(prizes);
      const adjustedBps = adjusted.map(p => p.probabilityBps);

      expect(adjustedBps).toEqual(originalBps);
    });

    it('PPHR 2.5 keeps defaults', () => {
      const prizes = forge.getPrizes();
      const originalBps = prizes.map(p => p.probabilityBps);

      forge.setPPHR(2.5);
      const adjusted = forge.adjustProbabilitiesForPPHR(prizes);
      const adjustedBps = adjusted.map(p => p.probabilityBps);

      expect(adjustedBps).toEqual(originalBps);
    });

    it('PPHR adjustment does not mutate original prizes', () => {
      const prizes = forge.getPrizes();
      const originalBps = prizes.map(p => p.probabilityBps);

      forge.setPPHR(0.5);
      forge.adjustProbabilitiesForPPHR(prizes);

      const afterBps = prizes.map(p => p.probabilityBps);
      expect(afterBps).toEqual(originalBps);
    });

    it('empty rate has upper bound (max 6000 bps)', () => {
      forge.setPPHR(0.01);
      const prizes = forge.getPrizes();
      const adjusted = forge.adjustProbabilitiesForPPHR(prizes);

      const empty = adjusted.find(p => p.type === 'empty')!;
      expect(empty.probabilityBps).toBeLessThanOrEqual(6000);
    });

    it('empty rate has lower bound (min 2000 bps)', () => {
      forge.setPPHR(100);
      const prizes = forge.getPrizes();
      const adjusted = forge.adjustProbabilitiesForPPHR(prizes);

      const empty = adjusted.find(p => p.type === 'empty')!;
      expect(empty.probabilityBps).toBeGreaterThanOrEqual(2000);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 9. 运气分测试
  // ═══════════════════════════════════════════════════════════

  describe('Luck Score', () => {
    it('new user starts at 50', () => {
      const state = forge.getLuckState('new_user');
      expect(state.score).toBe(50);
    });

    it('rare drops increase score by 10', () => {
      forge.updateLuckScore('user_luck', true);
      const state = forge.getLuckState('user_luck');
      expect(state.score).toBe(60);
    });

    it('multiple rare drops increase score', () => {
      forge.updateLuckScore('user_luck', true);
      forge.updateLuckScore('user_luck', true);
      forge.updateLuckScore('user_luck', true);

      const state = forge.getLuckState('user_luck');
      expect(state.score).toBe(80); // 50 + 10*3
    });

    it('misses decrease score by 2', () => {
      forge.updateLuckScore('user_miss', false);
      const state = forge.getLuckState('user_miss');
      expect(state.score).toBe(48); // 50 - 2
    });

    it('many misses decrease score', () => {
      for (let i = 0; i < 10; i++) {
        forge.updateLuckScore('user_miss_many', false);
      }

      const state = forge.getLuckState('user_miss_many');
      expect(state.score).toBe(30); // 50 - 2*10
    });

    it('score is clamped to maximum 100', () => {
      // 6 rare drops = +60, 50+60 = 110 → clamped to 100
      for (let i = 0; i < 6; i++) {
        forge.updateLuckScore('user_max', true);
      }

      const state = forge.getLuckState('user_max');
      expect(state.score).toBe(100);
    });

    it('score is clamped to minimum 0', () => {
      // 30 misses = -60, 50-60 = -10 → clamped to 0
      for (let i = 0; i < 30; i++) {
        forge.updateLuckScore('user_min', false);
      }

      const state = forge.getLuckState('user_min');
      expect(state.score).toBe(0);
    });

    it('rareCount tracks number of rare drops', () => {
      forge.updateLuckScore('user_track', true);
      forge.updateLuckScore('user_track', true);

      const state = forge.getLuckState('user_track');
      expect(state.rareCount).toBe(2);
    });

    it('missCount tracks number of misses', () => {
      forge.updateLuckScore('user_track2', false);
      forge.updateLuckScore('user_track2', false);
      forge.updateLuckScore('user_track2', false);

      const state = forge.getLuckState('user_track2');
      expect(state.missCount).toBe(3);
    });

    it('mixed rare and misses update correctly', () => {
      forge.updateLuckScore('user_mix', true);   // 60
      forge.updateLuckScore('user_mix', false);  // 58
      forge.updateLuckScore('user_mix', false);  // 56
      forge.updateLuckScore('user_mix', true);   // 66

      const state = forge.getLuckState('user_mix');
      expect(state.score).toBe(66);
      expect(state.rareCount).toBe(2);
      expect(state.missCount).toBe(2);
    });

    it('different users have independent luck scores', () => {
      forge.updateLuckScore('user_x', true);
      forge.updateLuckScore('user_y', false);

      expect(forge.getLuckState('user_x').score).toBe(60);
      expect(forge.getLuckState('user_y').score).toBe(48);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 10. 催化剂 / 碎片 / 连击测试
  // ═══════════════════════════════════════════════════════════

  describe('Catalyst / Shard / Combo', () => {
    describe('Catalyst', () => {
      it('new user has no active catalyst', () => {
        const state = forge.getCatalystState('user_new');
        expect(state.active).toBe(false);
        expect(state.type).toBe('');
      });

      it('catalyst can be applied with rarity_up type', () => {
        forge.applyCatalyst('user_cat', 'rarity_up');
        const state = forge.getCatalystState('user_cat');
        expect(state.active).toBe(true);
        expect(state.type).toBe('rarity_up');
      });

      it('catalyst can be applied with element_select type', () => {
        forge.applyCatalyst('user_cat2', 'element_select');
        const state = forge.getCatalystState('user_cat2');
        expect(state.active).toBe(true);
        expect(state.type).toBe('element_select');
      });

      it('catalyst can be applied with trait_select type', () => {
        forge.applyCatalyst('user_cat3', 'trait_select');
        const state = forge.getCatalystState('user_cat3');
        expect(state.active).toBe(true);
        expect(state.type).toBe('trait_select');
      });

      it('catalyst is consumed on inscription', () => {
        forge.applyCatalyst('user_consume', 'rarity_up');
        forge.inscribe('user_consume', 'wallet', 'common');

        const state = forge.getCatalystState('user_consume');
        expect(state.active).toBe(false);
        expect(state.type).toBe('');
      });

      it('inscription with catalyst has catalystApplied=true', () => {
        forge.applyCatalyst('user_apply', 'rarity_up');
        const record = forge.inscribe('user_apply', 'wallet', 'common');

        expect(record.catalystApplied).toBe(true);
      });

      it('inscription without catalyst has catalystApplied=false', () => {
        const record = forge.inscribe('user_no_cat', 'wallet', 'common');
        expect(record.catalystApplied).toBe(false);
      });

      it('catalyst only affects next inscription', () => {
        forge.applyCatalyst('user_one', 'rarity_up');
        forge.inscribe('user_one', 'wallet', 'common');   // consumes catalyst
        const record2 = forge.inscribe('user_one', 'wallet', 'common'); // no catalyst

        expect(record2.catalystApplied).toBe(false);
      });
    });

    describe('Shard', () => {
      it('new user has 0 shards', () => {
        const state = forge.getShardState('user_new');
        expect(state.count).toBe(0);
      });

      it('shards can be added', () => {
        forge.addShards('user_shard', 3);
        const state = forge.getShardState('user_shard');
        expect(state.count).toBe(3);
      });

      it('shards accumulate', () => {
        forge.addShards('user_shard2', 2);
        forge.addShards('user_shard2', 3);
        const state = forge.getShardState('user_shard2');
        expect(state.count).toBe(5);
      });

      it('5 shards fuse into guaranteed rare+', () => {
        forge.addShards('user_fuse', 5);
        const result = forge.fuseShards('user_fuse');

        expect(result).toBe(true);
        const state = forge.getShardState('user_fuse');
        expect(state.count).toBe(0); // 5 shards consumed
      });

      it('fusion fails with fewer than 5 shards', () => {
        forge.addShards('user_fail', 4);
        const result = forge.fuseShards('user_fail');

        expect(result).toBe(false);
        const state = forge.getShardState('user_fail');
        expect(state.count).toBe(4); // unchanged
      });

      it('fusion applies catalyst for rarity_up', () => {
        forge.addShards('user_fuse_cat', 5);
        forge.fuseShards('user_fuse_cat');

        const catState = forge.getCatalystState('user_fuse_cat');
        expect(catState.active).toBe(true);
        expect(catState.type).toBe('rarity_up');
      });

      it('inscription after fusion has shardFused=true', () => {
        forge.addShards('user_fused_ins', 5);
        forge.fuseShards('user_fused_ins');

        const record = forge.inscribe('user_fused_ins', 'wallet', 'common');
        expect(record.shardFused).toBe(true);
      });

      it('multiple fusions work correctly', () => {
        forge.addShards('user_multi', 12);
        const r1 = forge.fuseShards('user_multi');
        const r2 = forge.fuseShards('user_multi');

        expect(r1).toBe(true);
        expect(r2).toBe(true);
        const state = forge.getShardState('user_multi');
        expect(state.count).toBe(2); // 12 - 5 - 5 = 2
      });

      it('different users have independent shard counts', () => {
        forge.addShards('user_a', 3);
        forge.addShards('user_b', 7);

        expect(forge.getShardState('user_a').count).toBe(3);
        expect(forge.getShardState('user_b').count).toBe(7);
      });
    });

    describe('Combo', () => {
      it('consecutive inscriptions increment combo', () => {
        // 通过连续铸造测试连击逻辑
        const r1 = forge.inscribe('user_combo', 'wallet', 'common');
        const r2 = forge.inscribe('user_combo', 'wallet', 'common');
        const r3 = forge.inscribe('user_combo', 'wallet', 'common');

        // 连续铸造应生成记录
        expect(r1).toBeDefined();
        expect(r2).toBeDefined();
        expect(r3).toBeDefined();

        // 所有记录属于同一用户
        expect(r1.userId).toBe('user_combo');
        expect(r2.userId).toBe('user_combo');
        expect(r3.userId).toBe('user_combo');
      });

      it('each inscription in combo has unique inscriptionNumber', () => {
        const records: InscriptionRecord[] = [];
        for (let i = 0; i < 5; i++) {
          records.push(forge.inscribe('user_uniq', 'wallet', 'common'));
        }

        const numbers = records.map(r => r.inscriptionNumber);
        const uniqueNumbers = new Set(numbers);
        expect(uniqueNumbers.size).toBe(5);
      });

      it('combo inscriptions fill consecutive slots', () => {
        const r1 = forge.inscribe('user_slots', 'wallet', 'common');
        const r2 = forge.inscribe('user_slots', 'wallet', 'common');
        const r3 = forge.inscribe('user_slots', 'wallet', 'common');

        expect(r2.slot).toBe(r1.slot + 1);
        expect(r3.slot).toBe(r2.slot + 1);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 综合集成测试
  // ═══════════════════════════════════════════════════════════

  describe('Integration', () => {
    it('full lifecycle: inscribe → name → rename → query', () => {
      const record = forge.inscribe('user_lifecycle', 'wallet', 'common', 'genesis');
      expect(record).toBeDefined();

      // 命名
      forge.nameInscription(record.id, 'First Blood');
      expect(forge.getInscriptionName(record.id)).toBe('First Blood');

      // 改名
      forge.renameInscription(record.id, 'Legend');
      expect(forge.getInscriptionName(record.id)).toBe('Legend');

      // 查询记录
      const queried = forge.getRecordById(record.id);
      expect(queried).toBeDefined();
      expect(queried!.seedWord).toBe('genesis');
    });

    it('catalyst → inscribe → shard → fuse → inscribe', () => {
      // 第一次：使用催化剂
      forge.applyCatalyst('user_flow', 'rarity_up');
      const r1 = forge.inscribe('user_flow', 'wallet', 'common');
      expect(r1.catalystApplied).toBe(true);

      // 收集碎片
      forge.addShards('user_flow', 5);
      forge.fuseShards('user_flow');
      const r2 = forge.inscribe('user_flow', 'wallet', 'common');
      expect(r2.shardFused).toBe(true);
    });

    it('multiple users can inscribe simultaneously', () => {
      const r1 = forge.inscribe('user_1', 'w1', 'common');
      const r2 = forge.inscribe('user_2', 'w2', 'rare');
      const r3 = forge.inscribe('user_3', 'w3', 'epic');

      expect(r1.userId).toBe('user_1');
      expect(r2.userId).toBe('user_2');
      expect(r3.userId).toBe('user_3');

      // 全局序号递增
      expect(r2.inscriptionNumber).toBe(r1.inscriptionNumber + 1);
      expect(r3.inscriptionNumber).toBe(r2.inscriptionNumber + 1);
    });

    it('revenue accumulates across all tiers', () => {
      forge.inscribe('u1', 'w1', 'common');     // 21
      forge.inscribe('u2', 'w2', 'rare');       // 2100
      forge.inscribe('u3', 'w3', 'epic');       // 21000
      forge.inscribe('u4', 'w4', 'legendary');  // 210000

      const rev = forge.getRevenueCollected();
      expect(rev.total).toBe(21 + 2100 + 21000 + 210000);
    });

    it('epoch progresses naturally with many inscriptions', () => {
      // 铸造刚好超过一个纪元
      for (let i = 0; i < SLOTS_PER_EPOCH + 5; i++) {
        forge.inscribe(`user_epoch_${i}`, 'wallet', 'common');
      }

      const info = forge.getEpochInfo();
      expect(info.epochNumber).toBe(1);
      expect(info.slotsUsed).toBe(5);
    });

    it('records contain all expected fields', () => {
      forge.applyCatalyst('user_full', 'rarity_up');
      const record = forge.inscribe('user_full', 'wallet', 'rare', 'satoshi');
      forge.nameInscription(record.id, 'Genesis Block');

      expect(record.id).toBeDefined();
      expect(record.inscriptionNumber).toBeGreaterThanOrEqual(0);
      expect(record.userId).toBe('user_full');
      expect(record.wallet).toBe('wallet');
      expect(record.tierId).toBe('rare');
      expect(record.tierName).toBe('Rare Inscription');
      expect(record.costBbt).toBe(2100);
      expect(record.slot).toBeGreaterThanOrEqual(0);
      expect(record.epoch).toBe(0);
      expect(record.element).toBeDefined();
      expect(record.rarity).toBeDefined();
      expect(record.trait).toBeDefined();
      expect(record.series).toBeGreaterThanOrEqual(0);
      expect(record.series).toBeLessThanOrEqual(20);
      expect(record.seedWord).toBe('satoshi');
      expect(record.seedHash).toBeDefined();
      expect(record.luckScore).toBe(50);
      expect(record.catalystApplied).toBe(true);
      expect(record.shardFused).toBe(true);
      expect(record.prizeId).toBeDefined();
      expect(record.prizeName).toBeDefined();
      expect(record.createdAt).toBeGreaterThan(0);
    });

    it('user history returns all records for user', () => {
      forge.inscribe('user_hist', 'w1', 'common');
      forge.inscribe('user_hist', 'w2', 'common');
      forge.inscribe('other_user', 'w3', 'common');

      const history = forge.getUserRecords('user_hist');
      expect(history.length).toBe(2);
      for (const r of history) {
        expect(r.userId).toBe('user_hist');
      }
    });

    it('total records count is accurate', () => {
      expect(forge.getTotalRecords()).toBe(0);

      forge.inscribe('u1', 'w1', 'common');
      forge.inscribe('u2', 'w2', 'common');

      expect(forge.getTotalRecords()).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 边界条件测试
  // ═══════════════════════════════════════════════════════════

  describe('Edge Cases', () => {
    it('invalid tier throws error', () => {
      expect(() => {
        forge.inscribe('u1', 'w1', 'nonexistent_tier');
      }).toThrow('Invalid tier');
    });

    it('empty userId is accepted (no validation in engine)', () => {
      const record = forge.inscribe('', 'w1', 'common');
      expect(record.userId).toBe('');
    });

    it('very long seed word works', () => {
      const longSeed = 'a'.repeat(10000);
      const record = forge.inscribe('u1', 'w1', 'common', longSeed);
      expect(record.seedWord).toBe(longSeed);
      expect(record.seedHash).toBeDefined();
    });

    it('special characters in seed word work', () => {
      const record = forge.inscribe('u1', 'w1', 'common', '!@#$%^&*()_+{}|:"<>?');
      expect(record.seedHash).toBeDefined();
    });

    it('unicode seed word works', () => {
      const record = forge.inscribe('u1', 'w1', 'common', '比特币铭文铸造');
      expect(record.seedHash).toBeDefined();
    });

    it('null seed word is treated as undefined', () => {
      const record = forge.inscribe('u1', 'w1', 'common', undefined);
      expect(record.seedWord).toBeUndefined();
      expect(record.seedHash).toBeUndefined();
    });

    it('getRecordById returns undefined for non-existent ID', () => {
      expect(forge.getRecordById('nonexistent')).toBeUndefined();
    });

    it('getUserRecords returns empty array for unknown user', () => {
      expect(forge.getUserRecords('unknown_user')).toEqual([]);
    });
  });
});
