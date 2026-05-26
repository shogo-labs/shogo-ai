// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Worker Tunnel Client.
 *
 * Maintains presence with Shogo Cloud over outbound HTTPS:
 *   - HTTP heartbeat polling (default 60s) reports status and discovers
 *     when the cloud wants an interactive session (`wsRequested`).
 *   - On `wsRequested`, opens a single on-demand WebSocket for
 *     bidirectional command proxying. The cloud sends `request` frames
 *     containing arbitrary HTTP method/path/headers/body; the worker
 *     forwards them to a local agent-runtime (resolved via the
 *     `RuntimeResolver`) and streams responses back as `stream-chunk` /
 *     `stream-end` / `response` frames.
 *   - WS auto-closes after `WS_IDLE_TIMEOUT_MS`; tunnel falls back to
 *     polling and reopens on the next `wsRequested`.
 *
 * MIT port of apps/api/src/lib/instance-tunnel.ts, restructured as a
 * class so multiple consumers (worker, future tests) can hold their
 * own state. The desktop AGPL copy keeps its module-global form.
 */
import { hostname as osHostname, platform, arch as osArch } from 'node:os';

/**
 * Structured reason returned to the cloud (and ultimately to a Studio
 * client) when {@link RuntimeResolver.resolveLocalUrl} declines to
 * forward a tunneled request. Surfaced verbatim in the 502 body so a
 * future debugger reading the response without log access can tell
 * what happened.
 */
export interface ResolveRejection {
  /** Stable machine-readable identifier (UPPER_SNAKE_CASE). */
  code: string;
  /** Human-readable explanation. Should reference the actual path. */
  message: string;
}

/**
 * Pluggable resolver for the tunnel — provided by whoever owns the local
 * services that the cloud's tunneled requests should be forwarded to.
 *
 * Two known implementations:
 *   - `WorkerRuntimeManager` (this package, MIT) — only resolves /agent/*
 *     to per-project agent-runtime processes; non-agent paths return null.
 *   - apps/api desktop (AGPL) — resolves /agent/* to the desktop's
 *     existing per-project agent-runtime, AND forwards anything else to
 *     the desktop's local apps/api on its `API_PORT`.
 *
 * Both consumers share the WorkerTunnel transport this way without
 * duplicating heartbeat / WS / framing / backoff code.
 */
export interface RuntimeResolver {
  /**
   * Resolve a tunneled path to a local URL the worker should forward
   * the cloud's request to. Return null to make the tunnel reply 502
   * (no local service available for this path).
   *
   * The resolver may start the agent-runtime on demand for /agent/*
   * paths; cold-start latency surfaces to the cloud as request
   * latency, which is the right knob for per-project runtimes.
   */
  resolveLocalUrl(pathWithQuery: string, projectId?: string): Promise<string | null>;

  /** Mint a per-project runtime token for `x-runtime-token`. */
  deriveRuntimeToken(projectId: string): string | null;

  /** Return the project ids the worker currently has runtimes for. */
  getActiveProjects(): string[];

  /** Status snapshot for a single project — used in metadata payloads. */
  status(projectId: string): { status: string; agentPort?: number } | null;

  /**
   * Describe why a path was rejected. Called by the tunnel after a
   * `resolveLocalUrl` returned null so the structured 502 body can
   * carry an actionable code + message. Optional — when absent the
   * tunnel falls back to a generic `NO_LOCAL_RUNTIME` payload.
   */
  describeRejection?(pathWithQuery: string, projectId?: string): ResolveRejection;
}

interface TunnelRequest {
  type: 'request';
  requestId: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  stream?: boolean;
  projectId?: string;
}

interface CancelMessage {
  type: 'cancel';
  requestId: string;
}

type IncomingMessage = TunnelRequest | CancelMessage | { type: 'ping' } | { type: string };

type TunnelWebSocketInit = { headers: Record<string, string> };
type TunnelWebSocketConstructor = new (url: string, init: TunnelWebSocketInit) => WebSocket;

