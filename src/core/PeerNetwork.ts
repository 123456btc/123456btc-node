/**
 * PeerNetwork — 去中心化节点组网与信号传播
 *
 * 架构演进：
 * - Phase 1: 纯自研 WebSocket Gossip（泛洪、TTL、HMAC 签名）
 * - Phase 2: 混合模式 — libp2p-gossipsub 接管信号传播，WebSocket 保留 peer_announce 兼容层
 * - Phase 3（未来）: 完全 libp2p，WebSocket 仅用于 HTTP API
 *
 * 当前：GossipAdapter (libp2p-gossipsub) 负责 signal 的 Mesh 路由与 PeerScore，
 *       PeerNetwork 保留 WebSocket 连接用于 peer_announce / ping-pong 心跳。
 */

import { WebSocket, WebSocketServer, type RawData } from 'ws';
import http from 'http';
import type { SignalHub } from './SignalHub.js';
import type { Signal } from '../types/index.js';
import { createHmac, timingSafeEqual } from 'crypto';
import { GossipAdapter } from '../infra/network/GossipAdapter.js';

export type NodeRole = 'provider' | 'subscriber' | 'relay' | 'peer';

interface PeerInfo {
  url: string;
  ws: WebSocket;
  role: NodeRole;
  providerId?: string;
  connectedAt: number;
  lastPing: number;
}

interface WsMessage {
  type: 'signal' | 'peer_announce' | 'ping' | 'pong' | 'subscribe_strategy';
  payload?: unknown;
  from: string; // node id
  ttl: number;
  timestamp: number;
  sig: string; // HMAC 签名
}

export class PeerNetwork {
  private peers = new Map<string, PeerInfo>(); // peer url -> PeerInfo
  private seenMessages = new Set<string>(); // 去重
  private wss?: WebSocketServer;
  private nodeId: string;
  private gossipKey: string;
  private announceInterval?: ReturnType<typeof setInterval>;
  private cleanupInterval?: ReturnType<typeof setInterval>;
  private gossipAdapter: GossipAdapter;
  private gossipStarted = false;

  constructor(
    private role: NodeRole,
    private walletAddress: string,
    private port: number,
    private hub: SignalHub,
    private seedPeers: string[] = [],
    gossipAdapter?: GossipAdapter,
    private p2pPort?: number,
  ) {
    this.nodeId = `${walletAddress}_${Date.now().toString(36)}`;
    // 每个节点用自己的钱包地址派生 gossip key
    this.gossipKey = createHmac('sha256', 'gossip-salt-v1').update(walletAddress).digest('hex');
    this.gossipAdapter = gossipAdapter!; // 由调用方注入（DI 或手动传入）
  }


  // ── 启动监听 + 连接种子节点 ──

  async start(server: http.Server) {
    // 1. 启动 libp2p-gossipsub（实际信号传播层）
    if (this.gossipAdapter) {
      await this.gossipAdapter.start(
        {
          nodeId: this.nodeId,
          providerId: this.walletAddress,  // 兼容字段，实际传钱包地址
          port: this.port,
          role: this.role,
          seeds: this.seedPeers,
          p2pPort: this.p2pPort,
        },
        (msg) => this.handleGossipMessage(msg),
      );
      this.gossipStarted = true;
    }

    // 2. 启动 WebSocket 服务，接收其他节点连接（兼容层：peer_announce / ping-pong）
    this.wss = new WebSocketServer({ server, path: '/peer' });
    this.wss.on('connection', (ws, req) => {
      if (this.peers.size >= 100) {
        console.warn(`[PeerNetwork] Max peers reached, rejecting ${req.socket.remoteAddress}`);
        ws.close(1013, 'Max peers reached');
        return;
      }
      this.handleIncomingPeer(ws, req);
    });

    // 3. 主动连接种子节点（WebSocket 兼容层）
    for (const url of this.seedPeers) {
      await this.connectPeer(url);
    }

    // 4. 定时广播存活通告
    this.announceInterval = setInterval(() => this.broadcastAnnounce(), 30_000);

    // 5. 定期清理 seenMessages 去重缓存（每 60 秒清理一次）
    this.cleanupInterval = setInterval(() => { this.seenMessages.clear(); }, 60_000);

    const stats = this.gossipAdapter?.getStats();
    console.log(`[PeerNetwork] Node ${this.nodeId} started as ${this.role}, seeds=${this.seedPeers.length}, libp2p=${stats?.nodeId?.slice(0, 16) || 'n/a'}`);
  }

  async stop() {
    this.announceInterval && clearInterval(this.announceInterval);
    this.cleanupInterval && clearInterval(this.cleanupInterval);
    for (const peer of this.peers.values()) {
      peer.ws.close();
    }
    this.peers.clear();
    this.wss?.close();
    if (this.gossipAdapter && this.gossipStarted) {
      await this.gossipAdapter.stop();
      this.gossipStarted = false;
    }
  }

