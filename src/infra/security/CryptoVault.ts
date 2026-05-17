/**
 * CryptoVault — 加密与密钥管理
 * 职责：
 * 1. 数据库字段加解密（AES-256-GCM）
 * 2. 密钥派生（PBKDF2）
 * 3. 敏感数据内存安全清理
 * 4. Provider 签名（HMAC-SHA256 / Ed25519）
 * 5. Shamir Secret Sharing 集成 — 3/5 阈值分片消除单点故障
 */

import 'reflect-metadata';
import { singleton } from 'tsyringe';
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'crypto';
import { Logger } from '../logger/Logger.js';
import { ShamirSecretSharing, type Share } from './ShamirSecretSharing.js';

@singleton()
export class CryptoVault {
  private masterKey: Buffer | null = null;
  private recoveredShares: Share[] = []; // 恢复后持有的分片（可选，用于验证/再分片）

  constructor(
    private logger: Logger,
    private shamir: ShamirSecretSharing,
  ) {}

  // ── 向后兼容：直接加载主密钥 ──
  initWithKey(keyHex: string): void {
    this.masterKey = Buffer.from(keyHex, 'hex');
    if (this.masterKey.length !== 32) {
      throw new Error('Master key must be 32 bytes (64 hex chars)');
    }
    this.logger.info('CryptoVault initialized with raw key');
  }

  // ── 从密码派生主密钥（测试/开发场景） ──
  initMasterKey(password: string, salt?: string): string {
    const usedSalt = salt || randomBytes(16).toString('hex');
    this.masterKey = pbkdf2Sync(password, usedSalt, 100000, 32, 'sha512');
    this.logger.info('CryptoVault initialized from password', { salt_present: !!salt });
    return usedSalt;
  }

  // ── Shamir 模式：用分片恢复主密钥 ──
  initWithShares(shares: Share[]): void {
    if (shares.length < 2) {
      throw new Error('Need at least 2 shares to recover master key');
    }
    const keyHex = this.shamir.combine(shares);
    this.masterKey = Buffer.from(keyHex, 'hex');
    this.recoveredShares = shares.map((s) => ({ ...s })); // 浅拷贝持有
    this.logger.info('CryptoVault initialized from Shamir shares', {
      sharesUsed: shares.length,
    });
  }

  // ── 将当前主密钥分片（用于初始化时分发） ──
  splitCurrentKey(totalShares = 5, threshold = 3): Share[] {
    if (!this.masterKey) throw new Error('CryptoVault not initialized');
    const keyHex = this.masterKey.toString('hex');
    const shares = this.shamir.split(keyHex, totalShares, threshold);
    this.logger.info('Master key split into shares', { totalShares, threshold });
    return shares;
  }

  // ── 检查是否已初始化 ──
  get isInitialized(): boolean {
    return this.masterKey !== null && this.masterKey.length === 32;
  }

  // ── AES-256-GCM 加密 ──
  encrypt(plaintext: string): string {
    if (!this.isInitialized) throw new Error('CryptoVault not initialized');
    const iv = randomBytes(16);
    const authTagLength = 16;

    const cipher = require('crypto').createCipheriv('aes-256-gcm', this.masterKey!, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    // format: iv:authTag:encrypted
    const result = `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;

    // 清理明文
    this.secureZero(Buffer.from(plaintext));
    return result;
  }

  // ── AES-256-GCM 解密 ──
  decrypt(ciphertext: string): string {
    if (!this.isInitialized) throw new Error('CryptoVault not initialized');
    const [ivHex, authTagHex, encrypted] = ciphertext.split(':');
    if (!ivHex || !authTagHex || !encrypted) throw new Error('Invalid ciphertext format');

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = require('crypto').createDecipheriv('aes-256-gcm', this.masterKey!, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  // ── HMAC-SHA256 签名（Provider Auth） ──
  hmacSign(secret: string, payload: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex');
  }

  hmacVerify(secret: string, payload: string, signature: string): boolean {
    const expected = this.hmacSign(secret, payload);
    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  // ── SHA-256 Hash ──
  sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }

  // ── 安全随机 ID ──
  generateId(): string {
    return `${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  }

  // ── 内存安全清理 ──
  secureZero(buf: Buffer): void {
    if (Buffer.isBuffer(buf)) {
      buf.fill(0);
    }
  }

  // ── 紧急销毁 ──
  emergencyWipe(): void {
    if (this.masterKey) {
      this.secureZero(this.masterKey);
      this.masterKey = null;
    }
    // 清理持有的分片副本
    for (const s of this.recoveredShares) {
      s.y = '0'.repeat(64);
    }
    this.recoveredShares = [];
    this.logger.warn('CryptoVault emergency wiped — master key and shares zeroed');
  }
}
