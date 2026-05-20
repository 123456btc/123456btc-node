/**
 * Bridge Module — 跨链桥中继器入口
 *
 * 架构:
 *   SolanaListener ─┐
 *                   ├→ RelayService (BullMQ) → ProofGenerator → Multisig → Submitter
 *   EvmListener ────┘
 *
 * 数据流:
 *   1. 监听器捕获链上事件 (lock_bbt / unlock_bbt)
 *   2. 事件验证后投入 BullMQ 队列
 *   3. 生成 Merkle 证明
 *   4. 收集中继器多签
 *   5. 提交证明到目标链
 *   6. 结果持久化到 PostgreSQL
 */

import { Logger } from '../infra/logger/Logger.js';
import { loadBridgeConfig, type BridgeConfig, type BridgeEvent, type BridgeProof } from './config.js';
import { SolanaListener } from './listeners/solana.js';
import { EvmListener } from './listeners/evm.js';
import { ProofGenerator } from './processors/proof.js';
import { TransactionSubmitter } from './processors/submitter.js';
import { RelayService } from './services/relay.js';
import { MultisigService } from './services/multisig.js';

// ── 导出所有组件 ──

export {
  // 配置
  loadBridgeConfig,
  type BridgeConfig,
  type BridgeEvent,
  type BridgeProof,
  type RelayerSignature,
  type BridgeJob,
} from './config.js';

// 监听器
export { SolanaListener } from './listeners/solana.js';
export { EvmListener } from './listeners/evm.js';

// 处理器
export { ProofGenerator } from './processors/proof.js';
export { TransactionSubmitter } from './processors/submitter.js';

// 服务
export { RelayService } from './services/relay.js';
export { MultisigService } from './services/multisig.js';

// ── 快捷启动函数 ──

export interface BridgeStartOptions {
  config?: BridgeConfig;
  logger?: Logger;
  /**
   * 启动模式:
   * - 'full': 完整中继器（监听 + 证明 + 多签 + 提交）
   * - 'listener': 仅监听器（事件推送到外部系统）
   * - 'submitter': 仅提交器（从队列消费已签名的证明）
   */
  mode?: 'full' | 'listener' | 'submitter';
}

/**
 * 启动桥接中继器
 *
 * @example
 * ```ts
 * import { startBridge } from './bridge/index.js';
 *
 * const relay = await startBridge();
 * // relay 正在运行...
 *
 * // 停止
 * await relay.stop();
 * ```
 */
export async function startBridge(options: BridgeStartOptions = {}): Promise<RelayService> {
  const config = options.config ?? loadBridgeConfig();
  const logger = options.logger ?? new Logger();

  logger.info('Initializing bridge relay service', {
    mode: options.mode ?? 'full',
    solana_program: config.solana_bridge_program,
    evm_contract: config.evm_bridge_contract,
  });

  const relay = new RelayService(config, logger);

  await relay.start();

  // 优雅退出
  const shutdown = async () => {
    logger.info('Shutting down bridge relay...');
    await relay.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  return relay;
}
