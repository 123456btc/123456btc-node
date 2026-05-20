# 123456btc-node

> **[English](README.md)** | [中文](README_zh.md) | [فارسی](README_fa.md) | [မြန်မာ](README_my.md) | [العربية](README_ar.md) | [Français](README_fr.md)

> **شبکه توزیع استراتژی غیرمتمرکز**
>
> نود خود را اجرا کنید. قیمت خود را تعیین کنید. دایره خود را بسازید.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![Solana](https://img.shields.io/badge/Solana-Devnet%20%7C%20Mainnet-9945FF.svg)](https://solana.com)

---

## این پروژه چیست؟

یک شبکه P2P کاملاً غیرمتمرکز برای توزیع سیگنال‌های معاملاتی. نود خود را مستقر کنید، استراتژی‌ها را منتشر کنید و اشتراک‌های توکن BBT را دریافت کنید — بدون سرور مرکزی، بدون کارمزد پلتفرم.

** نحوه کار:**

1. شما یک **نود Provider** مستقر می‌کنید
2. استراتژی‌ها ایجاد کرده و قیمت‌ها را با BBT تعیین می‌کنید
3. کاربران نود شما را در جوامع خصوصی کشف می‌کنند
4. کاربران با ارسال BBT به کیف پول شما اشتراک می‌گیرند
5. سیستم شما سیگنال‌ها را ارسال می‌کند، آن‌ها به صورت بلادرنگ دریافت می‌کنند
6. شما BBT خود را بر اساس نیازهای خود مدیریت می‌کنید

**سه لایه محصول:**

- **جعبه‌های کور** — ارزش‌های ثابت (1 / 10 / 100 / 1K / 10K USDT)، باز کنید تا NFT اشتراک استراتژی دریافت کنید
- **اشتراک‌های استراتژی** — روزانه، به ازای هر سیگنال، یا رایگان
- **شبکه نود** — نود خود را اجرا کنید، قیمت‌گذاری خود را تنظیم کنید

---

## معماری شبکه

```
                         ┌─────────────────┐
                         │   Seed Node     │
                         └────────┬────────┘
                                  │
                   ┌──────────────┼──────────────┐
                   │              │              │
          ┌────────▼─────┐ ┌──────▼──────┐ ┌────▼─────────┐
          │   Provider   │ │    Relay    │ │  Subscriber  │
          └───────┬──────┘ └──────┬──────┘ └───────┬──────┘
                  │   Gossip Protocol (libp2p)      │
                  │               │                 │
          ┌───────▼──────┐ ┌──────▼──────┐ ┌───────▼──────┐
          │  Subscriber  │ │  Subscriber │ │ Telegram Bot │
          └──────────────┘ └─────────────┘ └──────────────┘
```

### نقش‌های نود

| نقش | وظیفه شما | چه کسی اجرا می‌کند |
|-----|----------|-------------------|
| **Provider** | ایجاد استراتژی، انتشار سیگنال، جمع‌آوری BBT | تیم‌های کوانت |
| **Subscriber** | دریافت سیگنال، مدیریت اشتراک‌ها | معامله‌گران |
| **Relay** | انتقال سیگنال، گسترش پوشش | داوطلبان جامعه |

### انتشار سیگنال

1. Provider سیگنال را از طریق REST API ارسال می‌کند (امضای کیف پول Ed25519)
2. نود اعتبارسنجی می‌کند، در SQLite ذخیره می‌کند، به صورت محلی از طریق WebSocket پخش می‌کند
3. سیگنال از طریق libp2p GossipSub انتشار می‌یابد (TTL=5 hops)
4. هر نود تکرارزدایی + امضای HMAC را تأیید می‌کند

---

## سری جعبه‌های کور

جعبه‌های کور با ارزش ثابت. باز کنید تا NFT اشتراک استراتژی دریافت کنید، قابل معامله در بازار ثانویه.

| سری | ارزش (USDT) | BBT | کارمزد |
|-----|-------------|-----|--------|
| Bronze | 1 | 100 | 3% |
| Silver | 10 | 1,000 | 2.5% |
| Gold | 100 | 10,000 | 2% |
| Platinum | 1,000 | 100,000 | 1.5% |
| Diamond | 10,000 | 1,000,000 | 1% |

### محتوای داخل

| کمیابی | محتوا | احتمال | مرجع بازار |
|--------|-------|--------|------------|
| سفید | 1 روز آزمایشی | 40% | 10 BBT |
| سبز | اشتراک 7 روزه | 30% | 50 BBT |
| آبی | اشتراک 30 روزه | 15% | 200 BBT |
| بنفش | اشتراک 90 روزه | 10% | 800 BBT |
| نارنجی | اشتراک 365 روزه | 4% | 3,000 BBT |
| مخفی | دائمی + دعوت خصوصی | 1% | 10,000+ BBT |

**سنتز:** 5 سفید -> 1 سبز، 3 سبز -> 1 آبی. سناریوهای سوزاندن ایجاد می‌کند.

---

## شروع سریع

### Docker

```bash
git clone <repo-url> && cd 123456btc-node
cp .env.example .env
# فایل .env را با کیف پول و تنظیمات خود ویرایش کنید
docker compose up -d
curl http://localhost:1119/health
```

### محلی

```bash
npm ci && npm run build

# مقداردهی اولیه
123456btc-node init --name "MyNode" --wallet "YOUR_SOLANA_WALLET" --rpc "https://api.devnet.solana.com"

# ایجاد استراتژی
123456btc-node strategy:create --name "BTC Alpha" --symbol "BTCUSDT" --pricing daily_bbt --price-day 100

# شروع
123456btc-node serve
```

---

## دستورات CLI

### نود

```bash
123456btc-node init              # مقداردهی اولیه نود
123456btc-node config            # مشاهده/به‌روزرسانی تنظیمات
123456btc-node serve             # شروع نود
123456btc-node emergency-wipe    # نابودی تمام داده‌ها (غیرقابل برگشت)
```

### استراتژی‌ها

```bash
123456btc-node strategy:create   # ایجاد استراتژی
123456btc-node strategy:list     # لیست استراتژی‌ها
123456btc-node strategy bind     # اتصال Agent به استراتژی
123456btc-node strategy bundles  # مشاهده بسته‌ها
123456btc-node strategy bundle   # خرید بسته
```

### هویت Agent

```bash
123456btc-node agent register    # ثبت Agent (Ed25519)
123456btc-node agent status      # مشاهده اعتبار
```

### جعبه‌های کور

```bash
123456btc-node blindbox create   # ایجاد جعبه کور
123456btc-node blindbox list     # لیست بازار
123456btc-node blindbox buy      # خرید جعبه کور
123456btc-node blindbox stats    # آمار بازار
```

### MCP Server

```bash
123456btc-node mcp               # شروع MCP server برای AI Agent‌ها
```

---

## REST API

| متد | مسیر | توضیحات |
|-----|------|---------|
| `GET` | `/health` | بررسی سلامت |
| `GET` | `/strategies` | لیست استراتژی‌ها |
| `POST` | `/strategies` | ایجاد استراتژی |
| `POST` | `/signals` | انتشار سیگنال |
| `GET` | `/signals/:strategyId` | تاریخچه سیگنال |
| `POST` | `/subscriptions` | ایجاد اشتراک |
| `GET` | `/subscriptions` | لیست اشتراک‌ها |
| `POST` | `/users/register` | ثبت کیف پول |
| `GET` | `/user/balance` | موجودی روی زنجیره |
| `GET` | `/admin/earnings` | داشبورد درآمد |

### WebSocket

| مسیر | توضیحات |
|------|---------|
| `ws://host:port` | ارسال سیگنال بلادرنگ |
| `ws://host:port/peer` | مش P2P gossip |

### نمونه احراز هویت

```bash
curl -X POST http://localhost:1119/signals \
  -H "x-wallet: <WALLET>" \
  -H "x-wallet-signature: <ED25519_SIG>" \
  -H "x-wallet-timestamp: <TIMESTAMP>" \
  -d '{"strategy_id":"...","symbol":"BTCUSDT","decision":"BUY","confidence":0.85}'
```

---

## توکن BBT

**Mint:** `3s4AK2x2nGkKP8ZADbcKuhdPr3coSuh1XnwZEzWgpump` | **اعشار:** 6 | **زنجیره:** Solana

### چرا BBT

- **استاندارد** — 1 BBT = 1 BBT، بدون پیچیدگی نرخ ارز
- **تقسیم‌پذیر** — 6 رقم اعشار، هر مبلغی
- **شفاف اما بافتاری** — قابل تأیید روی زنجیره، هر تراکنش دلیل تجاری دارد
- **جهانی** — 24/7، بدون SWIFT، بدون ساعات بانکی

### مکانیزم سوزاندن

| سناریو | درصد سوزاندن |
|--------|-------------|
| خرید جعبه کور | 30% |
| اشتراک استراتژی | 20% |
| فروش مجدد NFT | 5% |
| کارمزد سرویس نود | 10% |
| درآمد پروتکل | 50% بازخرید و سوزاندن |

عرضه کل: 1 میلیارد، بدون ضرب.

---

## اشتراک و تسویه

### مدل‌های صورتحساب

| مدل | توضیحات |
|-----|---------|
| `daily_bbt` | اشتراک روزانه، کاربر هر روز BBT ارسال می‌کند |
| `per_signal_bbt` | کسر به ازای هر سیگنال از موجودی از پیش واریز شده |
| `free` | رایگان، بدون صورتحساب |

### جریان تسویه

1. کاربر استراتژی را انتخاب می‌کند، اشتراک ایجاد می‌کند
2. نود برمی‌گرداند: کیف پول Provider + مبلغ + Memo
3. کاربر BBT را با Memo ارسال می‌کند: `BBT-SUB|{sub_id}|{strategy_id}|{wallet}`
4. BillingCron هر 60 ثانیه زنجیره را بررسی می‌کند، Memo را تطبیق می‌دهد، اشتراک را فعال می‌کند

---

## سیستم هویت Agent

- **ثبت** — امضای کیف پول Ed25519، هویت منحصربه‌فرد روی زنجیره
- **اعتبار** — نرخ برد معاملات، دقت سیگنال، زمان آپ‌بود، وزن سهام
- **NFT** — ضرب Bot ID NFT، قابل تأیید روی زنجیره
- **اتصال** — Agent -> استراتژی، تنظیم حالت اجرا (auto/semi_auto/manual) و سهم کارمزد
- **بسته‌ها** — محصولات ترکیبی استراتژی NFT + جعبه کور

---

## امنیت

- **احراز هویت کیف پول** — امضاهای Ed25519، بدون نام کاربری/رمز عبور
- **امضای پیام** — HMAC-SHA256، ضد جعل، ضد تکرار
- **رمزگذاری داده** — AES-256 روی فیلدهای حساس، کلیدها روی سرور نیستند
- **سیاست لاگ** — خودکار پاکسازی، چرخش و نابودی 7 روزه
- **پاکسازی اضطراری** — `kill -USR1 <pid>` صفر کردن و حذف پایگاه داده، لاگ‌ها، تنظیمات
- **Docker non-root** — UID 1001، حداقل دسترسی‌ها
- **رمزگذاری P2P** — پروتکل libp2p noise، رمزگذاری سرتاسری gossip

لیست کامل: [SECURITY.md](SECURITY.md)

---

## ربات Telegram

با تنظیم `TELEGRAM_BOT_TOKEN` در `.env` فعال کنید.

| دستور | توضیحات |
|-------|---------|
| `/wallet <address>` | اتصال کیف پول |
| `/strategies` | لیست استراتژی‌ها |
| `/subscribe <id> <days>` | اشتراک |
| `/signals` | سیگنال‌های اخیر |
| `/status` | وضعیت اشتراک |

---

## یکپارچگی MCP

MCP Server داخلی برای AI Agent‌ها (Claude Code, Cursor و غیره).

```json
{
  "mcpServers": {
    "123456btc": {
      "command": "npx",
      "args": ["tsx", "/path/to/src/mcp/server.ts"]
    }
  }
}
```

| ابزار | توضیحات |
|------|---------|
| `list_strategies` | لیست استراتژی‌ها |
| `create_strategy` | ایجاد استراتژی |
| `publish_signal` | انتشار سیگنال |
| `get_signals` | تاریخچه سیگنال |
| `my_subscriptions` | اشتراک‌های من |
| `register_wallet` | ثبت کیف پول |
| `node_status` | وضعیت نود |

---

## متغیرهای محیطی

| متغیر | پیش‌فرض | توضیحات |
|-------|---------|---------|
| `BBT_PROVIDER_ID` | (الزامی) | شناسه Provider |
| `BBT_WALLET_ADDRESS` | (الزامی) | کیف پول Solana شما |
| `BBT_NODE_PORT` | `1119` | پورت |
| `BBT_SOLANA_RPC` | mainnet | Solana RPC |
| `BBT_SETTLEMENT_MODE` | `memo` | حالت تسویه |
| `BBT_SEEDS` | (خالی) | URL‌های نود seed |
| `TELEGRAM_BOT_TOKEN` | (خالی) | ربات Telegram |
| `ENABLE_AUTO_EXECUTION` | `false` | اجرای خودکار از طریق Jupiter |
| `BBT_LOG_LEVEL` | `info` | سطح لاگ |

لیست کامل: [.env.example](.env.example)

---

## پشته فناوری

Node.js 20+ / TypeScript / SQLite / Solana / libp2p GossipSub / Commander / Pino / Telegraf / tsyringe / Jupiter / MCP

---

## مستندات

| مستند | محتوا |
|-------|-------|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | توپولوژی شبکه، انتشار سیگنال، مدل داده |
| [SIGNAL_STANDARD.md](docs/SIGNAL_STANDARD.md) | استاندارد سیگنال ISES v1 |
| [MCP-INTEGRATION.md](docs/MCP-INTEGRATION.md) | یکپارچگی AI Agent |
| [DEPLOY.md](DEPLOY.md) | Docker، HTTPS، پشتیبان‌گیری |
| [SECURITY.md](SECURITY.md) | چک‌لیست ممیزی امنیتی |

---

## تست

```bash
npm test              # اجرای تمام تست‌ها
npm run test:watch    # حالت نظارت
npm run lint          # لینت
```

---

## مجوز

Apache License 2.0
