/**
 * Wallet — Solana 钱包连接（Phantom / Solflare / Backpack）
 */

class WalletManager {
  constructor() {
    this.address = null;
    this.provider = null;
    this.listeners = [];
  }

  async connect() {
    // 检测钱包
    const provider = this.detectProvider();
    if (!provider) {
      throw new Error('未检测到 Solana 钱包，请安装 Phantom 或 Solflare');
    }

    try {
      const resp = await provider.connect();
      this.provider = provider;
      this.address = resp.publicKey.toString();
      this.notify('connect', this.address);

      // 监听断开
      provider.on('disconnect', () => {
        this.address = null;
        this.provider = null;
        this.notify('disconnect');
      });

      return this.address;
    } catch (err) {
      throw new Error('钱包连接被拒绝');
    }
  }

  disconnect() {
    if (this.provider) {
      this.provider.disconnect();
    }
    this.address = null;
    this.provider = null;
    this.notify('disconnect');
  }

  detectProvider() {
    if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
    if (window.solflare?.isSolflare) return window.solflare;
    if (window.solana?.isPhantom) return window.solana;
    if (window.backpack?.isBackpack) return window.backpack;
    return null;
  }

  isConnected() {
    return !!this.address;
  }

  getAddress() {
    return this.address;
  }

  on(event, cb) {
    this.listeners.push({ event, cb });
  }

  notify(event, data) {
    this.listeners.filter((l) => l.event === event).forEach((l) => l.cb(data));
  }
}

const wallet = new WalletManager();

// 全局绑定
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('connect-wallet');
  const addr = document.getElementById('wallet-address');

  if (!btn) return;

  btn.addEventListener('click', async () => {
    if (wallet.isConnected()) {
      wallet.disconnect();
      return;
    }
    try {
      await wallet.connect();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  wallet.on('connect', (address) => {
    btn.textContent = '断开';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-outline');
    addr.textContent = `${address.slice(0, 6)}...${address.slice(-4)}`;
    addr.classList.remove('hidden');
  });

  wallet.on('disconnect', () => {
    btn.textContent = '连接钱包';
    btn.classList.add('btn-primary');
    btn.classList.remove('btn-outline');
    addr.classList.add('hidden');
    addr.textContent = '';
  });
});
