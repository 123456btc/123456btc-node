/**
 * Crypto Utils
 */

import { randomBytes } from 'crypto';

export function generateId(): string {
  return `${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

export function getCurrentTimestamp(): number {
  return Date.now();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