type RuntimeWithBunWebSocketHeaders = typeof globalThis & {
  Bun?: unknown;
  process?: { versions?: { bun?: string } };
};

interface HeartbeatResponse {
  instanceId?: string;
  nextPollIn: number;
  wsRequested: boolean;
  wsUrl?: string;
}

export class TunnelWebSocketHeaderSupportError extends Error {
  code = 'TUNNEL_WS_HEADERS_UNSUPPORTED' as const;
  constructor() {
    super(
      'Tunnel WebSocket auth requires Bun WebSocket header support. ' +
        'This runtime does not advertise Bun, so Authorization headers may be dropped.',
    );
    this.name = 'TunnelWebSocketHeaderSupportError';
  }
}

const DEFAULT_POLL_INTERVAL_S = 60;
const AUTH_FAILURE_BACKOFF_S = 300;
const AUTH_FAILURE_THRESHOLD = 3;
const AUTH_RECOVERY_SUCCESS_THRESHOLD = AUTH_FAILURE_THRESHOLD;
const WS_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

/**
 * Protocol version advertised in heartbeat metadata. Stays lockstep with
 * apps/api/src/lib/instance-tunnel.ts so the cloud can gate features.
 *
 * Version history:
 *   1 — Initial tunnel with chat proxy
 *   2 — Transparent proxy (any HTTP request)
 *   3 — Remote state sync (projects, history routed through tunnel)
 */
export const TUNNEL_PROTOCOL_VERSION = 3;

export interface WorkerTunnelOptions {
  apiKey: string;
  cloudUrl: string;
  /** Friendly machine name reported to the cloud (default: hostname). */
  name?: string;
  /** Override the protocol-version-derived `kind` field on the heartbeat. */
  kind?: string;
  /** Explicit WS URL override (env: SHOGO_TUNNEL_WS_URL). */
  wsUrlOverride?: string;
  resolver: RuntimeResolver;
  /** Optional logger. Defaults to console. */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** Called when the cloud signals a final auth failure (key revoked). */
  onAuthRevoked?: (reason: string) => void;
}

export class WorkerTunnel {
  private readonly opts: WorkerTunnelOptions;
  private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private ws: WebSocket | null = null;
  private wsIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private currentPollInterval = DEFAULT_POLL_INTERVAL_S;
  private wsReconnectAttempt = 0;
  private lastHeartbeatError: string | null = null;
  private consecutiveAuthFailures = 0;
  private consecutiveAuthSuccesses = 0;
  private serverPublishedWsUrl: string | null = null;
  private readonly activeAbortControllers = new Map<string, AbortController>();

  constructor(opts: WorkerTunnelOptions) {
    this.opts = opts;
    this.log = opts.logger ?? console;
  }

  // ─── Public lifecycle ────────────────────────────────────────────

  start(): void {
    if (!this.opts.apiKey) {
      this.log.log('[WorkerTunnel] No API key set, skipping tunnel');
      return;
    }
    this.stopped = false;
    this.wsReconnectAttempt = 0;
    this.currentPollInterval = DEFAULT_POLL_INTERVAL_S;
    this.log.log('[WorkerTunnel] Starting heartbeat polling to Shogo Cloud...');
    void this.heartbeatLoop();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.cleanupWs();
    this.log.log('[WorkerTunnel] Tunnel stopped');
  }

