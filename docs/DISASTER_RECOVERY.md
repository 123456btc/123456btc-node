# 灾难恢复手册
# Disaster Recovery Playbook

> 研发总监编制
> 目标：节点宕机、数据丢失、密钥泄露时的紧急应对

---

## 一、灾难分级

| 级别 | 名称 | 场景 | 响应时间 |
|------|------|------|----------|
| P0 | 核灾难 | 服务器被物理查封 / 密钥完全泄露 | 立即 |
| P1 | 数据灾难 | 数据库损坏 / 节点永久离线 | 15分钟 |
| P2 | 服务灾难 | 节点宕机但数据完好 / 网络分区 | 1小时 |
| P3 | 性能灾难 | 高延迟 / 信号堆积 / 内存泄漏 | 4小时 |

---

## 二、P0 核灾难：服务器被物理查封

### 触发条件
- 服务器所在地执法机关介入
- 机房被断电/断网
- 云服务商配合调查冻结实例

### 紧急响应流程（5分钟内）

```bash
# Step 1: 所有在线节点执行紧急销毁
ssh node1 "killall -USR1 123456btc-node"   # USR1 触发 emergencyWipe
ssh node2 "killall -USR1 123456btc-node"
ssh node3 "killall -USR1 123456btc-node"

# Step 2: 远程擦除云盘（如支持）
# AWS: aws ec2 stop-instances --instance-ids i-xxx
# 配合 encrypted root volume + 删除 KMS key

# Step 3: 切断所有种子节点连接
# 修改 DNS / CDN 规则，将种子域名指向 127.0.0.1
```

### emergencyWipe 做了什么
1. `CryptoVault.emergencyWipe()` — 内存主密钥清零
2. `SQLiteStore.emergencyWipe()` — DROP 所有表
3. `SecureLogRotator.emergencyPurge()` — 安全删除所有日志
4. 进程退出

### 重建流程（新服务器，新身份）

```bash
# 1. 在新司法管辖区启动全新服务器
# 2. 生成全新 Provider ID 和密钥对
123456btc-node init --provider-name "NewIdentity" --wallet <NEW_WALLET> --role provider --port 1119

# 3. 从 Arweave 恢复历史信号（公开数据）
123456btc-node restore --from-arweave --date 2026-05-01

# 4. 通过私密渠道通知高净值客户新节点地址
# （不使用任何旧通信渠道）

# 5. 新节点运行 48 小时无异常后，逐步恢复业务
```

---

## 三、P1 数据灾难：数据库损坏

### 触发条件
- SQLite 文件损坏（磁盘故障/断电）
- better-sqlite3 版本不兼容导致无法读取
- 加密密钥丢失导致数据库无法解密

### 诊断命令

```bash
# 检查数据库完整性
sqlite3 data/node.db "PRAGMA integrity_check;"

# 检查 WAL 文件
ls -la data/node.db-wal data/node.db-shm

# 检查磁盘空间
df -h
```

### 恢复流程

**场景 A：有备份**

```bash
# 1. 停止节点
killall 123456btc-node

# 2. 备份当前损坏文件（ forensic 保留）
cp data/node.db data/node.db.corrupted.$(date +%s)

# 3. 从备份恢复
cp backups/node.db.latest data/node.db

# 4. 验证密钥仍能解密
123456btc-node verify-db

# 5. 启动节点
123456btc-node serve
```

**场景 B：无备份，但 Arweave 有信号历史**

```bash
# 1. 重建空数据库
rm -f data/node.db
123456btc-node init-db

# 2. 从 Arweave 恢复 signals（公开）
123456btc-node restore-signals --from-arweave

# 3. 用户订阅关系无法恢复（隐私数据未上链）
# 需要用户重新订阅，或 Provider 手动重建
```

**场景 C：密钥丢失（数据库变成无法解密的密文）**

```
结果：数据永久丢失，无法恢复。
预防措施：
- 主密钥分片存储（Shamir Secret Sharing，3/5 阈值）
- 分片分布在 5 个不同司法管辖区
- 任何 3 个分片可重构主密钥
```

---

## 四、P2 服务灾难：节点宕机

### 自动恢复（Docker + Systemd）

```yaml
# docker-compose.yml 已配置
restart: unless-stopped
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:1119/health"]
  interval: 30s
  timeout: 10s
  retries: 3
```

### 手动重启流程

```bash
# 1. 检查进程
ps aux | grep 123456btc-node

# 2. 检查日志最后 50 行
journalctl -u 123456btc-node -n 50

# 3. 检查端口占用
lsof -i :1119

# 4. 清理后重启
docker-compose down
docker-compose up -d

# 5. 验证健康
 curl http://localhost:1119/health
```

---

## 五、P3 性能灾难：信号堆积

### 诊断指标

```
# 查看 Prometheus 指标
curl http://localhost:1119/metrics | grep bbt_signals

# 关键阈值
bbt_signals_pending > 1000   → 警告
bbt_signals_pending > 5000   → 严重
bbt_http_request_duration_ms_bucket{le="1000"} < 0.95  → 延迟异常
```

### 扩容流程

```bash
# 1. 垂直扩容：增加 Worker Threads
export BBT_WORKER_THREADS=8

# 2. 水平扩容：启动更多 Relay 节点
123456btc-node init --role relay --port 1118 --seeds ws://main:1119/peer

# 3. 限流：降低 Gossip TTL
export BBT_GOSSIP_TTL=3

# 4. 降级：暂停非关键功能（Arweave备份、日志详细输出）
export BBT_LOG_LEVEL=error
export BBT_ARWEAVE_BACKUP=disabled
```

---

## 六、密钥轮换流程

### Provider Secret 泄露

```bash
# Step 1: 生成新密钥
NEW_SECRET=$(openssl rand -hex 32)

# Step 2: 更新环境变量（不重启进程，通过 SIGHUP 热加载）
echo "BBT_PROVIDER_SECRET=$NEW_SECRET" > /etc/123456btc-node/env
kill -HUP <pid>

# Step 3: 旧密钥在 5 分钟后失效（内存中保留双密钥窗口期）
# 新连接强制使用新密钥
```

### Ed25519 密钥对轮换

```bash
# 生成新密钥对
123456btc-node keygen --output /etc/123456btc-node/new_keypair.json

# 广播公钥到网络（通过 gossip 协议）
123456btc-node announce-key --public-key $(cat new_keypair.json | jq -r .publicKey)

# 24 小时后旧密钥失效
```

---

## 七、联系与升级

| 角色 | 职责 | 联系方式 |
|------|------|----------|
| 值班研发 | 技术故障处理 | Signal / Session |
| 安全负责人 | 密钥/加密问题 | 离线通信 |
| 运营负责人 | 客户沟通 | 备用 TG 群 |
| 法务顾问 | 执法应对 | 加密邮件 |

---

## 八、检查清单（每季度演练）

```
□ emergencyWipe 脚本测试（隔离环境）
□ 从 Arweave 恢复测试
□ 密钥分片重构测试
□ 数据库备份/恢复测试
□ 节点跨区迁移演练
□ Docker 重建时间 < 5 分钟
□ 混沌测试通过（1000信号 burst）
□ 所有节点日志自毁正常
```
