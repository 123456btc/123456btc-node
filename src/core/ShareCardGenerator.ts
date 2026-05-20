/**
 * ShareCardGenerator — InscriptionForge SVG Share Card System
 *
 * Generates beautiful shareable SVG images for:
 * 1. Inscription Result Card (800x1200 mobile story format)
 * 2. Collection Card (1200x800 landscape)
 * 3. Leaderboard Card (800x600)
 *
 * Zero external dependencies — pure SVG string generation.
 * Can be rendered in browser, sent as Telegram photo, or saved as file.
 */

import type {
  InscriptionRecord,
  InscriptionElement,
  InscriptionRarity,
  InscriptionTrait,
  LeaderboardEntry,
  CollectionStats,
} from './BlindBoxEngine.js';

// ═══════════════════════════════════════════════════════
//  Card Data Interfaces
// ═══════════════════════════════════════════════════════

export interface CardData {
  inscriptionId: string;
  inscriptionNumber: number;
  tier: string;
  element: { name: string; icon: string; color: string };
  rarity: { name: string; color: string };
  trait: { name: string; description: string };
  series: number;
  epoch: number;
  slot: number;
  luckScore: number;
  seedWord?: string;
  name?: string;
  wallet: string;
}

// ═══════════════════════════════════════════════════════
//  Element Theme Configuration
// ═══════════════════════════════════════════════════════

interface ElementTheme {
  icon: string;
  color: string;
  gradientStart: string;
  gradientEnd: string;
  glowColor: string;
}

const ELEMENT_THEMES: Record<InscriptionElement, ElementTheme> = {
  Fire: {
    icon: '🔥',
    color: '#ff4444',
    gradientStart: '#1a0505',
    gradientEnd: '#0a0a0a',
    glowColor: '#ff4444',
  },
  Water: {
    icon: '🌊',
    color: '#4488ff',
    gradientStart: '#05051a',
    gradientEnd: '#0a0a0a',
    glowColor: '#4488ff',
  },
  Earth: {
    icon: '🌿',
    color: '#88aa44',
    gradientStart: '#0a1205',
    gradientEnd: '#0a0a0a',
    glowColor: '#88aa44',
  },
  Metal: {
    icon: '⚔️',
    color: '#c0c0c0',
    gradientStart: '#0f0f0f',
    gradientEnd: '#0a0a0a',
    glowColor: '#c0c0c0',
  },
  Wood: {
    icon: '🌳',
    color: '#44aa44',
    gradientStart: '#051205',
    gradientEnd: '#0a0a0a',
    glowColor: '#44aa44',
  },
  Thunder: {
    icon: '⚡',
    color: '#aa44ff',
    gradientStart: '#12051a',
    gradientEnd: '#0a0a0a',
    glowColor: '#aa44ff',
  },
  Wind: {
    icon: '🌀',
    color: '#eeeeff',
    gradientStart: '#0f0f1a',
    gradientEnd: '#0a0a0a',
    glowColor: '#eeeeff',
  },
  Mountain: {
    icon: '🏔️',
    color: '#888888',
    gradientStart: '#0a0a0a',
    gradientEnd: '#050505',
    glowColor: '#888888',
  },
  Crystal: {
    icon: '💎',
    color: '#ffd700',
    gradientStart: '#1a1505',
    gradientEnd: '#0a0a0a',
    glowColor: '#ffd700',
  },
  Void: {
    icon: '🌑',
    color: '#222222',
    gradientStart: '#0a0a0a',
    gradientEnd: '#000000',
    glowColor: '#444444',
  },
};

// ═══════════════════════════════════════════════════════
//  Rarity Configuration
// ═══════════════════════════════════════════════════════

const RARITY_COLORS: Record<InscriptionRarity, string> = {
  Common: '#9ca3af',
  Rare: '#3b82f6',
  Epic: '#a855f7',
  Legendary: '#f59e0b',
};

const RARITY_BG_COLORS: Record<InscriptionRarity, string> = {
  Common: 'rgba(156,163,175,0.15)',
  Rare: 'rgba(59,130,246,0.15)',
  Epic: 'rgba(168,85,247,0.15)',
  Legendary: 'rgba(245,158,11,0.15)',
};

const RARITY_GLOW_COLORS: Record<InscriptionRarity, string> = {
  Common: 'rgba(156,163,175,0.3)',
  Rare: 'rgba(59,130,246,0.4)',
  Epic: 'rgba(168,85,247,0.5)',
  Legendary: 'rgba(245,158,11,0.6)',
};

// ═══════════════════════════════════════════════════════
//  Trait Descriptions
// ═══════════════════════════════════════════════════════

const TRAIT_DESCRIPTIONS: Record<InscriptionTrait, string> = {
  Lucky: 'Fortune favors the bold',
  Wise: 'Knowledge is power',
  Resilient: 'Unbreakable spirit',
  Swift: 'Speed of light',
  Keen: 'Sharp perception',
  Bold: 'Fearless heart',
  Serene: 'Inner peace',
};

