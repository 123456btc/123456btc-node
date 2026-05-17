import { describe, it, expect } from 'vitest';
import { ShamirSecretSharing, split, combine } from '../../src/infra/security/ShamirSecretSharing.js';
import { randomBytes } from 'crypto';

const stubLogger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, child: () => stubLogger } as any;

function randomHex(len = 64): string {
  return randomBytes(len / 2).toString('hex');
}

describe('ShamirSecretSharing', () => {
  const sss = new ShamirSecretSharing(stubLogger);

  it('splits and combines with exact threshold', () => {
    const secret = randomHex(64);
    const shares = sss.split(secret, 5, 3);

    // 任意3份恢复
    const recovered = sss.combine([shares[0], shares[2], shares[4]]);
    expect(recovered).toBe(secret);

    const recovered2 = sss.combine([shares[1], shares[3], shares[0]]);
    expect(recovered2).toBe(secret);
  });

  it('fails with fewer than threshold shares', () => {
    const secret = randomHex(64);
    const shares = sss.split(secret, 5, 3);

    // 2份无法恢复（拉格朗日插值会产出错误值，但不会被检测，除非长度 < 2 抛错）
    // 实际上2份恢复出的值大概率 != secret，但我们不保证能检测到
    // 这里只验证 combine 不会因 2 份抛错（因为 threshold=3, 给了 2 份，插值会算出某个值）
    const fake = sss.combine([shares[0], shares[1]]);
    expect(fake).not.toBe(secret);
  });

  it('all 5 shares recover the secret', () => {
    const secret = randomHex(64);
    const shares = sss.split(secret, 5, 3);
    const recovered = sss.combine(shares);
    expect(recovered).toBe(secret);
  });

  it('convenience functions work', () => {
    const secret = randomHex(64);
    const shares = split(secret, 5, 3);
    const recovered = combine([shares[0], shares[2], shares[4]]);
    expect(recovered).toBe(secret);
  });

  it('handles edge case: threshold = total', () => {
    const secret = randomHex(64);
    const shares = sss.split(secret, 3, 3);
    const recovered = sss.combine(shares);
    expect(recovered).toBe(secret);
  });

  it('throws on invalid parameters', () => {
    expect(() => sss.split(randomHex(), 2, 1)).toThrow('Threshold must be >= 2');
    expect(() => sss.split(randomHex(), 2, 3)).toThrow('Total shares must be >= threshold');
    expect(() => sss.split(randomHex(), 256, 3)).toThrow('Total shares must be <= 255');
  });

  it('deterministic across same secret but different random poly', () => {
    // 两次分片同一 secret，shares 不同，但任意 threshold 份都能恢复
    const secret = randomHex(64);
    const shares1 = sss.split(secret, 5, 3);
    const shares2 = sss.split(secret, 5, 3);

    // shares 应该不同（随机多项式不同）
    expect(shares1[0].y).not.toBe(shares2[0].y);

    // 但都能恢复
    expect(sss.combine(shares1.slice(0, 3))).toBe(secret);
    expect(sss.combine(shares2.slice(0, 3))).toBe(secret);
  });
});
