/**
 * API Client — 封装后端 HTTP 接口
 */

const API_BASE = '';

async function get(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function post(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function del(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

const api = {
  // 策略
  getStrategies: () => get('/strategies'),
  getStrategy: (id) => get(`/strategies/${id}`),

  // 用户
  registerUser: (wallet) => post('/users/register', { wallet_address: wallet }),

  // 订阅
  getSubscriptions: (wallet) => get(`/subscriptions?wallet=${wallet}`),
  createSubscription: (wallet, strategyId, days) =>
    post('/subscriptions', { wallet_address: wallet, strategy_id: strategyId, duration_days: days }),

  // 信号
  getSignals: (wallet, limit = 20) => get(`/signals?wallet=${wallet}&limit=${limit}`),

  // 自动执行
  createExecutionWallet: (userId, strategyId, seed) =>
    post('/execution/wallets', { user_id: userId, strategy_id: strategyId, wallet_seed: seed }),
  deleteExecutionWallet: (userId, strategyId) =>
    del('/execution/wallets', { user_id: userId, strategy_id: strategyId }),
  getTrades: (userId) => get(`/execution/trades?user_id=${userId}`),

  // 余额
  getBalance: (wallet) => get(`/user/balance?wallet=${wallet}`),
};
