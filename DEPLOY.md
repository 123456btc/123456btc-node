# 123456btc-node Deployment Guide

Production deployment guide for the 123456btc decentralized strategy service node.

---

## Prerequisites

- Docker 24+ and Docker Compose v2
- A Solana wallet address (your on-chain identity)
- Solana RPC endpoint (mainnet recommended: Helius, QuickNode, or Alchemy)
- (Optional) Telegram Bot Token for bot integration
- (Optional) Domain name + TLS certificate for HTTPS

---

## Quick Start (Docker)

### 1. Clone and Configure

```bash
git clone <repo-url> && cd 123456btc-node
cp .env.example .env
```

Edit `.env` with your real values. Required fields:

| Variable | Description |
|----------|-------------|
| `BBT_PROVIDER_ID` | Your provider identifier (usually your wallet address) |
| `BBT_WALLET_ADDRESS` | Your Solana wallet address |
| `BBT_ADMIN_API_KEY` | Admin API key (generate: `openssl rand -base64 24`) |

### 2. Build and Start

```bash
docker compose up -d
```

### 3. Verify

```bash
# Check container health
docker compose ps

# Check health endpoint
curl http://localhost:1119/health

# View logs
docker compose logs -f bbt-node
```

Expected health response:

```json
{
  "status": "ok",
  "provider": "your-wallet-address",
  "features": {
    "escrow": false,
    "auto_execution": false
  }
}
```

---

## First-Time Node Initialization

If running without Docker, initialize the node first:

```bash
# Install dependencies
npm ci
npm run build

# Initialize node
node dist/cli.js init \
  --name "My Node" \
  --wallet "YOUR_SOLANA_WALLET_ADDRESS" \
  --rpc "https://api.mainnet-beta.solana.com"

# Create a strategy
node dist/cli.js strategy:create \
  --name "BTC Alpha" \
  --symbol "BTCUSDT" \
  --pricing daily_bbt \
  --price-day 10

# Start server
node dist/cli.js serve
```

---

## Configuration Reference

### Environment Variables

See `.env.example` for the complete list. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `production` | Node environment |
| `BBT_NODE_PORT` | `1119` | HTTP/WS port |
| `BBT_SOLANA_RPC` | `https://api.mainnet-beta.solana.com` | Solana RPC |
| `BBT_BBT_MINT` | `3s4AK2x2nGkKP8ZADbcKuhdPr3coSuh1XnwZEzWgpump` | BBT token mint |
| `BBT_SETTLEMENT_MODE` | `memo` | `memo` or `escrow` |
| `BBT_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `BBT_SEEDS` | (empty) | Comma-separated seed peer URLs |
| `TELEGRAM_BOT_TOKEN` | (empty) | Telegram bot token |
| `ENABLE_AUTO_EXECUTION` | `false` | Enable Jupiter auto-execution |

### Configuration File

The node also reads from `~/.123456btc-node/config.json` (created by `init`). Environment variables take priority over the config file.

### Settlement Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| `memo` | Payment verification via Solana memo transactions | Simple, low-cost |
| `escrow` | On-chain escrow contract with dispute resolution | High-value subscriptions |

---

## HTTPS / Reverse Proxy

### Option A: Nginx (included in docker-compose)

```bash
# Create certs directory
mkdir -p docker/certs

# Copy your TLS certificates
cp /path/to/fullchain.pem docker/certs/
cp /path/to/privkey.pem docker/certs/

# Start with proxy profile
docker compose --profile proxy up -d
```

### Option B: Cloudflare / External Proxy

If using Cloudflare or another external proxy:
1. Set the external proxy to forward to `http://your-server:1119`
2. Disable the nginx service in docker-compose.yml
3. Set `BBT_NODE_PORT=1119` in `.env`

---

## Telegram Bot

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Get the bot token
3. Set `TELEGRAM_BOT_TOKEN` in `.env`
4. Restart: `docker compose restart bbt-node`

The bot supports:
- `/start` — Welcome message
- `/wallet <address>` — Bind Solana wallet
- `/strategies` — List strategies
- `/subscribe <id> <days>` — Create subscription
- `/signals` — View recent signals
- `/status` — Subscription status

---

## Monitoring

### Health Check

```bash
curl http://localhost:1119/health
```

### Metrics (Prometheus)

The node exposes Prometheus-compatible metrics. To scrape:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: '123456btc-node'
    static_configs:
      - targets: ['your-server:1119']
    metrics_path: /metrics
```

### Logs

```bash
# Docker logs (JSON format, production)
docker compose logs -f bbt-node

# Filter by level
docker compose logs bbt-node 2>&1 | grep '"level":"ERROR"'
```

---

## Backup and Recovery

### Database Backup

```bash
# Copy SQLite database from Docker volume
docker compose exec bbt-node cp /app/data/node.db /app/data/node.db.backup
docker cp bbt-node:/app/data/node.db.backup ./backups/node-$(date +%Y%m%d).db
```

### Automated Backup (cron)

```bash
# Add to crontab
0 3 * * * cd /path/to/123456btc-node && docker compose exec -T bbt-node sqlite3 /app/data/node.db ".backup /app/data/node.db.backup" && docker cp bbt-node:/app/data/node.db.backup ./backups/node-$(date +\%Y\%m\%d).db
```

### Recovery

```bash
# Stop node
docker compose down

# Restore database
cp ./backups/node-20250101.db ./data/node.db

# Restart
docker compose up -d
```

---

## Emergency Procedures

### Emergency Wipe (destroy all data)

```bash
# Via Docker signal
docker kill --signal=USR1 bbt-node

# Via CLI inside container
docker compose exec bbt-node node dist/cli.js emergency-wipe --confirm
```

### Restart

```bash
docker compose restart bbt-node
```

### View Recent Signals

```bash
curl -s http://localhost:1119/strategies | jq
```

---

## Production Checklist

Before going live:

- [ ] `.env` is configured with real values
- [ ] `BBT_ADMIN_API_KEY` is strong (24+ bytes entropy)
- [ ] TLS is configured (HTTPS only)
- [ ] Firewall allows only ports 443 and SSH
- [ ] Database backup cron is configured
- [ ] Health check monitoring is active
- [ ] Log collection is working
- [ ] Emergency wipe procedure is understood
- [ ] See `SECURITY.md` for the full security audit checklist

---

## Troubleshooting

### Container fails to start

```bash
docker compose logs bbt-node
# Common: missing required env vars (BBT_WALLET_ADDRESS, BBT_PROVIDER_ID)
```

### Health check fails

```bash
docker compose exec bbt-node curl -s http://localhost:1119/health
# Check if the node is binding to the correct port
```

### Database locked

```bash
# SQLite can get locked if the container was force-killed
docker compose down
# Delete WAL files if corrupted
rm -f data/node.db-wal data/node.db-shm
docker compose up -d
```

### P2P peers not connecting

```bash
# Check seed URLs in BBT_SEEDS
# Ensure port 1119 is accessible from the internet
# Check firewall rules
```
