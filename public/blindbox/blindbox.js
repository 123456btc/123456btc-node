/**
 * BlindBox H5 — 盲盒交互逻辑
 */

let config = null;
let isOpening = false;

// 获取钱包地址（从主站 cookie/localStorage 或 URL 参数）
function getWallet() {
  return localStorage.getItem('blindbox_wallet') || '';
}

function setWallet(addr) {
  localStorage.setItem('blindbox_wallet', addr);
}

// 页面加载
document.addEventListener('DOMContentLoaded', async () => {
  // 尝试从 URL 获取钱包地址
  const params = new URLSearchParams(location.search);
  const walletFromUrl = params.get('wallet');
  if (walletFromUrl) setWallet(walletFromUrl);

  await loadConfig();
  renderProbabilities();
  await loadHistory();
  await loadMyPrizes();
  updateBalance();
});

// 加载配置
async function loadConfig() {
  try {
    const res = await fetch('/blindbox/config');
    config = await res.json();
    document.querySelector('.open-btn .btn-text').textContent = `${config.priceBbt} BBT 开一次`;
    updateDailyLimit(config.dailyLimit);
    document.getElementById('jackpot-pool').textContent = `${Math.floor(config.jackpotPoolBbt)} BBT`;
  } catch {
    // fallback
    config = { priceBbt: 10, tiers: [], dailyLimit: 50, jackpotPoolBbt: 0 };
  }
}

// 渲染概率
function renderProbabilities() {
  if (!config?.tiers) return;
  const container = document.getElementById('prob-list');
  let html = '';
  for (const tier of config.tiers) {
    const pct = (tier.probabilityBps / 100).toFixed(1);
    html += `
      <div class="prob-item">
        <div class="prob-icon">${tier.icon}</div>
        <div class="prob-info">
          <div class="prob-name" style="color:${tier.color}">${tier.name}</div>
          <div class="prob-bar-bg">
            <div class="prob-bar-fill" style="width:${pct}%;background:${tier.color}"></div>
          </div>
        </div>
        <div class="prob-value">${pct}%</div>
      </div>
    `;
  }
  container.innerHTML = html;
}

// 开盒
window.openBox = async function() {
  if (isOpening) return;
  const walletAddr = getWallet();
  if (!walletAddr) {
    alert('请先连接钱包');
    return;
  }

  // 要求用户提供链上支付交易的 signature
  const paymentTx = prompt(
    '开盒需要支付 10 BBT 到平台 treasury。\n' +
    '请先在钱包中转账 10 BBT，然后将交易签名（Transaction Signature）粘贴到这里：'
  );
  if (!paymentTx) {
    alert('未提供支付交易，开盒取消');
    return;
  }

  isOpening = true;
  const box = document.getElementById('mystery-box');
  const btn = document.getElementById('open-btn');
  btn.disabled = true;

  // 1. 摇晃动画
  box.classList.add('shaking');

  try {
    // 2. 调用后端（带上支付交易签名）
    const res = await fetch('/blindbox/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: walletAddr, payment_tx: paymentTx.trim() }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || '开盒失败');
    }

    const result = await res.json();

    // 3. 开盒动画
    setTimeout(() => {
      box.classList.remove('shaking');
      box.classList.add('opening');

      setTimeout(() => {
        showResult(result);
        box.classList.remove('opening');
        btn.disabled = false;
        isOpening = false;
        updateDailyLimit(result.dailyRemaining);
        loadHistory();
        loadMyPrizes();
        updateBalance();
      }, 800);
    }, 600);

  } catch (err) {
    box.classList.remove('shaking');
    btn.disabled = false;
    isOpening = false;
    alert(err.message);
  }
};

