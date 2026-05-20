import { describe, it, expect } from 'vitest';
import { ShamirSecretSharing, split, combine } from '../../src/infra/security/ShamirSecretSharing.js';
import { randomBytes } from 'crypto';

const mockLogger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as any;

function randomHex(len = 64): string {
  return randomBytes(len / 2).toString('hex');
}

describe('ShamirSecretSharing', () => {
  const sss = new ShamirSecretSharing(mockLogger);

  // ── split + combine：3/5 阈值，任意 3 份可恢复 ──
  it('3/5 threshold: any 3 shares can recover the secret', () => {
    const secret = randomHex(64);
    const shares = sss.split(secret, 5, 3);

    expect(shares.length).toBe(5);

    // 多种 3 份组合都能恢复
    const combos = [
      [0, 1, 2],
      [0, 2, 4],
      [1, 3, 4],
      [0, 1, 4],
      [2, 3, 4],
    ];

    for (const combo of combos) {
      const recovered = sss.combine(combo.map((i) => shares[i]));
      expect(recovered).toBe(secret);
    }
  });

  // ── split + combine：2 份不足以恢复 ──
  it('2 shares are insufficient to recover the secret (produces wrong value)', () => {
    const secret = randomHex(64);
    const shares = sss.split(secret, 5, 3);

    // 2 份恢复出的值大概率 != secret
    const fake = sss.combine([shares[0], shares[1]]);
    expect(fake).not.toBe(secret);
  });

  // ── split：threshold < 2 抛异常 ──
  it('throws when threshold < 2', () => {
    expect(() => sss.split(randomHex(), 5, 1)).toThrow('Threshold must be >= 2');
    expect(() => sss.split(randomHex(), 5, 0)).toThrow('Threshold must be >= 2');
  });

  // ── split：totalShares < threshold 抛异常 ──
  it('throws when totalShares < threshold', () => {
    expect(() => sss.split(randomHex(), 2, 3)).toThrow('Total shares must be >= threshold');
    expect(() => sss.split(randomHex(), 4, 5)).toThrow('Total shares must be >= threshold');
  });

  // ── combine：少于 2 份抛异常 ──
  it('throws when combining fewer than 2 shares', () => {
    const secret = randomHex(64);
    const shares = sss.split(secret, 5, 3);

    expect(() => sss.combine([])).toThrow('Need at least 2 shares to combine');
    expect(() => sss.combine([shares[0]])).toThrow('Need at least 2 shares to combine');
  });

  // ── 不同分片组合都能恢复同一 secret ──
  it('different share combinations all recover the same secret', () => {
    const secret = randomHex(64);
    const shares = sss.split(secret, 7, 4);

    // 生成多组不同的 4 份组合
    const combos = [
      [0, 1, 2, 3],
      [0, 1, 2, 6],
      [1, 3, 5, 6],
      [0, 2, 4, 6],
      [3, 4, 5, 6],
    ];

    const results = new Set<string>();
    for (const combo of combos) {
      const recovered = sss.combine(combo.map((i) => shares[i]));
      results.add(recovered);
    }

    // 所有组合恢复出同一 secret
    expect(results.size).toBe(1);
    expect(results.has(secret)).toBe(true);
  });

  // ── split 产生的分片 x 值唯一 ──
  it('split produces shares with unique x values', () => {
    const secret = randomHex(64);
    const shares = sss.split(secret, 5, 3);

    const xValues = shares.map((s) => s.x);
    const uniqueX = new Set(xValues);

    expect(uniqueX.size).toBe(shares.length);
    // x 从 1 开始
    expect(xValues).toEqual([1, 2, 3, 4, 5]);
  });

  // ── convenience functions work ──
  it('top-level convenience split/combine functions work', () => {
    const secret = randomHex(64);
    const shares = split(secret, 5, 3);
    const recovered = combine([shares[0], shares[2], shares[4]]);
    expect(recovered).toBe(secret);
  });

  // ── all shares recover the secret ──
  it('using all shares also recovers the secret', () => {
    const secret = randomHex(64);
    const shares = sss.split(secret, 5, 3);
    const recovered = sss.combine(shares);
    expect(recovered).toBe(secret);
  });

  // ── totalShares > 255 抛异常 ──
  it('throws when totalShares > 255', () => {
    expect(() => sss.split(randomHex(), 256, 3)).toThrow('Total shares must be <= 255');
  });

  // ── verifyShares helper ──
  it('verifyShares returns true for valid shares', () => {
    const secret = randomHex(64);
    const shares = sss.split(secret, 5, 3);
    expect(sss.verifyShares([shares[0], shares[1], shares[2]])).toBe(true);
  });
});
