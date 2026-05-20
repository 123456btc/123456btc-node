/**
 * BlindBoxEngine (InscriptionForge) — 铭刻锻造系统
 *
 * Merges legacy BlindBox open() with full InscriptionForge.
 * Class kept as BlindBoxEngine for import compatibility.
 *
 * Core Design:
 * 1. 4-tier pricing: Bronze(21) / Silver(2,100) / Gold(21,000) / Diamond(210,000) BBT
 * 2. Pity system: hard pity (guaranteed rare+) + soft pity (+2% per open)
 * 3. Epoch system: 2,100 inscription slots per epoch, auto-advance
 * 4. Slot-derived attributes: element=slot%10, rarity=slot%100, trait=slot%7, series=number%21
 * 5. Seed word: optional user-provided word, SHA256 into the random seed
 * 6. Naming ceremony: post-inscription Agent ID naming
 * 7. Global sequential inscription numbers (low = prestige)
 * 8. Revenue allocation: 30% burn, 40% prize pool, 15% provider, 10% treasury, 5% referral
 * 9. PPHR dynamic probability: pool health ratio adjusts empty/jackpot odds
 */

import 'reflect-metadata';
import { singleton } from 'tsyringe';
import { randomBytes, createHash } from 'crypto';
import { Logger } from '../infra/logger/Logger.js';
import type { SubscriptionStore } from './SubscriptionStore.js';

// ═══════════════════════════════════════════════════════
//  Legacy interfaces (backward compat)
// ═══════════════════════════════════════════════════════

export interface PrizeTier {
  id: string;
  name: string;
  type: 'empty' | 'subscription_days' | 'bbt_return' | 'rare_access';
  value: number;
  probabilityBps: number;
  icon: string;
  color: string;
}

export interface BlindBoxRecord {
  id: string;
  userId: string;
  userWallet: string;
  tierId: string;
  tierName: string;
  costBbt: number;
  createdAt: number;
  claimed: boolean;
  claimTx?: string;
}

export interface BlindBoxConfig {
  priceBbt: number;
  tiers: PrizeTier[];
  dailyLimit: number;
  jackpotPoolBbt: number;
}

// ═══════════════════════════════════════════════════════
//  InscriptionForge types
// ═══════════════════════════════════════════════════════

export type InscriptionTier = 'bronze' | 'silver' | 'gold' | 'diamond';
export type InscriptionElement = 'Void' | 'Fire' | 'Water' | 'Earth' | 'Metal' | 'Wood' | 'Thunder' | 'Wind' | 'Mountain' | 'Crystal';
export type InscriptionRarity = 'Legendary' | 'Epic' | 'Rare' | 'Common';
export type InscriptionTrait = 'Lucky' | 'Wise' | 'Resilient' | 'Swift' | 'Keen' | 'Bold' | 'Serene';
export type LeaderboardType = 'luckiest' | 'whale' | 'opened' | 'jackpot' | 'referral';

/** Slot-derived attributes from the inscription number */
export interface InscriptionAttributes {
  element: InscriptionElement;
  elementIndex: number;
  rarity: InscriptionRarity;
  rarityTier: number;
  trait: InscriptionTrait;
  traitIndex: number;
  series: number;
}

/** Per-user per-tier pity state */
export interface PityState {
  userId: string;
  tier: InscriptionTier;
  counter: number;
  lastRareAt: number;
  softPityActive: boolean;
  totalOpens: number;
}

/** Revenue breakdown for a single inscription */
export interface RevenueAllocation {
  totalBbt: number;
  burnBbt: number;
  prizePoolBbt: number;
  providerBbt: number;
  treasuryBbt: number;
  referralBbt: number;
}

/** Full inscription record */
export interface InscriptionRecord {
  id: string;
  inscriptionNumber: number;
  userId: string;
  wallet: string;
  tier: InscriptionTier;
  tierName: string;
  costBbt: number;
  epoch: number;
  slot: number;
  attributes: InscriptionAttributes;
  seedWordHash?: string;
  name?: string;
  namedAt?: number;
  revenue: RevenueAllocation;
  createdAt: number;
  claimed: boolean;
  claimTx?: string;
}

/** Epoch metadata */
export interface EpochInfo {
  number: number;
  name: string;
  slotsTotal: number;
  slotsFilled: number;
  slotsRemaining: number;
  progress: number;
  isGenesis: boolean;
  startedAt: number;
}

/** Slot hunting info */
export interface SlotMilestone {
  slot: number;
  name: string;
  countdown: number;
}

export interface SlotHuntingInfo {
  currentSlot: number;
  milestones: SlotMilestone[];
}

/** PPHR snapshot */
export interface PPHRSnapshot {
  ratio: number;
  poolBalance: number;
  expectedPayouts: number;
  emptyAdjustmentBps: number;
  jackpotAdjustmentBps: number;
}

/** User collection summary */
export interface UserCollection {
  userId: string;
  inscriptions: InscriptionRecord[];
  totalSpent: number;
  tierCounts: Record<InscriptionTier, number>;
  luckScore: number;
  stats: CollectionStats;
}

