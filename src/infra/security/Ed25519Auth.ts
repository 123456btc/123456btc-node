/**
 * Ed25519Auth — 非对称签名认证模块
 * 升级自 HMAC-SHA256，提供更强的抗伪造能力
 *
 * 用途：
 * 1. Provider 推送信号时的身份认证
 * 2. Gossip 消息跨节点验证
 * 3. 未来扩展：用户钱包签名验证（替代 @solana/web3.js）
 */

import 'reflect-metadata';
import { singleton } from 'tsyringe';
import { createHash } from 'crypto';
import { Logger } from '../logger/Logger.js';

// 使用 tweetnacl 进行 Ed25519（纯 JS，无 native 依赖）
// 如果环境支持，可用 @noble/ed25519 替代
let nacl: typeof import('tweetnacl') | null = null;

try {
  nacl = require('tweetnacl');
} catch {
  // tweetnacl 未安装时，使用 crypto 的 ed25519（Node.js 15+）
}

@singleton()
export class Ed25519Auth {
  constructor(private logger: Logger) {
    if (!nacl && !require('crypto').createSign) {
      throw new Error('No Ed25519 implementation available. Install tweetnacl or use Node.js 15+');
    }
  }

  // ── 生成 Ed25519 密钥对 ──
  generateKeyPair(): { publicKey: string; secretKey: string } {
    if (nacl) {
      const pair = nacl.sign.keyPair();
      return {
        publicKey: Buffer.from(pair.publicKey).toString('base64'),
        secretKey: Buffer.from(pair.secretKey).toString('base64'),
      };
    }
    // Node.js native ed25519
    const { publicKey, privateKey } = require('crypto').generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { publicKey, secretKey: privateKey };
  }

  // ── 签名 ──
  sign(message: string | Buffer, secretKey: string): string {
    const msgBytes = typeof message === 'string' ? Buffer.from(message) : message;

    if (nacl) {
      const sk = Buffer.from(secretKey, 'base64');
      const sig = nacl.sign.detached(msgBytes, sk);
      return Buffer.from(sig).toString('base64');
    }

    // Node.js native
    const signer = require('crypto').createSign('sha512');
    signer.update(msgBytes);
    return signer.sign(secretKey, 'base64');
  }

  // ── 验签 ──
  verify(message: string | Buffer, signature: string, publicKey: string): boolean {
    const msgBytes = typeof message === 'string' ? Buffer.from(message) : message;

    if (nacl) {
      try {
        const pk = Buffer.from(publicKey, 'base64');
        const sig = Buffer.from(signature, 'base64');
        return nacl.sign.detached.verify(msgBytes, sig, pk);
      } catch {
        return false;
      }
    }

    // Node.js native
    try {
      const verifier = require('crypto').createVerify('sha512');
      verifier.update(msgBytes);
      return verifier.verify(publicKey, signature, 'base64');
    } catch {
      return false;
    }
  }

  // ── 从 Provider Secret 派生 Ed25519 密钥（兼容旧版 HMAC 用户） ──
  deriveFromSecret(providerSecret: string): { publicKey: string; secretKey: string } {
    const seed = createHash('sha256').update(`ed25519_seed:${providerSecret}`).digest();
    if (nacl) {
      const pair = nacl.sign.keyPair.fromSeed(seed);
      return {
        publicKey: Buffer.from(pair.publicKey).toString('base64'),
        secretKey: Buffer.from(pair.secretKey).toString('base64'),
      };
    }
    throw new Error('tweetnacl required for seed-based key derivation');
  }

  // ── 创建 Provider 认证 Payload ──
  createAuthPayload(providerId: string, timestamp: number): string {
    return `${providerId}:${timestamp}`;
  }

  // ── 完整 Provider 签名流程 ──
  signProviderPayload(providerId: string, timestamp: number, secretKey: string): { signature: string; payload: string } {
    const payload = this.createAuthPayload(providerId, timestamp);
    const signature = this.sign(payload, secretKey);
    return { signature, payload };
  }

  // ── 完整 Provider 验签流程 ──
  verifyProviderPayload(providerId: string, timestamp: number, signature: string, publicKey: string): boolean {
    // 防重放：timestamp 必须在 60 秒内
    if (Math.abs(Date.now() - timestamp) > 60_000) {
      return false;
    }
    const payload = this.createAuthPayload(providerId, timestamp);
    return this.verify(payload, signature, publicKey);
  }
}
