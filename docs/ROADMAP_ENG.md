# 123456btc-node 研发路线图
# Engineering Roadmap: From Prototype to Production

> 角色：研发总监
> 目标：把钱庄通道的代码基础打扎实，确保安全、稳定、可扩展

---

## 一、当前技术债务诊断

### 1.1 架构层（严重）

| 问题 | 风险等级 | 影响 |
|------|----------|------|
| SQLite 本地文件存储 | 🔴 Critical | 节点宕机数据丢失，无法跨节点恢复 |
| 自研 Gossip 无 BFT | 🔴 Critical | 恶意节点可伪造信号、Spam、选择性丢包 |
| 单进程架构 | 🟡 High | 无法利用多核，高并发下性能瓶颈 |
| 缺乏状态同步 | 🟡 High | Provider 和 Subscriber 数据不一致 |

### 1.2 安全层（严重）

| 问题 | 风险等级 | 影响 |
|------|----------|------|
| SQLite 明文存储 | 🔴 Critical | 服务器被物理查封即全部暴露 |
| 日志无销毁机制 | 🔴 Critical | 操作记录成为呈堂证供 |
| 密钥硬编码 | 🔴 Critical | config.json 泄露 = 全盘崩溃 |
| 无通信加密 | 🟡 High | Gossip 消息可被中间人监听 |

### 1.3 工程层（中等）

| 问题 | 风险等级 | 影响 |
|------|----------|------|
| 零单元测试 | 🟡 High | 重构风险极高，无法 CI |
| CLI 与核心耦合 | 🟡 High | 难以独立测试核心模块 |
| 缺乏配置管理 | 🟡 High | 多环境部署困难 |
| 无监控/告警 | 🟠 Medium | 故障无法及时发现 |
| 无 Docker 化 | 🟠 Medium | 部署依赖环境，一致性差 |

---

## 二、研发原则

作为研发总监，我定下三条铁律：

1. **安全优先于功能**：钱庄通道的代码，一个安全漏洞可能让所有人坐牢
2. **可测试优先于可运行**：没有测试的代码不是代码，是定时炸弹
3. **可观测优先于高性能**：先要知道系统在哪死了，再优化它怎么跑得更快

---

## 三、分阶段路线图

### Phase 1: 地基工程（第1-2周）
**目标：让代码从"能跑"变成"能维护"

- [ ] 目录结构重构（核心 / CLI / 测试 / 配置 分离）
- [ ] 引入依赖注入（Inversify/Tsyringe），解耦模块
- [ ] 建立统一的配置管理（环境变量 + 加密配置文件）
- [ ] 建立结构化日志（Pino），支持分级和脱敏
- [ ] 编写核心模块的单元测试（Vitest）
- [ ] ESLint + Prettier 代码规范

### Phase 2: 安全加固（第3-4周）
**目标：让代码从"能维护"变成"能抗审查"

- [ ] SQLite 数据库加密（SQLCipher 或应用层 AES）
- [ ] 敏感配置分离（密钥存入 OS Keychain / 环境变量）
- [ ] 日志自动轮转 + 定时销毁（7天自毁）
- [ ] Gossip 消息端到端加密（X25519）
- [ ] Provider 签名从 HMAC 升级到 Ed25519
- [ ] 引入内存安全清理（sensitive data zeroing）

### Phase 3: 架构升级（第5-8周）
**目标：让代码从"单机"变成"分布式"

- [ ] 存储层抽象（Repository Pattern），支持 SQLite / LevelDB / 远程
- [ ] 引入 libp2p-gossipsub 替代自研 Gossip
- [ ] 状态快照 + 定期 Arweave 备份
- [ ] Worker Threads 隔离 CPU 密集型任务
- [ ] Docker + Docker Compose 一键部署
- [ ] 健康检查 / 指标暴露（Prometheus 格式）

### Phase 4: 生产就绪（第9-12周）
**目标：让代码从"分布式"变成"高可用"

- [ ] 灰度发布机制
- [ ] 自动化混沌测试（随机断网、节点宕机）
- [ ] 性能基准测试（1000 TPS 信号推送）
- [ ] 灾难恢复手册（节点重建、数据恢复）
- [ ] 代码审计（内部 + 可选外部）

---

## 四、目录结构重构

