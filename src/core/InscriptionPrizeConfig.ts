/**
 * InscriptionPrizeConfig — InscriptionForge 奖品配置系统
 *
 * 核心设计：
 * 1. 12 大奖品类别覆盖完整生态功能
 * 2. 6 稀有度层级：Common → Mythic
 * 3. 4 个盲盒档位：21 / 2100 / 21000 / 210000 BBT
 * 4. 跨阶催化剂系统：Green → Cosmic
 * 5. 神秘碎片收集与融合
 * 6. 连击奖励机制
 * 7. 收益分配配置
 *
 * 概率单位：Basis Points (万分之)，每档概率总和 = 10000
 */

import { randomBytes } from 'crypto';

// ═══════════════════════════════════════════════════════════════════
// 1. 类型定义
// ═══════════════════════════════════════════════════════════════════

/** 12 大奖品类别 */
export type PrizeCategory =
  | 'BBT'   // BBT Token
  | 'SUB'   // Strategy Subscription
  | 'AAP'   // Agent Access Pass
  | 'AIN'   // Agent ID NFT
  | 'STK'   // Staking Boost
  | 'RST'   // Revenue Share Token
  | 'BBV'   // Blind Box Voucher
  | 'UPC'   // Upgrade Catalyst
  | 'GOV'   // Governance Token
  | 'EAK'   // Early Access Key
  | 'COS'   // Cosmetic Collectible
  | 'MYS';  // Mystery Prize

/** 6 稀有度层级 */
export type RarityTier = 'Common' | 'Uncommon' | 'Rare' | 'Epic' | 'Legendary' | 'Mythic';

/** 4 个盲盒档位 */
export type BoxTier = 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM';

/** 催化剂类型 */
export type CatalystType = 'GREEN' | 'BLUE' | 'PURPLE' | 'GOLD' | 'RAINBOW' | 'VOID' | 'COSMIC';

/** 碎片类型 */
export type ShardType = 'STRATEGY' | 'AGENT' | 'REVENUE' | 'GOVERNANCE' | 'COSMIC';

/** 连击类型 */
export type ComboType = 'STARTER_STREAK' | 'TRADER_RUSH' | 'PREMIUM_ASCENSION' | 'WHALE_RITUAL' | 'FULL_SPECTRUM';

// ═══════════════════════════════════════════════════════════════════
// 2. 接口定义
// ═══════════════════════════════════════════════════════════════════

