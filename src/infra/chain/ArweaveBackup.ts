/**
 * ArweaveBackup — 信号历史永久备份
 * 钱庄场景：即使节点被查封，历史信号记录永久存于 Arweave，不可篡改
 *
 * 备份策略：
 * 1. 每日打包前一天的所有信号（JSON → gzip → Arweave TX）
 * 2. 只备份 signals 表，不备份 users/subscriptions（隐私）
 * 3. 备份数据公开可查，但信号内容本身不包含用户身份
 * 4. 本地保留索引（date → Arweave TX ID），便于恢复
 */

import 'reflect-metadata';
import { singleton } from 'tsyringe';
import { Logger } from '../logger/Logger.js';
import type { IUnitOfWork } from '../../core/repository/interfaces.js';

export interface BackupManifest {
  date: string; // YYYY-MM-DD
  arweaveTxId: string;
  signalCount: number;
  merkleRoot: string;
  uploadedAt: number;
}

@singleton()
export class ArweaveBackup {
  private manifest: BackupManifest[] = [];
  private intervalId?: ReturnType<typeof setInterval>;

  constructor(
    private logger: Logger,
    private store: IUnitOfWork,
  ) {}

  start(intervalHours = 24): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.backup(), intervalHours * 60 * 60 * 1000);
    this.logger.info('ArweaveBackup started', { intervalHours });
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  async backup(): Promise<BackupManifest | null> {
    try {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const dateStr = yesterday.toISOString().split('T')[0];
      const startMs = new Date(dateStr).getTime();
      const endMs = startMs + 24 * 60 * 60 * 1000;

      // 获取昨日信号
      const signals = this.store.signals.findByStrategyIds(['*'], 10000); // 简化：实际应按时间过滤
      const daySignals = signals.filter((s) => s.created_at >= startMs && s.created_at < endMs);

      if (daySignals.length === 0) {
        this.logger.info('ArweaveBackup: no signals to backup', { date: dateStr });
        return null;
      }

      // 打包数据
      const payload = {
        protocol: 'bbt-signal-archive-v1',
        date: dateStr,
        node: 'anonymous',
        signals: daySignals,
      };
      const json = JSON.stringify(payload);
      const gzip = require('zlib').gzipSync(json);

      // TODO: 上传到 Arweave
      // const Arweave = require('arweave');
      // const arweave = Arweave.init({ host: 'arweave.net', port: 443, protocol: 'https' });
      // const tx = await arweave.createTransaction({ data: gzip }, wallet);
      // tx.addTag('App-Name', '123456btc-node');
      // tx.addTag('Content-Type', 'application/gzip');
      // tx.addTag('Date', dateStr);
      // await arweave.transactions.sign(tx, wallet);
      // await arweave.transactions.post(tx);

      const mockTxId = `mock_tx_${Date.now()}`; // 占位

      // 计算 merkle root（简化：sha256 of gzip）
      const { createHash } = require('crypto');
      const merkleRoot = createHash('sha256').update(gzip).digest('hex');

      const manifest: BackupManifest = {
        date: dateStr,
        arweaveTxId: mockTxId,
        signalCount: daySignals.length,
        merkleRoot,
        uploadedAt: Date.now(),
      };

      this.manifest.push(manifest);
      this.logger.info('ArweaveBackup completed', manifest);
      return manifest;
    } catch (e) {
      this.logger.error('ArweaveBackup failed', e as Error);
      return null;
    }
  }

  getManifests(): BackupManifest[] {
    return [...this.manifest];
  }

  // TODO: 从 Arweave 恢复
  async restore(date: string): Promise<Signal[] | null> {
    this.logger.info('ArweaveBackup restore requested', { date });
    return null;
  }
}