  // ── 连接远端节点 ──

  private async connectPeer(url: string): Promise<void> {
    if (this.peers.has(url)) return;

    return new Promise((resolve) => {
      try {
        const ws = new WebSocket(url);

        ws.on('open', () => {
          this.peers.set(url, {
            url,
            ws,
            role: 'relay',
            connectedAt: Date.now(),
            lastPing: Date.now(),
          });
          console.log(`[PeerNetwork] Connected to peer: ${url}`);

          // 发送自我介绍
          const announceMsg = {
            type: 'peer_announce' as const,
            payload: { nodeId: this.nodeId, role: this.role, providerId: this.walletAddress, port: this.port },
            from: this.nodeId,
            ttl: 3,
            timestamp: Date.now(),
          };
          this.sendToPeer(url, { ...announceMsg, sig: this.signMessage(announceMsg) });
          resolve();
        });

        ws.on('message', (data) => this.handlePeerMessage(url, data));
        ws.on('close', () => {
          this.peers.delete(url);
          console.log(`[PeerNetwork] Disconnected from peer: ${url}`);
        });
        ws.on('error', (err) => {
          console.error(`[PeerNetwork] Peer error ${url}:`, err.message);
          this.peers.delete(url);
          resolve(); // 即使失败也 resolve，不阻塞启动
        });
      } catch {
        resolve();
      }
    });
  }

  // ── 处理incoming peer连接 ──

  private handleIncomingPeer(ws: WebSocket, _req: http.IncomingMessage) {
    // 先以 ws 对象本身作为临时 key，收到 peer_announce 后再迁移到真实 url
    const tempKey = `ws://${_req.socket.remoteAddress}:${Date.now()}`;

    this.peers.set(tempKey, {
      url: tempKey,
      ws,
      role: 'relay',
      connectedAt: Date.now(),
      lastPing: Date.now(),
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as WsMessage;

        // 如果是 peer_announce，迁移到真实 url
        if (msg.type === 'peer_announce' && msg.payload && typeof msg.payload === 'object') {
          const p = msg.payload as { nodeId: string; role: NodeRole; providerId: string; port: number };
          const realUrl = `ws://${_req.socket.remoteAddress?.replace('::ffff:', '')}:${p.port}/peer`;

          const existing = this.peers.get(tempKey);
          if (existing) {
            this.peers.delete(tempKey);
            this.peers.set(realUrl, { ...existing, url: realUrl, role: p.role, providerId: p.providerId });
          }

          this.handlePeerMessage(realUrl, data);
        } else {
          // 查找该 ws 对应的当前 url
          const entry = Array.from(this.peers.entries()).find(([, v]) => v.ws === ws);
          const url = entry ? entry[1].url : tempKey;
          this.handlePeerMessage(url, data);
        }
      } catch {
        /* ignore invalid msg */
      }
    });