// 展示结果
function showResult(result) {
  const modal = document.getElementById('result-modal');
  const icon = document.getElementById('prize-icon');
  const name = document.getElementById('prize-name');
  const tag = document.getElementById('prize-tag');
  const reveal = document.getElementById('prize-reveal');

  icon.textContent = result.icon || '🎁';
  name.textContent = result.tierName || '神秘奖品';
  name.style.color = result.color || '#f59e0b';
  tag.textContent = result.tierId === 'empty' ? '再接再厉！' : `价值 ${result.value || ''} ${result.type === 'bbt_return' ? 'BBT' : ''}`;

  // 稀有奖品特效
  if (['rare_lifetime', 'jackpot', 'sub_30d'].includes(result.tierId)) {
    reveal.classList.add('rare-prize');
    createParticles(result.color || '#f59e0b');
  } else {
    reveal.classList.remove('rare-prize');
    createParticles(result.color || '#f59e0b', 8);
  }

  modal.classList.remove('hidden');
}

// 粒子特效
function createParticles(color, count = 20) {
  const container = document.getElementById('particles');
  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.background = color;
    p.style.left = '50%';
    p.style.top = '50%';
    const angle = (Math.PI * 2 * i) / count;
    const dist = 80 + Math.random() * 80;
    p.style.setProperty('--tx', `${Math.cos(angle) * dist}px`);
    p.style.setProperty('--ty', `${Math.sin(angle) * dist}px`);
    p.style.animationDelay = `${Math.random() * 0.2}s`;
    container.appendChild(p);
  }
}

// 关闭弹窗
window.closeModal = function() {
  document.getElementById('result-modal').classList.add('hidden');
  document.getElementById('particles').innerHTML = '';
};

// 加载最近开盒
async function loadHistory() {
  try {
    const res = await fetch('/blindbox/history');
    const data = await res.json();
    const container = document.getElementById('history-list');
    const records = data.records || [];

    if (records.length === 0) {
      container.innerHTML = '<div class="prize-empty">暂无记录</div>';
      return;
    }

    container.innerHTML = records.map((r) => `
      <div class="history-item">
        <span class="history-user">${r.userWallet.slice(0, 6)}...${r.userWallet.slice(-4)}</span>
        <span class="history-prize" style="color:${r.color || '#f3f4f6'}">${r.icon || '🎁'} ${r.tierName}</span>
      </div>
    `).join('');
  } catch {
    document.getElementById('history-list').innerHTML = '<div class="prize-empty">加载失败</div>';
  }
}

// 加载我的奖品
async function loadMyPrizes() {
  const walletAddr = getWallet();
  if (!walletAddr) {
    document.getElementById('prize-list').innerHTML = '<div class="prize-empty">连接钱包后查看奖品</div>';
    return;
  }

  try {
    const res = await fetch(`/blindbox/my?wallet=${walletAddr}`);
    const data = await res.json();
    const container = document.getElementById('prize-list');
    const records = data.records || [];

    if (records.length === 0) {
      container.innerHTML = '<div class="prize-empty">还没有奖品，快去开盒吧！</div>';
      return;
    }

    container.innerHTML = records.map((r) => `
      <div class="prize-item" style="border-left-color:${r.color || '#f59e0b'}">
        <div style="font-size:1.5rem">${r.icon || '🎁'}</div>
        <div style="flex:1">
          <div style="font-weight:600">${r.tierName}</div>
          <div style="font-size:0.75rem;color:var(--text-muted)">${new Date(r.createdAt).toLocaleString()}</div>
        </div>
        ${r.claimed ? '<span style="color:var(--success);font-size:0.75rem">✓ 已发放</span>' : '<span style="color:var(--warning);font-size:0.75rem">待发放</span>'}
      </div>
    `).join('');
  } catch {
    document.getElementById('prize-list').innerHTML = '<div class="prize-empty">加载失败</div>';
  }
}

// 更新余额显示
async function updateBalance() {
  const walletAddr = getWallet();
  if (!walletAddr) {
    document.getElementById('user-balance').textContent = '未连接';
    return;
  }
  try {
    const data = await api.getBalance(walletAddr);
    document.getElementById('user-balance').textContent = `${(data.balance || 0).toFixed(2)} BBT`;
  } catch {
    document.getElementById('user-balance').textContent = '-- BBT';
  }
}

function updateDailyLimit(remaining) {
  document.getElementById('daily-limit').textContent = `今日剩余 ${remaining} 次`;
}
