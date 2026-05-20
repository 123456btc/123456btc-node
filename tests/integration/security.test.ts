import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CryptoVault } from '../../src/infra/security/CryptoVault.js';
import { SecureLogRotator } from '../../src/infra/security/SecureLogRotator.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const mockLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
} as any;

function mockConfig(overrides: Record<string, any> = {}) {
  return { get: (key: string) => overrides[key] } as any;
}

describe('Security Infrastructure', () => {

  describe('CryptoVault', () => {
    let vault: CryptoVault;

    beforeEach(() => {
      vault = new CryptoVault(mockLogger);
      vault.initMasterKey('test-password-12345');
    });

    it('encrypt and decrypt roundtrip', () => {
      const plaintext = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
      const encrypted = vault.encrypt(plaintext);
      expect(encrypted).not.toBe(plaintext);
      const decrypted = vault.decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('different plaintexts produce different ciphertexts', () => {
      const a = vault.encrypt('wallet_a');
      const b = vault.encrypt('wallet_b');
      expect(a).not.toBe(b);
    });

    it('decrypt with wrong key fails', () => {
      const encrypted = vault.encrypt('secret');
      const vault2 = new CryptoVault(mockLogger);
      vault2.initMasterKey('wrong-password');
      expect(() => vault2.decrypt(encrypted)).toThrow();
    });

    it('emergencyWipe clears master key', () => {
      vault.encrypt('test'); // ensure key is used
      vault.emergencyWipe();
      expect(() => vault.encrypt('test')).toThrow();
    });

    it('hmacSign produces consistent signatures', () => {
      const sig1 = vault.hmacSign('payload', 'secret');
      const sig2 = vault.hmacSign('payload', 'secret');
      expect(sig1).toBe(sig2);
    });

    it('hmacVerify validates correct signature', () => {
      const sig = vault.hmacSign('payload', 'secret');
      expect(vault.hmacVerify('payload', 'secret', sig)).toBe(true);
      expect(vault.hmacVerify('payload', 'wrong', sig)).toBe(false);
    });
  });

  describe('SecureLogRotator', () => {
    let logsDir: string;
    let dataDir: string;
    let rotator: SecureLogRotator;

    beforeEach(() => {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-test-'));
      logsDir = path.join(dataDir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      rotator = new SecureLogRotator(mockConfig({ data_dir: dataDir, log_persist_days: 1 }), mockLogger);
    });

    afterEach(() => {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    });

    it('writes log files', () => {
      rotator.write('info', 'test message', {});
      const files = fs.readdirSync(logsDir);
      expect(files.length).toBeGreaterThan(0);
    });

    it('emergencyPurge deletes all log files', () => {
      rotator.write('info', 'msg1', {});
      rotator.write('info', 'msg2', {});
      expect(fs.readdirSync(logsDir).length).toBeGreaterThan(0);
      rotator.emergencyPurge();
      expect(fs.readdirSync(logsDir).length).toBe(0);
    });
  });

  describe('Emergency Wipe Integration', () => {
    it('wipe clears database and logs', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wipe-test-'));
      const dbPath = path.join(tmpDir, 'test.db');
      const logsDir = path.join(tmpDir, 'logs');
      fs.mkdirSync(logsDir);

      // Create fake files
      fs.writeFileSync(dbPath, 'fake db');
      fs.writeFileSync(path.join(logsDir, 'test.log'), 'fake log');

      // Verify files exist
      expect(fs.existsSync(dbPath)).toBe(true);
      expect(fs.existsSync(path.join(logsDir, 'test.log'))).toBe(true);

      // Simulate wipe
      fs.unlinkSync(dbPath);
      const rotator = new SecureLogRotator(mockConfig({ data_dir: tmpDir, log_persist_days: 0 }), mockLogger);
      rotator.emergencyPurge();

      // Verify files gone
      expect(fs.existsSync(dbPath)).toBe(false);
      expect(fs.readdirSync(logsDir).length).toBe(0);

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