    ws.on('close', () => {
      for (const [url, peer] of this.peers) {
        if (peer.ws === ws) {
          this.peers.delete(url);
        }
      }
    });
  }

  // ── 处理 peer 消息 ──

  private handlePeerMessage(peerUrl: string, data: RawData) {
    try {
      const msg = JSON.parse(data.toString()) as WsMessage;

      // 校验签名（简化：只校验 from 和 type 的 HMAC）
      if (!this.verifySig(msg)) {
        console.warn(`[PeerNetwork] Invalid sig from ${msg.from}`);
        return;
      }

      // 去重
      const msgKey = `${msg.from}_${msg.timestamp}_${msg.type}`;
      if (this.seenMessages.has(msgKey)) return;
      this.seenMessages.add(msgKey);

      switch (msg.type) {
        case 'signal': {
          const payload = msg.payload as Signal & { route?: { hops: string[]; currentHop?: number } };
          // 跳棋路由：如果消息带有 route 字段且尚未到达目标，转发给下一跳
          if (payload?.route && Array.isArray(payload.route.hops)) {
            const { hops, currentHop = 0 } = payload.route;
            if (currentHop < hops.length) {
              const nextHop = hops[currentHop];
              const forwardedPayload = { ...payload, route: { ...payload.route, currentHop: currentHop + 1 } };
              const { sig: _oldSig, ...forwardedBase } = {
                ...msg,
                payload: forwardedPayload,
                timestamp: Date.now(),
              };
              const forwarded: WsMessage = { ...forwardedBase, sig: this.signMessage(forwardedBase) };
              this.sendToPeer(nextHop, forwarded);
              return; // 不本地处理
            }
            // currentHop >= hops.length，到达目标，继续本地处理
          }

          const signal = payload as Signal;
          if (signal && this.role !== 'provider') {
            // Subscriber / Relay 节点收到信号后，本地广播给 WebSocket 客户端
            // 注意：这里不再次写入 SQLite，避免重复存储
            // 实际实现中，Subscriber 节点可能不需要持久化，只转发
            this.hub.rebroadcastSignal(signal);
          }
          // 继续 gossip 传播（ttl > 0）
          if (msg.ttl > 0) {
            this.gossip({ ...msg, ttl: msg.ttl - 1 }, peerUrl);
          }
          break;
        }

        case 'peer_announce': {
          // 已经在上层处理了记录逻辑
          break;
        }

        case 'ping': {
          const peer = this.peers.get(peerUrl);
          if (peer) {
            peer.lastPing = Date.now();
            const pongMsg = {
              type: 'pong' as const,
              from: this.nodeId,
              ttl: 1,
              timestamp: Date.now(),
            };
            this.sendToPeer(peerUrl, { ...pongMsg, sig: this.signMessage(pongMsg) });
          }
          break;
        }

        case 'pong': {
          const peer = this.peers.get(peerUrl);
          if (peer) peer.lastPing = Date.now();
          break;
        }
      }
    } catch {
      /* ignore */
    }
  }

  // ── 通过 libp2p-gossipsub 广播信号（Mesh 路由，TTL-free） ──

  broadcastSignal(signal: Signal) {
    if (this.gossipAdapter && this.gossipStarted) {
      const msg = this.gossipAdapter.createSignalMessage(signal, this.nodeId);
      this.gossipAdapter.broadcast(msg);
    }

    // 保留 WebSocket 兼容广播（允许未升级的旧节点接收）
    const signalMsg = {
      type: 'signal' as const,
      payload: signal,
      from: this.nodeId,
      ttl: 5,
      timestamp: Date.now(),
    };
    const fullMsg: WsMessage = { ...signalMsg, sig: this.signMessage(signalMsg) };
    for (const [url] of this.peers) {
      this.sendToPeer(url, fullMsg);
    }
  }

  /**
   * 通过指定路径发送信号（跳棋模式）
   * 信号经过多个节点中转后到达目标，增加追踪难度
   */
  hopRoute(signal: Signal, hops: string[]): void {
    if (hops.length === 0) return;
    const signalMsg = {
      type: 'signal' as const,
      payload: { ...signal, route: { hops, currentHop: 1 } },
      from: this.nodeId,
      ttl: 5,
      timestamp: Date.now(),
    };
    const msg: WsMessage = { ...signalMsg, sig: this.signMessage(signalMsg) };
    this.sendToPeer(hops[0], msg);
  }

  // ── 处理 gossipsub 接收到的信号 ──
  private handleGossipMessage(msg: import('../infra/network/GossipAdapter.js').GossipMessage) {
    if (msg.type === 'signal') {
      const signal = msg.payload as Signal;
      if (signal && this.role !== 'provider') {
        this.hub.rebroadcastSignal(signal);
      }
    }
  }

  // ── gossip 转发（排除来源 peer） ──

  private gossip(msg: WsMessage, excludeUrl: string) {
    for (const [url] of this.peers) {
      if (url === excludeUrl) continue;
      this.sendToPeer(url, msg);
    }
  }

  private broadcastAnnounce() {
    const announceMsg = {
      type: 'peer_announce' as const,
      payload: { nodeId: this.nodeId, role: this.role, providerId: this.walletAddress, port: this.port },
      from: this.nodeId,
      ttl: 3,
      timestamp: Date.now(),
    };
    const fullMsg: WsMessage = { ...announceMsg, sig: this.signMessage(announceMsg) };

    for (const [url] of this.peers) {
      this.sendToPeer(url, fullMsg);
    }

    // 清理死连接
    const now = Date.now();
    for (const [url, peer] of this.peers) {
      if (now - peer.lastPing > 120_000) {
        peer.ws.close();
        this.peers.delete(url);
      }
    }
  }

  private sendToPeer(url: string, msg: WsMessage) {
    const peer = this.peers.get(url);
    if (peer && peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(JSON.stringify(msg));
    }
  }

  // ── 签名/验签 ──
  // 同一 provider 圈子内所有节点共享 gossipKey，因此可以互验
  // 签名覆盖完整消息内容（from + type + timestamp + payload），防止内容篡改

  private signMessage(msg: Omit<WsMessage, 'sig'>): string {
    const content = `${msg.from}:${msg.type}:${msg.timestamp}:${JSON.stringify(msg.payload || '')}`;
    return createHmac('sha256', this.gossipKey).update(content).digest('hex');
  }

  private verifySig(msg: WsMessage): boolean {
    const content = `${msg.from}:${msg.type}:${msg.timestamp}:${JSON.stringify(msg.payload || '')}`;
    const expected = createHmac('sha256', this.gossipKey).update(content).digest('hex');
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(msg.sig));
    } catch {
      return false;
    }
  }

  getPeerCount(): number {
    const wsPeers = this.peers.size;
    const gossipStats = this.gossipAdapter?.getStats();
    return Math.max(wsPeers, gossipStats?.peerCount ?? 0);
  }
}