// ═══════════════════════════════════════════════════════
//  Tier Configuration
// ═══════════════════════════════════════════════════════

const TIER_ICONS: Record<string, string> = {
  bronze: '🟤',
  silver: '⬜',
  gold: '🟨',
  diamond: '💎',
};

const TIER_COLORS: Record<string, string> = {
  bronze: '#a0522d',
  silver: '#c0c0c0',
  gold: '#ffd700',
  diamond: '#b9f2ff',
};

// ═══════════════════════════════════════════════════════
//  SVG Utility Functions
// ═══════════════════════════════════════════════════════

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncateAddress(wallet: string, chars = 6): string {
  if (wallet.length <= chars * 2 + 3) return wallet;
  return `${wallet.slice(0, chars)}...${wallet.slice(-chars)}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

// ═══════════════════════════════════════════════════════
//  Convert InscriptionRecord to CardData
// ═══════════════════════════════════════════════════════

export function inscriptionToCardData(
  record: InscriptionRecord,
  luckScore: number,
  seedWord?: string,
): CardData {
  const elementTheme = ELEMENT_THEMES[record.attributes.element];
  return {
    inscriptionId: record.id,
    inscriptionNumber: record.inscriptionNumber,
    tier: record.tier,
    element: {
      name: record.attributes.element,
      icon: elementTheme.icon,
      color: elementTheme.color,
    },
    rarity: {
      name: record.attributes.rarity,
      color: RARITY_COLORS[record.attributes.rarity],
    },
    trait: {
      name: record.attributes.trait,
      description: TRAIT_DESCRIPTIONS[record.attributes.trait] || '',
    },
    series: record.attributes.series,
    epoch: record.epoch,
    slot: record.slot,
    luckScore,
    seedWord,
    name: record.name,
    wallet: record.wallet,
  };
}

// ═══════════════════════════════════════════════════════
//  1. Inscription Result Card (800x1200)
// ═══════════════════════════════════════════════════════

export function generateInscriptionCard(data: CardData): string {
  const theme = ELEMENT_THEMES[data.element.name as InscriptionElement] || ELEMENT_THEMES.Void;
  const rarityColor = data.rarity.color;
  const rarityBg = RARITY_BG_COLORS[data.rarity.name as InscriptionRarity] || 'rgba(156,163,175,0.15)';
  const rarityGlow = RARITY_GLOW_COLORS[data.rarity.name as InscriptionRarity] || 'rgba(156,163,175,0.3)';
  const tierColor = TIER_COLORS[data.tier] || '#c0c0c0';
  const tierIcon = TIER_ICONS[data.tier] || '⬜';
  const numberStr = `#${String(data.inscriptionNumber).padStart(4, '0')}`;
  const walletShort = truncateAddress(data.wallet, 6);

  // Determine if this is a special rarity for border effects
  const isLegendary = data.rarity.name === 'Legendary';
  const isEpic = data.rarity.name === 'Epic';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200" viewBox="0 0 800 1200">
  <defs>
    <!-- Background gradient -->
    <radialGradient id="bgGlow" cx="50%" cy="35%" r="60%" fx="50%" fy="35%">
      <stop offset="0%" stop-color="${theme.color}" stop-opacity="0.25"/>
      <stop offset="50%" stop-color="${theme.color}" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="${theme.gradientEnd}" stop-opacity="1"/>
    </radialGradient>

    <linearGradient id="cardBg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${theme.gradientStart}"/>
      <stop offset="100%" stop-color="${theme.gradientEnd}"/>
    </linearGradient>

    <!-- Element glow -->
    <radialGradient id="elementGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${theme.color}" stop-opacity="0.6"/>
      <stop offset="60%" stop-color="${theme.color}" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="${theme.color}" stop-opacity="0"/>
    </radialGradient>

    <!-- Rarity glow for number -->
    <radialGradient id="numberGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${rarityColor}" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="${rarityColor}" stop-opacity="0"/>
    </radialGradient>

    <!-- Legendary border gradient -->
    <linearGradient id="legendaryBorder" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f59e0b"/>
      <stop offset="25%" stop-color="#ef4444"/>
      <stop offset="50%" stop-color="#f59e0b"/>
      <stop offset="75%" stop-color="#ec4899"/>
      <stop offset="100%" stop-color="#f59e0b"/>
    </linearGradient>

    <!-- Subtle grid pattern -->
    <pattern id="gridPattern" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(255,255,255,0.03)" stroke-width="0.5"/>
    </pattern>

    <!-- Hex pattern -->
    <pattern id="hexPattern" width="60" height="52" patternUnits="userSpaceOnUse">
      <polygon points="30,2 55,15 55,37 30,50 5,37 5,15" fill="none" stroke="rgba(255,255,255,0.02)" stroke-width="0.5"/>
    </pattern>

    <!-- Drop shadow filter -->
    <filter id="softGlow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

    <filter id="textGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <!-- ═══ Background ═══ -->
  <rect width="800" height="1200" fill="url(#cardBg)"/>
  <rect width="800" height="1200" fill="url(#bgGlow)"/>
  <rect width="800" height="1200" fill="url(#gridPattern)"/>
  <rect width="800" height="1200" fill="url(#hexPattern)"/>

  <!-- ═══ Outer Border (legendary gets special border) ═══ -->
  ${isLegendary ? `
  <rect x="3" y="3" width="794" height="1194" rx="16" ry="16"
        fill="none" stroke="url(#legendaryBorder)" stroke-width="3" opacity="0.8"/>
  <rect x="8" y="8" width="784" height="1184" rx="12" ry="12"
        fill="none" stroke="url(#legendaryBorder)" stroke-width="1" opacity="0.4"/>
  ` : isEpic ? `
  <rect x="4" y="4" width="792" height="1192" rx="14" ry="14"
        fill="none" stroke="${rarityColor}" stroke-width="2" opacity="0.6"/>
  ` : `
  <rect x="4" y="4" width="792" height="1192" rx="14" ry="14"
        fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  `}

  <!-- ═══ Top Section: Brand & Tier ═══ -->
  <text x="400" y="52" text-anchor="middle" font-family="'SF Pro Display', -apple-system, sans-serif"
        font-size="14" fill="rgba(255,255,255,0.4)" letter-spacing="4" font-weight="500">
    123456BTC INSCRIPTIONFORGE
  </text>

  <!-- Tier badge -->
  <rect x="310" y="68" width="180" height="32" rx="16" fill="${tierColor}" opacity="0.15"/>
  <rect x="310" y="68" width="180" height="32" rx="16" fill="none" stroke="${tierColor}" stroke-width="1" opacity="0.4"/>
  <text x="400" y="90" text-anchor="middle" font-family="'SF Pro Display', sans-serif"
        font-size="15" fill="${tierColor}" font-weight="600">
    ${tierIcon} ${escapeXml(data.tier.toUpperCase())} TIER
  </text>

  <!-- ═══ Element Glow Background ═══ -->
  <circle cx="400" cy="320" r="200" fill="url(#elementGlow)"/>

  <!-- ═══ Central Element Icon ═══ -->
  <text x="400" y="350" text-anchor="middle" font-size="120" dominant-baseline="central"
        filter="url(#softGlow)">
    ${theme.icon}
  </text>

  <!-- ═══ Inscription Number (Hero) ═══ -->
  <circle cx="400" cy="510" r="120" fill="url(#numberGlow)"/>
  <text x="400" y="500" text-anchor="middle" font-family="'SF Mono', 'JetBrains Mono', monospace"
        font-size="72" fill="white" font-weight="800" letter-spacing="-2"
        filter="url(#textGlow)">
    ${numberStr}
  </text>

  <!-- Name (if named) -->
  ${data.name ? `
  <text x="400" y="555" text-anchor="middle" font-family="'SF Pro Display', sans-serif"
        font-size="22" fill="${rarityColor}" font-weight="600" font-style="italic">
    "${escapeXml(data.name)}"
  </text>
  ` : ''}

  <!-- ═══ Rarity Badge ═══ -->
  <rect x="280" y="${data.name ? 585 : 570}" width="240" height="42" rx="21"
        fill="${rarityBg}" stroke="${rarityColor}" stroke-width="1.5"/>
  <text x="400" y="${data.name ? 612 : 597}" text-anchor="middle"
        font-family="'SF Pro Display', sans-serif"
        font-size="18" fill="${rarityColor}" font-weight="700" letter-spacing="3">
    ${escapeXml(data.rarity.name.toUpperCase())}
  </text>

  <!-- ═══ Attribute Cards ═══ -->
  <!-- Element -->
  <rect x="60" y="650" width="200" height="100" rx="12"
        fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <text x="160" y="682" text-anchor="middle" font-family="'SF Pro Display', sans-serif"
        font-size="12" fill="rgba(255,255,255,0.4)" letter-spacing="2" font-weight="500">
    ELEMENT
  </text>
  <text x="160" y="718" text-anchor="middle" font-family="'SF Pro Display', sans-serif"
        font-size="22" fill="${theme.color}" font-weight="700">
    ${theme.icon} ${escapeXml(data.element.name)}
  </text>

  <!-- Trait -->
  <rect x="300" y="650" width="200" height="100" rx="12"
        fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <text x="400" y="682" text-anchor="middle" font-family="'SF Pro Display', sans-serif"
        font-size="12" fill="rgba(255,255,255,0.4)" letter-spacing="2" font-weight="500">
    TRAIT
  </text>
  <text x="400" y="718" text-anchor="middle" font-family="'SF Pro Display', sans-serif"
        font-size="22" fill="white" font-weight="700">
    ${escapeXml(data.trait.name)}
  </text>

  <!-- Series -->
  <rect x="540" y="650" width="200" height="100" rx="12"
        fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <text x="640" y="682" text-anchor="middle" font-family="'SF Pro Display', sans-serif"
        font-size="12" fill="rgba(255,255,255,0.4)" letter-spacing="2" font-weight="500">
    SERIES
  </text>
  <text x="640" y="718" text-anchor="middle" font-family="'SF Pro Display', sans-serif"
        font-size="22" fill="white" font-weight="700">
    #${String(data.series).padStart(2, '0')}
  </text>

  <!-- ═══ Details Section ═══ -->
  <line x1="60" y1="790" x2="740" y2="790" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>

  <!-- Epoch & Slot -->
  <text x="80" y="830" font-family="'SF Mono', monospace" font-size="13"
        fill="rgba(255,255,255,0.35)">
    Epoch
  </text>
  <text x="200" y="830" font-family="'SF Mono', monospace" font-size="13"
        fill="rgba(255,255,255,0.7)" text-anchor="end">
    ${data.epoch}
  </text>

  <text x="80" y="860" font-family="'SF Mono', monospace" font-size="13"
        fill="rgba(255,255,255,0.35)">
    Slot
  </text>
  <text x="200" y="860" font-family="'SF Mono', monospace" font-size="13"
        fill="rgba(255,255,255,0.7)" text-anchor="end">
    ${data.slot}
  </text>

  <!-- Luck Score -->
  <text x="80" y="900" font-family="'SF Mono', monospace" font-size="13"
        fill="rgba(255,255,255,0.35)">
    Luck Score
  </text>
  <text x="200" y="900" font-family="'SF Mono', monospace" font-size="13"
        fill="${data.luckScore >= 70 ? '#22c55e' : data.luckScore >= 40 ? '#f59e0b' : '#ef4444'}"
        text-anchor="end" font-weight="600">
    ${data.luckScore}/100
  </text>

  <!-- Seed Word -->
  ${data.seedWord ? `
  <text x="80" y="940" font-family="'SF Mono', monospace" font-size="13"
        fill="rgba(255,255,255,0.35)">
    Seed Word
  </text>
  <text x="200" y="940" font-family="'SF Mono', monospace" font-size="13"
        fill="${theme.color}" text-anchor="end" font-style="italic">
    ${escapeXml(data.seedWord)}
  </text>
  ` : ''}

  <!-- Wallet -->
  <text x="80" y="${data.seedWord ? 980 : 940}" font-family="'SF Mono', monospace" font-size="13"
        fill="rgba(255,255,255,0.35)">
    Wallet
  </text>
  <text x="200" y="${data.seedWord ? 980 : 940}" font-family="'SF Mono', monospace" font-size="13"
        fill="rgba(255,255,255,0.6)" text-anchor="end">
    ${escapeXml(walletShort)}
  </text>

  <!-- ═══ Luck Score Bar ═══ -->
  <rect x="380" y="815" width="340" height="8" rx="4" fill="rgba(255,255,255,0.08)"/>
  <rect x="380" y="815" width="${Math.max(8, (data.luckScore / 100) * 340)}" height="8" rx="4"
        fill="${data.luckScore >= 70 ? '#22c55e' : data.luckScore >= 40 ? '#f59e0b' : '#ef4444'}"
        opacity="0.8"/>

  <!-- Trait description -->
  <text x="400" y="870" text-anchor="middle" font-family="'SF Pro Display', sans-serif"
        font-size="16" fill="rgba(255,255,255,0.35)" font-style="italic">
    "${escapeXml(data.trait.description)}"
  </text>

  <!-- ═══ Divider ═══ -->
  <line x1="60" y1="960" x2="740" y2="960" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>

  <!-- ═══ QR Code Placeholder ═══ -->
  <rect x="290" y="990" width="220" height="100" rx="12"
        fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>

  <!-- QR Code Pattern (decorative) -->
  <g transform="translate(310, 1005)">
    ${generateQRPlaceholder(80, 80)}
  </g>

  <text x="510" y="1030" font-family="'SF Pro Display', sans-serif"
        font-size="14" fill="rgba(255,255,255,0.5)" font-weight="500">
    Scan to verify
  </text>
  <text x="510" y="1055" font-family="'SF Mono', monospace"
        font-size="12" fill="${theme.color}">
    123456btc.io
  </text>
  <text x="510" y="1075" font-family="'SF Mono', monospace"
        font-size="11" fill="rgba(255,255,255,0.3)">
    /inscribe
  </text>

  <!-- ═══ Bottom Branding ═══ -->
  <line x1="60" y1="1110" x2="740" y2="1110" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>

  <text x="400" y="1145" text-anchor="middle" font-family="'SF Pro Display', sans-serif"
        font-size="16" fill="rgba(255,255,255,0.25)" letter-spacing="6" font-weight="500">
    123456BTC
  </text>
  <text x="400" y="1170" text-anchor="middle" font-family="'SF Pro Display', sans-serif"
        font-size="11" fill="rgba(255,255,255,0.15)" letter-spacing="3">
    INSCRIPTIONFORGE PROTOCOL
  </text>
</svg>`;
}

// ═══════════════════════════════════════════════════════
//  2. Collection Card (1200x800)
// ═══════════════════════════════════════════════════════

export function generateCollectionCard(
  wallet: string,
  inscriptions: CardData[],
): string {
  const walletShort = truncateAddress(wallet, 8);
  const total = inscriptions.length;
  const luckScore = total > 0
    ? Math.round(inscriptions.reduce((sum, i) => sum + i.luckScore, 0) / total)
    : 50;

  // Rarity distribution
  const rarityDist: Record<string, number> = {};
  for (const ins of inscriptions) {
    rarityDist[ins.rarity.name] = (rarityDist[ins.rarity.name] || 0) + 1;
  }

  // Element distribution
  const elementDist: Record<string, number> = {};
  for (const ins of inscriptions) {
    elementDist[ins.element.name] = (elementDist[ins.element.name] || 0) + 1;
  }

  // Tier distribution
  const tierDist: Record<string, number> = {};
  for (const ins of inscriptions) {
    tierDist[ins.tier] = (tierDist[ins.tier] || 0) + 1;
  }

  // Grid of mini cards (max 20 shown)
  const showCards = inscriptions.slice(0, 20);
  const cols = 5;
  const miniCardW = 100;
  const miniCardH = 120;
  const gapX = 16;
  const gapY = 16;
  const gridStartX = 60;
  const gridStartY = 280;

  // Build mini cards
  const miniCards = showCards.map((card, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = gridStartX + col * (miniCardW + gapX);
    const y = gridStartY + row * (miniCardH + gapY);
    const theme = ELEMENT_THEMES[card.element.name as InscriptionElement] || ELEMENT_THEMES.Void;
    const rc = RARITY_COLORS[card.rarity.name as InscriptionRarity] || '#9ca3af';
    const numStr = `#${String(card.inscriptionNumber).padStart(4, '0')}`;

    return `
    <g transform="translate(${x}, ${y})">
      <rect width="${miniCardW}" height="${miniCardH}" rx="8"
            fill="rgba(255,255,255,0.04)" stroke="${rc}" stroke-width="1" opacity="0.6"/>
      <text x="${miniCardW / 2}" y="35" text-anchor="middle" font-size="32">
        ${theme.icon}
      </text>
      <text x="${miniCardW / 2}" y="65" text-anchor="middle"
            font-family="'SF Mono', monospace" font-size="14" fill="white" font-weight="700">
        ${numStr}
      </text>
      <text x="${miniCardW / 2}" y="85" text-anchor="middle"
            font-family="'SF Pro Display', sans-serif" font-size="10" fill="${rc}" font-weight="600">
        ${escapeXml(card.rarity.name)}
      </text>
      <text x="${miniCardW / 2}" y="105" text-anchor="middle"
            font-family="'SF Pro Display', sans-serif" font-size="10" fill="rgba(255,255,255,0.35)">
        ${escapeXml(card.element.name)}
      </text>
    </g>`;
  }).join('');

  // Rarity distribution bars
  const rarityOrder = ['Legendary', 'Epic', 'Rare', 'Common'];
  const rarityBars = rarityOrder.map((r, i) => {
    const count = rarityDist[r] || 0;
    const pct = total > 0 ? (count / total) * 100 : 0;
    const rc = RARITY_COLORS[r as InscriptionRarity] || '#9ca3af';
    const barY = 290 + i * 28;
    return `
    <text x="700" y="${barY}" font-family="'SF Pro Display', sans-serif"
          font-size="12" fill="rgba(255,255,255,0.5)" text-anchor="start">
      ${r}
    </text>
    <rect x="780" y="${barY - 10}" width="180" height="12" rx="6" fill="rgba(255,255,255,0.06)"/>
    <rect x="780" y="${barY - 10}" width="${Math.max(4, (pct / 100) * 180)}" height="12" rx="6"
          fill="${rc}" opacity="0.7"/>
    <text x="970" y="${barY}" font-family="'SF Mono', monospace"
          font-size="12" fill="${rc}" font-weight="600">
      ${count}
    </text>`;
  }).join('');

  // Element distribution (top 5)
  const elementEntries = Object.entries(elementDist)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);
  const elementBars = elementEntries.map(([elem, count], i) => {
    const theme = ELEMENT_THEMES[elem as InscriptionElement] || ELEMENT_THEMES.Void;
    const pct = total > 0 ? (count / total) * 100 : 0;
    const barY = 440 + i * 28;
    return `
    <text x="700" y="${barY}" font-family="'SF Pro Display', sans-serif"
          font-size="12" fill="rgba(255,255,255,0.5)" text-anchor="start">
      ${theme.icon} ${elem}
    </text>
    <rect x="780" y="${barY - 10}" width="180" height="12" rx="6" fill="rgba(255,255,255,0.06)"/>
    <rect x="780" y="${barY - 10}" width="${Math.max(4, (pct / 100) * 180)}" height="12" rx="6"
          fill="${theme.color}" opacity="0.5"/>
    <text x="970" y="${barY}" font-family="'SF Mono', monospace"
          font-size="12" fill="${theme.color}" font-weight="600">
      ${count}
    </text>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <defs>
    <linearGradient id="collBg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a0a12"/>
      <stop offset="100%" stop-color="#050508"/>
    </linearGradient>
    <radialGradient id="collGlow" cx="30%" cy="40%" r="60%">
      <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#050508" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- Background -->
  <rect width="1200" height="800" fill="url(#collBg)"/>
  <rect width="1200" height="800" fill="url(#collGlow)"/>
  <rect x="4" y="4" width="1192" height="792" rx="14"
        fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>

  <!-- Header -->
  <text x="60" y="45" font-family="'SF Pro Display', sans-serif"
        font-size="13" fill="rgba(255,255,255,0.3)" letter-spacing="4" font-weight="500">
    123456BTC COLLECTION
  </text>

  <!-- Wallet -->
  <text x="60" y="90" font-family="'SF Mono', monospace"
        font-size="24" fill="white" font-weight="700">
    ${escapeXml(walletShort)}
  </text>

  <!-- Stats Row -->
  <g transform="translate(60, 120)">
    <!-- Total -->
    <rect width="140" height="70" rx="10" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
    <text x="70" y="28" text-anchor="middle" font-family="'SF Pro Display', sans-serif"
          font-size="11" fill="rgba(255,255,255,0.4)" letter-spacing="1">TOTAL</text>
    <text x="70" y="55" text-anchor="middle" font-family="'SF Mono', monospace"
          font-size="26" fill="white" font-weight="800">${total}</text>
  </g>

  <g transform="translate(220, 120)">
    <!-- Luck Score -->
    <rect width="140" height="70" rx="10" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
    <text x="70" y="28" text-anchor="middle" font-family="'SF Pro Display', sans-serif"
          font-size="11" fill="rgba(255,255,255,0.4)" letter-spacing="1">LUCK SCORE</text>
    <text x="70" y="55" text-anchor="middle" font-family="'SF Mono', monospace"
          font-size="26" fill="${luckScore >= 70 ? '#22c55e' : luckScore >= 40 ? '#f59e0b' : '#ef4444'}"
          font-weight="800">${luckScore}</text>
  </g>

  ${Object.entries(tierDist).map(([tier, count], i) => {
    const tc = TIER_COLORS[tier] || '#c0c0c0';
    const ti = TIER_ICONS[tier] || '⬜';
    return `
  <g transform="translate(${380 + i * 160}, 120)">
    <rect width="140" height="70" rx="10" fill="rgba(255,255,255,0.04)" stroke="${tc}" stroke-width="1" opacity="0.4"/>
    <text x="70" y="28" text-anchor="middle" font-family="'SF Pro Display', sans-serif"
          font-size="11" fill="rgba(255,255,255,0.4)" letter-spacing="1">${ti} ${tier.toUpperCase()}</text>
    <text x="70" y="55" text-anchor="middle" font-family="'SF Mono', monospace"
          font-size="26" fill="${tc}" font-weight="800">${count}</text>
  </g>`;
  }).join('')}

  <!-- Mini Card Grid -->
  <text x="60" y="250" font-family="'SF Pro Display', sans-serif"
        font-size="14" fill="rgba(255,255,255,0.4)" letter-spacing="2">
    INSCRIPTIONS
  </text>

  ${miniCards}

  ${total > 20 ? `
  <text x="${gridStartX + 5 * (miniCardW + gapX) / 2}" y="${gridStartY + 4 * (miniCardH + gapY) + 20}"
        text-anchor="middle" font-family="'SF Pro Display', sans-serif"
        font-size="13" fill="rgba(255,255,255,0.3)">
    +${total - 20} more inscriptions
  </text>` : ''}

  <!-- Distribution Sidebar -->
  <text x="700" y="250" font-family="'SF Pro Display', sans-serif"
        font-size="14" fill="rgba(255,255,255,0.4)" letter-spacing="2">
    RARITY DISTRIBUTION
  </text>
  ${rarityBars}

  <text x="700" y="410" font-family="'SF Pro Display', sans-serif"
        font-size="14" fill="rgba(255,255,255,0.4)" letter-spacing="2">
    TOP ELEMENTS
  </text>
  ${elementBars}

  <!-- Bottom Branding -->
  <line x1="60" y1="740" x2="1140" y2="740" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  <text x="600" y="775" text-anchor="middle" font-family="'SF Pro Display', sans-serif"
        font-size="14" fill="rgba(255,255,255,0.2)" letter-spacing="5">
    123456BTC INSCRIPTIONFORGE
  </text>
</svg>`;
}

// ═══════════════════════════════════════════════════════
//  3. Leaderboard Card (800x600)
// ═══════════════════════════════════════════════════════

export function generateLeaderboardCard(
  rank: number,
  score: number,
  top10: LeaderboardEntry[],
  type: string = 'luckiest',
  viewerWallet?: string,
): string {
  const rankColors: Record<number, string> = {
    1: '#ffd700',
    2: '#c0c0c0',
    3: '#cd7f32',
  };
  const rankIcons: Record<number, string> = {
    1: '👑',
    2: '🥈',
    3: '🥉',
  };

  const isTop3 = rank <= 3;
  const rankColor = rankColors[rank] || 'rgba(255,255,255,0.7)';
  const rankIcon = rankIcons[rank] || '';
  const rankStr = `#${rank}`;

  const typeLabels: Record<string, string> = {
    luckiest: 'LUCKIEST',
    whale: 'WHALE',
    opened: 'MOST ACTIVE',
    jackpot: 'JACKPOT KING',
    referral: 'TOP REFERRER',
  };

  // Build leaderboard rows
  const rows = top10.slice(0, 8).map((entry, i) => {
    const y = 260 + i * 42;
    const rc = rankColors[entry.rank] || 'rgba(255,255,255,0.5)';
    const ri = rankIcons[entry.rank] || '';
    const isViewer = viewerWallet && entry.wallet === viewerWallet;
    const wShort = truncateAddress(entry.wallet, 5);
    const bgFill = isViewer ? 'rgba(59,130,246,0.12)' : (i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent');
    const borderStroke = isViewer ? 'rgba(59,130,246,0.3)' : 'transparent';

    return `
    <rect x="60" y="${y}" width="680" height="36" rx="8"
          fill="${bgFill}" stroke="${borderStroke}" stroke-width="1"/>
    <text x="90" y="${y + 24}" font-family="'SF Mono', monospace"
          font-size="16" fill="${rc}" font-weight="700">
      ${ri} ${entry.rank}
    </text>
    <text x="180" y="${y + 24}" font-family="'SF Mono', monospace"
          font-size="14" fill="rgba(255,255,255,0.7)">
      ${escapeXml(wShort)}
    </text>
    <text x="680" y="${y + 24}" font-family="'SF Mono', monospace"
          font-size="16" fill="${rc}" font-weight="700" text-anchor="end">
      ${formatNumber(entry.score)}
    </text>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <defs>
    <linearGradient id="lbBg" x1="0" y1="0" x2="0.5" y2="1">
      <stop offset="0%" stop-color="#0a0a14"/>
      <stop offset="100%" stop-color="#050508"/>
    </linearGradient>
    <radialGradient id="lbGlow" cx="50%" cy="25%" r="50%">
      <stop offset="0%" stop-color="${isTop3 ? rankColor : '#3b82f6'}" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#050508" stop-opacity="0"/>
    </radialGradient>
    ${isTop3 ? `
    <linearGradient id="rankBorder" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${rankColor}"/>
      <stop offset="50%" stop-color="${rankColor}" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="${rankColor}"/>
    </linearGradient>` : ''}
  </defs>

  <!-- Background -->
  <rect width="800" height="600" fill="url(#lbBg)"/>
  <rect width="800" height="600" fill="url(#lbGlow)"/>
  <rect x="4" y="4" width="792" height="592" rx="14"
        fill="none" stroke="${isTop3 ? rankColor : 'rgba(255,255,255,0.06)'}"
        stroke-width="${isTop3 ? 2 : 1}" opacity="${isTop3 ? 0.6 : 1}"/>

  <!-- Header -->
  <text x="400" y="40" text-anchor="middle" font-family="'SF Pro Display', sans-serif"
        font-size="13" fill="rgba(255,255,255,0.3)" letter-spacing="4">
    123456BTC LEADERBOARD
  </text>

  <text x="400" y="70" text-anchor="middle" font-family="'SF Pro Display', sans-serif"
        font-size="16" fill="rgba(255,255,255,0.5)" letter-spacing="3">
    ${escapeXml(typeLabels[type] || type.toUpperCase())}
  </text>

  <!-- Your Rank (hero) -->
  ${rankIcon ? `
  <text x="280" y="155" text-anchor="middle" font-size="60">${rankIcon}</text>
  ` : ''}
  <text x="${rankIcon ? 380 : 340}" y="130" font-family="'SF Mono', monospace"
        font-size="64" fill="${rankColor}" font-weight="900" text-anchor="middle">
    ${rankStr}
  </text>
  <text x="${rankIcon ? 380 : 340}" y="165" font-family="'SF Pro Display', sans-serif"
        font-size="14" fill="rgba(255,255,255,0.4)" text-anchor="middle" letter-spacing="2">
    YOUR RANK
  </text>

  <!-- Your Score -->
  <text x="${rankIcon ? 540 : 500}" y="130" font-family="'SF Mono', monospace"
        font-size="48" fill="white" font-weight="800" text-anchor="middle">
    ${formatNumber(score)}
  </text>
  <text x="${rankIcon ? 540 : 500}" y="165" font-family="'SF Pro Display', sans-serif"
        font-size="14" fill="rgba(255,255,255,0.4)" text-anchor="middle" letter-spacing="2">
    SCORE
  </text>

  <!-- Divider -->
  <line x1="60" y1="200" x2="740" y2="200" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>

  <!-- Column headers -->
  <text x="90" y="235" font-family="'SF Pro Display', sans-serif"
        font-size="11" fill="rgba(255,255,255,0.3)" letter-spacing="2">
    RANK
  </text>
  <text x="180" y="235" font-family="'SF Pro Display', sans-serif"
        font-size="11" fill="rgba(255,255,255,0.3)" letter-spacing="2">
    WALLET
  </text>
  <text x="680" y="235" font-family="'SF Pro Display', sans-serif"
        font-size="11" fill="rgba(255,255,255,0.3)" letter-spacing="2" text-anchor="end">
    SCORE
  </text>

  <!-- Leaderboard Rows -->
  ${rows}

  <!-- Bottom Branding -->
  <line x1="60" y1="560" x2="740" y2="560" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  <text x="400" y="585" text-anchor="middle" font-family="'SF Pro Display', sans-serif"
        font-size="13" fill="rgba(255,255,255,0.15)" letter-spacing="5">
    123456BTC INSCRIPTIONFORGE
  </text>
</svg>`;
}

// ═══════════════════════════════════════════════════════
//  QR Code Placeholder (decorative SVG pattern)
// ═══════════════════════════════════════════════════════

function generateQRPlaceholder(width: number, height: number): string {
  const cellSize = 5;
  const cols = Math.floor(width / cellSize);
  const rows = Math.floor(height / cellSize);
  const cells: string[] = [];

  // Deterministic pseudo-random pattern that looks like a QR code
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Position markers (corners)
      const isCornerMarker =
        (r < 4 && c < 4) ||
        (r < 4 && c >= cols - 4) ||
        (r >= rows - 4 && c < 4);

      // Inner position marker pattern
      const inCornerInner =
        (r === 1 && c === 1) || (r === 1 && c === 2) || (r === 2 && c === 1) || (r === 2 && c === 2) ||
        (r === 1 && c === cols - 3) || (r === 1 && c === cols - 2) || (r === 2 && c === cols - 3) || (r === 2 && c === cols - 2) ||
        (r === rows - 3 && c === 1) || (r === rows - 3 && c === 2) || (r === rows - 2 && c === 1) || (r === rows - 2 && c === 2);

      // Border of position markers
      const isCornerBorder =
        (r === 0 && c < 4) || (r === 3 && c < 4) || (c === 0 && r < 4) || (c === 3 && r < 4) ||
        (r === 0 && c >= cols - 4) || (r === 3 && c >= cols - 4) || (c === cols - 4 && r < 4) || (c === cols - 1 && r < 4) ||
        (r === rows - 4 && c < 4) || (r === rows - 1 && c < 4) || (c === 0 && r >= rows - 4) || (c === 3 && r >= rows - 4);

      // Data area: pseudo-random based on position
      const hash = ((r * 7 + c * 13 + r * c * 3) % 11);
      const isData = !isCornerMarker && hash < 4;

      const filled = inCornerInner || isCornerBorder || isData;
      if (filled) {
        cells.push(`<rect x="${c * cellSize}" y="${r * cellSize}" width="${cellSize}" height="${cellSize}" fill="rgba(255,255,255,0.7)"/>`);
      }
    }
  }

  return cells.join('\n    ');
}

// ═══════════════════════════════════════════════════════
//  Utility: SVG to Buffer (for Telegram photo upload)
// ═══════════════════════════════════════════════════════

export function svgToBuffer(svg: string): Buffer {
  return Buffer.from(svg, 'utf-8');
}

/**
 * Returns Content-Type and body for HTTP response.
 * Use with: res.setHeader('Content-Type', contentType); res.end(body);
 */
export function svgResponse(svg: string): { contentType: string; body: Buffer } {
  return {
    contentType: 'image/svg+xml; charset=utf-8',
    body: Buffer.from(svg, 'utf-8'),
  };
}
