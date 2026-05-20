# 123456btc-node

> **[English](README.md)** | [中文](README_zh.md) | [فارسی](README_fa.md) | [မြန်မာ](README_my.md) | [العربية](README_ar.md) | [Français](README_fr.md)

> **شبكة توزيع الاستراتيجيات اللامركزية**
>
> قم بتشغيل عقدتك الخاصة. حدد سعرك. ابنِ دوائرك.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![Solana](https://img.shields.io/badge/Solana-Devnet%20%7C%20Mainnet-9945FF.svg)](https://solana.com)

---

## ما هذا؟

شبكة P2P بالكامل لامركزية لتوزيع إشارات التداول. قم بنشر عقدتك الخاصة، وانشر الاستراتيجيات، واجمع اشتراكات رمز BBT — بدون خادم مركزي، بدون عمولة منصة.

**كيف يعمل:**

1. تقوم بنشر **عقدة مزود (Provider)**
2. تنشئ الاستراتيجيات وتضع الأسعار بـ BBT
3. يكتشف المستخدمون عقدتك في المجتمعات الخاصة
4. يشترك المستخدمون بإرسال BBT إلى محفظتك
5. يدفع نظامك الإشارات، وتصل للمستخدمين في الوقت الفعلي
6. تدير BBT الخاص بك وفقاً لاحتياجاتك

**ثلاث طبقات للمنتج:**

- **صناديق مفاجأة (Blind Boxes)** — فئات ثابتة (1 / 10 / 100 / 1K / 10K USDT)، افتح الصندوق للحصول على NFT اشتراك الاستراتيجية
- **اشتراكات الاستراتيجيات** — يومي، لكل إشارة، أو مجاني
- **شبكة العقد** — قم بتشغيل عقدتك الخاصة، وحدد تسعيرك

---

## بنية الشبكة

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

### أدوار العقد

| الدور | ماذا تفعل | من يديرها |
|-------|----------|----------|
| **مزود (Provider)** | إنشاء استراتيجيات، نشر إشارات، جمع BBT | فرق التحليل الكمي |
| **مشترك (Subscriber)** | استقبال إشارات، إدارة الاشتراكات | المتداولون |
| **مُرحّل (Relay)** | إعادة توجيه الإشارات، توسيع التغطية | متطوعو المجتمع |

### انتشار الإشارات

1. يدفع المزود إشارة عبر REST API (توقيع محفظة Ed25519)
2. تتحقق العقدة وتحفظ في SQLite وتُبث محلياً عبر WebSocket
3. تنتشر الإشارة عبر libp2p GossipSub (TTL=5 hops)
4. كل عقدة تزيل التكرارات وتتحقق من توقيع HMAC

---

## سلسلة صناديق المفاجأة

صناديق مفاجأة بفئات ثابتة. افتح الصندوق للحصول على NFT اشتراك الاستراتيجية، قابلة للتداول في السوق الثانوي.

| السلسلة | القيمة (USDT) | BBT | العمولة |
|---------|-------------|-----|--------|
| برونز | 1 | 100 | 3% |
| فضي | 10 | 1,000 | 2.5% |
| ذهبي | 100 | 10,000 | 2% |
| بلاتيني | 1,000 | 100,000 | 1.5% |
| ماسي | 10,000 | 1,000,000 | 1% |

### ما بداخله

| الندرة | المحتوى | الاحتمال | مرجع السوق |
|--------|---------|---------|-----------|
| أبيض | تجربة يوم واحد | 40% | 10 BBT |
| أخضر | اشتراك 7 أيام | 30% | 50 BBT |
| أزرق | اشتراك 30 يوم | 15% | 200 BBT |
| بنفسجي | اشتراك 90 يوم | 10% | 800 BBT |
| برتقالي | اشتراك 365 يوم | 4% | 3,000 BBT |
| مخفي | دائم + دعوة خاصة | 1% | 10,000+ BBT |

**الدمج:** 5 أبيض -> 1 أخضر، 3 أخضر -> 1 أزرق. يخلق سيناريوهات حرق.

---

## البدء السريع

### Docker

```bash
git clone <repo-url> && cd 123456btc-node
cp .env.example .env
# قم بتعديل .env بمحفظتك وإعداداتك
docker compose up -d
curl http://localhost:1119/health
```

### محلي

```bash
npm ci && npm run build

# التهيئة
123456btc-node init --name "MyNode" --wallet "YOUR_SOLANA_WALLET" --rpc "https://api.devnet.solana.com"

# إنشاء استراتيجية
123456btc-node strategy:create --name "BTC Alpha" --symbol "BTCUSDT" --pricing daily_bbt --price-day 100

# البدء
123456btc-node serve
```

---

## أوامر CLI

### العقدة

```bash
123456btc-node init              # تهيئة العقدة
123456btc-node config            # عرض/تحديث التكوين
123456btc-node serve             # بدء تشغيل العقدة
123456btc-node emergency-wipe    # حذف جميع البيانات (لا رجعة فيه)
```

### الاستراتيجيات

```bash
123456btc-node strategy:create   # إنشاء استراتيجية
123456btc-node strategy:list     # عرض الاستراتيجيات
123456btc-node strategy bind     # ربط Agent بالاستراتيجية
123456btc-node strategy bundles  # عرض الحزم
123456btc-node strategy bundle   # شراء حزمة
```

### هوية Agent

```bash
123456btc-node agent register    # تسجيل Agent (Ed25519)
123456btc-node agent status      # عرض السمعة
```

### صناديق المفاجأة

```bash
123456btc-node blindbox create   # إنشاء صندوق مفاجأة
123456btc-node blindbox list     # عروض السوق
123456btc-node blindbox buy      # شراء صندوق مفاجأة
123456btc-node blindbox stats    # إحصائيات السوق
```

### MCP Server

```bash
123456btc-node mcp               # بدء تشغيل MCP server لـ AI Agents
```

---

## REST API

| الطريقة | المسار | الوصف |
|---------|-------|------|
| `GET` | `/health` | فحص الحالة |
| `GET` | `/strategies` | عرض الاستراتيجيات |
| `POST` | `/strategies` | إنشاء استراتيجية |
| `POST` | `/signals` | نشر إشارة |
| `GET` | `/signals/:strategyId` | سجل الإشارات |
| `POST` | `/subscriptions` | إنشاء اشتراك |
| `GET` | `/subscriptions` | عرض الاشتراكات |
| `POST` | `/users/register` | تسجيل المحفظة |
| `GET` | `/user/balance` | الرصيد على السلسلة |
| `GET` | `/admin/earnings` | لوحة الأرباح |

### WebSocket

| المسار | الوصف |
|-------|------|
| `ws://host:port` | دفع إشارات في الوقت الفعلي |
| `ws://host:port/peer` | شبكة Gossip P2P |

### مثال المصادقة

```bash
curl -X POST http://localhost:1119/signals \
  -H "x-wallet: <WALLET>" \
  -H "x-wallet-signature: <ED25519_SIG>" \
  -H "x-wallet-timestamp: <TIMESTAMP>" \
  -d '{"strategy_id":"...","symbol":"BTCUSDT","decision":"BUY","confidence":0.85}'
```

---

## رمز BBT

**ال铸造:** `3s4AK2x2nGkKP8ZADbcKuhdPr3coSuh1XnwZEzWgpump` | **الكسور العشرية:** 6 | **السلسلة:** Solana

### لماذا BBT

- **معياري** — 1 BBT = 1 BBT، بدون تعقيد أسعار الصرف
- **قابل للقسمة** — 6 أماكن عشرية، أي مبلغ
- **شفاف ولكن سياقي** — قابل للتحقق على السلسلة، كل معاملة لها سبب تجاري
- **عالمي** — 24/7، بدون SWIFT، بدون ساعات مصرفية

### آلية الحرق

| السيناريو | نسبة الحرق |
|-----------|-----------|
| شراء صندوق مفاجأة | 30% |
| اشتراك استراتيجية | 20% |
| إعادة بيع NFT | 5% |
| رسوم خدمة العقدة | 10% |
| إيرادات البروتوكول | 50% إعادة شراء وحرق |

إمدادات إجمالية: 1 مليار، بدون سك جديد.

---

## الاشتراك والتسوية

### نماذج الفوترة

| النموذج | الوصف |
|--------|------|
| `daily_bbt` | اشتراك يومي، يرسل المستخدم BBT يومياً |
| `per_signal_bbt` | خصم لكل إشارة من الرصيد المودع مسبقاً |
| `free` | مجاني، بدون فوترة |

### تدفق التسوية

1. يختار المستخدم الاستراتيجية وينشئ اشتراكاً
2. تُرجع العقدة: محفظة المزود + المبلغ + المذكرة
3. يرسل المستخدم BBT مع المذكرة: `BBT-SUB|{sub_id}|{strategy_id}|{wallet}`
4. يقوم BillingCron بالاستعلام عن السلسلة كل 60 ثانية، ويطابق المذكرة، ويفعل الاشتراك

---

## نظام هوية Agent

- **التسجيل** — توقيع محفظة Ed25519، هوية فريدة على السلسلة
- **السمعة** — نسبة الربح، دقة الإشارة، وقت التشغيل، وزن الرهان
- **NFT** — سك Bot ID NFT، قابل للتحقق على السلسلة
- **الربط** — Agent -> Strategy، تعيين وضع التنفيذ (تلقائي/شبه تلقائي/يدوي) ونسبة العمولة
- **الحزم** — منتجات مجمعة Strategy NFT + Blind Box

---

## الأمان

- **مصادقة المحفظة** — توقيعات Ed25519، بدون اسم مستخدم/كلمة مرور
- **توقيع الرسائل** — HMAC-SHA256، مضاد للتزوير، مضاد لإعادة التشغيل
- **تشفير البيانات** — AES-256 للحقول الحساسة، المفاتيح ليست على الخادم
- **سياسة السجلات** — تنظيف تلقائي، تدوير وحذف كل 7 أيام
- **الحذف الطارئ** — `kill -USR1 <pid>` يُصفّر ويحذف قاعدة البيانات والسجلات والتكوين
- **Docker بدون صلاحيات root** — UID 1001، صلاحيات دنيا
- **تشفير P2P** — بروتوكول libp2p noise، تشفير من طرف إلى طرف

قائمة التحقق الكاملة: [SECURITY.md](SECURITY.md)

---

## بوت Telegram

قم بتفعيله عن طريق تعيين `TELEGRAM_BOT_TOKEN` في `.env`.

| الأمر | الوصف |
|------|------|
| `/wallet <address>` | ربط المحفظة |
| `/strategies` | عرض الاستراتيجيات |
| `/subscribe <id> <days>` | اشتراك |
| `/signals` | الإشارات الأخيرة |
| `/status` | حالة الاشتراك |

---

## تكامل MCP

MServer مدمج لـ AI Agents (Claude Code, Cursor, إلخ).

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

| الأداة | الوصف |
|-------|------|
| `list_strategies` | عرض الاستراتيجيات |
| `create_strategy` | إنشاء استراتيجية |
| `publish_signal` | نشر إشارة |
| `get_signals` | سجل الإشارات |
| `my_subscriptions` | اشتراكاتي |
| `register_wallet` | تسجيل المحفظة |
| `node_status` | حالة العقدة |

---

## متغيرات البيئة

| المتغير | الافتراضي | الوصف |
|---------|---------|------|
| `BBT_PROVIDER_ID` | (مطلوب) | معرف المزود |
| `BBT_WALLET_ADDRESS` | (مطلوب) | محفظة Solana الخاصة بك |
| `BBT_NODE_PORT` | `1119` | المنفذ |
| `BBT_SOLANA_RPC` | mainnet | Solana RPC |
| `BBT_SETTLEMENT_MODE` | `memo` | وضع التسوية |
| `BBT_SEEDS` | (فارغ) | روابط عقد البذور |
| `TELEGRAM_BOT_TOKEN` | (فارغ) | بوت Telegram |
| `ENABLE_AUTO_EXECUTION` | `false` | تنفيذ تلقائي عبر Jupiter |
| `BBT_LOG_LEVEL` | `info` | مستوى السجل |

القائمة الكاملة: [.env.example](.env.example)

---

## حزمة التقنيات

Node.js 20+ / TypeScript / SQLite / Solana / libp2p GossipSub / Commander / Pino / Telegraf / tsyringe / Jupiter / MCP

---

## التوثيق

| المستند | المحتوى |
|--------|--------|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | طوبولوجيا الشبكة، انتشار الإشارات، نموذج البيانات |
| [SIGNAL_STANDARD.md](docs/SIGNAL_STANDARD.md) | معيار إشارة ISES v1 |
| [MCP-INTEGRATION.md](docs/MCP-INTEGRATION.md) | تكامل AI Agent |
| [DEPLOY.md](DEPLOY.md) | Docker، HTTPS، النسخ الاحتياطي |
| [SECURITY.md](SECURITY.md) | قائمة تدقيق الأمن |

---

## الاختبار

```bash
npm test              # تشغيل جميع الاختبارات
npm run test:watch    # وضع المراقبة
npm run lint          # فحص الكود
```

---

## الترخيص

Apache License 2.0
