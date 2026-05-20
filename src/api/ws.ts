/**
 * WebSocket Handler — 实时信号广播 + 用户认证 + 订阅管理
 */

import { WebSocketServer, type WebSocket, type ServerOptions } from 'ws';
import type { SignalHub } from '../core/SignalHub.js';
import type { SubscriptionStore } from '../core/SubscriptionStore.js';
import type { AuthManager } from '../core/AuthManager.js';
import type { WsMessage } from '../types/index.js';

const MAX_WS_CONNECTIONS = 1000;

export function createWebSocketServer(
  options: ServerOptions,
  hub: SignalHub,
  store: SubscriptionStore,
  auth: AuthManager,
) {
  const wss = new WebSocketServer(options);

  wss.on('connection', (ws, req) => {
    // 连接数限制
    if (wss.clients.size > MAX_WS_CONNECTIONS) {
      console.warn(`[WS] Max connections reached (${MAX_WS_CONNECTIONS}), rejecting ${req.socket.remoteAddress}`);
      ws.close(1013, 'Server overloaded');
      return;
    }

    hub.registerClient(ws);
    console.log(`[WS] Client connected from ${req.socket.remoteAddress} (total: ${wss.clients.size})`);

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString()) as WsMessage;

        switch (msg.type) {
          case 'auth': {
            const { wallet, signature, timestamp } = msg as { wallet: string; signature: string; timestamp: number };
            const error = await hub.authenticateClient(ws, wallet, signature, timestamp);
            if (error) {
              ws.send(JSON.stringify({ type: 'error', message: error }));
              ws.close(1008, 'Auth failed');
            } else {
              ws.send(JSON.stringify({ type: 'auth_success', wallet }));
            }
            break;
          }

          case 'subscribe': {
            const clientMeta = hub.getClientMeta(ws);
            if (!clientMeta?.authenticated) {
              ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
              break;
            }
            const { strategy_id } = msg as { strategy_id: string };
            const error = hub.subscribeClient(ws, strategy_id);
            if (error) {
              ws.send(JSON.stringify({ type: 'error', message: error }));
            } else {
              ws.send(JSON.stringify({ type: 'subscribed', strategy_id }));
            }
            break;
          }

          case 'unsubscribe': {
            const clientMetaUnsub = hub.getClientMeta(ws);
            if (!clientMetaUnsub?.authenticated) {
              ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
              break;
            }
            const { strategy_id } = msg as { strategy_id: string };
            hub.unsubscribeClient(ws, strategy_id);
            ws.send(JSON.stringify({ type: 'unsubscribed', strategy_id }));
            break;
          }

          case 'pong': {
            // 客户端心跳回应
            break;
          }

          default:
            ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
        }
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      }
    });

    ws.on('close', () => {
      hub.removeClient(ws);
      console.log('[WS] Client disconnected');
    });

    ws.on('error', (err) => {
      console.error('[WS] Error:', err);
      hub.removeClient(ws);
    });

    // 发送欢迎消息，要求认证
    ws.send(JSON.stringify({ type: 'auth_required', message: 'Please authenticate with wallet signature' }));
  });

  // 定时 ping
  const pingInterval = setInterval(() => {
    hub.pingClients();
  }, 30_000);

  wss.on('close', () => {
    clearInterval(pingInterval);
  });

  return wss;
}
