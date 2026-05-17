/**
 * App — Web Dashboard 主应用
 * 路由：#strategies | #subscriptions | #execution | #chart/:id
 */

const app = document.getElementById('app');
let currentRoute = '';

// Toast
function showToast(message, type = 'success') {
  const container = document.querySelector('.toast-container') || (() => {
    const el = document.createElement('div');
    el.className = 'toast-container';
    document.body.appendChild(el);
    return el;
  })();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// 路由
function route() {
  const hash = location.hash.slice(1) || 'strategies';
  const [page, ...params] = hash.split('/');
  currentRoute = page;

  // 更新 nav active
  document.querySelectorAll('.nav-link').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('href') === `#${page}`);
  });

  app.innerHTML = '<div class="loading"><div class="spinner"></div>加载中...</div>';

  switch (page) {
    case 'strategies': renderStrategies(); break;
    case 'subscriptions': renderSubscriptions(); break;
    case 'execution': renderExecution(); break;
    case 'chart': renderChart(params[0]); break;
    default: renderStrategies();
  }
}

window.addEventListener('hashchange', route);
document.addEventListener('DOMContentLoaded', route);

// ═══════════════════════════════════════════
// 策略市场
// ═══════════════════════════════════════════

async function renderStrategies() {
  try {
    const data = await api.getStrategies();
    const strategies = data.strategies || [];

    let html = `
      <div class="container">
        <h1 class="page-title">📊 策略市场</h1>
        <div class="card-grid">
    `;

    for (const s of strategies) {
      const priceDisplay = s.pricing_model === 'free'
        ? '<span style="color:var(--success)">免费</span>'
        : `<span class="price-tag">${s.price_per_day || s.price_per_signal || 0}</span> <span class="price-unit">BBT/${s.pricing_model === 'daily_bbt' ? '天' : '信号'}</span>`;

      html += `
        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">${escapeHtml(s.name)}</div>
              <div class="card-subtitle">${escapeHtml(s.symbol)} · ${s.market_type || 'crypto'}</div>
            </div>
            <span class="card-badge badge-live">LIVE</span>
          </div>
          <div class="card-body">${escapeHtml(s.description || '暂无描述')}</div>
          <div class="card-footer">
            <div>${priceDisplay}</div>
            <div>
              <a href="#chart/${s.id}" class="btn btn-outline btn-sm">📈 图表</a>
              <button class="btn btn-primary btn-sm" onclick="openSubscribeModal('${s.id}', '${escapeHtml(s.name)}', ${s.price_per_day || 0}, '${s.pricing_model}')">订阅</button>
            </div>
          </div>
        </div>
      `;
    }

    html += '</div></div>';
    app.innerHTML = html;
  } catch (err) {
    app.innerHTML = `<div class="container"><p style="color:var(--danger)">加载失败: ${err.message}</p></div>`;
  }
}

