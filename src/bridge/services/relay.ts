/**
 * RelayService — 桥接中继核心服务
 * 编排事件监听 → 证明生成 → 多签收集 → 交易提交的完整流水线
 */

import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { Logger } from '../../infra/logger/Logger.js';
import type { BridgeConfig, BridgeEvent, BridgeProof, BridgeJob } from '../config.js';
import { SolanaListener } from '../listeners/solana.js';
import { EvmListener } from '../listeners/evm.js';
import { ProofGenerator } from '../processors/proof.js';
import { TransactionSubmitter } from '../processors/submitter.js';
import { MultisigService } from './multisig.js';

// ── BullMQ 队列名称 ──

const QUEUE_NAMES = {
  BRIDGE_EVENTS: 'bridge:events',
  PROOF_GENERATION: 'bridge:proofs',
  TX_SUBMISSION: 'bridge:submissions',
} as const;

// ── RelayService 类 ──

export class RelayService {
  private config: BridgeConfig;
  private logger: Logger;

  // 组件
  private solanaListener: SolanaListener;
  private evmListener: EvmListener;
  private proofGenerator: ProofGenerator;
  private submitter: TransactionSubmitter;
  private multisig: MultisigService;

  // 队列
  private redis: Redis;
  private eventQueue: Queue;
  private proofQueue: Queue;
  private submissionQueue: Queue;
  private eventWorker: Worker | null = null;
  private proofWorker: Worker | null = null;
  private submissionWorker: Worker | null = null;

  // 数据库
  private pgPool: Pool;

  // 状态
  private running = false;
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: BridgeConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    // 初始化组件
    this.solanaListener = new SolanaListener(config, logger);
    this.evmListener = new EvmListener(config, logger);
    this.proofGenerator = new ProofGenerator(logger);
    this.submitter = new TransactionSubmitter(config, logger);
    this.multisig = new MultisigService(config, logger);

    // Redis
    this.redis = new Redis(config.redis_url, { maxRetriesPerRequest: null });

    // BullMQ 队列
    this.eventQueue = new Queue(QUEUE_NAMES.BRIDGE_EVENTS, { connection: this.redis });
    this.proofQueue = new Queue(QUEUE_NAMES.PROOF_GENERATION, { connection: this.redis });
    this.submissionQueue = new Queue(QUEUE_NAMES.TX_SUBMISSION, { connection: this.redis });