export interface CollectionStats {
  total: number;
  byElement: Record<string, number>;
  byRarity: Record<string, number>;
  byTier: Record<string, number>;
}

export interface LeaderboardEntry {
  rank: number;
  wallet: string;
  score: number;
  stats: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════

const EPOCH_SIZE = 2_100;

const ELEMENTS: readonly InscriptionElement[] = [
  'Void', 'Fire', 'Water', 'Earth', 'Metal',
  'Wood', 'Thunder', 'Wind', 'Mountain', 'Crystal',
] as const;

const RARITY_THRESHOLDS: ReadonlyArray<{ max: number; name: InscriptionRarity; tier: number }> = [
  { max: 4, name: 'Legendary', tier: 0 },
  { max: 19, name: 'Epic', tier: 1 },
  { max: 49, name: 'Rare', tier: 2 },
  { max: 99, name: 'Common', tier: 3 },
];

const TRAITS: readonly InscriptionTrait[] = [
  'Lucky', 'Wise', 'Resilient', 'Swift', 'Keen', 'Bold', 'Serene',
] as const;

const RARITY_SCORES: Record<InscriptionRarity, number> = {
  Legendary: 200,
  Epic: 50,
  Rare: 10,
  Common: 1,
};

interface TierConfig {
  id: InscriptionTier;
  name: string;
  nameZh: string;
  costBbt: number;
  hardPity: number;
  softPityStart: number;
  jackpotBaseBps: number;
  rareBaseBps: number;
  icon: string;
  color: string;
}

const TIER_CONFIGS: TierConfig[] = [
  {
    id: 'bronze', name: 'Bronze', nameZh: '青铜',
    costBbt: 21, hardPity: 50, softPityStart: 25,
    jackpotBaseBps: 5, rareBaseBps: 500,
    icon: '🟤', color: '#a0522d',
  },
  {
    id: 'silver', name: 'Silver', nameZh: '白银',
    costBbt: 2_100, hardPity: 20, softPityStart: 10,
    jackpotBaseBps: 20, rareBaseBps: 800,
    icon: '⬜', color: '#c0c0c0',
  },
  {
    id: 'gold', name: 'Gold', nameZh: '黄金',
    costBbt: 21_000, hardPity: 10, softPityStart: 5,
    jackpotBaseBps: 50, rareBaseBps: 1_200,
    icon: '🟨', color: '#ffd700',
  },
  {
    id: 'diamond', name: 'Diamond', nameZh: '钻石',
    costBbt: 210_000, hardPity: 5, softPityStart: 2,
    jackpotBaseBps: 100, rareBaseBps: 2_000,
    icon: '💎', color: '#b9f2ff',
  },
];

// Revenue split (bps out of 10000)
const REVENUE_SPLIT = {
  burn: 3_000,       // 30%
  prizePool: 4_000,  // 40%
  provider: 1_500,   // 15%
  treasury: 1_000,   // 10%
  referral: 500,     // 5%
} as const;

const EPOCH_NAMES: readonly string[] = [
  'Genesis', 'Awakening', 'Convergence', 'Ascendance', 'Transcendence',
  'Eternity', 'Nexus', 'Primordial', 'Celestial', 'Omega',
];

const MILESTONE_SLOTS = [
  21, 100, 210, 500, 1_000, 2_100, 5_000, 10_000, 21_000, 50_000, 100_000, 1_000_000,
];

const MILESTONE_NAMES: Record<number, string> = {
  21: 'First Bronze',
  100: 'First Century',
  210: 'Tenth Percent',
  500: 'Pentagon',
  1_000: 'Millennium',
  2_100: 'Full Epoch',
  5_000: 'Half Deca-K',
  10_000: 'Deca-K',
  21_000: 'Golden Mile',
  50_000: 'Golden Half K',
  100_000: 'Centurion K',
  1_000_000: 'Million',
};

const DEFAULT_LEGACY_TIERS: PrizeTier[] = [
  { id: 'empty', name: '谢谢参与', type: 'empty', value: 0, probabilityBps: 4000, icon: '🌫️', color: '#9ca3af' },
  { id: 'sub_1d', name: '1天策略订阅', type: 'subscription_days', value: 1, probabilityBps: 2500, icon: '📅', color: '#3b82f6' },
  { id: 'sub_7d', name: '7天策略订阅', type: 'subscription_days', value: 7, probabilityBps: 1500, icon: '🎁', color: '#8b5cf6' },
  { id: 'bbt_30', name: '30 BBT 返还', type: 'bbt_return', value: 30, probabilityBps: 1000, icon: '💰', color: '#f59e0b' },
  { id: 'sub_30d', name: '30天策略订阅', type: 'subscription_days', value: 30, probabilityBps: 700, icon: '🚀', color: '#10b981' },
  { id: 'rare_lifetime', name: '终身高级策略', type: 'rare_access', value: 1, probabilityBps: 250, icon: '👑', color: '#ec4899' },
  { id: 'jackpot', name: '超级大奖', type: 'bbt_return', value: 1000, probabilityBps: 50, icon: '💎', color: '#ef4444' },
];

// ═══════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════

/** Returns a float in [0, 1) using crypto.randomBytes */
function secureRandom(): number {
  return randomBytes(4).readUInt32LE(0) / 0xffffffff;
}

/** SHA256 hex digest */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Classify a slot % 100 into rarity */
function classifyRarity(mod100: number): { name: InscriptionRarity; tier: number } {
  for (const threshold of RARITY_THRESHOLDS) {
    if (mod100 <= threshold.max) return { name: threshold.name, tier: threshold.tier };
  }
  return { name: 'Common', tier: 3 };
}

// ═══════════════════════════════════════════════════════
//  BlindBoxEngine (InscriptionForge)
// ═══════════════════════════════════════════════════════

@singleton()
export class BlindBoxEngine {
  // ── Legacy state ──
  private config: BlindBoxConfig;
  // TODO (QT-P2-008): records in-memory only; migrate to SQLite later
  private records: BlindBoxRecord[] = [];
  private userDailyCounts = new Map<string, { count: number; date: string }>();
  private usedPaymentTxes = new Set<string>();

