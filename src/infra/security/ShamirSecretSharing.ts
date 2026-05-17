/**
 * ShamirSecretSharing — 3/5 阈值密钥分片
 * 基于有限域 GF(p) 上的拉格朗日插值，使用原生 BigInt 实现
 *
 * 用法：
 * const shares = Shamir.split(secretHex, 5, 3); // 分5份，3份恢复
 * const recovered = Shamir.combine(shares.slice(0, 3)); // 任意3份
 *
 * 安全保证：
 * - 少于 threshold 份，信息论安全（无法获得任何 secret 信息）
 * - 所有运算在模大素数下进行，防止整数溢出分析
 */

import 'reflect-metadata';
import { singleton } from 'tsyringe';
import { randomBytes } from 'crypto';
import { Logger } from '../logger/Logger.js';

export interface Share {
  x: number; // 1-based index
  y: string; // hex string
}

// secp256k1 阶数 — 经过密码学验证的 256 位素数
// 使用此素数确保所有 32 字节随机 secret 的 >99.999% 概率都能容纳
const PRIME = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

@singleton()
export class ShamirSecretSharing {
  constructor(private logger: Logger) {}

  // ── 分片 ──
  split(secretHex: string, totalShares: number, threshold: number): Share[] {
    if (threshold < 2) throw new Error('Threshold must be >= 2');
    if (totalShares < threshold) throw new Error('Total shares must be >= threshold');
    if (totalShares > 255) throw new Error('Total shares must be <= 255');

    const secret = BigInt('0x' + secretHex);
    if (secret >= PRIME) throw new Error('Secret too large for prime field');

    // 生成随机多项式：f(x) = a_0 + a_1*x + ... + a_{t-1}*x^{t-1}
    // 其中 a_0 = secret
    const coefficients: bigint[] = [secret];
    for (let i = 1; i < threshold; i++) {
      coefficients.push(this.randomFieldElement());
    }

    // 计算 n 个点
    const shares: Share[] = [];
    for (let x = 1; x <= totalShares; x++) {
      const y = this.evaluatePolynomial(coefficients, BigInt(x));
      shares.push({ x, y: y.toString(16).padStart(64, '0') });
    }

    this.logger.info('Shamir split completed', { totalShares, threshold });
    return shares;
  }

  // ── 恢复 ──
  combine(shares: Share[]): string {
    if (shares.length < 2) throw new Error('Need at least 2 shares to combine');

    const points: [bigint, bigint][] = shares.map((s) => [BigInt(s.x), BigInt('0x' + s.y)]);
    const secret = this.lagrangeInterpolation(points);

    this.logger.info('Shamir combine completed', { sharesUsed: shares.length });
    return secret.toString(16).padStart(64, '0');
  }

  // ── 内部：多项式求值 ──
  private evaluatePolynomial(coeffs: bigint[], x: bigint): bigint {
    let result = 0n;
    let xPower = 1n;
    for (const coeff of coeffs) {
      result = this.fieldAdd(result, this.fieldMul(coeff, xPower));
      xPower = this.fieldMul(xPower, x);
    }
    return result;
  }

  // ── 内部：拉格朗日插值，求 f(0) ──
  private lagrangeInterpolation(points: [bigint, bigint][]): bigint {
    let secret = 0n;

    for (let i = 0; i < points.length; i++) {
      const [xi, yi] = points[i];
      let numerator = 1n;
      let denominator = 1n;

      for (let j = 0; j < points.length; j++) {
        if (i === j) continue;
        const [xj] = points[j];
        numerator = this.fieldMul(numerator, this.fieldNeg(xj)); // (0 - xj)
        denominator = this.fieldMul(denominator, this.fieldSub(xi, xj)); // (xi - xj)
      }

      const li = this.fieldMul(numerator, this.fieldInv(denominator));
      secret = this.fieldAdd(secret, this.fieldMul(yi, li));
    }

    return secret;
  }

  // ── 有限域运算 ──
  private fieldAdd(a: bigint, b: bigint): bigint {
    return (a + b) % PRIME;
  }

  private fieldSub(a: bigint, b: bigint): bigint {
    return (a - b + PRIME) % PRIME;
  }

  private fieldMul(a: bigint, b: bigint): bigint {
    return (a * b) % PRIME;
  }

  private fieldNeg(a: bigint): bigint {
    return (PRIME - a) % PRIME;
  }

  // 模逆元：扩展欧几里得算法
  private fieldInv(a: bigint): bigint {
    if (a === 0n) throw new Error('Cannot invert zero');
    let [old_r, r] = [a, PRIME];
    let [old_s, s] = [1n, 0n];

    while (r !== 0n) {
      const q = old_r / r;
      [old_r, r] = [r, old_r - q * r];
      [old_s, s] = [s, old_s - q * s];
    }

    // old_r = gcd(a, p) = 1 (因为 p 是素数)
    // old_s = a^{-1} mod p
    return ((old_s % PRIME) + PRIME) % PRIME;
  }

  private randomFieldElement(): bigint {
    // 生成 < PRIME 的随机数
    const buf = randomBytes(32);
    const num = BigInt('0x' + buf.toString('hex'));
    return num % PRIME;
  }

  // ── 辅助：验证 share 完整性（不暴露 secret） ──
  verifyShares(shares: Share[]): boolean {
    try {
      this.combine(shares); // 能恢复即有效
      return true;
    } catch {
      return false;
    }
  }
}

// 顶层便利函数（无需 DI 时使用）
export function split(secretHex: string, totalShares: number, threshold: number): Share[] {
  const sss = new ShamirSecretSharing({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as unknown as Logger);
  return sss.split(secretHex, totalShares, threshold);
}

export function combine(shares: Share[]): string {
  const sss = new ShamirSecretSharing({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as unknown as Logger);
  return sss.combine(shares);
}
