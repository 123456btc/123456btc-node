# 123456btc-node Security Audit Checklist

Pre-deployment security verification for production environments.

---

## 1. Secrets Management

- [ ] `.env` file is in `.gitignore` and never committed
- [ ] `BBT_ADMIN_API_KEY` is generated with at least 24 bytes of entropy
- [ ] `BBT_PROVIDER_SECRET` is stored in environment variables, not in config files
- [ ] No hardcoded private keys, mnemonics, or API keys in source code
- [ ] Telegram bot token is stored in environment variables only
- [ ] Solana wallet private key is stored in a hardware wallet or secure key management system (never on disk)

## 2. Network Security

- [ ] Node listens only on necessary ports (1119)
- [ ] TLS termination is configured via reverse proxy (nginx)
- [ ] HTTP to HTTPS redirect is enforced
- [ ] Rate limiting is active on API endpoints (100 req/min default)
- [ ] Admin endpoints (`/admin/*`) are restricted to trusted IPs or VPN
- [ ] WebSocket connections require wallet signature authentication
- [ ] P2P peer connections are authenticated via libp2p noise protocol
- [ ] Firewall rules allow only inbound 443 (HTTPS) and SSH from known IPs

## 3. Authentication & Authorization

- [ ] Wallet signature verification is enforced on all write endpoints
- [ ] Admin API key is required for `/admin/*` endpoints
- [ ] Signature timestamp is validated to prevent replay attacks (5-minute window)
- [ ] `payment_tx` is tracked for idempotency (anti-replay)
- [ ] Request body size is limited to 1MB

## 4. Data Security

- [ ] SQLite database files are in a persistent volume (not in container layer)
- [ ] Database file permissions are restricted to the `bbt` user (UID 1001)
- [ ] Sensitive fields in logs are automatically redacted by pino
- [ ] Log rotation is configured (max-size: 10m, max-file: 5)
- [ ] Emergency wipe command (`emergency-wipe`) securely zeroes data before deletion
- [ ] Old logs are automatically purged (configurable via `BBT_LOG_PERSIST_DAYS`)

## 5. Docker Security

- [ ] Docker image runs as non-root user (`bbt`, UID 1001)
- [ ] Multi-stage build minimizes attack surface (no dev dependencies in production)
- [ ] `tini` is used as PID 1 for proper signal handling
- [ ] Container has memory limits (512MB) and CPU limits (1 core)
- [ ] Health check is configured with appropriate timeouts
- [ ] No unnecessary ports are exposed
- [ ] Container filesystem is read-only where possible
- [ ] Base image is `node:20-alpine` (minimal footprint)

## 6. API Security

- [ ] Input validation via `zod` schemas on all request bodies
- [ ] JSON parse errors are caught and return 400 (not 500)
- [ ] CORS headers are configured for production domain only
- [ ] Error responses do not leak stack traces in production
- [ ] Directory traversal is prevented for static file serving

## 7. Solana / On-Chain Security

- [ ] Solana RPC endpoint is a trusted provider (Helius, QuickNode, Alchemy)
- [ ] BBT token mint address is hardcoded and verified: `3s4AK2x2nGkKP8ZADbcKuhdPr3coSuh1XnwZEzWgpump`
- [ ] Transaction signatures are verified on-chain before confirming payments
- [ ] Settlement mode is chosen based on security requirements (escrow > memo for large amounts)
- [ ] Burn rate is set appropriately for the business model

## 8. Monitoring & Alerting

- [ ] Health check endpoint (`/health`) is monitored externally
- [ ] Logs are collected and searchable (pino JSON output)
- [ ] Error rate alerts are configured
- [ ] Disk space monitoring is active (SQLite grows over time)
- [ ] Peer count monitoring is active (detect network isolation)
- [ ] Billing confirmation failures trigger alerts

## 9. Operational Security

- [ ] Deployment uses `docker compose` with pinned image versions
- [ ] SSH access to the host is key-based only (no password auth)
- [ ] OS packages are kept up to date
- [ ] Backup strategy is in place for the SQLite database
- [ ] Disaster recovery procedure is documented and tested
- [ ] SIGUSR1 emergency wipe is understood by the operations team

## 10. Compliance & Audit Trail

- [ ] All billing records are immutable once confirmed
- [ ] Transaction signatures are stored for audit
- [ ] Signal history is preserved with timestamps
- [ ] Admin actions are logged
- [ ] Data retention policy is documented

---

## Emergency Procedures

### SIGUSR1 — Emergency Wipe

Send `SIGUSR1` to the node process to immediately:
1. Delete the SQLite database
2. Zero-fill and delete all log files
3. Zero-fill and delete the config file

```bash
# In Docker
docker kill --signal=USR1 bbt-node

# On host
kill -USR1 <pid>
```

**Warning**: This is irreversible. All data is destroyed.

### Manual Emergency Wipe

```bash
123456btc-node emergency-wipe --confirm
```

---

## Security Contact

Report vulnerabilities privately. Do not open public issues for security bugs.