  // ── InscriptionForge state ──

  /** Global sequential inscription counter */
  private nextInscriptionNumber = 1;

  /** Current epoch */
  private currentEpochNumber = 1;

  /** Filled slots in the current epoch */
  private epochSlots = new Set<number>();

  /** Per-user, per-tier pity counters: key = `${userId}:${tier}` */
  private pityCounters = new Map<string, PityState>();

  /** All inscription records */
  private inscriptions: Map<string, InscriptionRecord> = new Map();

  /** Inscriptions indexed by wallet */
  private inscriptionsByWallet = new Map<string, string[]>();

  /** Inscriptions indexed by userId */
  private inscriptionsByUser = new Map<string, string[]>();

  /** Per-tier prize pool balances */
  private prizePools = new Map<InscriptionTier, number>();

  constructor(
    private logger: Logger,
    private store?: SubscriptionStore,
  ) {
    // Legacy config
    this.config = {
      priceBbt: 10,
      tiers: DEFAULT_LEGACY_TIERS,
      dailyLimit: 50,
      jackpotPoolBbt: 0,
    };

    // Initialize prize pools
    for (const tc of TIER_CONFIGS) {
      this.prizePools.set(tc.id, 0);
    }

    this.logger.info('BlindBoxEngine (InscriptionForge) initialized', {
      epoch: 1,
      epochName: 'Genesis',
      tiers: TIER_CONFIGS.map((t) => `${t.name}=${t.costBbt}BBT`),
    });
  }

  // ═══════════════════════════════════════════════════════
  //  Legacy API (backward compatible)
  // ═══════════════════════════════════════════════════════

  getConfig(): BlindBoxConfig {
    return { ...this.config, tiers: [...this.config.tiers] };
  }

  markPaymentUsed(tx: string): boolean {
    if (this.usedPaymentTxes.has(tx)) return false;
    this.usedPaymentTxes.add(tx);
    return true;
  }

  updateTiers(tiers: PrizeTier[]) {
    const total = tiers.reduce((sum, t) => sum + t.probabilityBps, 0);
    if (total !== 10000) {
      throw new Error(`Probability must sum to 10000 bps, got ${total}`);
    }
    this.config.tiers = tiers;
    this.logger.info('BlindBox tiers updated', { tiers: tiers.length });
  }

  /** Legacy open — uses the old single-price blind box system */
  open(userId: string, userWallet: string): BlindBoxRecord {
    const today = new Date().toISOString().slice(0, 10);

    for (const [key, val] of this.userDailyCounts) {
      if (val.date !== today) this.userDailyCounts.delete(key);
    }

    const daily = this.userDailyCounts.get(userId);
    if (daily && daily.date === today && daily.count >= this.config.dailyLimit) {
      throw new Error('Daily blind box limit reached');
    }

    const tier = this.drawLegacyTier();

    if (tier.id === 'empty' || tier.id === 'sub_1d') {
      this.config.jackpotPoolBbt += this.config.priceBbt * 0.5;
    }

    if (tier.id === 'jackpot') {
      const payout = Math.min(this.config.jackpotPoolBbt, tier.value);
      this.config.jackpotPoolBbt -= payout;
      tier.value = payout;
    }

    const record: BlindBoxRecord = {
      id: `box_${Date.now()}_${randomBytes(4).toString('hex')}`,
      userId,
      userWallet,
      tierId: tier.id,
      tierName: tier.name,
      costBbt: this.config.priceBbt,
      createdAt: Date.now(),
      claimed: false,
    };

    if (this.store) {
      this.store.insertBlindBoxRecord({
        id: record.id,
        user_id: record.userId,
        user_wallet: record.userWallet,
        tier_id: record.tierId,
        tier_name: record.tierName,
        cost_bbt: record.costBbt,
        created_at: record.createdAt,
        claimed: record.claimed,
      });
    } else {
      this.records.push(record);
    }

    if (daily && daily.date === today) {
      daily.count++;
    } else {
      this.userDailyCounts.set(userId, { count: 1, date: today });
    }

    this.logger.info('BlindBox opened', {
      userId,
      tier: tier.name,
      value: tier.value,
      jackpotPool: this.config.jackpotPoolBbt,
    });

    return record;
  }

