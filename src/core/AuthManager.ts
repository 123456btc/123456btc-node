/**
 * AuthManager — 本地认证管理
 * Provider HMAC 认证 + 用户钱包签名认证
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { PublicKey } from '@solana/web3.js';
import type { ProviderConfig } from '../types/index.js';

export interface ProviderAuthResult {
  valid: boolean;
  providerId?: string;
  error?: string;
}

export interface WalletAuthResult {
  valid: boolean;
  walletAddress?: string;
  error?: string;
}

export class AuthManager {
  constructor(private config: ProviderConfig) {}

  // ── Provider HMAC 认证（推送信号） ──

  verifyProvider(headers: Record<string, string | undefined>): ProviderAuthResult {
    const providerId = headers['x-provider-id'];
    const signature = headers['x-provider-signature'];
    const timestamp = headers['x-provider-timestamp'];

    if (!providerId || !signature || !timestamp) {
      return { valid: false, error: 'Missing provider auth headers' };
    }

    // 防重放：timestamp 必须在 60 秒内
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts) || Math.abs(Date.now() - ts) > 60_000) {
      return { valid: false, error: 'Timestamp expired or invalid' };
    }

    if (providerId !== this.config.provider_id) {
      return { valid: false, error: 'Unknown provider' };
    }

    const payload = `${providerId}:${timestamp}`;
    const expected = createHmac('sha256', this.config.provider_secret).update(payload).digest('hex');

    try {
      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return { valid: false, error: 'Invalid signature' };
      }
    } catch {
      return { valid: false, error: 'Invalid signature' };
    }

    return { valid: true, providerId };
  }

  signProviderPayload(payload: string): string {
    return createHmac('sha256', this.config.provider_secret).update(payload).digest('hex');
  }

  // ── 用户钱包签名认证（WebSocket / HTTP） ──

  verifyWalletSignature(walletAddress: string, signature: string, timestamp: number, message?: string): WalletAuthResult {
    // 防重放
    if (Math.abs(Date.now() - timestamp) > 60_000) {
      return { valid: false, error: 'Timestamp expired' };
    }

    try {
      const pubKey = new PublicKey(walletAddress);
      const msg = message || `123456btc-node auth ${walletAddress} ${timestamp}`;
      const msgBytes = new TextEncoder().encode(msg);
      const sigBytes = Buffer.from(signature, 'base64');

      // @ts-ignore — nacl.sign.detached.verify via PublicKey extension
      const valid = pubKey.verify ? pubKey.verify(msgBytes, sigBytes) : false;
      if (!valid) {
        return { valid: false, error: 'Invalid wallet signature' };
      }

      return { valid: true, walletAddress };
    } catch (e) {
      return { valid: false, error: `Wallet verification failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // ── Admin API Key 认证 ──

  verifyAdminKey(headers: Record<string, string | undefined>): boolean {
    const key = headers['x-admin-api-key'];
    if (!key) return false;
    try {
      return timingSafeEqual(Buffer.from(key), Buffer.from(this.config.admin_api_key));
    } catch {
      return false;
    }
  }
}