  isConnected(): boolean {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) return true;
    // Polling alone keeps the worker reachable; the WS is on-demand.
    return !this.stopped && !!this.opts.apiKey && this.lastHeartbeatError === null && this.pollTimer !== null;
  }

  // ─── Internals ──────────────────────────────────────────────────

  private getCloudUrl(): string {
    return this.opts.cloudUrl.replace(/\/$/, '');
  }

  private getWsBaseUrl(): string {
    const explicit = (this.opts.wsUrlOverride || process.env.SHOGO_TUNNEL_WS_URL || '').trim();
    if (explicit) return explicit.replace(/\/$/, '');
    if (this.serverPublishedWsUrl) return this.serverPublishedWsUrl.replace(/\/$/, '');
    return this.getCloudUrl().replace(/^http/, 'ws');
  }

  private buildWsUrl(): string {
    return `${this.getWsBaseUrl()}/api/instances/ws`;
  }

  private supportsWebSocketConstructorHeaders(
    runtime: RuntimeWithBunWebSocketHeaders = globalThis as RuntimeWithBunWebSocketHeaders,
  ): boolean {
    return typeof runtime.Bun !== 'undefined' || typeof runtime.process?.versions?.bun === 'string';
  }

  private createTunnelWebSocket(
    url: string,
    init: TunnelWebSocketInit,
    runtime: RuntimeWithBunWebSocketHeaders = globalThis as RuntimeWithBunWebSocketHeaders,
  ): WebSocket {
    if (!this.supportsWebSocketConstructorHeaders(runtime)) {
      throw new TunnelWebSocketHeaderSupportError();
    }
    const Ctor = WebSocket as unknown as TunnelWebSocketConstructor;
    return new Ctor(url, init);
  }

  private getReconnectDelayMs(): number {
    const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, this.wsReconnectAttempt), BACKOFF_MAX_MS);
    const jitter = delay * 0.2 * Math.random();
    return delay + jitter;
  }

  private async collectMetadata(): Promise<Record<string, unknown>> {
    const meta: Record<string, unknown> = {
      hostname: osHostname(),
      os: platform(),
      arch: osArch(),
      uptime: process.uptime(),
      protocolVersion: TUNNEL_PROTOCOL_VERSION,
      tunnelStatus: this.ws?.readyState === WebSocket.OPEN ? 'connected' : 'polling',
      kind: this.opts.kind ?? 'cli-worker',
    };
    try {
      const projectIds = this.opts.resolver.getActiveProjects();
      meta.activeProjects = projectIds.length;
      meta.projects = projectIds.map((projectId) => {
        const s = this.opts.resolver.status(projectId);
        return {
          projectId,
          status: s?.status ?? 'unknown',
          agentPort: s?.agentPort,
        };
      });
    } catch {
      meta.activeProjects = 0;
    }
    return meta;
  }

  // ─── HTTP Heartbeat Loop ────────────────────────────────────────

  private async sendHeartbeat(): Promise<HeartbeatResponse> {
    const cloudUrl = this.getCloudUrl();
    const metadata = await this.collectMetadata();
    const hn = osHostname();
    const name = this.opts.name ?? hn;

    const resp = await fetch(`${cloudUrl}/api/instances/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.opts.apiKey,
        'x-shogo-kind': this.opts.kind ?? 'cli-worker',
      },
      body: JSON.stringify({
        hostname: hn,
        name,
        os: platform(),
        arch: osArch(),
        kind: this.opts.kind ?? 'cli-worker',
        metadata,
      }),
    });

    if (!resp.ok) {
      throw new Error(`Heartbeat failed: HTTP ${resp.status}`);
    }

    const data = (await resp.json()) as HeartbeatResponse;

    if (typeof data.wsUrl === 'string' && data.wsUrl.length > 0) {
      if (data.wsUrl !== this.serverPublishedWsUrl) {
        this.log.log(`[WorkerTunnel] Cloud advertised tunnel WS URL: ${data.wsUrl}`);
      }
      this.serverPublishedWsUrl = data.wsUrl;
    }

    return data;
  }

  private scheduleNextPoll(intervalS?: number): void {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const delay = (intervalS ?? this.currentPollInterval) * 1000;
    this.pollTimer = setTimeout(() => void this.heartbeatLoop(), delay);
  }

  private async heartbeatLoop(): Promise<void> {
    if (this.stopped) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.scheduleNextPoll(this.currentPollInterval);
      return;
    }

    try {
      const result = await this.sendHeartbeat();
      const nextPollIn = result.nextPollIn || DEFAULT_POLL_INTERVAL_S;
      const wasInAuthBackoff = this.consecutiveAuthFailures >= AUTH_FAILURE_THRESHOLD;

      if (wasInAuthBackoff) {
        this.consecutiveAuthSuccesses++;
        if (this.consecutiveAuthSuccesses < AUTH_RECOVERY_SUCCESS_THRESHOLD) {
          this.currentPollInterval = AUTH_FAILURE_BACKOFF_S;
          this.scheduleNextPoll();
          return;
        }
      }

      this.currentPollInterval = nextPollIn;
      if (this.lastHeartbeatError) {
        this.log.log('[WorkerTunnel] Heartbeat recovered');
        this.lastHeartbeatError = null;
      }
      this.consecutiveAuthFailures = 0;
      this.consecutiveAuthSuccesses = 0;

      if (result.wsRequested && !this.ws) {
        this.log.log('[WorkerTunnel] Cloud requested WebSocket — connecting...');
        this.connectWs();
        return;
      }
    } catch (err: any) {
      const message = err?.message ?? String(err);
      const isAuthFailure = /HTTP 40[13]\b/.test(message);
      if (isAuthFailure) {
        this.consecutiveAuthFailures++;
        this.consecutiveAuthSuccesses = 0;
      } else {
        this.consecutiveAuthFailures = 0;
        this.consecutiveAuthSuccesses = 0;
      }
      if (message !== this.lastHeartbeatError) {
        this.log.error(`[WorkerTunnel] Heartbeat error: ${message}`);
        this.lastHeartbeatError = message;
      }
      if (this.consecutiveAuthFailures >= AUTH_FAILURE_THRESHOLD) {
        const reason = `tunnel saw ${this.consecutiveAuthFailures} consecutive auth failures from Shogo Cloud`;
        try {
          this.opts.onAuthRevoked?.(reason);
        } catch (cbErr: any) {
          this.log.warn(`[WorkerTunnel] onAuthRevoked threw: ${cbErr?.message ?? cbErr}`);
        }
        if (this.currentPollInterval !== AUTH_FAILURE_BACKOFF_S) {
          this.log.warn(
            `[WorkerTunnel] ${this.consecutiveAuthFailures} consecutive auth failures \u2014 ` +
              `backing off to ${AUTH_FAILURE_BACKOFF_S}s. Re-authenticate with \`shogo login\`.`,
          );
        }
        this.currentPollInterval = AUTH_FAILURE_BACKOFF_S;
      } else {
        this.currentPollInterval = DEFAULT_POLL_INTERVAL_S;
      }
    }

    this.scheduleNextPoll();
  }

  // ─── On-demand WebSocket ────────────────────────────────────────

  private async handleRequest(msg: TunnelRequest): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.resetWsIdleTimer();

    const controller = new AbortController();
    this.activeAbortControllers.set(msg.requestId, controller);

    try {
      const url = await this.resolveLocalUrl(msg.path, msg.projectId);
      if (!url) {
        // Structured 502 body so future debuggers reading the response
        // (without access to worker logs) can tell what happened. The
        // resolver provides the code/message; the tunnel always echoes
        // back the original path so the operator doesn't have to
        // correlate request-ids to figure out which fetch failed.
        const rejection: ResolveRejection = this.opts.resolver.describeRejection
          ? this.opts.resolver.describeRejection(msg.path, msg.projectId)
          : { code: 'NO_LOCAL_RUNTIME', message: `no local runtime available for path: ${msg.path}` };
        this.sendFrame({
          type: 'response',
          requestId: msg.requestId,
          status: 502,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            code: rejection.code,
            message: rejection.message,
            path: msg.path,
          }),
        });
        return;
      }

      const headers: Record<string, string> = { ...(msg.headers ?? {}) };

      if (msg.projectId && (msg.path.startsWith('/agent/') || msg.path === '/agent')) {
        const token = this.opts.resolver.deriveRuntimeToken(msg.projectId);
        if (token) headers['x-runtime-token'] = token;
      }

      const init: RequestInit = {
        method: msg.method,
        headers,
        signal: controller.signal,
      };
      if (msg.body && msg.method !== 'GET' && msg.method !== 'HEAD') {
        init.body = msg.body;
      }

      const resp = await fetch(url, init);

      if (msg.stream) {
        const reader = resp.body?.getReader();
        if (!reader) {
          this.sendFrame({
            type: 'stream-error',
            requestId: msg.requestId,
            error: 'No response body for stream',
          });
          return;
        }
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (this.ws?.readyState !== WebSocket.OPEN) break;
            this.sendFrame({
              type: 'stream-chunk',
              requestId: msg.requestId,
              data: decoder.decode(value, { stream: true }),
            });
          }
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.sendFrame({ type: 'stream-end', requestId: msg.requestId });
          }
        } catch (err: any) {
          if (err?.name !== 'AbortError' && this.ws?.readyState === WebSocket.OPEN) {
            this.sendFrame({
              type: 'stream-error',
              requestId: msg.requestId,
              error: err?.message ?? String(err),
            });
          }
        }
      } else {
        const body = await resp.text();
        const respHeaders: Record<string, string> = {};
        resp.headers.forEach((v, k) => { respHeaders[k] = v; });
        this.sendFrame({
          type: 'response',
          requestId: msg.requestId,
          status: resp.status,
          headers: respHeaders,
          body,
        });
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const payload = msg.stream
        ? { type: 'stream-error' as const, requestId: msg.requestId, error: err?.message ?? String(err) }
        : {
            type: 'response' as const,
            requestId: msg.requestId,
            status: 502,
            body: JSON.stringify({ error: err?.message ?? String(err) }),
          };
      this.sendFrame(payload);
    } finally {
      this.activeAbortControllers.delete(msg.requestId);
    }
  }

  /**
   * Path → local URL via the injected resolver. The tunnel itself has
   * no opinion about which paths route where; that's the resolver's
   * job (see `RuntimeResolver`).
   */
  private async resolveLocalUrl(pathWithQuery: string, projectId?: string): Promise<string | null> {
    return this.opts.resolver.resolveLocalUrl(pathWithQuery, projectId);
  }

  private sendFrame(frame: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err: any) {
      this.log.warn(`[WorkerTunnel] Frame send failed: ${err?.message ?? err}`);
    }
  }

  private resetWsIdleTimer(): void {
    if (this.wsIdleTimer) clearTimeout(this.wsIdleTimer);
    this.wsIdleTimer = setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.log.log('[WorkerTunnel] WebSocket idle timeout — closing, returning to polling');
        try { this.ws.close(1000, 'Idle timeout'); } catch { /* already gone */ }
      }
    }, WS_IDLE_TIMEOUT_MS);
  }

  private startWsHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(async () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        const metadata = await this.collectMetadata();
        this.sendFrame({ type: 'heartbeat', metadata });
      } catch { /* heartbeat is best-effort */ }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private connectWs(): void {
    if (this.stopped || this.ws) return;

    const url = this.buildWsUrl();
    const hn = osHostname();
    const os = platform();
    const arch = osArch();
    const name = this.opts.name ?? hn;

    this.log.log(`[WorkerTunnel] Opening WebSocket to ${url} (hostname=${hn})`);

    const wsInit: TunnelWebSocketInit = {
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'x-shogo-hostname': hn,
        'x-shogo-name': name,
        'x-shogo-os': os,
        'x-shogo-arch': arch,
        'x-shogo-kind': this.opts.kind ?? 'cli-worker',
      },
    };

    let socket: WebSocket;
    try {
      socket = this.createTunnelWebSocket(url, wsInit);
    } catch (err: any) {
      this.log.error(`[WorkerTunnel] WebSocket creation failed: ${err?.message ?? err}`);
      this.ws = null;
      this.scheduleNextPoll(5);
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.log.log('[WorkerTunnel] WebSocket connected — session active');
      this.wsReconnectAttempt = 0;
      this.startWsHeartbeat();
      this.resetWsIdleTimer();
    };

    socket.onmessage = (event) => {
      let msg: IncomingMessage;
      try {
        const raw = typeof event.data === 'string' ? event.data : (event.data as any).toString();
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === 'ping') {
        this.sendFrame({ type: 'pong' });
        this.resetWsIdleTimer();
        return;
      }
      if (msg.type === 'cancel') {
        const controller = this.activeAbortControllers.get((msg as CancelMessage).requestId);
        if (controller) controller.abort();
        return;
      }
      if (msg.type === 'request') {
        void this.handleRequest(msg as TunnelRequest).catch((err) => {
          this.log.error(`[WorkerTunnel] Error handling request: ${err?.message ?? err}`);
        });
        return;
      }
      // Unknown message types ignored for forward-compat.
    };

    socket.onclose = (event: { code: number; reason?: string }) => {
      this.log.log(`[WorkerTunnel] WebSocket closed: code=${event.code} reason=${event.reason || 'none'}`);
      this.cleanupWs();
      if (this.stopped) return;
      if (event.code === 1000 || event.code === 4000) {
        this.scheduleNextPoll(this.currentPollInterval);
      } else {
        this.wsReconnectAttempt++;
        const delay = this.getReconnectDelayMs();
        this.log.log(
          `[WorkerTunnel] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.wsReconnectAttempt})`,
        );
        this.scheduleNextPoll(Math.ceil(delay / 1000));
      }
    };

    socket.onerror = (event: { message?: string }) => {
      this.log.error('[WorkerTunnel] WebSocket error:', event?.message ?? 'unknown');
    };
  }

  private cleanupWs(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.wsIdleTimer) {
      clearTimeout(this.wsIdleTimer);
      this.wsIdleTimer = null;
    }
    for (const [, controller] of this.activeAbortControllers) {
      try { controller.abort(); } catch { /* nothing to do */ }
    }
    this.activeAbortControllers.clear();
    this.ws = null;
  }

  /**
   * Test-only access to internals. Returned as a fresh object that closes
   * over `this` so getters reflect live state without needing to re-bind.
   */
  _testing() {
    const self = this;
    return {
      sendHeartbeat: () => self.sendHeartbeat(),
      heartbeatLoop: () => self.heartbeatLoop(),
      connectWs: () => self.connectWs(),
      cleanupWs: () => self.cleanupWs(),
      handleRequest: (msg: TunnelRequest) => self.handleRequest(msg),
      installFakeWs: (fake: WebSocket) => {
        self.ws = fake;
      },
      getCloudUrl: () => self.getCloudUrl(),
      getWsBaseUrl: () => self.getWsBaseUrl(),
      buildWsUrl: () => self.buildWsUrl(),
      getReconnectDelayMs: () => self.getReconnectDelayMs(),
      supportsWebSocketConstructorHeaders: (runtime?: RuntimeWithBunWebSocketHeaders) =>
        self.supportsWebSocketConstructorHeaders(runtime),
      createTunnelWebSocket: (
        url: string,
        init: TunnelWebSocketInit,
        runtime?: RuntimeWithBunWebSocketHeaders,
      ) => self.createTunnelWebSocket(url, init, runtime),
      DEFAULT_POLL_INTERVAL_S,
      BACKOFF_BASE_MS,
      BACKOFF_MAX_MS,
      TUNNEL_PROTOCOL_VERSION,
      get currentPollInterval() { return self.currentPollInterval; },
      set currentPollInterval(v: number) { self.currentPollInterval = v; },
      get wsReconnectAttempt() { return self.wsReconnectAttempt; },
      set wsReconnectAttempt(v: number) { self.wsReconnectAttempt = v; },
      get ws() { return self.ws; },
      get stopped() { return self.stopped; },
      get serverPublishedWsUrl() { return self.serverPublishedWsUrl; },
      set serverPublishedWsUrl(v: string | null) { self.serverPublishedWsUrl = v; },
    };
  }
}