  async claimPrize(record: BlindBoxRecord): Promise<{ success: boolean; detail: string }> {
    if (record.claimed) return { success: false, detail: 'Already claimed' };

    const tier = this.config.tiers.find((t) => t.id === record.tierId);
    if (!tier) return { success: false, detail: 'Tier not found' };

    switch (tier.type) {
      case 'empty':
        record.claimed = true;
        return { success: true, detail: 'Empty box, better luck next time' };
      case 'subscription_days': {
        const subs = this.store?.getActiveSubscriptionsByUser(record.userId) ?? [];
        for (const sub of subs) {
          const currentExpiry = (sub as any).expires_at || Date.now();
          const newExpiry = currentExpiry + tier.value * 24 * 60 * 60 * 1000;
          this.store?.extendSubscription(sub.id, newExpiry);
        }
        record.claimed = true;
        return { success: true, detail: `Extended ${subs.length} subscriptions by ${tier.value} days` };
      }
      case 'bbt_return':
        record.claimed = true;
        return { success: true, detail: `${tier.value} BBT will be transferred to ${record.userWallet}` };
      case 'rare_access':
        record.claimed = true;
        return { success: true, detail: 'Lifetime premium access granted' };
      default:
        return { success: false, detail: 'Unknown prize type' };
    }
  }

