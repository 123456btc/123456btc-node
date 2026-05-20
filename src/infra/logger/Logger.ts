/**
 * Logger — 结构化日志
 * 安全原则：
 * 1. 生产环境默认不记录 debug
 * 2. 敏感字段自动脱敏
 * 3. 支持日志文件自动销毁（按天轮转）
 */

import 'reflect-metadata';
import { singleton } from 'tsyringe';
import pino, { type Logger as PinoLogger } from 'pino';
import { AppConfig } from '../config/AppConfig.js';
import { SecureLogRotator } from '../security/SecureLogRotator.js';

@singleton()
export class Logger {
  private logger: PinoLogger;
  private config: AppConfig;
  private rotator?: SecureLogRotator;

  constructor(config?: AppConfig, rotator?: SecureLogRotator) {
    this.config = config ?? ({} as AppConfig);
    this.rotator = rotator;
    const level = config?.get('log_level') ?? 'info';
    const isProd = config?.isProduction() ?? false;

    this.logger = pino({
      level,
      base: {
        pid: process.pid,
        node: config?.get('provider_id')?.slice(0, 8) ?? 'unknown',
      },
      redact: {
        paths: ['provider_secret', 'admin_api_key', 'api_key', 'signature', 'seed'],
        censor: '***REDACTED***',
      },
      transport: isProd
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,node',
            },
          },
      // 生产环境输出 JSON，便于下游处理
      formatters: isProd
        ? {
            level: (label) => ({ level: label.toUpperCase() }),
          }
        : undefined,
    });
  }

  private sanitize(obj: Record<string, unknown>): Record<string, unknown> {
    const sensitiveKeys = /secret|key|password|seed|private|token|auth/i;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (sensitiveKeys.test(k) && typeof v === 'string') {
        result[k] = v.length > 8 ? `${v.slice(0, 4)}...${v.slice(-4)}` : '***';
      } else if (typeof v === 'object' && v !== null) {
        result[k] = this.sanitize(v as Record<string, unknown>);
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    if (meta) {
      this.logger.debug(this.sanitize(meta), msg);
    } else {
      this.logger.debug(msg);
    }
    this.rotator?.write('debug', msg, meta);
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    if (meta) {
      this.logger.info(this.sanitize(meta), msg);
    } else {
      this.logger.info(msg);
    }
    this.rotator?.write('info', msg, meta);
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    if (meta) {
      this.logger.warn(this.sanitize(meta), msg);
    } else {
      this.logger.warn(msg);
    }
    this.rotator?.write('warn', msg, meta);
  }

  error(msg: string, err?: Error, meta?: Record<string, unknown>): void {
    const payload: Record<string, unknown> = { ...meta };
    if (err) {
      payload.error = err.message;
      payload.stack = err.stack;
    }
    this.logger.error(this.sanitize(payload), msg);
    this.rotator?.write('error', msg, { ...meta, error: err?.message, stack: err?.stack });
  }
}
