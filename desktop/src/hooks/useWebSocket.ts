/**
 * useWebSocket.ts — WebSocket connection manager for desktop sidecar.
 *
 * Connects to the coderix sidecar WebSocket gateway, handles
 * reconnection with exponential backoff, heartbeat, and message
 * routing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore, type ConnectionStatus } from '../stores/chatStore';

const DEFAULT_PORT = 9755;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 15_000;

export interface RpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface GatewayEvent {
  type: string;
  payload?: Record<string, unknown>;
  session_id?: string;
  [key: string]: unknown;
}

export type EventHandler = (event: GatewayEvent) => void;

export function useWebSocket() {
  const [wsPort] = useState(() => DEFAULT_PORT);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const handlersRef = useRef<EventHandler[]>([]);
  const idCounterRef = useRef(1);
  const pendingRequestsRef = useRef<
    Map<number, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }>
  >(new Map());

  const setConnectionStatus = useChatStore((s) => s.setConnectionStatus);

  // ── Connection ──────────────────────────────────────────────────

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setConnectionStatus('connecting');

    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);

    ws.onopen = () => {
      reconnectAttemptRef.current = 0;
      setConnectionStatus('connected');

      // Heartbeat
      pingTimerRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id: 0, method: 'gateway.status', params: {} }));
        }
      }, HEARTBEAT_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);

        // RPC response
        if ('id' in data && 'result' in data) {
          const pending = pendingRequestsRef.current.get(data.id as number);
          if (pending) {
            pending.resolve(data as RpcResponse);
            pendingRequestsRef.current.delete(data.id as number);
          }
          return;
        }

        // RPC error
        if ('id' in data && 'error' in data) {
          const pending = pendingRequestsRef.current.get(data.id as number);
          if (pending) {
            pending.reject(new Error(data.error.message || 'RPC error'));
            pendingRequestsRef.current.delete(data.id as number);
          }
          return;
        }

        // Gateway event
        if (data.type === 'event' && data.event) {
          const gatewayEvent = data.event as GatewayEvent;
          for (const handler of handlersRef.current) {
            handler(gatewayEvent);
          }
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onclose = () => {
      setConnectionStatus('disconnected');
      wsRef.current = null;
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
      // Reconnect with backoff
      const delay = Math.min(
        RECONNECT_BASE_MS * Math.pow(2, reconnectAttemptRef.current),
        RECONNECT_MAX_MS,
      );
      reconnectAttemptRef.current++;
      setConnectionStatus('reconnecting');
      reconnectTimerRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, [setConnectionStatus, wsPort]);

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onclose = null; // Prevent reconnect
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnectionStatus('disconnected');
  }, [setConnectionStatus]);

  // ── Event subscription ──────────────────────────────────────────

  const onEvent = useCallback((handler: EventHandler) => {
    handlersRef.current.push(handler);
    return () => {
      handlersRef.current = handlersRef.current.filter((h) => h !== handler);
    };
  }, []);

  // ── RPC call ────────────────────────────────────────────────────

  const sendRpc = useCallback(
    (method: string, params?: Record<string, unknown>): Promise<RpcResponse> => {
      return new Promise((resolve, reject) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          reject(new Error('WebSocket not connected'));
          return;
        }
        const id = idCounterRef.current++;
        pendingRequestsRef.current.set(id, { resolve, reject });
        wsRef.current.send(
          JSON.stringify({ id, method, params: params ?? {} }),
        );
        // Timeout after 30s
        setTimeout(() => {
          if (pendingRequestsRef.current.has(id)) {
            pendingRequestsRef.current.delete(id);
            reject(new Error(`RPC timeout: ${method}`));
          }
        }, 30_000);
      });
    },
    [],
  );

  // ── Auto-connect on mount ───────────────────────────────────────

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return {
    connect,
    disconnect,
    onEvent,
    sendRpc,
    isConnected: useChatStore((s) => s.connectionStatus === 'connected'),
  };
}
