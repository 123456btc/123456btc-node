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
import { createHmac } from 'crypto';
import { GossipAdapter } from '../infra/network/GossipAdapter.js';

export type NodeRole = 'provider' | 'subscriber' | 'relay';

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
  private gossipAdapter: GossipAdapter;
  private gossipStarted = false;

  constructor(
    private role: NodeRole,
    private providerId: string,
    private port: number,
    private hub: SignalHub,
    private seedPeers: string[] = [],
    gossipAdapter?: GossipAdapter,
  ) {
    this.nodeId = `${role}_${providerId}_${Date.now().toString(36)}`;
    // 同一 provider 圈子内的所有节点共享同一个 gossip key，用于互验签名
    this.gossipKey = createHmac('sha256', 'gossip-salt-v1').update(providerId).digest('hex');
    this.gossipAdapter = gossipAdapter!; // 由调用方注入（DI 或手动传入）
  }


  // ── 启动监听 + 连接种子节点 ──

  async start(server: http.Server) {
    // 1. 启动 libp2p-gossipsub（实际信号传播层）
    if (this.gossipAdapter) {
      await this.gossipAdapter.start(
        {
          nodeId: this.nodeId,
          providerId: this.providerId,
          port: this.port,
          role: this.role,
          seeds: this.seedPeers,
        },
        (msg) => this.handleGossipMessage(msg),
      );
      this.gossipStarted = true;
    }

    // 2. 启动 WebSocket 服务，接收其他节点连接（兼容层：peer_announce / ping-pong）
    this.wss = new WebSocketServer({ server, path: '/peer' });
    this.wss.on('connection', (ws, req) => {
      this.handleIncomingPeer(ws, req);
    });

    // 3. 主动连接种子节点（WebSocket 兼容层）
    for (const url of this.seedPeers) {
      await this.connectPeer(url);
    }

    // 4. 定时广播存活通告
    this.announceInterval = setInterval(() => this.broadcastAnnounce(), 30_000);

    const stats = this.gossipAdapter?.getStats();
    console.log(`[PeerNetwork] Node ${this.nodeId} started as ${this.role}, seeds=${this.seedPeers.length}, libp2p=${stats?.nodeId?.slice(0, 16) || 'n/a'}`);
  }

  async stop() {
    this.announceInterval && clearInterval(this.announceInterval);
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
          this.sendToPeer(url, {
            type: 'peer_announce',
            payload: { nodeId: this.nodeId, role: this.role, providerId: this.providerId, port: this.port },
            from: this.nodeId,
            ttl: 3,
            timestamp: Date.now(),
            sig: this.sign(),
          });
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

      // 清理旧去重缓存（保留最近 10000 条）
      if (this.seenMessages.size > 10000) {
        const iter = this.seenMessages.values();
        for (let i = 0; i < 1000; i++) {
          const val = iter.next().value;
          if (val) this.seenMessages.delete(val);
        }
      }

      switch (msg.type) {
        case 'signal': {
          const signal = msg.payload as Signal;
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
            this.sendToPeer(peerUrl, {
              type: 'pong',
              from: this.nodeId,
              ttl: 1,
              timestamp: Date.now(),
              sig: this.sign(),
            });
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
    const msg: WsMessage = {
      type: 'signal',
      payload: signal,
      from: this.nodeId,
      ttl: 5,
      timestamp: Date.now(),
      sig: this.sign(),
    };
    for (const [url] of this.peers) {
      this.sendToPeer(url, msg);
    }
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
    const msg: WsMessage = {
      type: 'peer_announce',
      payload: { nodeId: this.nodeId, role: this.role, providerId: this.providerId, port: this.port },
      from: this.nodeId,
      ttl: 3,
      timestamp: Date.now(),
      sig: this.sign(),
    };

    for (const [url] of this.peers) {
      this.sendToPeer(url, msg);
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

  private sign(): string {
    return createHmac('sha256', this.gossipKey).update(this.nodeId).digest('hex');
  }

  private verifySig(msg: WsMessage): boolean {
    const expected = createHmac('sha256', this.gossipKey).update(msg.from).digest('hex');
    try {
      return expected === msg.sig;
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
