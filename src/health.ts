/**
 * Health check HTTP server — exposes a single GET /health endpoint
 * for liveness checks (systemd, monitoring scripts, etc.).
 *
 * Bound to 127.0.0.1 only (not exposed externally).
 * Default port 18888; override with CTI_HEALTH_PORT.
 * Disable with CTI_HEALTH_DISABLED=true.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface HealthState {
  /** Process start time, used to compute uptime. */
  startedAt: Date;
  /** Returns current WebSocket readyState (1 = OPEN, 0 = CONNECTING, else CLOSED/CLOSING). */
  getWsState: () => number | null;
  /** Whether the feishu client is currently running. */
  isFeishuRunning: () => boolean;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  uptime_seconds: number;
  feishu_running: boolean;
  ws_state: 'OPEN' | 'CONNECTING' | 'CLOSING' | 'CLOSED' | 'UNKNOWN';
  ws_state_code: number | null;
  started_at: string;
}

/** Pure function — testable without a server. */
export function buildHealthResponse(state: HealthState, now: number = Date.now()): HealthResponse {
  const uptime = Math.max(0, Math.floor((now - state.startedAt.getTime()) / 1000));
  const wsStateCode = state.getWsState();
  const isRunning = state.isFeishuRunning();
  const ok = isRunning && wsStateCode === 1;

  let wsLabel: HealthResponse['ws_state'] = 'UNKNOWN';
  if (wsStateCode === 0) wsLabel = 'CONNECTING';
  else if (wsStateCode === 1) wsLabel = 'OPEN';
  else if (wsStateCode === 2) wsLabel = 'CLOSING';
  else if (wsStateCode === 3) wsLabel = 'CLOSED';

  return {
    status: ok ? 'ok' : 'degraded',
    uptime_seconds: uptime,
    feishu_running: isRunning,
    ws_state: wsLabel,
    ws_state_code: wsStateCode,
    started_at: state.startedAt.toISOString(),
  };
}

/** Start an HTTP server on 127.0.0.1:port. Returns the server. */
export function startHealthServer(
  state: HealthState,
  port: number,
  host: string = '127.0.0.1',
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url?.startsWith('/health?'))) {
      const body = buildHealthResponse(state);
      res.writeHead(body.status === 'ok' ? 200 : 503, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(body, null, 2));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found\n');
  });
  server.listen(port, host);
  return server;
}

/** Resolve a free port (used in tests to avoid conflicts). */
export function getListeningPort(server: http.Server): number {
  const addr = server.address() as AddressInfo;
  return addr.port;
}