/** 奖品配置 */
export interface PrizeConfig {
  id: string;
  category: PrizeCategory;
  rarity: RarityTier;
  value: number;
  probabilityBps: number;      // 万分比概率
  name: string;
  icon: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

/** 催化剂配置 */
export interface CatalystConfig {
  type: CatalystType;
  name: string;
  icon: string;
  sourceTier: BoxTier;         // 来源盲盒档位
  effect: CatalystEffect;
  dropRateBps: number;         // 万分比掉率
  description: string;
  color: string;
}

/** 催化剂效果 */
export interface CatalystEffect {
  type: 'probability_boost' | 'rarity_upgrade' | 'guaranteed_drop' | 'multi_draw' | 'special_unlock';
  value: number;               // 效果数值
  duration?: number;           // 持续时间（毫秒）
  targetRarity?: RarityTier;   // 目标稀有度
}

/** 碎片配置 */
export interface ShardConfig {
  type: ShardType;
  name: string;
  icon: string;
  color: string;
  fusionResult: FusionResult;
  sourceTiers: BoxTier[];      // 可产出的盲盒档位
  dropRateBps: number;
  requiredCount: number;       // 融合所需数量
  description: string;
}

/** 融合结果 */
export interface FusionResult {
  category: PrizeCategory;
  rarity: RarityTier;
  name: string;
  icon: string;
  value: number;
  description: string;
}

/** 连击配置 */
export interface ComboConfig {
  type: ComboType;
  name: string;
  icon: string;
  requirements: ComboRequirement;
  bonus: ComboBonus;
  description: string;
  color: string;
}

/** 连击要求 */
export interface ComboRequirement {
  consecutiveDraws: number;    // 连续抽取次数
  withinTimeMs?: number;       // 时间窗口（毫秒）
  minTier?: BoxTier;           // 最低档位
  specificCategories?: PrizeCategory[];  // 特定类别
  minRarity?: RarityTier;      // 最低稀有度
}

/** 连击奖励 */
export interface ComboBonus {
  type: 'multiplier' | 'guaranteed_rarity' | 'extra_draw' | 'token_bonus' | 'special_prize';
  value: number;
  targetRarity?: RarityTier;
  description: string;
}

/** 收益分配配置 */
export interface RevenueAllocation {
  burnPercent: number;         // 销毁比例
  prizePoolPercent: number;    // 奖池比例
  providerPercent: number;     // 运营商比例
  treasuryPercent: number;     // 国库比例
  referralPercent: number;     // 推荐奖励比例
}

/** 档位配置 */
export interface BoxTierConfig {
  tier: BoxTier;
  name: string;
  bbtCost: number;
  usdtEquiv: number;
  icon: string;
  color: string;
  prizes: PrizeConfig[];
  catalystDrops: CatalystType[];
  shardDrops: ShardType[];
  pityCounter: PityConfig;
  revenueAllocation: RevenueAllocation;
}

/** 保底配置 */
export interface PityConfig {
  enabled: boolean;
  threshold: number;           // 保底触发次数
  guaranteedRarity: RarityTier; // 保底稀有度
  escalationRateBps: number;   // 每次未中稀有品，概率提升（万分比）
}

/** 抽奖结果 */
export interface DrawResult {
  prize: PrizeConfig;
  catalyst?: CatalystConfig;
  shard?: ShardConfig;
  combo?: ComboConfig;
  isPity: boolean;
  drawIndex: number;
  timestamp: number;
}

/** 期望值计算结果 */
export interface ExpectedValue {
  tier: BoxTier;
  evBBT: number;               // 期望 BBT 回报
  evUSD: number;               // 期望 USD 回报
  roiPercent: number;          // 投资回报率
  breakdown: {
    category: PrizeCategory;
    probability: number;
    expectedValue: number;
  }[];
}

// ═══════════════════════════════════════════════════════════════════
// 3. 常量定义
// ═══════════════════════════════════════════════════════════════════

/** 稀有度权重（用于期望值计算） */
export const RARITY_WEIGHTS: Record<RarityTier, number> = {
  Common: 1,
  Uncommon: 2,
  Rare: 5,
  Epic: 15,
  Legendary: 50,
  Mythic: 200,
};

/** 稀有度颜色 */
export const RARITY_COLORS: Record<RarityTier, string> = {
  Common: '#9ca3af',
  Uncommon: '#22c55e',
  Rare: '#3b82f6',
  Epic: '#a855f7',
  Legendary: '#f59e0b',
  Mythic: '#ef4444',
};

/** BBT 到 USD 换算率（可动态更新） */
export const BBT_USD_RATE = 0.01; // 1 BBT = $0.01

// ═══════════════════════════════════════════════════════════════════
// 4. 奖品池配置 — BRONZE (21 BBT)
// ═══════════════════════════════════════════════════════════════════

export const BRONZE_PRIZES: PrizeConfig[] = [
  // ── Common (4000 bps = 40%) ──
  { id: 'bt_5', category: 'BBT', rarity: 'Common', value: 5, probabilityBps: 1650, name: '5 BBT', icon: '💰', description: 'Small BBT reward' },
  { id: 'sub_1d', category: 'SUB', rarity: 'Common', value: 1, probabilityBps: 1375, name: '1-Day Strategy', icon: '📅', description: '1 day strategy subscription' },
  { id: 'bbv_bronze', category: 'BBV', rarity: 'Common', value: 1, probabilityBps: 625, name: 'Bronze Voucher', icon: '🎫', description: '1 free bronze box draw' },
  { id: 'cos_common', category: 'COS', rarity: 'Common', value: 1, probabilityBps: 350, name: 'Common Badge', icon: '🏷️', description: 'Profile badge collectible' },

  // ── Uncommon (3000 bps = 30%) ──
  { id: 'bt_15', category: 'BBT', rarity: 'Uncommon', value: 15, probabilityBps: 1200, name: '15 BBT', icon: '💰', description: 'Medium BBT reward' },
  { id: 'sub_3d', category: 'SUB', rarity: 'Uncommon', value: 3, probabilityBps: 900, name: '3-Day Strategy', icon: '📅', description: '3 days strategy subscription' },
  { id: 'stk_10', category: 'STK', rarity: 'Uncommon', value: 10, probabilityBps: 550, name: '10 Staking Boost', icon: '📈', description: '10 BBT staking boost' },
  { id: 'upc_green', category: 'UPC', rarity: 'Uncommon', value: 1, probabilityBps: 350, name: 'Green Catalyst', icon: '🟢', description: 'Uncommon upgrade catalyst' },

  // ── Rare (2000 bps = 20%) ──
  { id: 'bt_50', category: 'BBT', rarity: 'Rare', value: 50, probabilityBps: 800, name: '50 BBT', icon: '💰', description: 'Large BBT reward' },
  { id: 'sub_7d', category: 'SUB', rarity: 'Rare', value: 7, probabilityBps: 600, name: '7-Day Strategy', icon: '📅', description: '1 week strategy subscription' },
  { id: 'eak_bronze', category: 'EAK', rarity: 'Rare', value: 1, probabilityBps: 350, name: 'Early Access Key', icon: '🔑', description: 'Early feature access' },
  { id: 'shard_strat', category: 'MYS', rarity: 'Rare', value: 1, probabilityBps: 250, name: 'Strategy Shard', icon: '🔷', description: 'Strategy shard fragment' },

  // ── Epic (750 bps = 7.5%) ──
  { id: 'bt_200', category: 'BBT', rarity: 'Epic', value: 200, probabilityBps: 300, name: '200 BBT', icon: '💰', description: 'Epic BBT reward' },
  { id: 'sub_30d', category: 'SUB', rarity: 'Epic', value: 30, probabilityBps: 200, name: '30-Day Strategy', icon: '📅', description: '1 month strategy subscription' },
  { id: 'rst_1p', category: 'RST', rarity: 'Epic', value: 1, probabilityBps: 150, name: '1% Revenue Share', icon: '📊', description: '1% revenue share token' },
  { id: 'upc_blue', category: 'UPC', rarity: 'Epic', value: 1, probabilityBps: 100, name: 'Blue Catalyst', icon: '🔵', description: 'Epic upgrade catalyst' },

  // ── Legendary (200 bps = 2%) ──
  { id: 'bt_1000', category: 'BBT', rarity: 'Legendary', value: 1000, probabilityBps: 80, name: '1000 BBT', icon: '💰', description: 'Legendary BBT reward' },
  { id: 'ain_bronze', category: 'AIN', rarity: 'Legendary', value: 1, probabilityBps: 50, name: 'Agent ID NFT', icon: '🤖', description: 'Basic Agent ID NFT' },
  { id: 'gov_10', category: 'GOV', rarity: 'Legendary', value: 10, probabilityBps: 40, name: '10 Gov Tokens', icon: '🏛️', description: '10 governance tokens' },
  { id: 'sub_90d', category: 'SUB', rarity: 'Legendary', value: 90, probabilityBps: 30, name: '90-Day Strategy', icon: '📅', description: '3 months strategy subscription' },

  // ── Mythic (50 bps = 0.5%) ──
  { id: 'bt_5000', category: 'BBT', rarity: 'Mythic', value: 5000, probabilityBps: 20, name: '5000 BBT', icon: '💰', description: 'Mythic BBT jackpot' },
  { id: 'sub_lifetime', category: 'SUB', rarity: 'Mythic', value: 0, probabilityBps: 15, name: 'Lifetime Strategy', icon: '👑', description: 'Lifetime strategy access (expires_at=0)' },
  { id: 'ain_legendary', category: 'AIN', rarity: 'Mythic', value: 1, probabilityBps: 10, name: 'Legendary Agent NFT', icon: '🤖', description: 'Legendary tier Agent ID NFT' },
  { id: 'upc_cosmic', category: 'UPC', rarity: 'Mythic', value: 1, probabilityBps: 5, name: 'Cosmic Catalyst', icon: '🌌', description: 'Mythic cosmic catalyst' },
];

// ═══════════════════════════════════════════════════════════════════
// 5. 奖品池配置 — SILVER (2100 BBT)
// ═══════════════════════════════════════════════════════════════════

export const SILVER_PRIZES: PrizeConfig[] = [
  // ── Common (2500 bps = 25%) ──
  { id: 'sv_bt_100', category: 'BBT', rarity: 'Common', value: 100, probabilityBps: 1000, name: '100 BBT', icon: '💰', description: 'Small BBT reward' },
  { id: 'sv_sub_3d', category: 'SUB', rarity: 'Common', value: 3, probabilityBps: 800, name: '3-Day Strategy', icon: '📅', description: '3 days strategy subscription' },
  { id: 'sv_bbv_silver', category: 'BBV', rarity: 'Common', value: 1, probabilityBps: 400, name: 'Silver Voucher', icon: '🎫', description: '1 free silver box draw' },
  { id: 'sv_cos_uncommon', category: 'COS', rarity: 'Common', value: 2, probabilityBps: 300, name: 'Silver Badge', icon: '🏷️', description: 'Silver tier collectible' },

  // ── Uncommon (3000 bps = 30%) ──
  { id: 'sv_bt_300', category: 'BBT', rarity: 'Uncommon', value: 300, probabilityBps: 1200, name: '300 BBT', icon: '💰', description: 'Medium BBT reward' },
  { id: 'sv_sub_7d', category: 'SUB', rarity: 'Uncommon', value: 7, probabilityBps: 900, name: '7-Day Strategy', icon: '📅', description: '1 week strategy subscription' },
  { id: 'sv_stk_50', category: 'STK', rarity: 'Uncommon', value: 50, probabilityBps: 500, name: '50 Staking Boost', icon: '📈', description: '50 BBT staking boost' },
  { id: 'sv_upc_green', category: 'UPC', rarity: 'Uncommon', value: 2, probabilityBps: 400, name: 'Green Catalyst x2', icon: '🟢', description: '2x green catalysts' },

  // ── Rare (2500 bps = 25%) ──
  { id: 'sv_bt_1000', category: 'BBT', rarity: 'Rare', value: 1000, probabilityBps: 1000, name: '1000 BBT', icon: '💰', description: 'Large BBT reward' },
  { id: 'sv_sub_30d', category: 'SUB', rarity: 'Rare', value: 30, probabilityBps: 700, name: '30-Day Strategy', icon: '📅', description: '1 month strategy subscription' },
  { id: 'sv_eak_silver', category: 'EAK', rarity: 'Rare', value: 2, probabilityBps: 450, name: 'Premium Early Key', icon: '🔑', description: 'Premium early feature access' },
  { id: 'sv_rst_2p', category: 'RST', rarity: 'Rare', value: 2, probabilityBps: 350, name: '2% Revenue Share', icon: '📊', description: '2% revenue share token' },

  // ── Epic (1200 bps = 12%) ──
  { id: 'sv_bt_5000', category: 'BBT', rarity: 'Epic', value: 5000, probabilityBps: 500, name: '5000 BBT', icon: '💰', description: 'Epic BBT reward' },
  { id: 'sv_sub_90d', category: 'SUB', rarity: 'Epic', value: 90, probabilityBps: 300, name: '90-Day Strategy', icon: '📅', description: '3 months strategy subscription' },
  { id: 'sv_ain_basic', category: 'AIN', rarity: 'Epic', value: 1, probabilityBps: 250, name: 'Agent ID NFT', icon: '🤖', description: 'Basic Agent ID NFT' },
  { id: 'sv_upc_purple', category: 'UPC', rarity: 'Epic', value: 1, probabilityBps: 150, name: 'Purple Catalyst', icon: '🟣', description: 'Epic purple catalyst' },

  // ── Legendary (650 bps = 6.5%) ──
  { id: 'sv_bt_20000', category: 'BBT', rarity: 'Legendary', value: 20000, probabilityBps: 250, name: '20000 BBT', icon: '💰', description: 'Legendary BBT jackpot' },
  { id: 'sv_gov_50', category: 'GOV', rarity: 'Legendary', value: 50, probabilityBps: 200, name: '50 Gov Tokens', icon: '🏛️', description: '50 governance tokens' },
  { id: 'sv_aap_basic', category: 'AAP', rarity: 'Legendary', value: 30, probabilityBps: 120, name: '30-Day Agent Pass', icon: '🎫', description: '30 days agent access pass' },
  { id: 'sv_sub_365d', category: 'SUB', rarity: 'Legendary', value: 365, probabilityBps: 80, name: '365-Day Strategy', icon: '📅', description: '1 year strategy subscription' },

  // ── Mythic (150 bps = 1.5%) ──
  { id: 'sv_bt_100000', category: 'BBT', rarity: 'Mythic', value: 100000, probabilityBps: 50, name: '100000 BBT', icon: '💰', description: 'Mythic BBT mega jackpot' },
  { id: 'sv_sub_lifetime', category: 'SUB', rarity: 'Mythic', value: 0, probabilityBps: 40, name: 'Lifetime Strategy', icon: '👑', description: 'Lifetime strategy access' },
  { id: 'sv_ain_legendary', category: 'AIN', rarity: 'Mythic', value: 1, probabilityBps: 35, name: 'Legendary Agent NFT', icon: '🤖', description: 'Legendary tier Agent ID NFT' },
  { id: 'sv_upc_gold', category: 'UPC', rarity: 'Mythic', value: 1, probabilityBps: 25, name: 'Gold Catalyst', icon: '🟡', description: 'Mythic gold catalyst' },
];

// ═══════════════════════════════════════════════════════════════════
// 6. 奖品池配置 — GOLD (21000 BBT)
// ═══════════════════════════════════════════════════════════════════

export const GOLD_PRIZES: PrizeConfig[] = [
  // ── Common (1500 bps = 15%) ──
  { id: 'gd_bt_500', category: 'BBT', rarity: 'Common', value: 500, probabilityBps: 600, name: '500 BBT', icon: '💰', description: 'Small BBT reward' },
  { id: 'gd_sub_7d', category: 'SUB', rarity: 'Common', value: 7, probabilityBps: 500, name: '7-Day Strategy', icon: '📅', description: '1 week strategy subscription' },
  { id: 'gd_stk_100', category: 'STK', rarity: 'Common', value: 100, probabilityBps: 250, name: '100 Staking Boost', icon: '📈', description: '100 BBT staking boost' },
  { id: 'gd_cos_rare', category: 'COS', rarity: 'Common', value: 3, probabilityBps: 150, name: 'Gold Badge', icon: '🏷️', description: 'Gold tier collectible' },

  // ── Uncommon (2500 bps = 25%) ──
  { id: 'gd_bt_1500', category: 'BBT', rarity: 'Uncommon', value: 1500, probabilityBps: 1000, name: '1500 BBT', icon: '💰', description: 'Medium BBT reward' },
  { id: 'gd_sub_30d', category: 'SUB', rarity: 'Uncommon', value: 30, probabilityBps: 800, name: '30-Day Strategy', icon: '📅', description: '1 month strategy subscription' },
  { id: 'gd_rst_3p', category: 'RST', rarity: 'Uncommon', value: 3, probabilityBps: 400, name: '3% Revenue Share', icon: '📊', description: '3% revenue share token' },
  { id: 'gd_upc_green3', category: 'UPC', rarity: 'Uncommon', value: 3, probabilityBps: 300, name: 'Green Catalyst x3', icon: '🟢', description: '3x green catalysts' },

  // ── Rare (3000 bps = 30%) ──
  { id: 'gd_bt_5000', category: 'BBT', rarity: 'Rare', value: 5000, probabilityBps: 1200, name: '5000 BBT', icon: '💰', description: 'Large BBT reward' },
  { id: 'gd_sub_90d', category: 'SUB', rarity: 'Rare', value: 90, probabilityBps: 800, name: '90-Day Strategy', icon: '📅', description: '3 months strategy subscription' },
  { id: 'gd_aap_90d', category: 'AAP', rarity: 'Rare', value: 90, probabilityBps: 600, name: '90-Day Agent Pass', icon: '🎫', description: '90 days agent access pass' },
  { id: 'gd_eak_gold', category: 'EAK', rarity: 'Rare', value: 3, probabilityBps: 400, name: 'VIP Early Key', icon: '🔑', description: 'VIP early feature access' },

  // ── Epic (1800 bps = 18%) ──
  { id: 'gd_bt_20000', category: 'BBT', rarity: 'Epic', value: 20000, probabilityBps: 700, name: '20000 BBT', icon: '💰', description: 'Epic BBT reward' },
  { id: 'gd_ain_epic', category: 'AIN', rarity: 'Epic', value: 1, probabilityBps: 500, name: 'Epic Agent NFT', icon: '🤖', description: 'Epic tier Agent ID NFT' },
  { id: 'gd_gov_100', category: 'GOV', rarity: 'Epic', value: 100, probabilityBps: 350, name: '100 Gov Tokens', icon: '🏛️', description: '100 governance tokens' },
  { id: 'gd_upc_purple2', category: 'UPC', rarity: 'Epic', value: 2, probabilityBps: 250, name: 'Purple Catalyst x2', icon: '🟣', description: '2x purple catalysts' },

  // ── Legendary (900 bps = 9%) ──
  { id: 'gd_bt_100000', category: 'BBT', rarity: 'Legendary', value: 100000, probabilityBps: 350, name: '100000 BBT', icon: '💰', description: 'Legendary BBT mega jackpot' },
  { id: 'gd_sub_365d', category: 'SUB', rarity: 'Legendary', value: 365, probabilityBps: 250, name: '365-Day Strategy', icon: '📅', description: '1 year strategy subscription' },
  { id: 'gd_rst_10p', category: 'RST', rarity: 'Legendary', value: 10, probabilityBps: 200, name: '10% Revenue Share', icon: '📊', description: '10% revenue share token' },
  { id: 'gd_upc_gold', category: 'UPC', rarity: 'Legendary', value: 1, probabilityBps: 100, name: 'Gold Catalyst', icon: '🟡', description: 'Legendary gold catalyst' },

  // ── Mythic (300 bps = 3%) ──
  { id: 'gd_bt_500000', category: 'BBT', rarity: 'Mythic', value: 500000, probabilityBps: 100, name: '500000 BBT', icon: '💰', description: 'Mythic BBT ultra jackpot' },
  { id: 'gd_sub_lifetime', category: 'SUB', rarity: 'Mythic', value: 0, probabilityBps: 80, name: 'Lifetime Strategy', icon: '👑', description: 'Lifetime strategy access' },
  { id: 'gd_ain_mythic', category: 'AIN', rarity: 'Mythic', value: 1, probabilityBps: 70, name: 'Mythic Agent NFT', icon: '🤖', description: 'Mythic tier Agent ID NFT' },
  { id: 'gd_upc_rainbow', category: 'UPC', rarity: 'Mythic', value: 1, probabilityBps: 50, name: 'Rainbow Catalyst', icon: '🌈', description: 'Mythic rainbow catalyst' },
];

// ═══════════════════════════════════════════════════════════════════
// 7. 奖品池配置 — PLATINUM (210000 BBT)
// ═══════════════════════════════════════════════════════════════════

export const PLATINUM_PRIZES: PrizeConfig[] = [
  // ── Common (1000 bps = 10%) ──
  { id: 'pt_bt_2000', category: 'BBT', rarity: 'Common', value: 2000, probabilityBps: 400, name: '2000 BBT', icon: '💰', description: 'Small BBT reward' },
  { id: 'pt_sub_30d', category: 'SUB', rarity: 'Common', value: 30, probabilityBps: 300, name: '30-Day Strategy', icon: '📅', description: '1 month strategy subscription' },
  { id: 'pt_stk_500', category: 'STK', rarity: 'Common', value: 500, probabilityBps: 200, name: '500 Staking Boost', icon: '📈', description: '500 BBT staking boost' },
  { id: 'pt_bbv_gold', category: 'BBV', rarity: 'Common', value: 1, probabilityBps: 100, name: 'Gold Voucher', icon: '🎫', description: '1 free gold box draw' },

  // ── Uncommon (2000 bps = 20%) ──
  { id: 'pt_bt_5000', category: 'BBT', rarity: 'Uncommon', value: 5000, probabilityBps: 800, name: '5000 BBT', icon: '💰', description: 'Medium BBT reward' },
  { id: 'pt_sub_90d', category: 'SUB', rarity: 'Uncommon', value: 90, probabilityBps: 600, name: '90-Day Strategy', icon: '📅', description: '3 months strategy subscription' },
  { id: 'pt_aap_180d', category: 'AAP', rarity: 'Uncommon', value: 180, probabilityBps: 350, name: '180-Day Agent Pass', icon: '🎫', description: '180 days agent access pass' },
  { id: 'pt_upc_purple3', category: 'UPC', rarity: 'Uncommon', value: 3, probabilityBps: 250, name: 'Purple Catalyst x3', icon: '🟣', description: '3x purple catalysts' },

  // ── Rare (2800 bps = 28%) ──
  { id: 'pt_bt_20000', category: 'BBT', rarity: 'Rare', value: 20000, probabilityBps: 1100, name: '20000 BBT', icon: '💰', description: 'Large BBT reward' },
  { id: 'pt_sub_365d', category: 'SUB', rarity: 'Rare', value: 365, probabilityBps: 800, name: '365-Day Strategy', icon: '📅', description: '1 year strategy subscription' },
  { id: 'pt_ain_epic', category: 'AIN', rarity: 'Rare', value: 1, probabilityBps: 500, name: 'Epic Agent NFT', icon: '🤖', description: 'Epic tier Agent ID NFT' },
  { id: 'pt_rst_5p', category: 'RST', rarity: 'Rare', value: 5, probabilityBps: 400, name: '5% Revenue Share', icon: '📊', description: '5% revenue share token' },

  // ── Epic (2200 bps = 22%) ──
  { id: 'pt_bt_100000', category: 'BBT', rarity: 'Epic', value: 100000, probabilityBps: 800, name: '100000 BBT', icon: '💰', description: 'Epic BBT mega reward' },
  { id: 'pt_gov_500', category: 'GOV', rarity: 'Epic', value: 500, probabilityBps: 600, name: '500 Gov Tokens', icon: '🏛️', description: '500 governance tokens' },
  { id: 'pt_ain_legendary', category: 'AIN', rarity: 'Epic', value: 1, probabilityBps: 500, name: 'Legendary Agent NFT', icon: '🤖', description: 'Legendary tier Agent ID NFT' },
  { id: 'pt_upc_gold2', category: 'UPC', rarity: 'Epic', value: 2, probabilityBps: 300, name: 'Gold Catalyst x2', icon: '🟡', description: '2x gold catalysts' },

  // ── Legendary (1500 bps = 15%) ──
  { id: 'pt_bt_500000', category: 'BBT', rarity: 'Legendary', value: 500000, probabilityBps: 600, name: '500000 BBT', icon: '💰', description: 'Legendary BBT ultra jackpot' },
  { id: 'pt_sub_lifetime', category: 'SUB', rarity: 'Legendary', value: 0, probabilityBps: 400, name: 'Lifetime Strategy', icon: '👑', description: 'Lifetime strategy access' },
  { id: 'pt_aap_lifetime', category: 'AAP', rarity: 'Legendary', value: 0, probabilityBps: 300, name: 'Lifetime Agent Pass', icon: '🎫', description: 'Lifetime agent access pass' },
  { id: 'pt_rst_25p', category: 'RST', rarity: 'Legendary', value: 25, probabilityBps: 200, name: '25% Revenue Share', icon: '📊', description: '25% revenue share token' },

  // ── Mythic (500 bps = 5%) ──
  { id: 'pt_bt_2000000', category: 'BBT', rarity: 'Mythic', value: 2000000, probabilityBps: 150, name: '2000000 BBT', icon: '💰', description: 'Mythic BBT legendary jackpot' },
  { id: 'pt_ain_mythic', category: 'AIN', rarity: 'Mythic', value: 1, probabilityBps: 150, name: 'Mythic Agent NFT', icon: '🤖', description: 'Mythic tier Agent ID NFT' },
  { id: 'pt_upc_cosmic', category: 'UPC', rarity: 'Mythic', value: 1, probabilityBps: 100, name: 'Cosmic Catalyst', icon: '🌌', description: 'Mythic cosmic catalyst' },
  { id: 'pt_gov_5000', category: 'GOV', rarity: 'Mythic', value: 5000, probabilityBps: 100, name: '5000 Gov Tokens', icon: '🏛️', description: '5000 governance tokens' },
];

// ═══════════════════════════════════════════════════════════════════
// 8. 跨阶催化剂配置
// ═══════════════════════════════════════════════════════════════════

export const CATALYST_CONFIGS: CatalystConfig[] = [
  {
    type: 'GREEN',
    name: 'Green Catalyst',
    icon: '🟢',
    sourceTier: 'BRONZE',
    effect: { type: 'probability_boost', value: 500, duration: 3600000 },
    dropRateBps: 350,
    description: '+5% probability boost for 1 hour',
    color: '#22c55e',
  },
  {
    type: 'BLUE',
    name: 'Blue Catalyst',
    icon: '🔵',
    sourceTier: 'SILVER',
    effect: { type: 'rarity_upgrade', value: 1, targetRarity: 'Rare' },
    dropRateBps: 250,
    description: 'Upgrade next draw rarity by 1 tier',
    color: '#3b82f6',
  },
  {
    type: 'PURPLE',
    name: 'Purple Catalyst',
    icon: '🟣',
    sourceTier: 'GOLD',
    effect: { type: 'rarity_upgrade', value: 2, targetRarity: 'Epic' },
    dropRateBps: 180,
    description: 'Upgrade next draw rarity by 2 tiers',
    color: '#a855f7',
  },
  {
    type: 'GOLD',
    name: 'Gold Catalyst',
    icon: '🟡',
    sourceTier: 'GOLD',
    effect: { type: 'guaranteed_drop', value: 1, targetRarity: 'Legendary' },
    dropRateBps: 100,
    description: 'Guarantee Legendary or better on next draw',
    color: '#f59e0b',
  },
  {
    type: 'RAINBOW',
    name: 'Rainbow Catalyst',
    icon: '🌈',
    sourceTier: 'PLATINUM',
    effect: { type: 'multi_draw', value: 3 },
    dropRateBps: 80,
    description: 'Draw 3 times, keep the best result',
    color: '#ec4899',
  },
  {
    type: 'VOID',
    name: 'Void Catalyst',
    icon: '🕳️',
    sourceTier: 'PLATINUM',
    effect: { type: 'special_unlock', value: 1, targetRarity: 'Mythic' },
    dropRateBps: 40,
    description: 'Unlock Void-tier prizes from the shadow pool',
    color: '#6b7280',
  },
  {
    type: 'COSMIC',
    name: 'Cosmic Catalyst',
    icon: '🌌',
    sourceTier: 'PLATINUM',
    effect: { type: 'guaranteed_drop', value: 1, targetRarity: 'Mythic' },
    dropRateBps: 15,
    description: 'Guarantee Mythic on next draw',
    color: '#0ea5e9',
  },
];

// ═══════════════════════════════════════════════════════════════════
// 9. 神秘碎片配置
// ═══════════════════════════════════════════════════════════════════

export const SHARD_CONFIGS: ShardConfig[] = [
  {
    type: 'STRATEGY',
    name: 'Strategy Shard',
    icon: '🔷',
    color: '#3b82f6',
    fusionResult: {
      category: 'SUB',
      rarity: 'Epic',
      name: 'Fused Strategy Access',
      icon: '📅',
      value: 90,
      description: '90-day premium strategy subscription',
    },
    sourceTiers: ['BRONZE', 'SILVER', 'GOLD'],
    dropRateBps: 250,
    requiredCount: 5,
    description: 'Collect 5 to fuse into 90-day strategy subscription',
  },
  {
    type: 'AGENT',
    name: 'Agent Shard',
    icon: '🔶',
    color: '#f59e0b',
    fusionResult: {
      category: 'AIN',
      rarity: 'Legendary',
      name: 'Fused Agent NFT',
      icon: '🤖',
      value: 1,
      description: 'Legendary tier Agent ID NFT',
    },
    sourceTiers: ['SILVER', 'GOLD', 'PLATINUM'],
    dropRateBps: 180,
    requiredCount: 7,
    description: 'Collect 7 to fuse into Legendary Agent ID NFT',
  },
  {
    type: 'REVENUE',
    name: 'Revenue Shard',
    icon: '🔹',
    color: '#22c55e',
    fusionResult: {
      category: 'RST',
      rarity: 'Epic',
      name: 'Fused Revenue Share',
      icon: '📊',
      value: 5,
      description: '5% revenue share token',
    },
    sourceTiers: ['GOLD', 'PLATINUM'],
    dropRateBps: 150,
    requiredCount: 10,
    description: 'Collect 10 to fuse into 5% revenue share token',
  },
  {
    type: 'GOVERNANCE',
    name: 'Governance Shard',
    icon: '🔺',
    color: '#a855f7',
    fusionResult: {
      category: 'GOV',
      rarity: 'Legendary',
      name: 'Fused Governance Pack',
      icon: '🏛️',
      value: 200,
      description: '200 governance tokens',
    },
    sourceTiers: ['SILVER', 'GOLD', 'PLATINUM'],
    dropRateBps: 120,
    requiredCount: 8,
    description: 'Collect 8 to fuse into 200 governance tokens',
  },
  {
    type: 'COSMIC',
    name: 'Cosmic Shard',
    icon: '🔻',
    color: '#ef4444',
    fusionResult: {
      category: 'MYS',
      rarity: 'Mythic',
      name: 'Cosmic Mystery Prize',
      icon: '🌌',
      value: 1,
      description: 'Exclusive Mythic mystery prize from the cosmic pool',
    },
    sourceTiers: ['PLATINUM'],
    dropRateBps: 40,
    requiredCount: 3,
    description: 'Collect 3 to fuse into exclusive Mythic prize',
  },
];

// ═══════════════════════════════════════════════════════════════════
// 10. 连击奖励配置
// ═══════════════════════════════════════════════════════════════════

export const COMBO_CONFIGS: ComboConfig[] = [
  {
    type: 'STARTER_STREAK',
    name: 'Starter Streak',
    icon: '🔥',
    requirements: {
      consecutiveDraws: 3,
      withinTimeMs: 3600000,     // 1 hour
    },
    bonus: {
      type: 'multiplier',
      value: 1.5,
      description: '1.5x probability multiplier on next draw',
    },
    description: 'Open 3 boxes within 1 hour for 1.5x boost',
    color: '#f97316',
  },
  {
    type: 'TRADER_RUSH',
    name: 'Trader Rush',
    icon: '⚡',
    requirements: {
      consecutiveDraws: 5,
      withinTimeMs: 7200000,     // 2 hours
      minTier: 'SILVER',
    },
    bonus: {
      type: 'guaranteed_rarity',
      value: 1,
      targetRarity: 'Rare',
      description: 'Guarantee Rare or better on next draw',
    },
    description: 'Open 5 Silver+ boxes within 2 hours for guaranteed Rare',
    color: '#eab308',
  },
  {
    type: 'PREMIUM_ASCENSION',
    name: 'Premium Ascension',
    icon: '🌟',
    requirements: {
      consecutiveDraws: 10,
      withinTimeMs: 86400000,    // 24 hours
      minTier: 'GOLD',
    },
    bonus: {
      type: 'guaranteed_rarity',
      value: 2,
      targetRarity: 'Epic',
      description: 'Guarantee Epic or better on next draw',
    },
    description: 'Open 10 Gold+ boxes within 24 hours for guaranteed Epic',
    color: '#a855f7',
  },
  {
    type: 'WHALE_RITUAL',
    name: 'Whale Ritual',
    icon: '🐋',
    requirements: {
      consecutiveDraws: 3,
      withinTimeMs: 3600000,     // 1 hour
      minTier: 'PLATINUM',
    },
    bonus: {
      type: 'extra_draw',
      value: 2,
      description: 'Get 2 extra free Platinum draws',
    },
    description: 'Open 3 Platinum boxes within 1 hour for 2 free draws',
    color: '#0ea5e9',
  },
  {
    type: 'FULL_SPECTRUM',
    name: 'Full Spectrum',
    icon: '🌈',
    requirements: {
      consecutiveDraws: 4,
      specificCategories: ['BBT', 'SUB', 'AIN', 'UPC'],
    },
    bonus: {
      type: 'special_prize',
      value: 1,
      description: 'Unlock exclusive Full Spectrum mystery box',
    },
    description: 'Draw BBT + SUB + AIN + UPC prizes to unlock mystery box',
    color: '#ec4899',
  },
];

// ═══════════════════════════════════════════════════════════════════
// 11. 收益分配配置
// ═══════════════════════════════════════════════════════════════════

export const DEFAULT_REVENUE_ALLOCATION: RevenueAllocation = {
  burnPercent: 30,
  prizePoolPercent: 40,
  providerPercent: 15,
  treasuryPercent: 10,
  referralPercent: 5,
};

// ═══════════════════════════════════════════════════════════════════
// 12. 盲盒档位完整配置
// ═══════════════════════════════════════════════════════════════════

export const BOX_TIER_CONFIGS: Record<BoxTier, BoxTierConfig> = {
  BRONZE: {
    tier: 'BRONZE',
    name: 'Bronze Box',
    bbtCost: 21,
    usdtEquiv: 1,
    icon: '🥉',
    color: '#cd7f32',
    prizes: BRONZE_PRIZES,
    catalystDrops: ['GREEN'],
    shardDrops: ['STRATEGY'],
    pityCounter: {
      enabled: true,
      threshold: 50,
      guaranteedRarity: 'Rare',
      escalationRateBps: 200,
    },
    revenueAllocation: DEFAULT_REVENUE_ALLOCATION,
  },
  SILVER: {
    tier: 'SILVER',
    name: 'Silver Box',
    bbtCost: 2100,
    usdtEquiv: 10,
    icon: '🥈',
    color: '#c0c0c0',
    prizes: SILVER_PRIZES,
    catalystDrops: ['GREEN', 'BLUE'],
    shardDrops: ['STRATEGY', 'AGENT', 'GOVERNANCE'],
    pityCounter: {
      enabled: true,
      threshold: 30,
      guaranteedRarity: 'Epic',
      escalationRateBps: 300,
    },
    revenueAllocation: DEFAULT_REVENUE_ALLOCATION,
  },
  GOLD: {
    tier: 'GOLD',
    name: 'Gold Box',
    bbtCost: 21000,
    usdtEquiv: 100,
    icon: '🥇',
    color: '#ffd700',
    prizes: GOLD_PRIZES,
    catalystDrops: ['GREEN', 'BLUE', 'PURPLE', 'GOLD'],
    shardDrops: ['STRATEGY', 'AGENT', 'REVENUE', 'GOVERNANCE'],
    pityCounter: {
      enabled: true,
      threshold: 20,
      guaranteedRarity: 'Legendary',
      escalationRateBps: 500,
    },
    revenueAllocation: DEFAULT_REVENUE_ALLOCATION,
  },
  PLATINUM: {
    tier: 'PLATINUM',
    name: 'Platinum Box',
    bbtCost: 210000,
    usdtEquiv: 1000,
    icon: '💎',
    color: '#e5e4e2',
    prizes: PLATINUM_PRIZES,
    catalystDrops: ['GREEN', 'BLUE', 'PURPLE', 'GOLD', 'RAINBOW', 'VOID', 'COSMIC'],
    shardDrops: ['STRATEGY', 'AGENT', 'REVENUE', 'GOVERNANCE', 'COSMIC'],
    pityCounter: {
      enabled: true,
      threshold: 10,
      guaranteedRarity: 'Mythic',
      escalationRateBps: 1000,
    },
    revenueAllocation: DEFAULT_REVENUE_ALLOCATION,
  },
};

// ═══════════════════════════════════════════════════════════════════
// 13. 奖品池索引（快速查找）
// ═══════════════════════════════════════════════════════════════════

const PRIZE_POOL_MAP: Record<BoxTier, PrizeConfig[]> = {
  BRONZE: BRONZE_PRIZES,
  SILVER: SILVER_PRIZES,
  GOLD: GOLD_PRIZES,
  PLATINUM: PLATINUM_PRIZES,
};

const CATALYST_MAP = new Map<CatalystType, CatalystConfig>(
  CATALYST_CONFIGS.map((c) => [c.type, c]),
);

const SHARD_MAP = new Map<ShardType, ShardConfig>(
  SHARD_CONFIGS.map((s) => [s.type, s]),
);

const COMBO_MAP = new Map<ComboType, ComboConfig>(
  COMBO_CONFIGS.map((c) => [c.type, c]),
);

// ═══════════════════════════════════════════════════════════════════
// 14. 辅助函数
// ═══════════════════════════════════════════════════════════════════

/**
 * 获取指定档位的所有奖品
 * @param tier 盲盒档位
 * @returns 奖品配置数组
 */
export function getPrizePoolForTier(tier: BoxTier): PrizeConfig[] {
  const pool = PRIZE_POOL_MAP[tier];
  if (!pool) {
    throw new Error(`Invalid box tier: ${tier}`);
  }
  return [...pool];
}

/**
 * 获取指定档位配置
 * @param tier 盲盒档位
 * @returns 档位配置
 */
export function getBoxTierConfig(tier: BoxTier): BoxTierConfig {
  const config = BOX_TIER_CONFIGS[tier];
  if (!config) {
    throw new Error(`Invalid box tier: ${tier}`);
  }
  return { ...config };
}

/**
 * 抽奖函数（考虑保底和催化剂）
 * @param tier 盲盒档位
 * @param pityCounter 当前保底计数
 * @param pphr 当前概率提升值（Probability Per Hit Rate，来自催化剂等）
 * @returns 抽奖结果
 */
export function drawPrize(
  tier: BoxTier,
  pityCounter: number = 0,
  pphr: number = 0,
): DrawResult {
  const config = BOX_TIER_CONFIGS[tier];
  if (!config) {
    throw new Error(`Invalid box tier: ${tier}`);
  }

  const prizes = config.prizes;
  const pity = config.pityCounter;
  let isPity = false;
  let adjustedPrizes = [...prizes];

  // ── 保底机制 ──
  if (pity.enabled && pityCounter >= pity.threshold) {
    // 强制保底：只抽稀有度 >= 保底稀有度的奖品
    const pityRarityIndex = RARITY_ORDER.indexOf(pity.guaranteedRarity);
    adjustedPrizes = prizes.filter(
      (p) => RARITY_ORDER.indexOf(p.rarity) >= pityRarityIndex,
    );
    isPity = true;
  } else if (pity.enabled && pityCounter > 0) {
    // 概率提升（每次未中稀有品，概率递增）
    const escalation = pityCounter * pity.escalationRateBps;
    adjustedPrizes = prizes.map((p) => {
      const rarityIndex = RARITY_ORDER.indexOf(p.rarity);
      const pityRarityIndex = RARITY_ORDER.indexOf(pity.guaranteedRarity);
      if (rarityIndex >= pityRarityIndex) {
        return {
          ...p,
          probabilityBps: p.probabilityBps + Math.floor(escalation / 10),
        };
      }
      return p;
    });
  }

  // ── 催化剂概率加成 ──
  if (pphr > 0) {
    adjustedPrizes = adjustedPrizes.map((p) => ({
      ...p,
      probabilityBps: p.probabilityBps + Math.floor(pphr * p.probabilityBps / 10000),
    }));
  }

  // ── 归一化概率（确保总和为 10000）──
  const totalBps = adjustedPrizes.reduce((sum, p) => sum + p.probabilityBps, 0);
  if (totalBps !== 10000) {
    const scaleFactor = 10000 / totalBps;
    adjustedPrizes = adjustedPrizes.map((p) => ({
      ...p,
      probabilityBps: Math.round(p.probabilityBps * scaleFactor),
    }));
    // 修正浮点误差：调整最后一个奖品
    const adjustedTotal = adjustedPrizes.reduce((sum, p) => sum + p.probabilityBps, 0);
    if (adjustedTotal !== 10000 && adjustedPrizes.length > 0) {
      adjustedPrizes[adjustedPrizes.length - 1].probabilityBps += 10000 - adjustedTotal;
    }
  }

  // ── 加密安全随机抽奖 ──
  const rand = randomBytes(4).readUInt32LE(0) / 0xffffffff; // [0, 1)
  let cumulative = 0;
  let selectedPrize = adjustedPrizes[0]; // fallback

  for (const prize of adjustedPrizes) {
    cumulative += prize.probabilityBps / 10000;
    if (rand < cumulative) {
      selectedPrize = prize;
      break;
    }
  }

  // ── 检查催化剂掉落 ──
  let catalyst: CatalystConfig | undefined;
  const catalystRand = randomBytes(4).readUInt32LE(0) / 0xffffffff;
  for (const catalystType of config.catalystDrops) {
    const catalystConfig = CATALYST_MAP.get(catalystType);
    if (catalystConfig && catalystRand < catalystConfig.dropRateBps / 10000) {
      catalyst = catalystConfig;
      break;
    }
  }

  // ── 检查碎片掉落 ──
  let shard: ShardConfig | undefined;
  const shardRand = randomBytes(4).readUInt32LE(0) / 0xffffffff;
  for (const shardType of config.shardDrops) {
    const shardConfig = SHARD_MAP.get(shardType);
    if (shardConfig && shardRand < shardConfig.dropRateBps / 10000) {
      shard = shardConfig;
      break;
    }
  }

  return {
    prize: selectedPrize,
    catalyst,
    shard,
    isPity,
    drawIndex: pityCounter + 1,
    timestamp: Date.now(),
  };
}

/**
 * 计算指定档位的期望值
 * @param tier 盲盒档位
 * @returns 期望值计算结果
 */
export function calculateEV(tier: BoxTier): ExpectedValue {
  const config = BOX_TIER_CONFIGS[tier];
  if (!config) {
    throw new Error(`Invalid box tier: ${tier}`);
  }

  let totalEV_BBT = 0;
  const breakdown: ExpectedValue['breakdown'] = [];

  for (const prize of config.prizes) {
    const probability = prize.probabilityBps / 10000;
    let prizeValueBBT = prize.value;

    // 非 BBT 类奖品转换为 BBT 估算值
    switch (prize.category) {
      case 'SUB':
        // 策略订阅按每日 BBT 价值估算
        prizeValueBBT = prize.value * 10; // 1天 = 10 BBT
        break;
      case 'AIN':
        // Agent ID NFT 估算值
        prizeValueBBT = prize.rarity === 'Mythic' ? 50000 :
                        prize.rarity === 'Legendary' ? 10000 :
                        prize.rarity === 'Epic' ? 2000 : 500;
        break;
      case 'AAP':
        // Agent Access Pass
        prizeValueBBT = prize.value === 0 ? 100000 : prize.value * 15;
        break;
      case 'STK':
        // Staking Boost 本身就是 BBT
        prizeValueBBT = prize.value;
        break;
      case 'RST':
        // Revenue Share 按比例估值
        prizeValueBBT = prize.value * 1000;
        break;
      case 'BBV':
        // Blind Box Voucher 按档位成本
        prizeValueBBT = config.bbtCost;
        break;
      case 'GOV':
        // Governance Token
        prizeValueBBT = prize.value * 5;
        break;
      case 'EAK':
        // Early Access Key
        prizeValueBBT = prize.value * 500;
        break;
      case 'COS':
        // Cosmetic
        prizeValueBBT = prize.value * 50;
        break;
      case 'MYS':
        // Mystery
        prizeValueBBT = 1000;
        break;
      default:
        prizeValueBBT = prize.value;
    }

    const ev = probability * prizeValueBBT;
    totalEV_BBT += ev;

    breakdown.push({
      category: prize.category,
      probability,
      expectedValue: ev,
    });
  }

  const evUSD = totalEV_BBT * BBT_USD_RATE;
  const costUSD = config.bbtCost * BBT_USD_RATE;
  const roiPercent = ((evUSD - costUSD) / costUSD) * 100;

  return {
    tier,
    evBBT: Math.round(totalEV_BBT * 100) / 100,
    evUSD: Math.round(evUSD * 100) / 100,
    roiPercent: Math.round(roiPercent * 100) / 100,
    breakdown,
  };
}

/**
 * 获取催化剂配置
 * @param catalystType 催化剂类型
 * @returns 催化剂配置
 */
export function getCatalystConfig(catalystType: CatalystType): CatalystConfig | undefined {
  return CATALYST_MAP.get(catalystType);
}

/**
 * 获取所有催化剂配置
 * @returns 催化剂配置数组
 */
export function getAllCatalystConfigs(): CatalystConfig[] {
  return [...CATALYST_CONFIGS];
}

/**
 * 获取碎片配置
 * @param shardType 碎片类型
 * @returns 碎片配置
 */
export function getShardConfig(shardType: ShardType): ShardConfig | undefined {
  return SHARD_MAP.get(shardType);
}

/**
 * 获取所有碎片配置
 * @returns 碎片配置数组
 */
export function getAllShardConfigs(): ShardConfig[] {
  return [...SHARD_CONFIGS];
}

/**
 * 获取连击配置
 * @param comboType 连击类型
 * @returns 连击配置
 */
export function getComboConfig(comboType: ComboType): ComboConfig | undefined {
  return COMBO_MAP.get(comboType);
}

/**
 * 获取所有连击配置
 * @returns 连击配置数组
 */
export function getAllComboConfigs(): ComboConfig[] {
  return [...COMBO_CONFIGS];
}

/**
 * 验证奖品池概率总和
 * @param tier 盲盒档位
 * @returns 是否有效（总和 = 10000）
 */
export function validatePrizePool(tier: BoxTier): { valid: boolean; total: number } {
  const prizes = PRIZE_POOL_MAP[tier];
  if (!prizes) {
    return { valid: false, total: 0 };
  }
  const total = prizes.reduce((sum, p) => sum + p.probabilityBps, 0);
  return { valid: total === 10000, total };
}

/**
 * 按稀有度筛选奖品
 * @param tier 盲盒档位
 * @param rarity 稀有度
 * @returns 符合条件的奖品数组
 */
export function getPrizesByRarity(tier: BoxTier, rarity: RarityTier): PrizeConfig[] {
  const prizes = PRIZE_POOL_MAP[tier];
  if (!prizes) return [];
  return prizes.filter((p) => p.rarity === rarity);
}

/**
 * 按类别筛选奖品
 * @param tier 盲盒档位
 * @param category 奖品类别
 * @returns 符合条件的奖品数组
 */
export function getPrizesByCategory(tier: BoxTier, category: PrizeCategory): PrizeConfig[] {
  const prizes = PRIZE_POOL_MAP[tier];
  if (!prizes) return [];
  return prizes.filter((p) => p.category === category);
}

/**
 * 计算保底概率提升值
 * @param pityCounter 当前保底计数
 * @param tier 盲盒档位
 * @returns 概率提升值（bps）
 */
export function calculatePityBonus(pityCounter: number, tier: BoxTier): number {
  const config = BOX_TIER_CONFIGS[tier];
  if (!config || !config.pityCounter.enabled) return 0;
  return pityCounter * config.pityCounter.escalationRateBps;
}

/**
 * 检查是否触发保底
 * @param pityCounter 当前保底计数
 * @param tier 盲盒档位
 * @returns 是否触发保底
 */
export function isPityTriggered(pityCounter: number, tier: BoxTier): boolean {
  const config = BOX_TIER_CONFIGS[tier];
  if (!config || !config.pityCounter.enabled) return false;
  return pityCounter >= config.pityCounter.threshold;
}

/**
 * 获取收益分配配置
 * @param tier 盲盒档位
 * @returns 收益分配配置
 */
export function getRevenueAllocation(tier: BoxTier): RevenueAllocation {
  const config = BOX_TIER_CONFIGS[tier];
  if (!config) {
    throw new Error(`Invalid box tier: ${tier}`);
  }
  return { ...config.revenueAllocation };
}

/**
 * 计算收益分配金额
 * @param tier 盲盒档位
 * @param totalAmount 总金额（BBT）
 * @returns 各方分配金额
 */
export function calculateRevenueSplit(
  tier: BoxTier,
  totalAmount: number,
): {
  burn: number;
  prizePool: number;
  provider: number;
  treasury: number;
  referral: number;
} {
  const allocation = getRevenueAllocation(tier);
  return {
    burn: Math.round(totalAmount * allocation.burnPercent / 100),
    prizePool: Math.round(totalAmount * allocation.prizePoolPercent / 100),
    provider: Math.round(totalAmount * allocation.providerPercent / 100),
    treasury: Math.round(totalAmount * allocation.treasuryPercent / 100),
    referral: Math.round(totalAmount * allocation.referralPercent / 100),
  };
}

// ═══════════════════════════════════════════════════════════════════
// 15. 内部工具
// ═══════════════════════════════════════════════════════════════════

/** 稀有度排序（低 → 高） */
const RARITY_ORDER: RarityTier[] = [
  'Common',
  'Uncommon',
  'Rare',
  'Epic',
  'Legendary',
  'Mythic',
];

// ═══════════════════════════════════════════════════════════════════
// 16. 聚合导出
// ═══════════════════════════════════════════════════════════════════

/** 所有奖品池 */
export const ALL_PRIZE_POOLS = {
  BRONZE: BRONZE_PRIZES,
  SILVER: SILVER_PRIZES,
  GOLD: GOLD_PRIZES,
  PLATINUM: PLATINUM_PRIZES,
};

/** 所有档位配置 */
export const ALL_BOX_TIERS = BOX_TIER_CONFIGS;

/** 统计信息 */
export function getPoolStats(tier: BoxTier): {
  totalPrizes: number;
  byRarity: Record<RarityTier, number>;
  byCategory: Record<PrizeCategory, number>;
  totalProbabilityBps: number;
} {
  const prizes = PRIZE_POOL_MAP[tier] || [];
  const byRarity = {} as Record<RarityTier, number>;
  const byCategory = {} as Record<PrizeCategory, number>;

  // 初始化计数
  for (const r of RARITY_ORDER) byRarity[r] = 0;
  const categories: PrizeCategory[] = ['BBT', 'SUB', 'AAP', 'AIN', 'STK', 'RST', 'BBV', 'UPC', 'GOV', 'EAK', 'COS', 'MYS'];
  for (const c of categories) byCategory[c] = 0;

  let totalProbabilityBps = 0;

  for (const prize of prizes) {
    byRarity[prize.rarity]++;
    byCategory[prize.category]++;
    totalProbabilityBps += prize.probabilityBps;
  }

  return {
    totalPrizes: prizes.length,
    byRarity,
    byCategory,
    totalProbabilityBps,
  };
}