  getUserHistory(userId: string): BlindBoxRecord[] {
    if (this.store) {
      const rows = this.store.getBlindBoxByUser(userId);
      return rows.map((r: any) => ({
        id: r.id,
        userId: r.user_id,
        userWallet: r.user_wallet,
        tierId: r.tier_id,
        tierName: r.tier_name,
        costBbt: r.cost_bbt,
        createdAt: r.created_at,
        claimed: !!r.claimed,
        claimTx: r.claim_tx || undefined,
      }));
    }
    return this.records
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  getRecentHistory(limit = 20): BlindBoxRecord[] {
    if (this.store) {
      const rows = this.store.getRecentBlindBox(limit);
      return rows.map((r: any) => ({
        id: r.id,
        userId: r.user_id,
        userWallet: r.user_wallet,
        tierId: r.tier_id,
        tierName: r.tier_name,
        costBbt: r.cost_bbt,
        createdAt: r.created_at,
        claimed: !!r.claimed,
        claimTx: r.claim_tx || undefined,
      }));
    }
    return [...this.records]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  getUserDailyCount(userId: string): number {
    if (this.store) {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const endOfDay = startOfDay + 24 * 60 * 60 * 1000;
      return this.store.getBlindBoxDailyCount(userId, startOfDay, endOfDay);
    }
    const today = new Date().toISOString().slice(0, 10);
    const daily = this.userDailyCounts.get(userId);
    return daily && daily.date === today ? daily.count : 0;
  }

  // ═══════════════════════════════════════════════════════
  //  InscriptionForge — Config
  // ═══════════════════════════════════════════════════════

  getTierConfig(tier: InscriptionTier): TierConfig | undefined {
    return TIER_CONFIGS.find((t) => t.id === tier);
  }

  getAllTierConfigs(): TierConfig[] {
    return [...TIER_CONFIGS];
  }

  // ═══════════════════════════════════════════════════════
  //  InscriptionForge — Core: inscribe()
  // ═══════════════════════════════════════════════════════

  /**
   * Core inscription method. Creates a new Agent ID inscription.
   *
   * Backward-compatible signature: inscribe(wallet, tier, seedWord?)
   * Full signature: inscribe(wallet, tier, seedWord?, userId?, referralId?)
   *
   * @param wallet      - Solana wallet address (also used as userId if userId not given)
   * @param tier        - Pricing tier (bronze/silver/gold/diamond)
   * @param seedWord    - Optional user-provided seed word for provenance
   * @param userId      - Optional internal user ID (defaults to wallet)
   * @param referralId  - Optional referrer ID for referral bonus
   */
  inscribe(
    wallet: string,
    tier: InscriptionTier,
    seedWord?: string,
    userId?: string,
    referralId?: string,
  ): InscriptionRecord {
    const userWallet = wallet;
    if (!userId) userId = wallet;
    const tierConfig = TIER_CONFIGS.find((t) => t.id === tier);
    if (!tierConfig) throw new Error(`Unknown tier: ${tier}`);

    // 1. Allocate slot (auto-advances epoch if full)
    const { slot, epoch } = this.allocateSlot();

    // 2. Global sequential inscription number
    const inscriptionNumber = this.nextInscriptionNumber++;

    // 3. Slot-derived attributes
    const attributes = this.deriveAttributes(slot, inscriptionNumber);

    // 4. Get pity state
    const pity = this.getOrCreatePity(userId, tier);

    // 5. Build random seed incorporating seed word
    const seedWordHash = seedWord ? sha256Hex(seedWord) : undefined;
    const randomSeed = this.buildRandomSeed(userId, tier, inscriptionNumber, slot, seedWord);

    // 6. Draw prize with pity + PPHR adjustments
    const prizeResult = this.drawInscriptionPrize(tierConfig, pity, randomSeed);

    // 7. Update pity counters
    this.updatePity(pity, prizeResult.isRare);

    // 8. Compute and allocate revenue
    const revenue = this.allocateRevenue(tierConfig.costBbt, referralId);

    // 9. Update prize pools
    const currentPool = this.prizePools.get(tier) ?? 0;
    this.prizePools.set(tier, currentPool + revenue.prizePoolBbt);
    this.config.jackpotPoolBbt += revenue.prizePoolBbt;

    // 10. Build record
    const record: InscriptionRecord = {
      id: `ins_${Date.now()}_${randomBytes(4).toString('hex')}`,
      inscriptionNumber,
      userId,
      wallet: userWallet,
      tier: tierConfig.id,
      tierName: `${tierConfig.name} (${tierConfig.nameZh})`,
      costBbt: tierConfig.costBbt,
      epoch,
      slot,
      attributes,
      seedWordHash,
      revenue,
      createdAt: Date.now(),
      claimed: false,
    };

    // 11. Store
    this.inscriptions.set(record.id, record);

    const walletList = this.inscriptionsByWallet.get(userWallet) ?? [];
    walletList.push(record.id);
    this.inscriptionsByWallet.set(userWallet, walletList);

    const userList = this.inscriptionsByUser.get(userId) ?? [];
    userList.push(record.id);
    this.inscriptionsByUser.set(userId, userList);

    // 12. Persist to DB if available
    if (this.store) {
      this.store.insertBlindBoxRecord({
        id: record.id,
        user_id: userId,
        user_wallet: userWallet,
        tier_id: tierConfig.id,
        tier_name: record.tierName,
        cost_bbt: tierConfig.costBbt,
        created_at: record.createdAt,
        claimed: false,
      });
    }

    this.logger.info('Inscription minted', {
      inscriptionNumber,
      userId,
      wallet: userWallet,
      tier: tierConfig.name,
      cost: tierConfig.costBbt,
      slot,
      epoch,
      element: attributes.element,
      rarity: attributes.rarity,
      trait: attributes.trait,
      series: attributes.series,
      pityCounter: pity.counter,
      softPityActive: pity.softPityActive,
      pphr: this.getPPHR(tier).ratio.toFixed(3),
    });

    return record;
  }

  // ═══════════════════════════════════════════════════════
  //  InscriptionForge — Naming Ceremony
  // ═══════════════════════════════════════════════════════

  /**
   * Name an inscription (Agent ID naming ceremony).
   * Names must be 1-64 chars, alphanumeric + underscore + dash.
   */
  nameInscription(
    inscriptionId: string,
    name: string,
    userIdOrWallet: string,
  ): InscriptionRecord {
    const sanitized = name.trim();
    if (sanitized.length === 0 || sanitized.length > 64) {
      throw new Error('Name must be 1-64 characters');
    }
    if (!/^[a-zA-Z0-9_\-\s]+$/.test(sanitized)) {
      throw new Error('Name may only contain alphanumeric, underscore, dash, space');
    }

    const ins = this.inscriptions.get(inscriptionId);
    if (!ins) throw new Error('Inscription not found');
    if (ins.userId !== userIdOrWallet && ins.wallet !== userIdOrWallet) {
      throw new Error('Only the owner can name this inscription');
    }
    if (ins.name) throw new Error('Already named');

    ins.name = sanitized;
    ins.namedAt = Date.now();

    this.logger.info('Inscription named', {
      inscriptionNumber: ins.inscriptionNumber,
      name: sanitized,
      owner: userIdOrWallet,
    });

    return ins;
  }

  // ═══════════════════════════════════════════════════════
  //  InscriptionForge — Queries
  // ═══════════════════════════════════════════════════════

  getInscription(id: string): InscriptionRecord | undefined {
    return this.inscriptions.get(id);
  }

  getInscriptionByNumber(number: number): InscriptionRecord | undefined {
    for (const ins of this.inscriptions.values()) {
      if (ins.inscriptionNumber === number) return ins;
    }
    return undefined;
  }

  getRecentInscriptions(limit = 20): InscriptionRecord[] {
    return [...this.inscriptions.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  getTotalInscriptions(): number {
    return this.inscriptions.size;
  }

  /** Get a user's full collection by userId */
  getUserCollection(userId: string): UserCollection {
    const ids = this.inscriptionsByUser.get(userId) ?? [];
    const inscriptions = ids.map((id) => this.inscriptions.get(id)!).filter(Boolean);
    return this.buildCollection(userId, inscriptions);
  }

  /** Get a user's collection by wallet address */
  getCollection(wallet: string): UserCollection {
    const ids = this.inscriptionsByWallet.get(wallet) ?? [];
    const inscriptions = ids.map((id) => this.inscriptions.get(id)!).filter(Boolean);
    const firstIns = inscriptions[0];
    const userId = firstIns?.userId ?? wallet;
    return this.buildCollection(userId, inscriptions);
  }

  private buildCollection(userId: string, inscriptions: InscriptionRecord[]): UserCollection {
    const tierCounts: Record<InscriptionTier, number> = {
      bronze: 0, silver: 0, gold: 0, diamond: 0,
    };
    let totalSpent = 0;

    for (const ins of inscriptions) {
      tierCounts[ins.tier]++;
      totalSpent += ins.costBbt;
    }

    return {
      userId,
      inscriptions,
      totalSpent,
      tierCounts,
      luckScore: this.calculateLuckScore(inscriptions),
      stats: this.calculateStats(inscriptions),
    };
  }

  /** Get inscriptions for a specific epoch */
  getEpochInscriptions(epochNumber: number): InscriptionRecord[] {
    const results: InscriptionRecord[] = [];
    for (const ins of this.inscriptions.values()) {
      if (ins.epoch === epochNumber) results.push(ins);
    }
    return results.sort((a, b) => a.slot - b.slot);
  }

  // ── Epoch & Slot ──

  getEpochInfo(): EpochInfo {
    const slotsInCurrentEpoch = this.epochSlots.size;
    const nameIdx = (this.currentEpochNumber - 1) % EPOCH_NAMES.length;
    return {
      number: this.currentEpochNumber,
      name: EPOCH_NAMES[nameIdx] ?? `Epoch ${this.currentEpochNumber}`,
      slotsTotal: EPOCH_SIZE,
      slotsFilled: slotsInCurrentEpoch,
      slotsRemaining: EPOCH_SIZE - slotsInCurrentEpoch,
      progress: Math.round((slotsInCurrentEpoch / EPOCH_SIZE) * 10000) / 100,
      isGenesis: this.currentEpochNumber === 1,
      startedAt: Date.now(),
    };
  }

  getSlotHunting(): SlotHuntingInfo {
    const currentSlot = this.nextInscriptionNumber - 1;
    const milestones: SlotMilestone[] = [];

    for (const slot of MILESTONE_SLOTS) {
      if (slot > currentSlot) {
        milestones.push({
          slot,
          name: MILESTONE_NAMES[slot] ?? `Slot ${slot}`,
          countdown: slot - currentSlot,
        });
      }
    }

    return { currentSlot, milestones: milestones.slice(0, 7) };
  }

  // ── Pity ──

  getPityState(userId: string, tier: InscriptionTier): PityState | undefined {
    return this.pityCounters.get(`${userId}:${tier}`);
  }

  /** Get luck score (0-100). Higher = luckier */
  getLuckScore(userId: string): number {
    const ids = this.inscriptionsByUser.get(userId) ?? [];
    const inscriptions = ids.map((id) => this.inscriptions.get(id)!).filter(Boolean);
    return this.calculateLuckScore(inscriptions);
  }

  // ── PPHR ──

  getPPHR(tier: InscriptionTier): PPHRSnapshot {
    const tierConfig = TIER_CONFIGS.find((t) => t.id === tier);
    if (!tierConfig) {
      return { ratio: 1, poolBalance: 0, expectedPayouts: 0, emptyAdjustmentBps: 0, jackpotAdjustmentBps: 0 };
    }

    const poolBalance = this.prizePools.get(tier) ?? 0;
    // Expected avg payout: rare ~= costBbt*3, jackpot ~= costBbt*10
    const avgPayoutPerOpen =
      (tierConfig.rareBaseBps / 10_000) * tierConfig.costBbt * 3 +
      (tierConfig.jackpotBaseBps / 10_000) * tierConfig.costBbt * 10;
    const expectedNext1000 = avgPayoutPerOpen * 1_000;
    const ratio = expectedNext1000 > 0 ? poolBalance / expectedNext1000 : 1;

    let emptyAdjustmentBps = 0;
    let jackpotAdjustmentBps = 0;

    if (ratio < 1.0) {
      emptyAdjustmentBps = 500;    // empty +5%
      jackpotAdjustmentBps = -5000; // jackpot -50%
    } else if (ratio > 3.0) {
      emptyAdjustmentBps = -300;   // empty -3%
      jackpotAdjustmentBps = 10_000; // jackpot +100%
    }

    return { ratio, poolBalance, expectedPayouts: expectedNext1000, emptyAdjustmentBps, jackpotAdjustmentBps };
  }

  // ── Revenue Stats ──

  getRevenueStats(): {
    totalInscriptions: number;
    totalRevenue: number;
    totalBurned: number;
    totalPrizePool: number;
    totalProvider: number;
    totalTreasury: number;
    totalReferral: number;
  } {
    let totalRevenue = 0;
    let totalBurned = 0;
    let totalPrizePool = 0;
    let totalProvider = 0;
    let totalTreasury = 0;
    let totalReferral = 0;

    for (const ins of this.inscriptions.values()) {
      totalRevenue += ins.revenue.totalBbt;
      totalBurned += ins.revenue.burnBbt;
      totalPrizePool += ins.revenue.prizePoolBbt;
      totalProvider += ins.revenue.providerBbt;
      totalTreasury += ins.revenue.treasuryBbt;
      totalReferral += ins.revenue.referralBbt;
    }

    return {
      totalInscriptions: this.inscriptions.size,
      totalRevenue,
      totalBurned,
      totalPrizePool,
      totalProvider,
      totalTreasury,
      totalReferral,
    };
  }

  // ── Leaderboard ──

  getLeaderboard(type: LeaderboardType, limit = 50): LeaderboardEntry[] {
    const entries: { wallet: string; score: number; stats: Record<string, unknown> }[] = [];

    for (const [wallet, ids] of this.inscriptionsByWallet) {
      const inscriptions = ids.map((id) => this.inscriptions.get(id)!).filter(Boolean);
      let score = 0;
      const stats: Record<string, unknown> = {};

      switch (type) {
        case 'luckiest':
          score = this.calculateLuckScore(inscriptions);
          stats.totalInscriptions = inscriptions.length;
          break;
        case 'whale':
          score = inscriptions.reduce((sum, i) => sum + i.costBbt, 0);
          stats.totalValue = score;
          break;
        case 'opened':
          score = inscriptions.length;
          stats.totalOpened = score;
          break;
        case 'jackpot':
          score = inscriptions.filter((i) => i.attributes.rarity === 'Legendary').length;
          stats.legendaryCount = score;
          stats.epicCount = inscriptions.filter((i) => i.attributes.rarity === 'Epic').length;
          break;
        case 'referral':
          score = 0;
          stats.referrals = 0;
          break;
      }

      entries.push({ wallet, score, stats });
    }

    return entries
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry, idx) => ({ rank: idx + 1, ...entry }));
  }

  // ── Attributes ──

  getAttributes(id: string): InscriptionAttributes | null {
    const record = this.inscriptions.get(id);
    return record ? record.attributes : null;
  }

  // ── Backward-compatible aliases ──

  /** Alias for getEpochInfo() — used by older callers */
  getEpochStatus(): EpochInfo {
    return this.getEpochInfo();
  }

  // ═══════════════════════════════════════════════════════
  //  Internal: Slot & Epoch
  // ═══════════════════════════════════════════════════════

  private allocateSlot(): { slot: number; epoch: number } {
    if (this.epochSlots.size >= EPOCH_SIZE) {
      this.advanceEpoch();
    }

    const slot = this.epochSlots.size;
    this.epochSlots.add(slot);

    return { slot, epoch: this.currentEpochNumber };
  }

  private advanceEpoch(): void {
    const prev = this.currentEpochNumber;
    this.currentEpochNumber++;
    this.epochSlots.clear();

    this.logger.info('Epoch advanced', {
      from: prev,
      to: this.currentEpochNumber,
      name: EPOCH_NAMES[(this.currentEpochNumber - 1) % EPOCH_NAMES.length],
    });
  }

  // ═══════════════════════════════════════════════════════
  //  Internal: Attribute Derivation
  // ═══════════════════════════════════════════════════════

  private deriveAttributes(slot: number, inscriptionNumber: number): InscriptionAttributes {
    const elementIndex = slot % 10;
    const mod100 = slot % 100;
    const rarityResult = classifyRarity(mod100);
    const traitIndex = slot % 7;
    const series = inscriptionNumber % 21;

    return {
      element: ELEMENTS[elementIndex],
      elementIndex,
      rarity: rarityResult.name,
      rarityTier: rarityResult.tier,
      trait: TRAITS[traitIndex],
      traitIndex,
      series,
    };
  }

  // ═══════════════════════════════════════════════════════
  //  Internal: Pity System
  // ═══════════════════════════════════════════════════════

  private getOrCreatePity(userId: string, tier: InscriptionTier): PityState {
    const key = `${userId}:${tier}`;
    let pity = this.pityCounters.get(key);
    if (!pity) {
      pity = {
        userId,
        tier,
        counter: 0,
        lastRareAt: 0,
        softPityActive: false,
        totalOpens: 0,
      };
      this.pityCounters.set(key, pity);
    }
    return pity;
  }

  private updatePity(pity: PityState, gotRare: boolean): void {
    pity.totalOpens++;
    if (gotRare) {
      pity.counter = 0;
      pity.lastRareAt = Date.now();
      pity.softPityActive = false;
    } else {
      pity.counter++;
      const tc = TIER_CONFIGS.find((t) => t.id === pity.tier);
      if (tc && pity.counter >= tc.softPityStart) {
        pity.softPityActive = true;
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  //  Internal: Random Seed
  // ═══════════════════════════════════════════════════════

  /**
   * Build a random seed. The seed word is SHA256-hashed and mixed into
   * the entropy but doesn't change the probability distribution — it's
   * stored for on-chain provenance.
   */
  private buildRandomSeed(
    userId: string,
    tier: InscriptionTier,
    inscriptionNumber: number,
    slot: number,
    seedWord?: string,
  ): number {
    const parts = [
      randomBytes(16).toString('hex'),
      userId,
      tier,
      String(inscriptionNumber),
      String(slot),
      String(Date.now()),
      seedWord ?? '',
    ];

    const hash = sha256Hex(parts.join(':'));
    return parseInt(hash.slice(0, 8), 16) / 0xffffffff;
  }

  // ═══════════════════════════════════════════════════════
  //  Internal: Prize Drawing
  // ═══════════════════════════════════════════════════════

  private drawInscriptionPrize(
    tierConfig: TierConfig,
    pity: PityState,
    randomSeed: number,
  ): { isRare: boolean; isJackpot: boolean; prizeType: string } {
    const pphr = this.getPPHR(tierConfig.id);

    // Hard pity: guaranteed rare+
    if (pity.counter >= tierConfig.hardPity) {
      this.logger.info('Hard pity triggered', {
        userId: pity.userId,
        tier: pity.tier,
        counter: pity.counter,
      });
      return { isRare: true, isJackpot: false, prizeType: 'hard_pity_rare' };
    }

    // Base probabilities
    let jackpotBps = tierConfig.jackpotBaseBps;
    let rareBps = tierConfig.rareBaseBps;
    let emptyBps = 4_000;

    // PPHR adjustments
    emptyBps += pphr.emptyAdjustmentBps;
    jackpotBps += Math.round(jackpotBps * (pphr.jackpotAdjustmentBps / 10_000));

    // Soft pity: +2% rare per open after soft pity threshold
    if (pity.softPityActive) {
      const bonusBps = (pity.counter - tierConfig.softPityStart) * 200;
      rareBps += bonusBps;
      emptyBps = Math.max(1_000, emptyBps - bonusBps);
    }

    // Clamp
    jackpotBps = Math.max(1, Math.min(5_000, jackpotBps));
    rareBps = Math.max(100, Math.min(8_000, rareBps));
    emptyBps = Math.max(500, Math.min(8_000, emptyBps));

    // Normalize to <= 10000
    const totalBps = emptyBps + rareBps + jackpotBps;
    if (totalBps > 10_000) {
      const scale = 10_000 / totalBps;
      emptyBps = Math.round(emptyBps * scale);
      rareBps = Math.round(rareBps * scale);
      jackpotBps = Math.round(jackpotBps * scale);
    }

    // Draw
    const rand = randomSeed * 10_000;
    let cumulative = 0;

    cumulative += jackpotBps;
    if (rand < cumulative) {
      return { isRare: true, isJackpot: true, prizeType: 'jackpot' };
    }

    cumulative += rareBps;
    if (rand < cumulative) {
      return { isRare: true, isJackpot: false, prizeType: 'rare' };
    }

    return { isRare: false, isJackpot: false, prizeType: 'common' };
  }

  // ═══════════════════════════════════════════════════════
  //  Internal: Revenue Allocation
  // ═══════════════════════════════════════════════════════

  private allocateRevenue(costBbt: number, referralId?: string): RevenueAllocation {
    const totalBbt = costBbt;
    const burnBbt = Math.floor(totalBbt * REVENUE_SPLIT.burn / 10_000);
    const prizePoolBbt = Math.floor(totalBbt * REVENUE_SPLIT.prizePool / 10_000);
    const providerBbt = Math.floor(totalBbt * REVENUE_SPLIT.provider / 10_000);
    const treasuryBbt = Math.floor(totalBbt * REVENUE_SPLIT.treasury / 10_000);
    // Referral gets the remainder to avoid rounding dust
    const referralBbt = totalBbt - burnBbt - prizePoolBbt - providerBbt - treasuryBbt;

    return { totalBbt, burnBbt, prizePoolBbt, providerBbt, treasuryBbt, referralBbt };
  }

  // ═══════════════════════════════════════════════════════
  //  Internal: Legacy draw (unchanged)
  // ═══════════════════════════════════════════════════════

  private drawLegacyTier(): PrizeTier {
    const rand = randomBytes(4).readUInt32LE(0) / 0xffffffff;
    let cumulative = 0;
    for (const tier of this.config.tiers) {
      cumulative += tier.probabilityBps / 10000;
      if (rand < cumulative) return tier;
    }
    return this.config.tiers[0];
  }

  // ═══════════════════════════════════════════════════════
  //  Internal: Luck & Stats
  // ═══════════════════════════════════════════════════════

  private calculateLuckScore(inscriptions: InscriptionRecord[]): number {
    if (inscriptions.length === 0) return 50;

    const totalScore = inscriptions.reduce(
      (sum, ins) => sum + (RARITY_SCORES[ins.attributes.rarity] ?? 0),
      0,
    );
    // Normalize to 0-100: avg rarity score, with 1=common being 20, 200=legendary being 100
    const avg = totalScore / inscriptions.length;
    return Math.min(100, Math.round((avg / 200) * 100));
  }

  private calculateStats(inscriptions: InscriptionRecord[]): CollectionStats {
    const byElement: Record<string, number> = {};
    const byRarity: Record<string, number> = {};
    const byTier: Record<string, number> = {};

    for (const ins of inscriptions) {
      byElement[ins.attributes.element] = (byElement[ins.attributes.element] || 0) + 1;
      byRarity[ins.attributes.rarity] = (byRarity[ins.attributes.rarity] || 0) + 1;
      byTier[ins.tier] = (byTier[ins.tier] || 0) + 1;
    }

    return { total: inscriptions.length, byElement, byRarity, byTier };
  }
}
