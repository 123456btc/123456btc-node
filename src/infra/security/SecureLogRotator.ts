/**
 * SecureLogRotator — 安全日志轮转与自毁
 * 钱庄红线：日志不能成为呈堂证供
 *
 * 功能：
 * 1. 按天切割日志文件
 * 2. 超过保留天数的日志自动物理删除（不是 soft delete）
 * 3. 删除前覆写文件（防止数据恢复）
 * 4. 支持紧急一键清理所有日志
 */

import 'reflect-metadata';
import { singleton } from 'tsyringe';
import fs from 'fs';
import path from 'path';
import { Logger } from '../logger/Logger.js';
import { AppConfig } from '../config/AppConfig.js';

@singleton()
export class SecureLogRotator {
  private logDir: string;
  private persistDays: number;
  private intervalId?: ReturnType<typeof setInterval>;

  constructor(
    private config: AppConfig,
    private logger: Logger,
  ) {
    this.logDir = path.join(config.get('data_dir'), 'logs');
    this.persistDays = config.get('log_persist_days');
    fs.mkdirSync(this.logDir, { recursive: true });
    this.start();
  }

  start(): void {
    if (this.intervalId) return;
    // 每小时检查一次
    this.intervalId = setInterval(() => this.rotate(), 60 * 60 * 1000);
    this.logger.info('SecureLogRotator started', { persistDays: this.persistDays, logDir: this.logDir });
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  rotate(): void {
    try {
      const files = fs.readdirSync(this.logDir);
      const cutoff = Date.now() - this.persistDays * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (!file.endsWith('.log')) continue;
        const filePath = path.join(this.logDir, file);
        const stat = fs.statSync(filePath);

        if (stat.mtimeMs < cutoff) {
          this.secureDelete(filePath);
        }
      }
    } catch (e) {
      this.logger.error('Log rotation failed', e as Error);
    }
  }

  // ── 安全删除：覆写后删除 ──
  private secureDelete(filePath: string): void {
    try {
      const size = fs.statSync(filePath).size;
      // 覆写 3 次：随机数据 → 0x00 → 随机数据
      const passes = [cryptoRandomBytes, zeroBytes, cryptoRandomBytes];
      for (const pass of passes) {
        const fd = fs.openSync(filePath, 'w');
        const chunk = pass(Math.min(size, 64 * 1024)); // 64KB chunks
        let written = 0;
        while (written < size) {
          const toWrite = Math.min(chunk.length, size - written);
          fs.writeSync(fd, chunk, 0, toWrite, written);
          written += toWrite;
        }
        fs.fsyncSync(fd);
        fs.closeSync(fd);
      }
      fs.unlinkSync(filePath);
      this.logger.info('Log file securely deleted', { file: path.basename(filePath) });
    } catch (e) {
      this.logger.error('Secure delete failed', e as Error, { filePath });
    }
  }

  // ── 紧急清理所有日志 ──
  emergencyPurge(): void {
    this.logger.warn('EMERGENCY LOG PURGE initiated');
    try {
      const files = fs.readdirSync(this.logDir);
      for (const file of files) {
        if (file.endsWith('.log')) {
          this.secureDelete(path.join(this.logDir, file));
        }
      }
    } catch (e) {
      this.logger.error('Emergency purge failed', e as Error);
    }
  }

  getLogDir(): string {
    return this.logDir;
  }

  // ── 写入日志条目（供 Logger 集成调用） ──
  write(level: string, msg: string, meta?: Record<string, unknown>): void {
    try {
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
      const logFile = path.join(this.logDir, `${dateStr}.log`);
      const timeStr = now.toISOString();
      const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
      const line = `[${timeStr}] [${level.toUpperCase()}] ${msg}${metaStr}\n`;
      fs.appendFileSync(logFile, line, 'utf-8');
    } catch {
      // 写日志失败不能影响主流程
    }
  }
}

function cryptoRandomBytes(size: number): Buffer {
  return require('crypto').randomBytes(size);
}

function zeroBytes(size: number): Buffer {
  return Buffer.alloc(size, 0);
}
