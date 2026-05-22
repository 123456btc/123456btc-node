/**
 * GossipAdapter — libp2p-gossipsub 实际集成
 *
 * 替换自研 WebSocket Gossip，引入：
 * 1. Mesh 路由优化（gossipsub 内建，TTL-free 泛洪替代）
 * 2. PeerScore 声誉系统（识别/惩罚恶意节点，灰名单隔离）
 * 3. 消息签名与去重（libp2p 内建 signMessages + seq 去重）
 * 4. NAT 穿透（WebSocket transport + bootstrap + identify 协议）
 * 5. 多路复用（yamux）与噪声加密（noise）
 *
 * 向后兼容：
 * - 保留 GossipMessage 接口与 broadcast/createSignalMessage 语义
 * - PeerNetwork 的 WebSocket 层继续用于 peer_announce / 心跳（可选混合模式）
 */

import 'reflect-metadata';
import { singleton } from 'tsyringe';
import { Logger } from '../logger/Logger.js';
import type { Signal } from '../../types/index.js';

export interface GossipMessage {
  type: 'signal' | 'peer_announce' | 'heartbeat';
  payload?: unknown;
  from: string; // nodeId（与 libp2p peerId 解耦，保留业务标识）
  seq: number;
  timestamp: number;
}

export interface GossipAdapterOptions {
  nodeId: string;
  providerId: string;
  port: number;
  role: 'provider' | 'subscriber' | 'relay' | 'peer';
  seeds: string[]; // ws://host:port/peer 格式
  topic?: string;
  p2pPort?: number; // libp2p TCP/WebSocket 监听端口，0 或留空表示随机端口
}

export interface GossipStats {
  seenMessages: number;
  started: boolean;
  peerCount: number;
  meshPeers: number;
  nodeId?: string; // libp2p peerId
}

@singleton()
export class GossipAdapter {
  private node: any = null; // libp2p 节点（运行时动态加载，避免 ESM/CJS 编译耦合）
  private started = false;
  private seq = 0;
  private seen = new Set<string>(); // 业务层去重缓存
  private topic = '123456btc/signals/v1';
  private onMessageHandler?: (msg: GossipMessage) => void;
  private options?: GossipAdapterOptions;
  private libp2pPeerId = '';
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(private logger: Logger) {}