    // PostgreSQL
    this.pgPool = new Pool({ connectionString: config.pg_url });
  }

  // ═══════════════════════════════════════════════════════════
  // 生命周期
  // ═══════════════════════════════════════════════════════════

  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('RelayService already running');
      return;
    }

    this.running = true;
    this.logger.info('Starting RelayService...');

    // 1. 初始化数据库表
    await this.initDatabase();

    // 2. 初始化各组件
    await this.submitter.init();
    this.multisig.init();

    // 3. 注册事件监听回调
    this.solanaListener.onEvent((event) => this.onBridgeEvent(event));
    this.evmListener.onEvent((event) => this.onBridgeEvent(event));

    // 4. 启动队列 Worker
    this.startWorkers();

    // 5. 启动事件监听
    await this.solanaListener.start();
    await this.evmListener.start();

    // 6. 启动重试定时器
    this.retryTimer = setInterval(() => {
      void this.submitter.processRetryQueue();
    }, 30_000);

    this.logger.info('RelayService started successfully');
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;
    this.logger.info('Stopping RelayService...');

    // 停止监听器
    await this.solanaListener.stop();
    await this.evmListener.stop();

    // 停止 Worker
    await this.eventWorker?.close();
    await this.proofWorker?.close();
    await this.submissionWorker?.close();

    // 清理定时器
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }

    // 关闭队列
    await this.eventQueue.close();
    await this.proofQueue.close();
    await this.submissionQueue.close();

    // 关闭 Redis 和 PG
    await this.redis.quit();
    await this.pgPool.end();

    this.logger.info('RelayService stopped');
  }

  // ═══════════════════════════════════════════════════════════
  // 事件处理流水线
  // ═══════════════════════════════════════════════════════════

  /**
   * 桥接事件回调 — 验证后投入队列
   */
  private async onBridgeEvent(event: BridgeEvent): Promise<void> {
    // 验证事件有效性
    const validation = this.proofGenerator.validateEvent(event);
    if (!validation.valid) {
      this.logger.warn('Invalid bridge event rejected', {
        event_id: event.id,
        error: validation.error,
      });
      return;
    }

    // 持久化到数据库
    await this.saveEvent(event);

    // 投入事件队列
    await this.eventQueue.add('process-event', event, {
      jobId: event.id, // 去重
      attempts: this.config.max_retries,
      backoff: { type: 'exponential', delay: this.config.retry_delay_ms },
    });

    this.logger.info('Bridge event queued', {
      event_id: event.id,
      source: event.source_chain,
      target: event.target_chain,
    });
  }

  /**
   * 启动 BullMQ Worker
   */
  private startWorkers(): void {
    // Worker 1: 处理桥接事件 → 生成证明
    this.eventWorker = new Worker(
      QUEUE_NAMES.BRIDGE_EVENTS,
      async (job: Job) => {
        const event = job.data as BridgeEvent;
        await this.processEvent(event);
      },
      { connection: this.redis, concurrency: 5 },
    );

    this.eventWorker.on('failed', (job, err) => {
      this.logger.error('Event processing failed', err, { job_id: job?.id });
    });

    // Worker 2: 证明生成 → 等待多签
    this.proofWorker = new Worker(
      QUEUE_NAMES.PROOF_GENERATION,
      async (job: Job) => {
        const { event, proof } = job.data as { event: BridgeEvent; proof: BridgeProof };
        await this.processProof(event, proof);
      },
      { connection: this.redis, concurrency: 3 },
    );

    this.proofWorker.on('failed', (job, err) => {
      this.logger.error('Proof processing failed', err, { job_id: job?.id });
    });

    // Worker 3: 提交交易
    this.submissionWorker = new Worker(
      QUEUE_NAMES.TX_SUBMISSION,
      async (job: Job) => {
        const { event, proof } = job.data as { event: BridgeEvent; proof: BridgeProof };
        await this.processSubmission(event, proof);
      },
      { connection: this.redis, concurrency: 2 },
    );

    this.submissionWorker.on('failed', (job, err) => {
      this.logger.error('Submission failed', err, { job_id: job?.id });
    });

    this.logger.info('BullMQ workers started');
  }

  // ── 处理单个桥接事件 ──

  private async processEvent(event: BridgeEvent): Promise<void> {
    // 添加到 Merkle 池
    this.proofGenerator.addEvent(event);

    // 本地签名
    const leafHash = this.proofGenerator.getRoot();
    if (leafHash) {
      this.multisig.signEvent(event.id, leafHash);
    }

    // 生成本地证明
    const result = this.multisig.getResult(event.id);
    const proof = this.proofGenerator.generateProof(event.id, result.signatures);

    if (!proof) {
      this.logger.error('Failed to generate proof', undefined, { event_id: event.id });
      return;
    }

    // 更新事件状态
    event.status = 'proved';
    await this.updateEventStatus(event.id, 'proved');

    // 投入证明队列
    await this.proofQueue.add('verify-proof', { event, proof }, {
      jobId: `proof:${event.id}`,
    });
  }

  // ── 处理证明：多签收集 → 阈值检查 → 提交 ──

  private async processProof(event: BridgeEvent, proof: BridgeProof): Promise<void> {
    const result = this.multisig.getResult(event.id);

    if (!result.threshold_met) {
      // 签名不够，等待更多签名（实际可通过 P2P 网络收集）
      this.logger.info('Waiting for more signatures', {
        event_id: event.id,
        collected: result.collected,
        required: result.required,
      });

      // 重新入队，延迟执行
      await this.proofQueue.add(
        'retry-proof',
        { event, proof },
        { delay: this.config.retry_delay_ms },
      );
      return;
    }

    // 签名够了，附加签名到证明
    const finalProof = this.multisig.attachSignaturesToProof(proof);

    // 验证所有签名
    const verification = this.multisig.verifyAllSignatures(
      event.id,
      finalProof.leaf_hash,
      finalProof.signatures,
    );

    if (!verification.valid) {
      this.logger.warn('Signature verification failed', {
        event_id: event.id,
        valid_count: verification.valid_count,
        invalid_relayers: verification.invalid_relayers,
      });
      return;
    }

    // 保存证明
    await this.saveProof(finalProof);

    // 投入提交队列
    await this.submissionQueue.add('submit-tx', { event, proof: finalProof }, {
      jobId: `submit:${event.id}`,
    });

    event.status = 'submitted';
    await this.updateEventStatus(event.id, 'submitted');
  }

  // ── 处理交易提交 ──

  private async processSubmission(event: BridgeEvent, proof: BridgeProof): Promise<void> {
    const result = await this.submitter.submitWithRetry(event, proof);

    if (result.success) {
      event.status = 'confirmed';
      await this.updateEventStatus(event.id, 'confirmed');
      await this.updateProofTxHash(event.id, result.tx_hash!);

      this.logger.info('Bridge transfer confirmed', {
        event_id: event.id,
        tx_hash: result.tx_hash,
        chain: result.chain,
      });
    } else {
      event.status = 'failed';
      await this.updateEventStatus(event.id, 'failed');

      this.logger.error('Bridge transfer failed', undefined, {
        event_id: event.id,
        error: result.error,
        attempts: result.attempts,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 数据库操作
  // ═══════════════════════════════════════════════════════════

  private async initDatabase(): Promise<void> {
    const client = await this.pgPool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS bridge_events (
          id              TEXT PRIMARY KEY,
          source_chain    TEXT NOT NULL,
          target_chain    TEXT NOT NULL,
          event_name      TEXT NOT NULL,
          sender          TEXT NOT NULL,
          recipient       TEXT NOT NULL,
          amount          TEXT NOT NULL,
          amount_human    TEXT NOT NULL,
          token           TEXT NOT NULL,
          tx_hash         TEXT NOT NULL,
          block_number    BIGINT NOT NULL,
          timestamp       BIGINT NOT NULL,
          nonce           TEXT NOT NULL,
          raw_data        TEXT,
          status          TEXT NOT NULL DEFAULT 'pending',
          created_at      BIGINT NOT NULL,
          updated_at      BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bridge_proofs (
          event_id        TEXT PRIMARY KEY REFERENCES bridge_events(id),
          merkle_root     TEXT NOT NULL,
          merkle_proof    TEXT[] NOT NULL,
          leaf_hash       TEXT NOT NULL,
          signatures      JSONB NOT NULL DEFAULT '[]',
          tx_hash         TEXT,
          created_at      BIGINT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_bridge_events_status ON bridge_events(status);
        CREATE INDEX IF NOT EXISTS idx_bridge_events_created ON bridge_events(created_at);
      `);

      this.logger.info('Bridge database tables initialized');
    } finally {
      client.release();
    }
  }

  private async saveEvent(event: BridgeEvent): Promise<void> {
    await this.pgPool.query(
      `INSERT INTO bridge_events (id, source_chain, target_chain, event_name, sender, recipient, amount, amount_human, token, tx_hash, block_number, timestamp, nonce, raw_data, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (id) DO NOTHING`,
      [
        event.id, event.source_chain, event.target_chain, event.event_name,
        event.sender, event.recipient, event.amount, event.amount_human,
        event.token, event.tx_hash, event.block_number, event.timestamp,
        event.nonce, event.raw_data, event.status, event.created_at, event.updated_at,
      ],
    );
  }

  private async saveProof(proof: BridgeProof): Promise<void> {
    await this.pgPool.query(
      `INSERT INTO bridge_proofs (event_id, merkle_root, merkle_proof, leaf_hash, signatures, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (event_id) DO UPDATE SET
         merkle_root = $2, merkle_proof = $3, leaf_hash = $4, signatures = $5`,
      [
        proof.event_id,
        proof.merkle_root,
        proof.merkle_proof,
        proof.leaf_hash,
        JSON.stringify(proof.signatures),
        proof.created_at,
      ],
    );
  }

  private async updateEventStatus(eventId: string, status: BridgeEvent['status']): Promise<void> {
    await this.pgPool.query(
      'UPDATE bridge_events SET status = $1, updated_at = $2 WHERE id = $3',
      [status, Date.now(), eventId],
    );
  }

  private async updateProofTxHash(eventId: string, txHash: string): Promise<void> {
    await this.pgPool.query(
      'UPDATE bridge_proofs SET tx_hash = $1 WHERE event_id = $2',
      [txHash, eventId],
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 查询接口
  // ═══════════════════════════════════════════════════════════

  async getEvent(eventId: string): Promise<BridgeEvent | null> {
    const result = await this.pgPool.query(
      'SELECT * FROM bridge_events WHERE id = $1',
      [eventId],
    );
    return result.rows[0] ?? null;
  }

  async getEventsByStatus(status: BridgeEvent['status'], limit = 50): Promise<BridgeEvent[]> {
    const result = await this.pgPool.query(
      'SELECT * FROM bridge_events WHERE status = $1 ORDER BY created_at DESC LIMIT $2',
      [status, limit],
    );
    return result.rows;
  }

  async getProof(eventId: string): Promise<BridgeProof | null> {
    const result = await this.pgPool.query(
      'SELECT * FROM bridge_proofs WHERE event_id = $1',
      [eventId],
    );
    return result.rows[0] ?? null;
  }

  getStats(): {
    merkle_pool_size: number;
    retry_queue_size: number;
    solana_running: boolean;
    evm_running: boolean;
  } {
    return {
      merkle_pool_size: this.proofGenerator.getPoolSize(),
      retry_queue_size: this.submitter.getRetryQueueSize(),
      solana_running: this.solanaListener.isRunning(),
      evm_running: this.evmListener.isRunning(),
    };
  }

  // ── 访问子组件 ──

  getSolanaListener(): SolanaListener { return this.solanaListener; }
  getEvmListener(): EvmListener { return this.evmListener; }
  getProofGenerator(): ProofGenerator { return this.proofGenerator; }
  getSubmitter(): TransactionSubmitter { return this.submitter; }
  getMultisig(): MultisigService { return this.multisig; }
}