```
123456btc-node/
├── src/
│   ├── core/                    # 核心领域层（纯业务逻辑，无框架依赖）
│   │   ├── domain/              # 实体、值对象
│   │   ├── repository/          # 存储接口（抽象）
│   │   ├── service/             # 业务服务（SignalHub, BillingCron等）
│   │   └── crypto/              # 加密工具（独立模块）
│   ├── infra/                   # 基础设施层（具体实现）
│   │   ├── db/                  # SQLite / LevelDB 实现
│   │   ├── network/             # P2P 网络（Gossip）
│   │   ├── chain/               # Solana 交互
│   │   ├── config/              # 配置管理
│   │   ├── logger/              # 日志
│   │   └── security/            # 密钥管理、数据销毁
│   ├── api/                     # 接口层
│   │   ├── http/                # REST API
│   │   ├── websocket/           # WS 用户端
│   │   └── peer/                # P2P 节点间通信
│   ├── cli/                     # 命令行入口
│   └── container/               # 依赖注入容器
├── tests/
│   ├── unit/                    # 单元测试
│   ├── integration/             # 集成测试
│   └── e2e/                     # 端到端测试
├── scripts/                     # 部署脚本
├── docker/                      # Docker 配置
└── docs/
```

---

## 五、关键技术决策

### 5.1 依赖注入容器

选择 **Tsyringe**（TypeScript 原生，轻量，反射支持好）

原因：
- 核心模块需要解耦，方便测试时 Mock
- Provider/Subscriber/Relay 需要不同的模块组合
- 便于未来替换实现（如从 SQLite 换到 LevelDB）

### 5.2 数据库加密

选择 **应用层 AES-256-GCM 加密**

原因：
- SQLCipher 需要重新编译 SQLite，增加部署复杂度
- 应用层加密更可控，可以按列选择加密粒度
- 密钥可以灵活管理（OS Keychain / TPM / HSM）

方案：
- 敏感字段（wallet_address, billing_records）加密存储
- 密钥由用户在 init 时生成，存入系统 Keychain
- 运行时从 Keychain 读取，内存中解密

### 5.3 Gossip 网络

**短期**：继续自研，但升级到 Ed25519 签名 + X25519 加密
**中期**：引入 libp2p-gossipsub（成熟、有 PeerScore、有 Mesh 优化）
**长期**：如果需要 BFT，引入 HotStuff 或 Tendermint 轻量共识

### 5.4 日志策略

**开发环境**：详细日志，文件存储
**生产环境**：
- 日志分级：ERROR > WARN > INFO（默认）> DEBUG（关闭）
- 敏感信息自动脱敏（钱包地址只显示前4后4位）
- 日志文件 7 天自动销毁（cron 定时删除）
- 内存缓冲写入，减少磁盘 IO

---

## 六、测试策略

### 6.1 测试金字塔

```
        /\
       /  \     E2E (5%)  — 完整节点启动、信号传播
      /----\    
     /      \   Integration (20%) — 模块间交互
    /--------\  
   /          \ Unit (75%) — 业务逻辑、加密、配置
  /____________\
```

### 6.2 核心测试覆盖

| 模块 | 测试重点 | 工具 |
|------|----------|------|
| AuthManager | HMAC/Ed25519 签名验证、重放攻击 | Vitest |
| SignalHub | 信号广播、去重、权限校验 | Vitest |
| BillingCron | 续费扫描、支付匹配、边界条件 | Vitest |
| SettlementEngine | 余额查询、转账构建 | Vitest + Mock Solana RPC |
| PeerNetwork | 节点发现、消息传播、TTL | Vitest + Mock WS |
| 加密模块 | AES 加解密、密钥派生 | Vitest |

---

## 七、安全 Checklist（研发红线）

```
□ 所有敏感数据（密钥、数据库）必须加密
□ 所有网络通信必须加密（TLS/WSS + 应用层加密）
□ 所有用户输入必须校验（防止 SQL 注入、XSS）
□ 所有随机数必须密码学安全（crypto.randomBytes）
□ 日志中不得出现完整密钥、完整钱包地址
□ 进程退出时必须清理内存中的敏感数据
□ 配置文件不得提交到 Git（.gitignore 强制）
□ 生产环境必须关闭 Debug 日志
□ 数据库必须支持"紧急销毁"命令（一键 wipe）
```

---

## 八、交付物

| 交付物 | 说明 | 优先级 |
|--------|------|--------|
| 重构后的代码结构 | core/infra/api/cli 分离 | P0 |
| 单元测试覆盖 | >70% 核心模块 | P0 |
| 配置管理系统 | 环境变量 + 加密配置 | P0 |
| 数据库加密 | AES-256-GCM | P0 |
| 日志脱敏 + 自毁 | 7天自动销毁 | P0 |
| Docker 化 | Dockerfile + Compose | P1 |
| 监控指标 | /metrics 端点 | P1 |
| 灾难恢复脚本 | 备份/恢复/重建 | P1 |
