/**
 * MultisigService — 多签验证服务
 * 收集多个中继器签名，验证签名有效性
 * 用于跨链证明的多方确认
 */

import { createHash, createSign, createVerify, generateKeyPairSync } from 'crypto';
import { Logger } from '../../infra/logger/Logger.js';
import type { BridgeConfig, BridgeProof, RelayerSignature } from '../config.js';

// ── 签名结果 ──

export interface MultisigResult {
  event_id: string;
  collected: number;
  required: number;
  threshold_met: boolean;
  signatures: RelayerSignature[];
}

// ── MultisigService 类 ──

export class MultisigService {
  private config: BridgeConfig;
  private logger: Logger;
  private localKeypair: { publicKey: string; privateKey: string } | null = null;
  private knownRelayers = new Map<string, string>(); // relayer_id -> public_key (PEM)
  private pendingSigs = new Map<string, Map<string, RelayerSignature>>(); // event_id -> (relayer_id -> sig)

  constructor(config: BridgeConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  // ── 初始化：生成或加载本地密钥对 ──

  init(): void {
    // 生成本地 ECDSA P-256 密钥对（用于签名）
    const { publicKey, privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    this.localKeypair = { publicKey, privateKey };

    // 注册自己
    const relayerId = this.generateRelayerId(publicKey);
    this.knownRelayers.set(relayerId, publicKey);

    this.logger.info('MultisigService initialized', {
      relayer_id: relayerId,
      known_relayers: this.knownRelayers.size,
    });
  }

  // ── 注册已知中继器公钥 ──

  registerRelayer(relayerId: string, publicKeyPem: string): void {
    this.knownRelayers.set(relayerId, publicKeyPem);
    this.logger.debug('Relayer registered', { relayer_id: relayerId });
  }

  // ── 对事件数据签名 ──

  signEvent(eventId: string, leafHash: string): RelayerSignature | null {
    if (!this.localKeypair) {
      this.logger.error('Cannot sign: MultisigService not initialized');
      return null;
    }

    const message = `${eventId}:${leafHash}`;
    const signature = createSign('SHA256')
      .update(message)
      .sign(this.localKeypair.privateKey, 'hex');

    const relayerId = this.generateRelayerId(this.localKeypair.publicKey);

    const sig: RelayerSignature = {
      relayer_id: relayerId,
      relayer_address: this.localKeypair.publicKey.slice(0, 32),
      signature: '0x' + signature,
      timestamp: Date.now(),
    };

    // 存入待收集池
    if (!this.pendingSigs.has(eventId)) {
      this.pendingSigs.set(eventId, new Map());
    }
    this.pendingSigs.get(eventId)!.set(relayerId, sig);

    this.logger.debug('Event signed', { event_id: eventId, relayer_id: relayerId });

    return sig;
  }

  // ── 收集外部中继器签名 ──

  collectSignature(eventId: string, signature: RelayerSignature): MultisigResult {
    // 验证签名格式
    if (!this.isValidSignatureFormat(signature)) {
      this.logger.warn('Invalid signature format', { relayer_id: signature.relayer_id });
      return this.getResult(eventId);
    }

    // 验证签名者是否为已知中继器
    const publicKeyPem = this.knownRelayers.get(signature.relayer_id);
    if (!publicKeyPem) {
      this.logger.warn('Unknown relayer', { relayer_id: signature.relayer_id });
      return this.getResult(eventId);
    }

    // 存入池中
    if (!this.pendingSigs.has(eventId)) {
      this.pendingSigs.set(eventId, new Map());
    }
    this.pendingSigs.get(eventId)!.set(signature.relayer_id, signature);

    this.logger.info('Signature collected', {
      event_id: eventId,
      relayer_id: signature.relayer_id,
    });

    return this.getResult(eventId);
  }

  // ── 验证签名有效性 ──

  verifySignature(eventId: string, leafHash: string, signature: RelayerSignature): boolean {
    const publicKeyPem = this.knownRelayers.get(signature.relayer_id);
    if (!publicKeyPem) return false;

    const message = `${eventId}:${leafHash}`;

    try {
      const verifier = createVerify('SHA256');
      verifier.update(message);
      return verifier.verify(publicKeyPem, signature.signature.slice(2), 'hex');
    } catch (err) {
      this.logger.error('Signature verification failed', err as Error, {
        relayer_id: signature.relayer_id,
      });
      return false;
    }
  }

  // ── 验证证明中的所有签名 ──

  verifyAllSignatures(eventId: string, leafHash: string, signatures: RelayerSignature[]): {
    valid: boolean;
    valid_count: number;
    invalid_relayers: string[];
  } {
    const invalidRelayers: string[] = [];
    let validCount = 0;

    // 检查去重
    const seen = new Set<string>();

    for (const sig of signatures) {
      if (seen.has(sig.relayer_id)) {
        invalidRelayers.push(sig.relayer_id);
        continue;
      }
      seen.add(sig.relayer_id);

      if (this.verifySignature(eventId, leafHash, sig)) {
        validCount++;
      } else {
        invalidRelayers.push(sig.relayer_id);
      }
    }

    return {
      valid: validCount >= this.config.required_signatures,
      valid_count: validCount,
      invalid_relayers: invalidRelayers,
    };
  }

  // ── 检查是否达到签名阈值 ──

  isThresholdMet(eventId: string): boolean {
    const result = this.getResult(eventId);
    return result.threshold_met;
  }

  // ── 获取已收集签名的结果 ──

  getResult(eventId: string): MultisigResult {
    const sigMap = this.pendingSigs.get(eventId);
    const signatures = sigMap ? Array.from(sigMap.values()) : [];

    return {
      event_id: eventId,
      collected: signatures.length,
      required: this.config.required_signatures,
      threshold_met: signatures.length >= this.config.required_signatures,
      signatures,
    };
  }

  // ── 将已收集签名附加到证明 ──

  attachSignaturesToProof(proof: BridgeProof): BridgeProof {
    const result = this.getResult(proof.event_id);
    return {
      ...proof,
      signatures: result.signatures,
    };
  }

  // ── 清理已完成的事件签名池 ──

  clearEvent(eventId: string): void {
    this.pendingSigs.delete(eventId);
  }

  // ── 获取已知中继器列表 ──

  getKnownRelayers(): string[] {
    return Array.from(this.knownRelayers.keys());
  }

  // ── 获取本地公钥 (用于广播给其他中继器) ──

  getLocalPublicKey(): string | null {
    return this.localKeypair?.publicKey ?? null;
  }

  // ── 工具方法 ──

  private generateRelayerId(publicKeyPem: string): string {
    return createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16);
  }

  private isValidSignatureFormat(sig: RelayerSignature): boolean {
    return !!(
      sig.relayer_id &&
      sig.relayer_address &&
      sig.signature?.startsWith('0x') &&
      sig.signature.length > 10 &&
      sig.timestamp > 0
    );
  }
}
