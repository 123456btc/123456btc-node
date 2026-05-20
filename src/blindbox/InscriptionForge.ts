/**
 * InscriptionForge — 铭文铸造系统
 *
 * 核心设计：
 * 1. 四级铭刻：Bronze / Silver / Gold / Diamond
 * 2. 五行元素：金 Metal / 木 Wood / 水 Water / 火 Fire / 土 Earth
 * 3. 稀有度系统：Common / Uncommon / Rare / Epic / Legendary
 * 4. 每个铭文有唯一编号、元素、稀有度、特质、系列、纪元
 * 5. Seed word 可影响铸造结果（加权偏移）
 * 6. 纪元系统：每 1000 个铭文为一个 epoch，自动轮转
 * 7. Genesis Agent 计数器：铭文编号 #0001 开始
 *
 * 安全原则：
 * - 所有随机数使用 crypto.randomBytes（加密安全）
 * - 纯本地模拟模式（不依赖链上）
 * - 铭文记录存储在本地 JSON 文件
 */

import { randomBytes, createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ═══════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════

/** 铭刻等级 */
export enum InscriptionTier {
  BRONZE   = 'bronze',    // 青铜
  SILVER   = 'silver',    // 白银
  GOLD     = 'gold',      // 黄金
  DIAMOND  = 'diamond',   // 钻石
}

/** 五行元素 */
export enum Element {
  METAL = 'metal',  // 金
  WOOD  = 'wood',   // 木
  WATER = 'water',  // 水
  FIRE  = 'fire',   // 火
  EARTH = 'earth',  // 土
}

/** 稀有度 */
export enum Rarity {
  COMMON    = 'common',     // 普通 — 40%
  UNCOMMON  = 'uncommon',   // 稀有 — 25%
  RARE      = 'rare',       // 史诗 — 18%
  EPIC      = 'epic',       // 传说 — 12%
  LEGENDARY = 'legendary',  // 创世 — 5%
}

/** 铭文特质 */
export interface Trait {
  id: string;
  name: string;
  description: string;
  bonus: number; // 加成百分比
}

/** 铭文记录 */
export interface Inscription {
  id: string;                // 唯一 ID (格式: INSC-XXXXXX)
  number: number;            // 全局序号
  tier: InscriptionTier;
  element: Element;
  rarity: Rarity;
  trait: Trait;
  series: string;            // 系列名
  epoch: number;             // 纪元
  name?: string;             // 用户命名
  seedWord?: string;         // 铸造时使用的种子词
  wallet: string;            // 铸造者钱包
  luckScore: number;         // 幸运分数 (0-100)
  createdAt: number;
}

/** 纪元信息 */
export interface EpochInfo {
  epoch: number;
  name: string;
  totalSlots: number;
  filledSlots: number;
  remainingSlots: number;
  progress: number;          // 0-100
  startInscription: number;
  endInscription: number;
  startedAt: number;
}

/** 收藏统计 */
export interface CollectionStats {
  wallet: string;
  totalInscriptions: number;
  luckScore: number;         // 平均幸运分
  rarityDistribution: Record<Rarity, number>;
  tierDistribution: Record<InscriptionTier, number>;
  elementDistribution: Record<Element, number>;
  jackpots: number;          // Legendary 数量
}

/** 排行榜条目 */
export interface LeaderboardEntry {
  rank: number;
  wallet: string;
  luckScore: number;
  totalInscriptions: number;
  jackpots: number;
}

// ═══════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════

const SLOTS_PER_EPOCH = 1000;

const EPOCH_NAMES: Record<number, string> = {
  0: 'Genesis',
  1: 'Awakening',
  2: 'Convergence',
  3: 'Ascension',
  4: 'Eternal',
};

const ELEMENTS: Element[] = [Element.METAL, Element.WOOD, Element.WATER, Element.FIRE, Element.EARTH];
const ELEMENT_ICONS: Record<Element, string> = {
  [Element.METAL]: '⚱️',
  [Element.WOOD]: '🌿',
  [Element.WATER]: '💧',
  [Element.FIRE]: '🔥',
  [Element.EARTH]: '🪨',
};
const ELEMENT_NAMES: Record<Element, string> = {
  [Element.METAL]: 'Metal',
  [Element.WOOD]: 'Wood',
  [Element.WATER]: 'Water',
  [Element.FIRE]: 'Fire',
  [Element.EARTH]: 'Earth',
};

const RARITY_ORDER: Rarity[] = [Rarity.COMMON, Rarity.UNCOMMON, Rarity.RARE, Rarity.EPIC, Rarity.LEGENDARY];
const RARITY_WEIGHTS: Record<Rarity, number> = {
  [Rarity.COMMON]: 4000,
  [Rarity.UNCOMMON]: 2500,
  [Rarity.RARE]: 1800,
  [Rarity.EPIC]: 1200,
  [Rarity.LEGENDARY]: 500,
};
const RARITY_ICONS: Record<Rarity, string> = {
  [Rarity.COMMON]: '⬜',
  [Rarity.UNCOMMON]: '🟢',
  [Rarity.RARE]: '🔵',
  [Rarity.EPIC]: '🟣',
  [Rarity.LEGENDARY]: '🟡',
};
const RARITY_NAMES: Record<Rarity, string> = {
  [Rarity.COMMON]: 'Common',
  [Rarity.UNCOMMON]: 'Uncommon',
  [Rarity.RARE]: 'Rare',
  [Rarity.EPIC]: 'Epic',
  [Rarity.LEGENDARY]: 'Legendary',
};

const TIER_CONFIG: Record<InscriptionTier, { name: string; icon: string; multiplier: number }> = {
  [InscriptionTier.BRONZE]:  { name: 'Bronze',  icon: '🥉', multiplier: 1.0 },
  [InscriptionTier.SILVER]:  { name: 'Silver',  icon: '🥈', multiplier: 1.5 },
  [InscriptionTier.GOLD]:    { name: 'Gold',    icon: '🥇', multiplier: 2.0 },
  [InscriptionTier.DIAMOND]: { name: 'Diamond', icon: '💎', multiplier: 3.0 },
};

const TRAITS: Trait[] = [
  { id: 'swift',      name: 'Swift',      description: 'Quick reflexes, faster execution',     bonus: 5 },
  { id: 'sturdy',     name: 'Sturdy',     description: 'Resilient against market volatility',   bonus: 8 },
  { id: 'lucky',      name: 'Lucky',      description: 'Higher chance of rare drops',           bonus: 12 },
  { id: 'wise',       name: 'Wise',       description: 'Better signal accuracy',                bonus: 10 },
  { id: 'fierce',     name: 'Fierce',     description: 'Aggressive trading style',              bonus: 7 },
  { id: 'calm',       name: 'Calm',       description: 'Patient, waits for optimal entry',      bonus: 9 },
  { id: 'cunning',    name: 'Cunning',    description: 'Exploits arbitrage opportunities',      bonus: 11 },
  { id: 'noble',      name: 'Noble',      description: 'Higher reputation multiplier',           bonus: 15 },
  { id: 'ancient',    name: 'Ancient',    description: 'Genesis-era bonus attributes',           bonus: 20 },
  { id: 'quantum',    name: 'Quantum',    description: 'Entangled probability fields',           bonus: 25 },
];

const SERIES_NAMES = [
  'Dragon Gate', 'Phoenix Rise', 'Tiger Mountain', 'Serpent Coil',
  'Eagle Peak', 'Turtle Shell', 'Fox Spirit', 'Bear Claw',
  'Wolf Pack', 'Crane Wing', 'Monkey King', 'Rat Race',
];

// ═══════════════════════════════════════════════
// InscriptionForge 引擎
// ═══════════════════════════════════════════════

export class InscriptionForge {
  private inscriptions: Inscription[] = [];
  private globalCounter: number = 0;
  private dataPath: string;

  constructor() {
    const configDir = path.join(os.homedir(), '.123456btc-node');
    const dataDir = path.join(configDir, 'data');
    this.dataPath = path.join(dataDir, 'inscriptions.json');
    this.load();
  }

  // ── 核心铸造 ──

  /**
   * 铸造一枚铭文
   * @param tier 铭刻等级
   * @param wallet 铸造者钱包地址
   * @param seedWord 可选种子词（影响结果）
   */
  forge(tier: InscriptionTier, wallet: string, seedWord?: string): Inscription {
    this.globalCounter++;
    const number = this.globalCounter;

    // 生成确定性偏移（如果提供了 seed word）
    const seedOffset = seedWord ? this.hashSeedWord(seedWord) : 0;

    // 五行元素（等概率 + 种子偏移）
    const elementIdx = (this.secureRandom(10000) + seedOffset) % ELEMENTS.length;
    const element = ELEMENTS[elementIdx];

    // 稀有度（加权随机 + 等级加成 + 种子偏移）
    const tierMultiplier = TIER_CONFIG[tier].multiplier;
    const rarity = this.rollRarity(tierMultiplier, seedOffset);

    // 特质（随机选择 + 稀有度加成）
    const trait = this.rollTrait(rarity, seedOffset);

    // 系列（基于 epoch + 种子偏移）
    const epoch = this.getEpoch(number);
    const seriesIdx = (epoch + seedOffset) % SERIES_NAMES.length;
    const series = SERIES_NAMES[seriesIdx];

    // 幸运分数
    const luckScore = this.calculateLuckScore(tier, rarity, trait, seedWord);

    // 铭文 ID
    const id = `INSC-${number.toString().padStart(6, '0')}`;

    const inscription: Inscription = {
      id,
      number,
      tier,
      element,
      rarity,
      trait,
      series,
      epoch: epoch,
      seedWord,
      wallet,
      luckScore,
      createdAt: Date.now(),
    };

    this.inscriptions.push(inscription);
    this.save();

    return inscription;
  }

  // ── 查询 ──

  /** 获取当前纪元信息 */
  getCurrentEpoch(): EpochInfo {
    const currentNumber = this.globalCounter;
    const epoch = this.getEpoch(currentNumber);
    const startInscription = epoch * SLOTS_PER_EPOCH + 1;
    const endInscription = (epoch + 1) * SLOTS_PER_EPOCH;
    const filledSlots = currentNumber - startInscription + 1;
    const remainingSlots = Math.max(0, endInscription - currentNumber);
    const progress = Math.min(100, (filledSlots / SLOTS_PER_EPOCH) * 100);

    const epochName = EPOCH_NAMES[epoch] || `Epoch ${epoch}`;

    // 查找该 epoch 的第一条铭文时间
    const firstInEpoch = this.inscriptions.find(i => i.epoch === epoch);
    const startedAt = firstInEpoch?.createdAt || Date.now();

    return {
      epoch,
      name: epochName,
      totalSlots: SLOTS_PER_EPOCH,
      filledSlots: Math.max(0, filledSlots),
      remainingSlots,
      progress,
      startInscription,
      endInscription,
      startedAt,
    };
  }

  /** 获取所有纪元历史 */
  getAllEpochs(): EpochInfo[] {
    const maxEpoch = this.getEpoch(this.globalCounter);
    const epochs: EpochInfo[] = [];
    for (let e = 0; e <= maxEpoch; e++) {
      const start = e * SLOTS_PER_EPOCH + 1;
      const end = (e + 1) * SLOTS_PER_EPOCH;
      const inscriptionsInEpoch = this.inscriptions.filter(i => i.epoch === e);
      epochs.push({
        epoch: e,
        name: EPOCH_NAMES[e] || `Epoch ${e}`,
        totalSlots: SLOTS_PER_EPOCH,
        filledSlots: inscriptionsInEpoch.length,
        remainingSlots: Math.max(0, SLOTS_PER_EPOCH - inscriptionsInEpoch.length),
        progress: (inscriptionsInEpoch.length / SLOTS_PER_EPOCH) * 100,
        startInscription: start,
        endInscription: end,
        startedAt: inscriptionsInEpoch[0]?.createdAt || Date.now(),
      });
    }
    return epochs;
  }

  /** 获取 Genesis Agent 数量（Epoch 0 的 Legendary 铭文） */
  getGenesisAgentCount(): number {
    return this.inscriptions.filter(i => i.epoch === 0 && i.rarity === Rarity.LEGENDARY).length;
  }

  /** 获取某个钱包的收藏 */
  getCollection(wallet: string): Inscription[] {
    return this.inscriptions.filter(i => i.wallet === wallet);
  }

  /** 获取收藏统计 */
  getCollectionStats(wallet: string): CollectionStats {
    const collection = this.getCollection(wallet);

    const rarityDistribution: Record<Rarity, number> = {
      [Rarity.COMMON]: 0,
      [Rarity.UNCOMMON]: 0,
      [Rarity.RARE]: 0,
      [Rarity.EPIC]: 0,
      [Rarity.LEGENDARY]: 0,
    };
    const tierDistribution: Record<InscriptionTier, number> = {
      [InscriptionTier.BRONZE]: 0,
      [InscriptionTier.SILVER]: 0,
      [InscriptionTier.GOLD]: 0,
      [InscriptionTier.DIAMOND]: 0,
    };
    const elementDistribution: Record<Element, number> = {
      [Element.METAL]: 0,
      [Element.WOOD]: 0,
      [Element.WATER]: 0,
      [Element.FIRE]: 0,
      [Element.EARTH]: 0,
    };

    let totalLuck = 0;
    let jackpots = 0;

    for (const i of collection) {
      rarityDistribution[i.rarity]++;
      tierDistribution[i.tier]++;
      elementDistribution[i.element]++;
      totalLuck += i.luckScore;
      if (i.rarity === Rarity.LEGENDARY) jackpots++;
    }

    return {
      wallet,
      totalInscriptions: collection.length,
      luckScore: collection.length > 0 ? Math.round(totalLuck / collection.length) : 0,
      rarityDistribution,
      tierDistribution,
      elementDistribution,
      jackpots,
    };
  }

  /** 获取排行榜 */
  getLeaderboard(limit: number = 10): LeaderboardEntry[] {
    // 按钱包聚合
    const walletMap = new Map<string, { luckScore: number; count: number; jackpots: number }>();

    for (const i of this.inscriptions) {
      const existing = walletMap.get(i.wallet) || { luckScore: 0, count: 0, jackpots: 0 };
      existing.luckScore += i.luckScore;
      existing.count++;
      if (i.rarity === Rarity.LEGENDARY) existing.jackpots++;
      walletMap.set(i.wallet, existing);
    }

    const entries: LeaderboardEntry[] = [];
    for (const [wallet, stats] of walletMap) {
      entries.push({
        rank: 0,
        wallet,
        luckScore: Math.round(stats.luckScore / stats.count),
        totalInscriptions: stats.count,
        jackpots: stats.jackpots,
      });
    }

    // 排序：先按 jackpots 降序，再按 luckScore 降序
    entries.sort((a, b) => {
      if (b.jackpots !== a.jackpots) return b.jackpots - a.jackpots;
      return b.luckScore - a.luckScore;
    });

    // 填充排名
    entries.forEach((e, i) => e.rank = i + 1);

    return entries.slice(0, limit);
  }

  /** 命名铭文 */
  nameInscription(inscriptionId: string, name: string, wallet: string): Inscription | null {
    const inscription = this.inscriptions.find(i => i.id === inscriptionId && i.wallet === wallet);
    if (!inscription) return null;
    inscription.name = name;
    this.save();
    return inscription;
  }

  /** 获取单个铭文 */
  getInscription(id: string): Inscription | undefined {
    return this.inscriptions.find(i => i.id === id);
  }

  /** 获取总铭文数 */
  getTotalInscriptions(): number {
    return this.globalCounter;
  }

  // ── 内部方法 ──

  private getEpoch(number: number): number {
    return Math.floor((number - 1) / SLOTS_PER_EPOCH);
  }

  private secureRandom(max: number): number {
    const buf = randomBytes(4);
    return buf.readUInt32BE(0) % max;
  }

  private hashSeedWord(word: string): number {
    const hash = createHash('sha256').update(word).digest();
    return hash.readUInt32BE(0) % 100;
  }

  private rollRarity(tierMultiplier: number, seedOffset: number): Rarity {
    // 计算总权重（tier 加成影响稀有度概率）
    const adjustedWeights: Record<Rarity, number> = {
      [Rarity.COMMON]: RARITY_WEIGHTS[Rarity.COMMON] / tierMultiplier,
      [Rarity.UNCOMMON]: RARITY_WEIGHTS[Rarity.UNCOMMON],
      [Rarity.RARE]: RARITY_WEIGHTS[Rarity.RARE] * tierMultiplier,
      [Rarity.EPIC]: RARITY_WEIGHTS[Rarity.EPIC] * tierMultiplier,
      [Rarity.LEGENDARY]: RARITY_WEIGHTS[Rarity.LEGENDARY] * tierMultiplier * 1.2,
    };

    const totalWeight = Object.values(adjustedWeights).reduce((a, b) => a + b, 0);
    let roll = (this.secureRandom(100000) + seedOffset * 100) % totalWeight;

    for (const rarity of RARITY_ORDER) {
      roll -= adjustedWeights[rarity];
      if (roll <= 0) return rarity;
    }

    return Rarity.COMMON;
  }

  private rollTrait(rarity: Rarity, seedOffset: number): Trait {
    // 高稀有度更可能获得高 bonus 特质
    const rarityBonus = RARITY_ORDER.indexOf(rarity);
    const idx = (this.secureRandom(TRAITS.length) + seedOffset + rarityBonus) % TRAITS.length;
    return TRAITS[idx];
  }

  private calculateLuckScore(
    tier: InscriptionTier,
    rarity: Rarity,
    trait: Trait,
    seedWord?: string,
  ): number {
    const tierMult = TIER_CONFIG[tier].multiplier;
    const rarityBonus = RARITY_ORDER.indexOf(rarity) * 15;
    const traitBonus = trait.bonus;
    const seedBonus = seedWord ? (this.hashSeedWord(seedWord) % 10) : 0;
    const base = this.secureRandom(20) + 10; // 10-29 base

    const score = Math.min(100, Math.round(
      (base + rarityBonus + traitBonus + seedBonus) * tierMult / 2
    ));

    return score;
  }

  // ── 持久化 ──

  private load(): void {
    try {
      if (fs.existsSync(this.dataPath)) {
        const data = JSON.parse(fs.readFileSync(this.dataPath, 'utf-8'));
        this.inscriptions = data.inscriptions || [];
        this.globalCounter = data.globalCounter || 0;
      }
    } catch {
      this.inscriptions = [];
      this.globalCounter = 0;
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.dataPath, JSON.stringify({
        inscriptions: this.inscriptions,
        globalCounter: this.globalCounter,
      }, null, 2));
    } catch (err) {
      console.error('[InscriptionForge] Failed to save:', (err as Error).message);
    }
  }
}

// 重新导出常量供 CLI 使用
export {
  ELEMENTS, ELEMENT_ICONS, ELEMENT_NAMES,
  RARITY_ORDER, RARITY_ICONS, RARITY_NAMES,
  TIER_CONFIG, TRAITS, SERIES_NAMES,
};
