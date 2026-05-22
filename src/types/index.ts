/**
 * 123456btc-node Core Types
 * 兼容 ISES v1 和 BBT Signal Protocol v1
 */

// ───────────────────────────────────────────────
// 1. 策略 (Strategy)
// ───────────────────────────────────────────────

export interface Strategy {
  id: string;
  provider_id: string;        // 兼容旧字段，新逻辑用 creator_wallet
  creator_wallet: string;     // 策略创建者钱包地址，BBT 收款目标
  name: string;
  description?: string;
  symbol: string;
  market_type: string;
  pricing_model: 'daily_bbt' | 'per_signal_bbt' | 'free';
  price_per_day?: number;
  price_per_signal?: number;
  min_bbt_tier: number;
  status: 'live' | 'paused' | 'archived';
  created_at: number;
  updated_at: number;
}

// ───────────────────────────────────────────────
// 2. 用户/订阅者 (User)
// ───────────────────────────────────────────────

export interface User {
  id: string;
  wallet_address: string;
  display_name?: string;
  chain_bbt_balance: number;
  status: 'active' | 'suspended';
  created_at: number;
}

// ───────────────────────────────────────────────
// 3. 订阅 (Subscription)
// ───────────────────────────────────────────────

export interface Subscription {
  id: string;
  user_id: string;
  strategy_id: string;
  status: 'pending' | 'active' | 'expired' | 'cancelled';
  billing_model: 'daily_bbt' | 'per_signal_bbt' | 'free';
  next_bill_at: number | null;
  expires_at?: number;
  created_at: number;
}

// ───────────────────────────────────────────────
// 4. 信号 (Signal) — 兼容 ISES v1 简化版
// ───────────────────────────────────────────────

export interface Signal {
  id: string;
  strategy_id: string;
  provider_id: string;
  symbol: string;
  decision: string;
  confidence?: number;
  price?: number;
  stop_loss?: number;
  take_profit?: number;
  reasoning?: string;
  raw_payload: string; // 完整 JSON
  created_at: number;
}

// ───────────────────────────────────────────────
// 5. 账单 (BillingRecord)
// ───────────────────────────────────────────────

export interface BillingRecord {
  id: string;
  subscription_id: string;
  user_id: string;
  strategy_id: string;
  type: 'subscription' | 'signal' | 'renewal';
  amount_bbt: number;
  tx_signature?: string;
  status: 'pending' | 'confirmed' | 'failed';
  created_at: number;
}

// ───────────────────────────────────────────────
// 6. Provider 配置
// ───────────────────────────────────────────────

export interface ProviderConfig {
  provider_id: string;
  provider_secret: string;
  name: string;
  wallet_address: string;
  treasury_wallet: string; // 平台 treasury，盲盒收入等进入此地址
  solana_rpc: string;
  bbt_mint: string;
  burn_rate: number;
  node_port: number;
  p2p_port?: number;
  admin_api_key: string;
  settlement_mode?: 'memo' | 'escrow';
  escrow_program_id?: string;
  provider_keypair_path?: string;
  platform_wallet?: string;
}

// ───────────────────────────────────────────────
// 7. WebSocket 消息类型
// ───────────────────────────────────────────────

export type WsMessage =
  | { type: 'signal'; payload: Signal }
  | { type: 'auth'; wallet: string; signature: string; timestamp: number }
  | { type: 'subscribe'; strategy_id: string }
  | { type: 'unsubscribe'; strategy_id: string }
  | { type: 'pong' }
  | { type: 'error'; message: string };

// ───────────────────────────────────────────────
// 8. ISES v1 兼容类型 (精简)
// ───────────────────────────────────────────────

export interface IsesStrategySignalLite {
  schema: 'ises.strategy_signal.v1';
  signal_id: string;
  created_at_ms: number;
  source: {
    system: string;
    strategy_id: string;
    strategy_name: string;
  };
  scope: {
    symbol: string;
    market_type: string;
  };
  decision: {
    action: string;
    side: string;
    confidence: number;
  };
  market_context: {
    price: string;
    data_quality: string;
  };
  levels?: {
    stop_loss?: string;
    take_profit?: string;
  };
  rationale?: {
    summary: string;
  };
}
