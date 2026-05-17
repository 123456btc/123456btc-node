/**
 * DI Container — 依赖注入容器注册
 * 使用 tsyringe 实现 IoC
 */

import 'reflect-metadata';
import { container } from 'tsyringe';
import { AppConfig } from '../infra/config/AppConfig.js';
import { Logger } from '../infra/logger/Logger.js';
import { CryptoVault } from '../infra/security/CryptoVault.js';
import { Metrics } from '../infra/metrics/Metrics.js';
import { MemoryStore } from '../infra/db/MemoryStore.js';
import { SQLiteStore } from '../infra/db/SQLiteStore.js';
import { SignalService } from '../core/service/SignalService.js';
import { Ed25519Auth } from '../infra/security/Ed25519Auth.js';
import { SecureLogRotator } from '../infra/security/SecureLogRotator.js';
import { GossipAdapter } from '../infra/network/GossipAdapter.js';
import { ArweaveBackup } from '../infra/chain/ArweaveBackup.js';
import { WorkerPool } from '../core/service/WorkerPool.js';
import { ShamirSecretSharing } from '../infra/security/ShamirSecretSharing.js';
import { SubscriptionEscrowClient } from '../infra/chain/SubscriptionEscrow.js';
import { JupiterClient } from '../infra/chain/JupiterClient.js';
import { AutoExecutionEngine } from '../core/AutoExecutionEngine.js';
import { BlindBoxEngine } from '../core/BlindBoxEngine.js';
import type { IUnitOfWork } from '../core/repository/interfaces.js';

export function registerDependencies(useSQLite = false): void {
  // 基础设施层（单例）
  container.register(AppConfig, { useClass: AppConfig });
  container.register(Logger, { useClass: Logger });
  container.register(CryptoVault, { useClass: CryptoVault });
  container.register(Metrics, { useClass: Metrics });
  container.register(Ed25519Auth, { useClass: Ed25519Auth });
  container.register(ShamirSecretSharing, { useClass: ShamirSecretSharing });
  container.register(SubscriptionEscrowClient, { useClass: SubscriptionEscrowClient });
  container.register(JupiterClient, { useClass: JupiterClient });
  container.register(AutoExecutionEngine, { useClass: AutoExecutionEngine });
  container.register(BlindBoxEngine, { useClass: BlindBoxEngine });

  // 存储层（可替换：MemoryStore for dev/test, SQLiteStore for prod）
  if (useSQLite) {
    container.register<IUnitOfWork>('IUnitOfWork', { useClass: SQLiteStore });
  } else {
    container.register<IUnitOfWork>('IUnitOfWork', { useClass: MemoryStore });
  }

  // 业务服务
  container.register(SignalService, { useClass: SignalService });
  container.register(SecureLogRotator, { useClass: SecureLogRotator });
  container.register(GossipAdapter, { useClass: GossipAdapter });
  container.register(ArweaveBackup, { useClass: ArweaveBackup });
  container.register(WorkerPool, { useClass: WorkerPool });
}

export { container };
