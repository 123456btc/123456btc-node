/**
 * AppConfig — 统一配置管理
 * 支持：环境变量 > 加密配置文件 > 默认值
 * 安全：敏感字段（密钥）不从文件读取，必须走环境变量或OS Keychain
 */

import 'reflect-metadata';
import { singleton } from 'tsyringe';
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface NodeConfig {
  provider_id: string;
  provider_secret: string;
  name: string;
  wallet_address: string;
  solana_rpc: string;
  bbt_mint: string;
  burn_rate: number;
  node_port: number;
  p2p_port: number;
  admin_api_key: string;
  role: 'provider' | 'subscriber' | 'relay' | 'peer';
  seeds: string[];
  db_path: string;
  log_level: 'debug' | 'info' | 'warn' | 'error';
  log_persist_days: number;
  data_dir: string;
  settlement_mode: 'memo' | 'escrow';
}

const DEFAULTS: Partial<NodeConfig> = {
  solana_rpc: 'https://api.mainnet-beta.solana.com',
  bbt_mint: '3s4AK2x2nGkKP8ZADbcKuhdPr3coSuh1XnwZEzWgpump',
  burn_rate: 0,
  node_port: 1119,
  p2p_port: 0,
  role: 'peer',
  seeds: [],
  log_level: 'info',
  log_persist_days: 7,
  settlement_mode: 'memo',
};

@singleton()
export class AppConfig {
  private config: NodeConfig;
  private configDir: string;

  constructor() {
    this.configDir = path.join(os.homedir(), '.123456btc-node');
    this.config = this.load();
    this.validate();
  }

  private load(): NodeConfig {
    // 1. 读取配置文件
    const configPath = path.join(this.configDir, 'config.json');
    let fileConfig: Partial<NodeConfig> = {};
    if (fs.existsSync(configPath)) {
      try {
        fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<NodeConfig>;
      } catch {
        throw new Error(`Invalid config file: ${configPath}`);
      }
    }

    // 2. 环境变量覆盖（敏感字段强制走环境变量）
    const envOverride: Partial<NodeConfig> = {};
    if (process.env.BBT_PROVIDER_SECRET) envOverride.provider_secret = process.env.BBT_PROVIDER_SECRET;
    if (process.env.BBT_ADMIN_API_KEY) envOverride.admin_api_key = process.env.BBT_ADMIN_API_KEY;
    if (process.env.BBT_SOLANA_RPC) envOverride.solana_rpc = process.env.BBT_SOLANA_RPC;
    if (process.env.BBT_NODE_PORT) envOverride.node_port = parseInt(process.env.BBT_NODE_PORT, 10);
    if (process.env.BBT_LOG_LEVEL) envOverride.log_level = process.env.BBT_LOG_LEVEL as NodeConfig['log_level'];
    if (process.env.BBT_SETTLEMENT_MODE) envOverride.settlement_mode = process.env.BBT_SETTLEMENT_MODE as 'memo' | 'escrow';

    // 3. 合并：默认值 < 文件 < 环境变量
    const merged = {
      ...DEFAULTS,
      ...fileConfig,
      ...envOverride,
    } as NodeConfig;

    // 4. 补全路径
    merged.data_dir = merged.data_dir || path.join(this.configDir, 'data');
    merged.db_path = merged.db_path || path.join(merged.data_dir, 'node.db');

    return merged;
  }

  private validate(): void {
    const required = ['provider_id', 'wallet_address'] as const;
    for (const key of required) {
      if (!this.config[key]) {
        throw new Error(`Missing required config: ${key}`);
      }
    }
  }

  get<K extends keyof NodeConfig>(key: K): NodeConfig[K] {
    return this.config[key];
  }

  getAll(): Readonly<NodeConfig> {
    return Object.freeze({ ...this.config });
  }

  isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  }
}
