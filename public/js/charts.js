/**
 * Charts — Lightweight Charts 封装
 * K线 + 信号标记叠加
 */

let chartInstance = null;
let candleSeries = null;
let markerSeries = null;

// 生成 mock K线数据（实际项目应调用 Binance/OKX API）
function generateMockCandles(count = 200) {
  const data = [];
  let price = 45000 + Math.random() * 5000;
  let time = new Date().getTime() / 1000 - count * 3600;

  for (let i = 0; i < count; i++) {
    const volatility = price * 0.008;
    const open = price;
    const high = open + Math.random() * volatility;
    const low = open - Math.random() * volatility;
    const close = low + Math.random() * (high - low);
    const volume = Math.random() * 100 + 10;

    data.push({
      time: Math.floor(time),
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume: +volume.toFixed(2),
    });

    price = close;
    time += 3600; // 1 hour candles
  }
  return data;
}

// 生成 mock 信号标记
function generateMockSignals(count = 30) {
  const decisions = ['enter', 'exit', 'reduce', 'hold'];
  const signals = [];
  let time = new Date().getTime() / 1000 - count * 3600 * 4;

  for (let i = 0; i < count; i++) {
    const decision = decisions[Math.floor(Math.random() * 3)]; // skip hold mostly
    const confidence = 0.6 + Math.random() * 0.35;

    signals.push({
      time: Math.floor(time),
      decision,
      confidence: +confidence.toFixed(2),
      price: 45000 + Math.random() * 8000,
    });

    time += 3600 * 4 + Math.random() * 3600 * 8; // 4-12h intervals
  }
  return signals;
}

function decisionColor(decision) {
  switch (decision) {
    case 'enter': return '#10b981';
    case 'exit': return '#ef4444';
    case 'reduce': return '#f59e0b';
    case 'hold': return '#3b82f6';
    default: return '#9ca3af';
  }
}

function decisionShape(decision) {
  switch (decision) {
    case 'enter': return 'arrowUp';
    case 'exit': return 'arrowDown';
    case 'reduce': return 'circle';
    default: return 'square';
  }
}

function decisionText(decision) {
  const map = { enter: '买入', exit: '卖出', reduce: '减仓', hold: '持有' };
  return map[decision] || decision;
}

async function initChart(strategyId) {
  const container = document.getElementById('chart');
  if (!container) return;

  // 清理旧图表
  if (chartInstance) {
    chartInstance.remove();
    chartInstance = null;
  }

  // 创建图表
  chartInstance = LightweightCharts.createChart(container, {
    layout: {
      background: { color: '#111827' },
      textColor: '#9ca3af',
    },
    grid: {
      vertLines: { color: '#1f2937' },
      horzLines: { color: '#1f2937' },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
    },
    rightPriceScale: {
      borderColor: '#374151',
    },
    timeScale: {
      borderColor: '#374151',
      timeVisible: true,
    },
    autoSize: true,
  });

  // K线系列
  candleSeries = chartInstance.addCandlestickSeries({
    upColor: '#10b981',
    downColor: '#ef4444',
    borderUpColor: '#10b981',
    borderDownColor: '#ef4444',
    wickUpColor: '#10b981',
    wickDownColor: '#ef4444',
  });

  // 加载 K线数据
  const candles = generateMockCandles(200);
  candleSeries.setData(candles);

  // 加载信号
  let signals = [];
  try {
    // 尝试从 API 获取真实信号
    const walletAddr = wallet.getAddress() || 'mock';
    const res = await api.getSignals(walletAddr, 50);
    signals = (res.signals || []).map((s) => ({
      time: Math.floor(s.created_at_ms / 1000),
      decision: s.decision,
      confidence: s.confidence || 0.8,
      price: s.price || candles[candles.length - 1]?.close || 50000,
    }));
  } catch {
    // fallback to mock
    signals = generateMockSignals(20);
  }

  // 叠加信号标记
  const markers = signals.map((s) => ({
    time: s.time,
    position: s.decision === 'enter' ? 'belowBar' : s.decision === 'exit' ? 'aboveBar' : 'inBar',
    color: decisionColor(s.decision),
    shape: decisionShape(s.decision),
    text: `${decisionText(s.decision)} ${Math.round(s.confidence * 100)}%`,
    size: s.confidence > 0.8 ? 2 : 1,
  }));

  candleSeries.setMarkers(markers);

  // 信号列表
  const listContainer = document.getElementById('signal-list');
  if (listContainer) {
    let html = '<div class="table-container"><table><thead><tr><th>时间</th><th>决策</th><th>置信度</th><th>价格</th></tr></thead><tbody>';
    for (const s of signals.slice(-10).reverse()) {
      const colorClass = `signal-${s.decision}`;
      html += `<tr>
        <td>${new Date(s.time * 1000).toLocaleString()}</td>
        <td class="${colorClass}">${decisionText(s.decision)}</td>
        <td>${Math.round(s.confidence * 100)}%</td>
        <td>$${s.price.toFixed(2)}</td>
      </tr>`;
    }
    html += '</tbody></table></div>';
    listContainer.innerHTML = html;
  }

  chartInstance.timeScale().fitContent();
}

// 响应式
window.addEventListener('resize', () => {
  if (chartInstance) chartInstance.applyOptions({ autoSize: true });
});
