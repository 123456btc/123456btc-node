/**
 * Share Card HTTP Endpoints
 *
 * Provides SVG image endpoints for InscriptionForge share cards:
 * - GET /share/inscribe/:id   — Inscription result card
 * - GET /share/collection/:wallet — Collection overview card
 * - GET /share/leaderboard    — Leaderboard card
 *
 * These endpoints are public (no auth required) for social sharing.
 * Returns SVG with proper Content-Type headers for browser/Telegram rendering.
 */

import * as http from 'http';
import type { BlindBoxEngine } from '../core/BlindBoxEngine.js';
import {
  generateInscriptionCard,
  generateCollectionCard,
  generateLeaderboardCard,
  inscriptionToCardData,
  svgResponse,
  type CardData,
} from '../core/ShareCardGenerator.js';

// ═══════════════════════════════════════════════════════
//  Route Handler Registration
// ═══════════════════════════════════════════════════════

/**
 * Attempts to handle a share card request.
 * Returns true if the request was handled, false if it should fall through.
 */
export function handleShareCardRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  inscriptionForge?: BlindBoxEngine,
): boolean {
  if (!inscriptionForge) return false;

  // ── GET /share/inscribe/:id ──
  if (req.method === 'GET' && url.pathname.startsWith('/share/inscribe/')) {
    handleInscriptionCard(req, res, url, inscriptionForge);
    return true;
  }

  // ── GET /share/collection/:wallet ──
  if (req.method === 'GET' && url.pathname.startsWith('/share/collection/')) {
    handleCollectionCard(req, res, url, inscriptionForge);
    return true;
  }

  // ── GET /share/leaderboard ──
  if (req.method === 'GET' && url.pathname === '/share/leaderboard') {
    handleLeaderboardCard(req, res, url, inscriptionForge);
    return true;
  }

  return false;
}

// ═══════════════════════════════════════════════════════
//  /share/inscribe/:id
// ═══════════════════════════════════════════════════════

function handleInscriptionCard(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  engine: BlindBoxEngine,
): void {
  // Extract inscription ID from path: /share/inscribe/:id
  const parts = url.pathname.split('/');
  const inscriptionId = parts[3];

  if (!inscriptionId) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Inscription ID required' }));
    return;
  }

  // Look up by ID first, then by number
  let record = engine.getInscription(inscriptionId);
  if (!record) {
    const num = parseInt(inscriptionId, 10);
    if (!isNaN(num)) {
      record = engine.getInscriptionByNumber(num);
    }
  }

  if (!record) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Inscription not found' }));
    return;
  }

  // Check for optional seed word via query param
  const seedWord = url.searchParams.get('seed') || url.searchParams.get('seedWord') || undefined;

  // Build card data
  const luckScore = engine.getLuckScore(record.userId);
  const cardData = inscriptionToCardData(record, luckScore, seedWord || undefined);

  // Generate SVG
  const svg = generateInscriptionCard(cardData);
  const { contentType, body } = svgResponse(svg);

  // Cache for 1 hour (inscription data is immutable once minted)
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.statusCode = 200;
  res.end(body);
}

// ═══════════════════════════════════════════════════════
//  /share/collection/:wallet
// ═══════════════════════════════════════════════════════

function handleCollectionCard(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  engine: BlindBoxEngine,
): void {
  // Extract wallet from path: /share/collection/:wallet
  const parts = url.pathname.split('/');
  const wallet = parts[3];

  if (!wallet) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Wallet address required' }));
    return;
  }

  // Get collection
  const collection = engine.getCollection(wallet);

  if (collection.inscriptions.length === 0) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'No inscriptions found for this wallet' }));
    return;
  }

  // Convert to card data
  const cardDataList: CardData[] = collection.inscriptions.map((record) =>
    inscriptionToCardData(record, collection.luckScore),
  );

  // Generate SVG
  const svg = generateCollectionCard(wallet, cardDataList);
  const { contentType, body } = svgResponse(svg);

  // Cache for 5 minutes (collection can change)
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.statusCode = 200;
  res.end(body);
}

// ═══════════════════════════════════════════════════════
//  /share/leaderboard
// ═══════════════════════════════════════════════════════

function handleLeaderboardCard(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  engine: BlindBoxEngine,
): void {
  const type = url.searchParams.get('type') || 'luckiest';
  const wallet = url.searchParams.get('wallet') || undefined;

  const validTypes = ['luckiest', 'whale', 'opened', 'jackpot', 'referral'];
  if (!validTypes.includes(type)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Invalid leaderboard type' }));
    return;
  }

  // Get leaderboard
  const leaderboard = engine.getLeaderboard(type as any, 10);

  // Find viewer's rank if wallet provided
  let viewerRank = 0;
  let viewerScore = 0;

  if (wallet) {
    // Check full leaderboard for the viewer
    const fullLeaderboard = engine.getLeaderboard(type as any, 1000);
    const viewerEntry = fullLeaderboard.find((e) => e.wallet === wallet);
    if (viewerEntry) {
      viewerRank = viewerEntry.rank;
      viewerScore = viewerEntry.score;
    } else {
      // Not ranked yet
      viewerRank = fullLeaderboard.length + 1;
      viewerScore = 0;
    }
  } else {
    // Default to first entry
    if (leaderboard.length > 0) {
      viewerRank = leaderboard[0].rank;
      viewerScore = leaderboard[0].score;
    }
  }

  // Generate SVG
  const svg = generateLeaderboardCard(viewerRank, viewerScore, leaderboard, type, wallet);
  const { contentType, body } = svgResponse(svg);

  // Cache for 2 minutes (leaderboard changes frequently)
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=120');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.statusCode = 200;
  res.end(body);
}

// ═══════════════════════════════════════════════════════
//  Integration Helper
// ═══════════════════════════════════════════════════════

/**
 * Call this from createHttpServer() to register share card routes.
 *
 * Usage in http.ts:
 * ```ts
 * import { handleShareCardRoute } from './shareCard.js';
 *
 * // Inside the request handler, before other routes:
 * if (handleShareCardRoute(req, res, url, inscriptionForge)) return;
 * ```
 */
export { handleShareCardRoute as default };
