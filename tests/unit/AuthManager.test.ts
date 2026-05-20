import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import { AuthManager } from '../../src/core/AuthManager.js';
import type { ProviderConfig } from '../../src/types/index.js';

const PROVIDER_ID = 'prov_test_001';
const PROVIDER_SECRET = 'super-secret-key-for-hmac-testing-32b!';
const ADMIN_API_KEY = 'admin-test-api-key-12345';

function createMockConfig(): ProviderConfig {
  return {
    provider_id: PROVIDER_ID,
    provider_secret: PROVIDER_SECRET,
    name: 'Test Provider',
    wallet_address: 'TestWallet1111111111111111111111111111111111',
    treasury_wallet: 'Treasury111111111111111111111111111111111111',
    solana_rpc: 'http://localhost:8899',
    bbt_mint: 'BBBToken1111111111111111111111111111111111111',
    burn_rate: 0.5,
    node_port: 3000,
    admin_api_key: ADMIN_API_KEY,
  };
}

function signPayload(providerId: string, timestamp: string, secret: string): string {
  const payload = `${providerId}:${timestamp}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

describe('AuthManager', () => {
  let auth: AuthManager;

  beforeEach(() => {
    auth = new AuthManager(createMockConfig());
  });

  // ── verifyProvider ──

  describe('verifyProvider', () => {
    it('valid HMAC signature passes', () => {
      const timestamp = Date.now().toString();
      const signature = signPayload(PROVIDER_ID, timestamp, PROVIDER_SECRET);

      const result = auth.verifyProvider({
        'x-provider-id': PROVIDER_ID,
        'x-provider-signature': signature,
        'x-provider-timestamp': timestamp,
      });

      expect(result.valid).toBe(true);
      expect(result.providerId).toBe(PROVIDER_ID);
      expect(result.error).toBeUndefined();
    });

    it('expired timestamp rejects', () => {
      const expiredTs = (Date.now() - 120_000).toString(); // 2 minutes ago
      const signature = signPayload(PROVIDER_ID, expiredTs, PROVIDER_SECRET);

      const result = auth.verifyProvider({
        'x-provider-id': PROVIDER_ID,
        'x-provider-signature': signature,
        'x-provider-timestamp': expiredTs,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Timestamp expired');
    });

    it('wrong signature rejects', () => {
      const timestamp = Date.now().toString();
      const wrongSignature = signPayload(PROVIDER_ID, timestamp, 'wrong-secret');

      const result = auth.verifyProvider({
        'x-provider-id': PROVIDER_ID,
        'x-provider-signature': wrongSignature,
        'x-provider-timestamp': timestamp,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid signature');
    });

    it('missing headers rejects', () => {
      // All missing
      const result1 = auth.verifyProvider({});
      expect(result1.valid).toBe(false);
      expect(result1.error).toContain('Missing provider auth headers');

      // Only provider-id present
      const result2 = auth.verifyProvider({ 'x-provider-id': PROVIDER_ID });
      expect(result2.valid).toBe(false);
      expect(result2.error).toContain('Missing provider auth headers');

      // Missing timestamp
      const result3 = auth.verifyProvider({
        'x-provider-id': PROVIDER_ID,
        'x-provider-signature': 'abc',
      });
      expect(result3.valid).toBe(false);
      expect(result3.error).toContain('Missing provider auth headers');
    });

    it('unknown provider id rejects', () => {
      const timestamp = Date.now().toString();
      const signature = signPayload('unknown_provider', timestamp, PROVIDER_SECRET);

      const result = auth.verifyProvider({
        'x-provider-id': 'unknown_provider',
        'x-provider-signature': signature,
        'x-provider-timestamp': timestamp,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unknown provider');
    });
  });

  // ── verifyAdminKey ──

  describe('verifyAdminKey', () => {
    it('correct key passes', () => {
      const result = auth.verifyAdminKey({ 'x-admin-api-key': ADMIN_API_KEY });
      expect(result).toBe(true);
    });

    it('wrong key rejects', () => {
      const result = auth.verifyAdminKey({ 'x-admin-api-key': 'wrong-key' });
      expect(result).toBe(false);
    });

    it('missing key rejects', () => {
      const result = auth.verifyAdminKey({});
      expect(result).toBe(false);
    });
  });

  // ── verifyWalletSignature ──

  describe('verifyWalletSignature', () => {
    it('expired timestamp rejects', () => {
      const expiredTs = Date.now() - 600_000; // 10 minutes ago
      const result = auth.verifyWalletSignature(
        'SomeWallet111111111111111111111111111111111111',
        'dGVzdA==', // base64 "test"
        expiredTs,
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Timestamp expired');
    });

    it('invalid wallet address rejects gracefully', () => {
      const result = auth.verifyWalletSignature(
        'not-a-valid-solana-pubkey',
        'dGVzdA==',
        Date.now(),
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Wallet verification failed');
    });
  });
});