  // ── 启动 libp2p 节点 ──
  async start(options: GossipAdapterOptions, onMessage: (msg: GossipMessage) => void): Promise<void> {
    this.options = options;
    this.onMessageHandler = onMessage;
    this.topic = options.topic || this.topic;

    // 动态导入 ESM 模块（libp2p 为纯 ESM，当前项目为 Node16 混合模块）
    const { createLibp2p } = await import('libp2p');
    const { tcp } = await import('@libp2p/tcp');
    const { webSockets } = await import('@libp2p/websockets');
    const { noise } = await import('@libp2p/noise');
    const { yamux } = await import('@libp2p/yamux');
    const { gossipsub } = await import('@chainsafe/libp2p-gossipsub');
    const { bootstrap } = await import('@libp2p/bootstrap');
    const { identify } = await import('@libp2p/identify');

    // 将 ws://host:port/peer 转换为 multiaddr
    const bootstrapList = options.seeds
      .map((s) => this.urlToMultiaddr(s))
      .filter(Boolean) as string[];

    // PeerScore 参数：识别恶意/垃圾节点
    const scoreParams = {
      topicScoreCap: 100,
      // 主题权重：信号主题权重高
      topics: {
        [this.topic]: {
          topicWeight: 1.0,
          // 第一消息权重（首次投递奖励）
          firstMessageDeliveriesWeight: 1.0,
          firstMessageDeliveriesDecay: 0.9,
          firstMessageDeliveriesCap: 50,
          // 消息投递时间窗口
          timeInMeshWeight: 0.01,
          timeInMeshQuantum: 1,
          timeInMeshCap: 100,
          // 消息失效惩罚
          meshMessageDeliveriesWeight: -1.0,
          meshMessageDeliveriesDecay: 0.9,
          meshMessageDeliveriesCap: 100,
          meshMessageDeliveriesThreshold: 5,
          meshMessageDeliveriesWindow: 10,
          meshFailurePenaltyWeight: -2.0,
          meshFailurePenaltyDecay: 0.9,
          // 无效消息惩罚
          invalidMessageDeliveriesWeight: -10.0,
          invalidMessageDeliveriesDecay: 0.9,
        },
      },
      // 应用层评分（可扩展）
      appSpecificScore: () => 0,
      appSpecificWeight: 1,
      // IP 冲突惩罚
      ipColocationFactorWeight: -5,
      ipColocationFactorThreshold: 3,
      // 行为衰减
      behaviourPenaltyWeight: -10,
      behaviourPenaltyThreshold: 5,
      behaviourPenaltyDecay: 0.9,
      decayInterval: 1000,
      decayToZero: 0.01,
      retainScore: 3600_000, // 1 小时保留历史评分
    };

    const scoreThresholds = {
      gossipThreshold: -10,
      publishThreshold: -50,
      graylistThreshold: -100,
      acceptPXThreshold: 20,
      opportunisticGraftThreshold: 5,
    };

    this.node = await createLibp2p({
      transports: [tcp(), webSockets()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: bootstrapList.length > 0
        ? [bootstrap({ list: bootstrapList, timeout: 3000 })]
        : [],
      services: {
        pubsub: gossipsub({
          emitSelf: false,
          fallbackToFloodsub: false, // 强制 gossipsub，不降级
          floodPublish: true,
          doPX: options.role === 'relay', // Relay 节点允许 peer exchange
          scoreParams: scoreParams as any,
          scoreThresholds: scoreThresholds as any,
          directConnectTicks: 5,
          maxInboundStreams: 64,
          maxOutboundStreams: 128,
        }) as any,
        identify: identify() as any,
      },
      addresses: {
        listen: options.p2pPort && options.p2pPort > 0
          ? [
              `/ip4/0.0.0.0/tcp/${options.p2pPort}`,
              `/ip4/0.0.0.0/tcp/${options.p2pPort}/ws`,
            ]
          : [
              `/ip4/0.0.0.0/tcp/0`, // TCP 随机端口，避免多节点同机冲突
              `/ip4/0.0.0.0/tcp/0/ws`, // WebSocket 随机端口
            ],
      },
      transportManager: {
        faultTolerance: 'NO_FATAL' as any,
      },
      connectionManager: {
        maxConnections: 256,
        maxIncomingPendingConnections: 32,
      },
    });

    this.libp2pPeerId = this.node.peerId.toString();

    // 订阅信号主题
    this.node.services.pubsub.subscribe(this.topic);

    // 消息接收
    this.node.services.pubsub.addEventListener('message', (evt: any) => {
      this.handlePubsubMessage(evt.detail);
    });

    // 连接事件（日志/指标）
    this.node.addEventListener('peer:connect', (evt: any) => {
      this.logger.debug('libp2p peer connected', { peer: evt.detail.toString() });
    });
    this.node.addEventListener('peer:disconnect', (evt: any) => {
      this.logger.debug('libp2p peer disconnected', { peer: evt.detail.toString() });
    });

    await this.node.start();
    this.started = true;

    // 定期清理 seen 去重缓存（每 60 秒清理一次）
    this.cleanupInterval = setInterval(() => { this.seen.clear(); }, 60_000);

    // 获取实际监听地址
    const listenAddrs = this.node.getMultiaddrs?.().map((a: any) => a.toString()) ?? [];

    this.logger.info('GossipAdapter (libp2p-gossipsub) started', {
      nodeId: options.nodeId,
      peerId: this.libp2pPeerId,
      topic: this.topic,
      seeds: bootstrapList.length,
      role: options.role,
      listenAddresses: listenAddrs,
    });
  }

  // ── 停止 ──
  async stop(): Promise<void> {
    this.cleanupInterval && clearInterval(this.cleanupInterval);
    if (this.node) {
      await this.node.stop();
      this.node = null;
    }
    this.started = false;
    this.seen.clear();
    this.logger.info('GossipAdapter stopped');
  }

  // ── 广播消息 ──
  broadcast(msg: GossipMessage): boolean {
    if (!this.started || !this.node) return false;
    const key = `${msg.from}:${msg.seq}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);

    const data = new TextEncoder().encode(JSON.stringify(msg));
    this.node.services.pubsub
      .publish(this.topic, data)
      .then(() => {
        this.logger.debug('GossipAdapter published', { seq: msg.seq, type: msg.type });
      })
      .catch((err: any) => {
        this.logger.warn('GossipAdapter publish failed', { seq: msg.seq, err: err?.message });
      });
    return true;
  }

  // ── 构造信号消息 ──
  createSignalMessage(signal: Signal, nodeId: string): GossipMessage {
    return {
      type: 'signal',
      payload: signal,
      from: nodeId,
      seq: ++this.seq,
      timestamp: Date.now(),
    };
  }

  // ── 统计 ──
  getStats(): GossipStats {
    const meshPeers = this.node?.services?.pubsub?.mesh?.get?.(this.topic)?.size ?? 0;
    return {
      seenMessages: this.seen.size,
      started: this.started,
      peerCount: this.node?.getPeers?.().length ?? 0,
      meshPeers,
      nodeId: this.libp2pPeerId,
    };
  }

  // ── 内部：处理 gossipsub 消息 ──
  private handlePubsubMessage(detail: any) {
    try {
      const data = new TextDecoder().decode(detail.data);
      const msg = JSON.parse(data) as GossipMessage;

      // 业务层去重
      const key = `${msg.from}:${msg.seq}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);

      this.onMessageHandler?.(msg);
    } catch (err) {
      this.logger.warn('Invalid gossipsub message', { err });
    }
  }

  // ── 内部：URL → multiaddr ──
  private urlToMultiaddr(url: string): string | null {
    try {
      const u = new URL(url);
      const host = u.hostname;
      const port = u.port || (u.protocol === 'wss:' ? 443 : 80);
      // ws://host:port/peer → /ip4/host/tcp/port/ws
      // 如果是域名，使用 /dns/host/tcp/port/ws
      const family = host.match(/^(\d{1,3}\.){3}\d{1,3}$/) ? 'ip4' : 'dns';
      return `/${family}/${host}/tcp/${port}/ws`;
    } catch {
      this.logger.warn('Invalid seed URL', { url });
      return null;
    }
  }
}