// 订阅弹窗
window.openSubscribeModal = function(strategyId, name, price, pricingModel) {
  const walletAddr = wallet.getAddress();
  if (!walletAddr) {
    showToast('请先连接钱包', 'error');
    return;
  }

  const days = pricingModel === 'daily_bbt' ? 7 : 1;
  const amount = pricingModel === 'free' ? 0 : (price * days).toFixed(2);

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-title">订阅 ${escapeHtml(name)}</div>
      <div class="modal-body">
        <p>钱包: <code>${walletAddr.slice(0, 10)}...${walletAddr.slice(-6)}</code></p>
        <p>时长: <strong>${pricingModel === 'daily_bbt' ? days + ' 天' : '按信号计费'}</strong></p>
        <p>金额: <strong style="color:var(--primary)">${amount} BBT</strong></p>
        <p style="font-size:0.75rem;color:var(--text-muted);margin-top:12px;">
          资金由链上合约托管，按时间释放。可随时取消退款。
        </p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="this.closest('.modal-overlay').remove()">取消</button>
        <button class="btn btn-primary" id="confirm-sub">确认订阅</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('#confirm-sub').addEventListener('click', async () => {
    try {
      await api.registerUser(walletAddr);
      const result = await api.createSubscription(walletAddr, strategyId, days);
      showToast(`订阅成功! ${result.subscription_id || ''}`);
      modal.remove();
      location.hash = 'subscriptions';
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

// ═══════════════════════════════════════════
// 我的订阅
// ═══════════════════════════════════════════

async function renderSubscriptions() {
  const walletAddr = wallet.getAddress();
  if (!walletAddr) {
    app.innerHTML = `
      <div class="container">
        <h1 class="page-title">📋 我的订阅</h1>
        <p style="color:var(--text-muted)">请先连接钱包查看订阅</p>
      </div>`;
    return;
  }

  try {
    const data = await api.getSubscriptions(walletAddr);
    const subs = data.subscriptions || [];

    let html = `
      <div class="container">
        <h1 class="page-title">📋 我的订阅</h1>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>策略</th>
                <th>计费模式</th>
                <th>状态</th>
                <th>到期时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
    `;

    for (const sub of subs) {
      const statusClass = sub.status === 'active' ? 'signal-enter' : 'signal-exit';
      const expires = sub.expires_at ? new Date(sub.expires_at).toLocaleDateString() : 'N/A';
      html += `
        <tr>
          <td><strong>${escapeHtml(sub.strategy_name || sub.strategy_id)}</strong></td>
          <td>${sub.billing_model}</td>
          <td class="${statusClass}">${sub.status.toUpperCase()}</td>
          <td>${expires}</td>
          <td>
            <a href="#chart/${sub.strategy_id}" class="btn btn-outline btn-sm">图表</a>
          </td>
        </tr>
      `;
    }

    if (subs.length === 0) {
      html += '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">暂无订阅</td></tr>';
    }

    html += '</tbody></table></div></div>';
    app.innerHTML = html;
  } catch (err) {
    app.innerHTML = `<div class="container"><p style="color:var(--danger)">加载失败: ${err.message}</p></div>`;
  }
}

// ═══════════════════════════════════════════
// 自动执行
// ═══════════════════════════════════════════

async function renderExecution() {
  const walletAddr = wallet.getAddress();
  if (!walletAddr) {
    app.innerHTML = `
      <div class="container">
        <h1 class="page-title">⚡ 自动执行</h1>
        <p style="color:var(--text-muted)">请先连接钱包管理自动交易</p>
      </div>`;
    return;
  }

  let html = `
    <div class="container">
      <h1 class="page-title">⚡ 自动执行</h1>
      <div class="card" style="max-width:600px;margin-bottom:24px;">
        <div class="card-title">什么是自动执行？</div>
        <div class="card-body">
          绑定执行钱包后，策略信号到达时将自动通过 Jupiter 完成交易。<br>
          建议只存入小额资金（如 50-100 USDC）。<br>
          平台持有执行钱包私钥，可随时删除钱包撤回资金。
        </div>
      </div>
      <h2 style="font-size:1rem;margin-bottom:12px;">创建执行钱包</h2>
      <div class="card" style="max-width:600px;">
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;">
          <div style="flex:1;min-width:200px;">
            <label style="display:block;font-size:0.75rem;color:var(--text-muted);margin-bottom:6px;">策略ID</label>
            <input type="text" id="exec-strategy-id" placeholder="输入策略ID" style="width:100%;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);">
          </div>
          <div style="flex:1;min-width:200px;">
            <label style="display:block;font-size:0.75rem;color:var(--text-muted);margin-bottom:6px;">日限额 (USDC)</label>
            <input type="number" id="exec-daily-limit" value="100" style="width:100%;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);">
          </div>
          <button class="btn btn-primary" onclick="createExecWallet()">创建钱包</button>
        </div>
      </div>
      <div id="exec-result" style="margin-top:16px;"></div>
    </div>
  `;
  app.innerHTML = html;
}

window.createExecWallet = async function() {
  const strategyId = document.getElementById('exec-strategy-id').value;
  const limit = parseInt(document.getElementById('exec-daily-limit').value, 10);
  const walletAddr = wallet.getAddress();

  if (!strategyId) { showToast('请输入策略ID', 'error'); return; }

  try {
    const user = await api.registerUser(walletAddr);
    const result = await api.createExecutionWallet(user.user_id || walletAddr, strategyId);
    document.getElementById('exec-result').innerHTML = `
      <div class="card" style="border-left:4px solid var(--success);max-width:600px;">
        <div class="card-title">✅ 执行钱包已创建</div>
        <div class="card-body">
          <p>地址: <code>${result.public_key}</code></p>
          <p style="color:var(--warning);margin-top:8px;">⚠️ ${result.warning}</p>
        </div>
      </div>
    `;
    showToast('执行钱包创建成功');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ═══════════════════════════════════════════
// 图表（K线 + 信号）
// ═══════════════════════════════════════════

async function renderChart(strategyId) {
  if (!strategyId) { location.hash = 'strategies'; return; }

  app.innerHTML = `
    <div class="container">
      <h1 class="page-title">📈 策略图表</h1>
      <div class="chart-container" id="chart"></div>
      <h2 style="font-size:1rem;margin:24px 0 12px;">最近信号</h2>
      <div id="signal-list"></div>
    </div>
  `;

  // 延迟初始化图表，等 DOM 渲染
  setTimeout(() => initChart(strategyId), 100);
}

// ═══════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
