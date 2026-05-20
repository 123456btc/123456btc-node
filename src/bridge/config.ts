/**
 * Bridge Config — 跨链桥中继器配置
 * 所有敏感字段通过环境变量注入
 */

// ── 配置 Schema ──

export interface BridgeConfig {
  // Solana
  solana_rpc: string;
  solana_bridge_program: string;
  solana_relayer_keypair_path: string;

  // EVM
  evm_rpc: string;
  evm_bridge_contract: string;
  evm_relayer_private_key: string;
  evm_chain_id: number;

  // Redis (BullMQ)
  redis_url: string;

  // PostgreSQL
  pg_url: string;

  // 多签
  required_signatures: number;
  relayer_peer_ids: string[];

  // 重试
  max_retries: number;
  retry_delay_ms: number;

  // 日志
  log_level: 'debug' | 'info' | 'warn' | 'error';
}

// ── 默认值 ──

const DEFAULTS: Partial<BridgeConfig> = {
  solana_rpc: 'https://api.mainnet-beta.solana.com',
  evm_rpc: 'https://eth-mainnet.g.alchemy.com/v2/demo',
  evm_chain_id: 1,
  redis_url: 'redis://localhost:6379',
  pg_url: 'postgresql://localhost:5432/bridge_relay',
  required_signatures: 3,
  relayer_peer_ids: [],
  max_retries: 3,
  retry_delay_ms: 5000,
  log_level: 'info',
};

// ── 从环境变量加载配置 ──

export function loadBridgeConfig(): BridgeConfig {
  const cfg: BridgeConfig = {
    // Solana
    solana_rpc: process.env.BRIDGE_SOLANA_RPC || DEFAULTS.solana_rpc!,
    solana_bridge_program: process.env.BRIDGE_SOLANA_PROGRAM || '',
    solana_relayer_keypair_path: process.env.BRIDGE_SOLANA_KEYPAIR || '',

    // EVM
    evm_rpc: process.env.BRIDGE_EVM_RPC || DEFAULTS.evm_rpc!,
    evm_bridge_contract: process.env.BRIDGE_EVM_CONTRACT || '',
    evm_relayer_private_key: process.env.BRIDGE_EVM_PRIVATE_KEY || '',
    evm_chain_id: parseInt(process.env.BRIDGE_EVM_CHAIN_ID || '1', 10),

    // Redis
    redis_url: process.env.BRIDGE_REDIS_URL || DEFAULTS.redis_url!,

    // PostgreSQL
    pg_url: process.env.BRIDGE_PG_URL || DEFAULTS.pg_url!,

    // 多签
    required_signatures: parseInt(process.env.BRIDGE_REQUIRED_SIGS || '3', 10),
    relayer_peer_ids: process.env.BRIDGE_RELAYER_PEERS?.split(',').filter(Boolean) || [],

    // 重试
    max_retries: parseInt(process.env.BRIDGE_MAX_RETRIES || '3', 10),
    retry_delay_ms: parseInt(process.env.BRIDGE_RETRY_DELAY || '5000', 10),

    // 日志
    log_level: (process.env.BRIDGE_LOG_LEVEL as BridgeConfig['log_level']) || DEFAULTS.log_level!,
  };

  validateBridgeConfig(cfg);
  return cfg;
}

// ── 校验必填字段 ──

function validateBridgeConfig(cfg: BridgeConfig): void {
  const required: (keyof BridgeConfig)[] = [
    'solana_bridge_program',
    'evm_bridge_contract',
    'evm_relayer_private_key',
  ];

  for (const key of required) {
    if (!cfg[key]) {
      throw new Error(`Missing required bridge config: ${key} (set env BRIDGE_*)`);
    }
  }
}

// ── 事件类型定义 ──

export interface BridgeEvent {
  id: string;                   // 唯一标识: {chain}:{txHash}:{logIndex}
  source_chain: 'solana' | 'evm';
  target_chain: 'solana' | 'evm';
  event_name: string;           // lock_bbt | unlock_bbt | BBTLocked | BBTUnlocked | BBTMinted | BBTBurned
  sender: string;               // 发送方地址
  recipient: string;            // 接收方地址
  amount: string;               // 原始金额 (lamports / wei 字符串)
  amount_human: string;         // 人类可读金额
  token: string;                // 代币地址
  tx_hash: string;              // 源链交易哈希
  block_number: number;         // 区块高度
  timestamp: number;            // 时间戳
  nonce: string;                // 桥接 nonce，防止重放
  raw_data: string;             // 原始事件数据
  status: 'pending' | 'proved' | 'submitted' | 'confirmed' | 'failed';
  created_at: number;
  updated_at: number;
}

export interface BridgeProof {
  event_id: string;
  merkle_root: string;
  merkle_proof: string[];
  leaf_hash: string;
  signatures: RelayerSignature[];
  created_at: number;
}

export interface RelayerSignature {
  relayer_id: string;
  relayer_address: string;
  signature: string;
  timestamp: number;
}

export interface BridgeJob {
  id: string;
  event: BridgeEvent;
  proof?: BridgeProof;
  attempts: number;
  max_attempts: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;
  created_at: number;
  updated_at: number;
}
