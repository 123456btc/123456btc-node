/**
 * WorkerPool — Worker Threads 线程池
 * 隔离 CPU 密集型任务，避免阻塞主事件循环
 *
 * 适用场景：
 * 1. 信号批量验证（大量 ISES 校验）
 * 2. 加密/解密批量操作
 * 3. 数据压缩/解压（Arweave 备份前）
 * 4. 历史数据回溯计算
 */

import 'reflect-metadata';
import { singleton } from 'tsyringe';
import { Worker } from 'worker_threads';
import os from 'os';
import { Logger } from '../../infra/logger/Logger.js';

export type WorkerTask =
  | { type: 'validate_signals'; signals: unknown[] }
  | { type: 'encrypt_batch'; plaintexts: string[]; key: string }
  | { type: 'compress'; data: Buffer }
  | { type: 'hash_batch'; inputs: string[] };

export type WorkerResult =
  | { type: 'validate_signals'; results: { id: string; valid: boolean; error?: string }[] }
  | { type: 'encrypt_batch'; ciphertexts: string[] }
  | { type: 'compress'; compressed: Buffer }
  | { type: 'hash_batch'; hashes: string[] };

@singleton()
export class WorkerPool {
  private workers: Worker[] = [];
  private queue: { id: number; task: WorkerTask }[] = [];
  private busy = new Map<Worker, number>();
  private taskCounter = 0;
  private pendingTasks = new Map<number, { resolve: (result: WorkerResult) => void; reject: (err: Error) => void }>();
  private scriptPath: string;

  constructor(
    private logger: Logger,
    private poolSize = Math.max(2, os.cpus().length - 1),
  ) {
    // CJS-compatible: use __filename instead of import.meta.url
    this.scriptPath = __filename;
  }

  async init(): Promise<void> {
    for (let i = 0; i < this.poolSize; i++) {
      // Worker 脚本内联创建（避免额外文件）
      const worker = new Worker(`
        const { parentPort } = require('worker_threads');
        const crypto = require('crypto');
        const zlib = require('zlib');

        parentPort.on('message', async (task) => {
          try {
            let result;
            switch (task.type) {
              case 'validate_signals': {
                result = task.signals.map((sig, idx) => {
                  const valid = sig && typeof sig === 'object' && sig.signal_id && sig.strategy_id;
                  return { id: sig?.signal_id || String(idx), valid, error: valid ? undefined : 'Invalid signal structure' };
                });
                break;
              }
              case 'encrypt_batch': {
                result = task.plaintexts.map((pt) => {
                  const iv = crypto.randomBytes(16);
                  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(task.key, 'hex'), iv);
                  let enc = cipher.update(pt, 'utf8', 'hex');
                  enc += cipher.final('hex');
                  const authTag = cipher.getAuthTag();
                  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + enc;
                });
                break;
              }
              case 'compress': {
                result = zlib.gzipSync(Buffer.from(task.data));
                break;
              }
              case 'hash_batch': {
                result = task.inputs.map((input) => crypto.createHash('sha256').update(input).digest('hex'));
                break;
              }
              default:
                throw new Error('Unknown task type: ' + task.type);
            }
            parentPort.postMessage({ success: true, result: { type: task.type, [getResultKey(task.type)]: result }, _taskId: task._taskId });
          } catch (err) {
            parentPort.postMessage({ success: false, error: err.message, _taskId: task._taskId });
          }
        });

        function getResultKey(type) {
          const map = { validate_signals: 'results', encrypt_batch: 'ciphertexts', compress: 'compressed', hash_batch: 'hashes' };
          return map[type];
        }
      `, { eval: true });

      worker.on('message', (msg) => this.handleMessage(worker, msg));
      worker.on('error', (err) => this.logger.error('Worker error', err));
      worker.on('exit', (code) => {
        if (code !== 0) this.logger.error(`Worker stopped with exit code ${code}`);
      });
      this.workers.push(worker);
    }
    this.logger.info('WorkerPool initialized', { size: this.poolSize });
  }

  async execute(task: WorkerTask): Promise<WorkerResult> {
    return new Promise((resolve, reject) => {
      const id = ++this.taskCounter;
      this.pendingTasks.set(id, { resolve, reject });
      this.queue.push({ id, task });
      this.dispatch();
    });
  }

  private dispatch(): void {
    if (this.queue.length === 0) return;
    const available = this.workers.find((w) => !this.busy.has(w));
    if (!available) return;

    const job = this.queue.shift()!;
    this.busy.set(available, job.id);
    available.postMessage({ ...job.task, _taskId: job.id });
  }

  private handleMessage(worker: Worker, msg: { success: boolean; result?: WorkerResult; error?: string; _taskId?: number }): void {
    const taskId = this.busy.get(worker);
    this.busy.delete(worker);

    if (taskId !== undefined) {
      const pending = this.pendingTasks.get(taskId);
      if (pending) {
        this.pendingTasks.delete(taskId);
        if (msg.success && msg.result) {
          pending.resolve(msg.result);
        } else {
          pending.reject(new Error(msg.error || 'Worker task failed'));
        }
      }
    }

    this.dispatch();
  }

  terminate(): Promise<number[]> {
    return Promise.all(this.workers.map((w) => w.terminate()));
  }
}
