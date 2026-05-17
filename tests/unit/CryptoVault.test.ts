import { describe, it, expect, beforeEach } from 'vitest';
import { CryptoVault } from '../../src/infra/security/CryptoVault.js';
import { ShamirSecretSharing } from '../../src/infra/security/ShamirSecretSharing.js';

const stubLogger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, child: () => stubLogger } as any;

describe('CryptoVault + Shamir integration', () => {
  let vault: CryptoVault;
  let shamir: ShamirSecretSharing;

  beforeEach(() => {
    shamir = new ShamirSecretSharing(stubLogger);
    vault = new CryptoVault(stubLogger, shamir);
  });

  it('initWithKey + encrypt/decrypt roundtrip', () => {
    const keyHex = 'a'.repeat(64);
    vault.initWithKey(keyHex);
    expect(vault.isInitialized).toBe(true);

    const plaintext = 'sensitive data 敏感信息';
    const cipher = vault.encrypt(plaintext);
    expect(cipher).toContain(':');

    const decrypted = vault.decrypt(cipher);
    expect(decrypted).toBe(plaintext);
  });

  it('initWithShares: 3-of-5 recovery', () => {
    // 先用密码生成一个 key
    vault.initMasterKey('test-password-123', 'deadbeefdeadbeef');
    const shares = vault.splitCurrentKey(5, 3);
    expect(shares.length).toBe(5);

    // 销毁当前 vault
    vault.emergencyWipe();
    expect(vault.isInitialized).toBe(false);

    // 用任意 3 份恢复
    const newVault = new CryptoVault(stubLogger, shamir);
    newVault.initWithShares([shares[0], shares[2], shares[4]]);
    expect(newVault.isInitialized).toBe(true);

    // 加密解密验证 key 一致
    const plaintext = 'roundtrip after shamir recovery';
    const cipher = newVault.encrypt(plaintext);
    expect(newVault.decrypt(cipher)).toBe(plaintext);
  });

  it('emergencyWipe clears master key', () => {
    vault.initWithKey('b'.repeat(64));
    expect(vault.isInitialized).toBe(true);
    vault.emergencyWipe();
    expect(vault.isInitialized).toBe(false);
  });

  it('throws when not initialized', () => {
    expect(() => vault.encrypt('test')).toThrow('CryptoVault not initialized');
    expect(() => vault.decrypt('iv:tag:data')).toThrow('CryptoVault not initialized');
  });

  it('hmac sign/verify works', () => {
    const secret = 'my-secret';
    const payload = 'payload-data';
    const sig = vault.hmacSign(secret, payload);
    expect(vault.hmacVerify(secret, payload, sig)).toBe(true);
    expect(vault.hmacVerify(secret, 'tampered', sig)).toBe(false);
  });

  it('initWithKey validates key length', () => {
    expect(() => vault.initWithKey('short')).toThrow('32 bytes');
    expect(() => vault.initWithKey('a'.repeat(63))).toThrow('32 bytes');
  });
});
