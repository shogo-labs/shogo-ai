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
 *   - WS auto-closes after `WS_IDLE_TIMEOUT_MS`; the tunnel falls back to
 *     polling (a graceful close), and an abnormal close reconnects the WS
 *     itself with backoff (SHO-506) instead of waiting for a wake that the
 *     cloud already cleared when this tunnel connected.
 *   - A live socket is replaced before it can be taken away from under a
 *     stream (SHO-565): on a `drain` frame from a pod that is shutting down,
 *     or on the socket's own max-age timer, the replacement socket is opened
 *     first and the old one is closed only once the cloud has confirmed the
 *     new one owns the machine (`ready`). In-flight requests finish on the
 *     socket that carried them; new ones use the replacement.
 *
 * MIT port of apps/api/src/lib/instance-tunnel.ts, restructured as a
 * class so multiple consumers (worker, future tests) can hold their
 * own state. The desktop AGPL copy keeps its module-global form.
 */
import { hostname as osHostname, platform, arch as osArch } from 'node:os';
import { workerUserAgent } from './user-agent.ts';
import { getOrCreateDeviceId } from './device-id.ts';

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
 * Cache key for a resolve rejection. The target is part of the key: the same
 * path can be answered by a different runtime per workspace, so keying on the
 * path alone would hand one workspace's `RUNTIME_STARTING` to another.
 */
export function rejectionKey(
  pathWithQuery: string,
  projectId?: string,
  workspaceId?: string,
): string {
  return `${pathWithQuery}|${projectId ?? ''}|${workspaceId ?? ''}`;
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
  resolveLocalUrl(
    pathWithQuery: string,
    projectId?: string,
    workspaceId?: string,
  ): Promise<string | null>;

  /** Mint the `x-runtime-token` the local runtime serving `projectId` accepts. */
  deriveRuntimeToken(projectId: string): string | null | Promise<string | null>;

  /**
   * Mint the `x-runtime-token` for a workspace-targeted request (a chat in a
   * workspace that has no project of its own — the personal companion, or a
   * paired desktop's own workspace). Same token the desktop's local
   * `/api/workspaces/:id/agent-proxy` route hands its runtime.
   */
  deriveWorkspaceRuntimeToken?(workspaceId: string): string | null | Promise<string | null>;

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
  describeRejection?(
    pathWithQuery: string,
    projectId?: string,
    workspaceId?: string,
  ): ResolveRejection | Promise<ResolveRejection>;

  /**
   * Refresh whatever the synchronous calls above read from.
   *
   * The tunnel runs on its own thread (SHO-185 §5), and `getActiveProjects()` /
   * `status()` are synchronous per heartbeat — so a resolver that cannot answer
   * those from its own memory (a bridged one asks the main thread) refreshes in
   * one awaited round trip here, before the heartbeat that reads them.
   */
  refresh?(): Promise<void>;

  /**
   * Owner-gated snapshot of this machine's own workspaces (ids, names,
   * counts — never transcripts). Carried on every heartbeat so the cloud
   * can list a machine's workspaces, and show its last-known state while
   * it is offline, without persisting anything machine-specific.
   */
  machineSnapshot?(): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
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
  /**
   * From `/api/workspaces/:id/agent-proxy/...` before path normalization. A
   * workspace chat has no project of its own, so this is the only target the
   * desktop gets — without it it fell back to *whichever* runtime was running
   * and that runtime answered 401 (SHO-526).
   */
  workspaceId?: string;
  /**
   * Response body encodings the cloud can decode. Absent (an older cloud) means
   * text frames only, exactly as before; `['base64']` lets a binary body cross
   * the tunnel without a lossy UTF-8 round trip.
   */
  acceptBodyEncoding?: string[];
}

interface CancelMessage {
  type: 'cancel';
  requestId: string;
}

/**
 * The pod that just took ownership of this machine (SHO-565).
 *
 * Sent after the api pod has written the Redis ownership key, so a replacement
 * socket is only promoted — and the old one only retired — once the cloud
 * really routes new requests to it.
 */
interface TunnelReadyMessage {
  type: 'ready';
  podId?: string;
}

/**
 * "This pod is going away — replace the socket before I close it" (SHO-565).
 *
 * Sent from a pod's SIGTERM handler. The worker opens the replacement first, so
 * the turn in flight is never cut; `graceMs` is how long the pod expects to
 * live, which is only used for logging.
 */
interface TunnelDrainMessage {
  type: 'drain';
  graceMs?: number;
}

type IncomingMessage =
  | TunnelRequest
  | CancelMessage
  | TunnelReadyMessage
  | TunnelDrainMessage
  | { type: 'ping' }
  | { type: string };

type TunnelWebSocketInit = { headers: Record<string, string> };
type TunnelWebSocketConstructor = new (url: string, init: TunnelWebSocketInit) => WebSocket;

type RuntimeWithBunWebSocketHeaders = typeof globalThis & {
  Bun?: unknown;
  process?: { versions?: { bun?: string; node?: string } };
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
      'Tunnel WebSocket auth requires a runtime with WebSocket header support (Bun or Node >= 21). ' +
        'Current runtime does not support WebSocket constructor headers.',
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
 * How many times an abnormal close reconnects straight away before the tunnel
 * gives up and goes back to heartbeat polling (SHO-506).
 *
 * Reconnecting needs nothing from the cloud: the WS route authenticates on the
 * device key it is handed, so a drop (an ingress timeout, a dropped network) is
 * a blip rather than a dead tunnel. The cap keeps a genuinely broken path — a
 * revoked key, a wrong URL — from retrying forever instead of polling.
 */
const WS_RECONNECT_MAX_ATTEMPTS = 5;

/**
 * How long one socket may serve before the worker replaces it (SHO-565).
 *
 * A socket that lives forever is one Knative rollout, node drain or ingress
 * timeout away from cutting a stream mid-turn. Replacing it on our own schedule
 * — with the replacement open before the old one closes — keeps every cut on
 * the worker's terms. Kept under `WS_IDLE_TIMEOUT_MS` so rotation always
 * happens while a socket is still healthy.
 */
const WS_MAX_AGE_MS = 25 * 60 * 1000;
/** Spread rotations of many desktops over a window instead of one instant. */
const WS_MAX_AGE_JITTER_MS = 3 * 60 * 1000;
/**
 * Promote a replacement that the cloud never confirmed with `ready`.
 *
 * An older cloud has no `ready` frame, and its `open` handler already wrote the
 * ownership key, so promote anyway rather than stranding the replacement. Short
 * enough that rotation still happens well before the old socket is at risk.
 */
const WS_ROTATE_READY_FALLBACK_MS = 5_000;
/**
 * Pause before opening a replacement after a `drain`.
 *
 * A terminating pod stays in its Service's endpoint list for a moment, so an
 * immediate reconnect can land right back on it. Waiting gives the endpoint
 * update time to land; the drained socket keeps serving meanwhile.
 */
const WS_ROTATE_RETRY_MS = 5_000;
/**
 * How long a replaced socket may keep running the requests it already carries
 * before it is closed anyway. A stream that never ends must not pin the socket
 * (and the pod behind it) forever.
 */
const WS_DRAIN_GRACE_MS = 2 * 60 * 1000;

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

/**
 * Largest raw response body one non-stream frame may carry.
 *
 * A frame is JSON over the cloud's WebSocket, which Bun caps at 16 MiB
 * (`maxPayloadLength` default). Base64 inflates by 4/3, so a body over ~11 MiB
 * cannot fit even before the envelope. Over the cap the worker answers a
 * structured 502 instead of sending a frame that closes the socket — the socket
 * drop used to take the whole tunnel down for one oversized MP4 (SHO-526).
 */
export const TUNNEL_MAX_FRAME_BODY_BYTES = 11 * 1024 * 1024;

/**
 * Whether a response body is text that survives a UTF-8 frame.
 *
 * A missing content-type counts as binary: guessing wrong on text is a garbled
 * string, guessing wrong on a JPEG is a corrupt image, and only the latter is
 * unrecoverable.
 */
export function isTextualContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (!type) return false;
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type.endsWith('+json') ||
    type === 'application/xml' ||
    type.endsWith('+xml') ||
    type === 'application/javascript' ||
    type === 'application/x-javascript' ||
    type === 'application/x-www-form-urlencoded' ||
    type === 'application/event-stream' ||
    type === 'text/event-stream'
  );
}


export interface WorkerTunnelOptions {
  apiKey: string;
  cloudUrl: string;
  /** Friendly machine name reported to the cloud (default: hostname). */
  name?: string;
  /**
   * Stable per-machine id (`~/.shogo/device-id` by default). The cloud keys a
   * machine on this rather than on `hostname`: macOS renames the host per
   * network, and a hostname-keyed row forked one machine into two (SHO-276).
   */
  deviceId?: string;
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
  /** Last time this WS carried anything (open, ping, request) — the idle window's start. */
  private wsLastActiveAt: number | null = null;
  /** A replacement socket opened but not yet promoted over {@link ws} (SHO-565). */
  private wsPending: WebSocket | null = null;
  /**
   * Sockets that have been replaced but are still finishing the requests they
   * carried, mapped to the deadline timer that closes them anyway.
   */
  private wsRetired = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  /** Requests each socket is currently carrying — a retired socket closes at zero. */
  private wsInflight = new Map<WebSocket, number>();
  private wsMaxAgeTimer: ReturnType<typeof setTimeout> | null = null;
  private wsRotateDelayTimer: ReturnType<typeof setTimeout> | null = null;
  private wsReadyTimer: ReturnType<typeof setTimeout> | null = null;
  /** The rotation a delay is holding back (also lets a test run it at once). */
  private wsRotateDelayFn: (() => void) | null = null;
  private rotating = false;
  private lastHeartbeatError: string | null = null;
  private consecutiveAuthFailures = 0;
  private consecutiveAuthSuccesses = 0;
  private serverPublishedWsUrl: string | null = null;
  /**
   * The cloud `instances` row id the last heartbeat reported. The machine copy
   * (SHO-185) pushes under it, and it only exists once the cloud has answered a
   * heartbeat, so it is read from there rather than assumed.
   */
  private lastInstanceId: string | null = null;
  private readonly activeAbortControllers = new Map<string, AbortController>();

  constructor(opts: WorkerTunnelOptions) {
    this.opts = opts;
    this.log = opts.logger ?? console;
  }

  /** The cloud instance id for this machine, or null before the first heartbeat. */
  get instanceId(): string | null {
    return this.lastInstanceId;
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
    const pending = this.wsPending;
    this.cleanupWs();
    // A replacement socket nobody watches would linger; the live one is left to
    // the host, and the retired ones are closed by `cleanupWs`.
    if (pending) {
      try { pending.close(1000, 'Tunnel stopped'); } catch { /* already gone */ }
    }
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

  /**
   * The device id this machine reports, read once.
   *
   * A machine keeps its cloud row across a hostname change because of this id
   * (SHO-276). `~/.shogo/device-id` is the same value `shogo login` sends, so a
   * desktop and a worker on one box agree; a failure to read it is not fatal —
   * the cloud then falls back to hostname, exactly as before.
   */
  private deviceIdValue: string | null = null;
  private get deviceId(): string {
    if (this.deviceIdValue !== null) return this.deviceIdValue;
    let value = (this.opts.deviceId ?? '').trim();
    if (!value) {
      try {
        value = getOrCreateDeviceId();
      } catch {
        value = '';
      }
    }
    this.deviceIdValue = value;
    return value;
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
    if (typeof runtime.Bun !== 'undefined' || typeof runtime.process?.versions?.bun === 'string') return true;
    // Node 21+ ships WebSocket (via undici) with header support in the constructor.
    // Detect by checking for Node >= 21 (the version that made WebSocket a global).
    const nodeVersion = runtime.process?.versions?.node;
    if (nodeVersion) {
      const major = parseInt(nodeVersion.split('.')[0] ?? '0', 10);
      if (major >= 21) return true;
    }
    return false;
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
    // One awaited round trip for everything read synchronously below, so the
    // heartbeat carries this cycle's runtimes rather than the last thread's.
    try {
      await this.opts.resolver.refresh?.();
    } catch {
      // A stale snapshot is better than no heartbeat at all.
    }
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
    try {
      const machine = await this.opts.resolver.machineSnapshot?.();
      if (machine) meta.machine = machine;
    } catch {
      // Best-effort: a stale snapshot is better than no heartbeat at all.
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
        'User-Agent': workerUserAgent(),
        'x-api-key': this.opts.apiKey,
        'x-shogo-kind': this.opts.kind ?? 'cli-worker',
        ...(this.deviceId ? { 'x-shogo-device-id': this.deviceId } : {}),
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

    if (typeof data.instanceId === 'string' && data.instanceId.length > 0) {
      this.lastInstanceId = data.instanceId;
    }

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

  /**
   * Retry the WebSocket itself, without waiting for the cloud to ask for it.
   *
   * A heartbeat-then-poll would work only if the cloud still had a pending
   * `wsRequestedAt`, and it clears that on connect — so this opens the WS directly.
   * Once the attempts are spent (or the idle window has passed) it goes back to
   * the heartbeat loop, which is the pre-SHO-506 behaviour.
   */
  private scheduleWsReconnect(delayMs: number): void {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (this.stopped || this.ws) return;
      if (!this.shouldReconnectWs()) {
        void this.heartbeatLoop();
        return;
      }
      this.connectWs();
    }, delayMs);
  }

  /**
   * Whether another direct WS attempt is worth it: inside the idle window this
   * tunnel was opened in, and under the attempt cap.
   */
  private shouldReconnectWs(): boolean {
    if (this.wsReconnectAttempt > WS_RECONNECT_MAX_ATTEMPTS) return false;
    if (this.wsLastActiveAt === null) return false;
    return Date.now() - this.wsLastActiveAt < WS_IDLE_TIMEOUT_MS;
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

  private async handleRequest(msg: TunnelRequest, socket: WebSocket | null = this.ws): Promise<void> {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (socket === this.ws) this.resetWsIdleTimer();
    this.wsInflight.set(socket, (this.wsInflight.get(socket) ?? 0) + 1);

    const controller = new AbortController();
    this.activeAbortControllers.set(msg.requestId, controller);

    try {
      const url = await this.resolveLocalUrl(msg.path, msg.projectId, msg.workspaceId);
      if (!url) {
        // Structured 502 body so future debuggers reading the response
        // (without access to worker logs) can tell what happened. The
        // resolver provides the code/message; the tunnel always echoes
        // back the original path so the operator doesn't have to
        // correlate request-ids to figure out which fetch failed.
        const rejection: ResolveRejection = this.opts.resolver.describeRejection
          ? await this.opts.resolver.describeRejection(msg.path, msg.projectId, msg.workspaceId)
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
        }, socket);
        return;
      }

      const headers: Record<string, string> = { ...(msg.headers ?? {}) };

      if (msg.path.startsWith('/agent/') || msg.path === '/agent') {
        if (msg.projectId) {
          const token = await this.opts.resolver.deriveRuntimeToken(msg.projectId);
          if (token) headers['x-runtime-token'] = token;
        } else if (msg.workspaceId) {
          const token = await this.opts.resolver.deriveWorkspaceRuntimeToken?.(msg.workspaceId);
          if (token) headers['x-runtime-token'] = token;
        }
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
          }, socket);
          return;
        }
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (socket.readyState !== WebSocket.OPEN) break;
            this.sendFrame({
              type: 'stream-chunk',
              requestId: msg.requestId,
              data: decoder.decode(value, { stream: true }),
            }, socket);
          }
          if (socket.readyState === WebSocket.OPEN) {
            this.sendFrame({ type: 'stream-end', requestId: msg.requestId }, socket);
          }
        } catch (err: any) {
          if (err?.name !== 'AbortError' && socket.readyState === WebSocket.OPEN) {
            this.sendFrame({
              type: 'stream-error',
              requestId: msg.requestId,
              error: err?.message ?? String(err),
            }, socket);
          }
        }
      } else {
        const acceptsBase64 = Array.isArray(msg.acceptBodyEncoding) && msg.acceptBodyEncoding.includes('base64');
        const binary = acceptsBase64 && !isTextualContentType(resp.headers.get('content-type'));
        const declared = Number(resp.headers.get('content-length') ?? '');
        if (acceptsBase64 && Number.isFinite(declared) && declared > TUNNEL_MAX_FRAME_BODY_BYTES) {
          this.sendTooLarge(msg, declared, socket);
          return;
        }
        const bytes = new Uint8Array(await resp.arrayBuffer());
        if (acceptsBase64 && bytes.byteLength > TUNNEL_MAX_FRAME_BODY_BYTES) {
          this.sendTooLarge(msg, bytes.byteLength, socket);
          return;
        }
        const respHeaders: Record<string, string> = {};
        resp.headers.forEach((v, k) => { respHeaders[k] = v; });
        // `fetch` has already decompressed the body, so the framed length and
        // encoding describe bytes the cloud no longer holds. Drop both and let
        // its Response set the length from what it actually writes.
        delete respHeaders['content-length'];
        delete respHeaders['content-encoding'];
        this.sendFrame({
          type: 'response',
          requestId: msg.requestId,
          status: resp.status,
          headers: respHeaders,
          body: binary ? Buffer.from(bytes).toString('base64') : new TextDecoder().decode(bytes),
          ...(binary ? { bodyEncoding: 'base64' } : {}),
        }, socket);
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      if (socket.readyState !== WebSocket.OPEN) return;
      const payload = msg.stream
        ? { type: 'stream-error' as const, requestId: msg.requestId, error: err?.message ?? String(err) }
        : {
            type: 'response' as const,
            requestId: msg.requestId,
            status: 502,
            body: JSON.stringify({ error: err?.message ?? String(err) }),
          };
      this.sendFrame(payload, socket);
    } finally {
      this.activeAbortControllers.delete(msg.requestId);
      this.releaseRequest(socket);
    }
  }

  /**
   * One request finished on `socket`. A socket that has been replaced closes as
   * soon as the last one it carries is done, so a turn in flight is never cut
   * but the old socket does not outlive its work either.
   */
  private releaseRequest(socket: WebSocket): void {
    const left = (this.wsInflight.get(socket) ?? 1) - 1;
    if (left > 0) {
      this.wsInflight.set(socket, left);
      return;
    }
    this.wsInflight.delete(socket);
    if (this.wsRetired.has(socket)) this.closeRetiredSocket(socket, 'its last request finished');
  }

  /**
   * Path → local URL via the injected resolver. The tunnel itself has
   * no opinion about which paths route where; that's the resolver's
   * job (see `RuntimeResolver`).
   */
  private async resolveLocalUrl(
    pathWithQuery: string,
    projectId?: string,
    workspaceId?: string,
  ): Promise<string | null> {
    return this.opts.resolver.resolveLocalUrl(pathWithQuery, projectId, workspaceId);
  }

  /**
   * Refuse a body that cannot fit one frame, as a normal 502 the cloud can
   * read — never as a frame that makes the cloud close the socket.
   */
  private sendTooLarge(msg: TunnelRequest, size: number, socket: WebSocket | null = this.ws): void {
    this.sendFrame({
      type: 'response',
      requestId: msg.requestId,
      status: 502,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'TUNNEL_BODY_TOO_LARGE',
        size,
        limit: TUNNEL_MAX_FRAME_BODY_BYTES,
        path: msg.path,
      }),
    }, socket);
  }

  private sendFrame(frame: Record<string, unknown>, socket: WebSocket | null = this.ws): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch (err: any) {
      this.log.warn(`[WorkerTunnel] Frame send failed: ${err?.message ?? err}`);
    }
  }

  private resetWsIdleTimer(): void {
    this.wsLastActiveAt = Date.now();
    this.armWsIdleTimer(WS_IDLE_TIMEOUT_MS);
  }

  /**
   * Arm the idle window on the *activity* clock, not the socket's: rotation
   * replaces the socket but changes nothing about whether this machine is idle.
   */
  private armWsIdleTimer(ms: number): void {
    if (this.wsIdleTimer) clearTimeout(this.wsIdleTimer);
    this.wsIdleTimer = setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.log.log('[WorkerTunnel] WebSocket idle timeout — closing, returning to polling');
        try { this.ws.close(1000, 'Idle timeout'); } catch { /* already gone */ }
      }
    }, ms);
  }

  private rearmWsIdleTimer(): void {
    if (this.wsLastActiveAt === null) {
      this.resetWsIdleTimer();
      return;
    }
    const remaining = Math.max(1_000, WS_IDLE_TIMEOUT_MS - (Date.now() - this.wsLastActiveAt));
    this.armWsIdleTimer(remaining);
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

  private wsInit(): TunnelWebSocketInit {
    const hn = osHostname();
    return {
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'User-Agent': workerUserAgent(),
        'x-shogo-hostname': hn,
        'x-shogo-name': this.opts.name ?? hn,
        'x-shogo-os': platform(),
        'x-shogo-arch': osArch(),
        'x-shogo-kind': this.opts.kind ?? 'cli-worker',
        ...(this.deviceId ? { 'x-shogo-device-id': this.deviceId } : {}),
      },
    };
  }

  /**
   * Create and wire one socket. Nothing here makes it the live tunnel: the
   * caller decides whether it becomes active immediately (`connectWs`) or only
   * after the cloud confirms it (`maybeRotate` → `ready`).
   */
  private openSocket(): WebSocket | null {
    const url = this.buildWsUrl();
    this.log.log(`[WorkerTunnel] Opening WebSocket to ${url} (hostname=${osHostname()})`);

    let socket: WebSocket;
    try {
      socket = this.createTunnelWebSocket(url, this.wsInit());
    } catch (err: any) {
      this.log.error(`[WorkerTunnel] WebSocket creation failed: ${err?.message ?? err}`);
      return null;
    }

    socket.onopen = () => {
      if (this.ws === socket) {
        this.log.log('[WorkerTunnel] WebSocket connected — session active');
        this.onSocketActive();
        return;
      }
      this.log.log('[WorkerTunnel] Replacement WebSocket open — waiting for the cloud to confirm ownership');
      // An older cloud never sends `ready` (its `open` handler already wrote the
      // ownership key), so promote after a short wait instead of stranding it.
      if (this.wsReadyTimer) clearTimeout(this.wsReadyTimer);
      this.wsReadyTimer = setTimeout(() => this.confirmSocket(socket, 'no ready frame'), WS_ROTATE_READY_FALLBACK_MS);
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
        this.sendFrame({ type: 'pong' }, socket);
        if (socket === this.ws) this.resetWsIdleTimer();
        return;
      }
      if (msg.type === 'ready') {
        this.confirmSocket(socket, 'server confirmed ownership');
        return;
      }
      if (msg.type === 'drain') {
        this.onServerDrain(socket, msg as TunnelDrainMessage);
        return;
      }
      if (msg.type === 'cancel') {
        const controller = this.activeAbortControllers.get((msg as CancelMessage).requestId);
        if (controller) controller.abort();
        return;
      }
      if (msg.type === 'request') {
        void this.handleRequest(msg as TunnelRequest, socket).catch((err) => {
          this.log.error(`[WorkerTunnel] Error handling request: ${err?.message ?? err}`);
        });
        return;
      }
      // Unknown message types ignored for forward-compat.
    };

    socket.onclose = (event: { code: number; reason?: string }) => {
      this.log.log(`[WorkerTunnel] WebSocket closed: code=${event.code} reason=${event.reason || 'none'}`);

      if (this.ws !== socket) {
        // A replacement that never became live, or a socket that was replaced:
        // the tunnel itself is unaffected, so there is nothing to reconnect.
        const wasPending = this.wsPending === socket;
        const timer = this.wsRetired.get(socket);
        if (timer) clearTimeout(timer);
        this.wsRetired.delete(socket);
        this.wsInflight.delete(socket);
        if (wasPending) {
          this.wsPending = null;
          this.rotating = false;
          this.clearReadyTimer();
          if (!this.stopped) {
            this.log.log('[WorkerTunnel] Replacement socket closed before it was confirmed — keeping the current tunnel');
            this.scheduleRotationRetry();
          }
        }
        return;
      }

      this.cleanupWs();
      if (this.stopped) return;
      if (event.code === 1000 || event.code === 4000) {
        this.scheduleNextPoll(this.currentPollInterval);
        return;
      }
      // An abnormal close (1006 is an ingress or network kill: no close frame).
      // The cloud cleared `wsRequestedAt` when this tunnel connected, so waiting
      // for a new wake means waiting forever — the old code polled, saw
      // `wsRequested: false`, and left the tunnel down until something else woke
      // it (SHO-506). Reconnect the WS itself, with the same backoff.
      this.wsReconnectAttempt++;
      if (!this.shouldReconnectWs()) {
        this.log.log('[WorkerTunnel] Not reconnecting the WebSocket — falling back to polling');
        this.scheduleNextPoll();
        return;
      }
      const delay = this.getReconnectDelayMs();
      this.log.log(
        `[WorkerTunnel] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.wsReconnectAttempt})`,
      );
      this.scheduleWsReconnect(delay);
    };

    socket.onerror = (event: { message?: string }) => {
      this.log.error('[WorkerTunnel] WebSocket error:', event?.message ?? 'unknown');
    };

    return socket;
  }

  private connectWs(): void {
    if (this.stopped || this.ws) return;
    const socket = this.openSocket();
    if (!socket) {
      this.ws = null;
      this.scheduleNextPoll(5);
      return;
    }
    // The first socket is live as soon as it opens: there is nothing to replace,
    // and waiting for `ready` would strand this tunnel against an older cloud.
    this.ws = socket;
  }

  /** The socket the cloud now routes to is open: start its timers. */
  private onSocketActive(): void {
    this.wsReconnectAttempt = 0;
    this.startWsHeartbeat();
    this.rearmWsIdleTimer();
    this.armMaxAgeTimer();
  }

  /**
   * Replace the live socket with a new one, in that order (SHO-565).
   *
   * The replacement is opened while the current socket keeps serving, and the
   * current one is only retired once the cloud says the new one owns this
   * machine — so no turn is ever cut by the swap.
   */
  private maybeRotate(reason: string, delayMs = 0): void {
    if (this.stopped || this.rotating || this.wsPending) return;
    const current = this.ws;
    if (!current || current.readyState !== WebSocket.OPEN) return;

    this.rotating = true;
    const open = () => {
      if (this.wsRotateDelayTimer) clearTimeout(this.wsRotateDelayTimer);
      this.wsRotateDelayTimer = null;
      this.wsRotateDelayFn = null;
      if (this.stopped) {
        this.rotating = false;
        return;
      }
      const active = this.ws;
      if (!active || active.readyState !== WebSocket.OPEN) {
        // Nothing left to hand over from: the normal close path owns recovery.
        this.rotating = false;
        return;
      }
      this.log.log(`[WorkerTunnel] Rotating the tunnel (${reason}) — opening the replacement first`);
      const socket = this.openSocket();
      if (!socket) {
        this.rotating = false;
        this.log.warn('[WorkerTunnel] Could not open a replacement tunnel — keeping the current socket');
        this.scheduleRotationRetry();
        return;
      }
      this.wsPending = socket;
      this.clearReadyTimer();
      this.wsReadyTimer = setTimeout(() => this.confirmSocket(socket, 'no ready frame'), WS_ROTATE_READY_FALLBACK_MS);
    };

    if (delayMs > 0) {
      if (this.wsRotateDelayTimer) clearTimeout(this.wsRotateDelayTimer);
      this.wsRotateDelayFn = open;
      this.wsRotateDelayTimer = setTimeout(open, delayMs);
      return;
    }
    open();
  }

  /**
   * Promote a replacement over the live socket and retire the old one.
   *
   * Called on the cloud's `ready` (ownership is in Redis, so new requests
   * really do land on the new socket) or after {@link WS_ROTATE_READY_FALLBACK_MS}
   * for a cloud too old to send it.
   */
  private confirmSocket(socket: WebSocket, why: string): void {
    if (this.wsPending !== socket) return;
    if (socket.readyState !== WebSocket.OPEN) return;
    this.wsPending = null;
    this.rotating = false;
    this.clearReadyTimer();

    const previous = this.ws;
    this.ws = socket;
    this.log.log(`[WorkerTunnel] Replacement WebSocket is live (${why}) — retiring the previous socket`);
    this.onSocketActive();
    if (previous && previous !== socket) this.retireSocket(previous);
  }

  /**
   * Stop using a socket for new requests without closing it: whatever it is
   * already carrying finishes there, then it closes.
   */
  private retireSocket(socket: WebSocket): void {
    const inflight = this.wsInflight.get(socket) ?? 0;
    if (inflight > 0) {
      const timer = setTimeout(
        () => this.closeRetiredSocket(socket, `${WS_DRAIN_GRACE_MS / 1000}s grace expired`),
        WS_DRAIN_GRACE_MS,
      );
      this.wsRetired.set(socket, timer);
      this.log.log(`[WorkerTunnel] Keeping the previous socket for ${inflight} in-flight request(s)`);
      return;
    }
    this.closeRetiredSocket(socket, 'nothing in flight');
  }

  private closeRetiredSocket(socket: WebSocket, why: string): void {
    const timer = this.wsRetired.get(socket);
    if (timer) clearTimeout(timer);
    this.wsRetired.delete(socket);
    this.wsInflight.delete(socket);
    try {
      socket.close(1000, 'Rotated');
    } catch {
      // Already gone; nothing to close.
    }
    this.log.log(`[WorkerTunnel] Previous socket closed (${why})`);
  }

  /** A pod is shutting down: move the tunnel off it before it goes. */
  private onServerDrain(socket: WebSocket, frame: TunnelDrainMessage): void {
    const graceS = Math.round((frame.graceMs ?? 0) / 1000);
    if (this.wsPending === socket) {
      // The replacement landed on a pod that is going away too. Drop it, keep
      // serving on the current socket, and try again once the terminating pod
      // has left its Service's endpoints.
      this.wsPending = null;
      this.rotating = false;
      this.clearReadyTimer();
      try {
        socket.close(1000, 'Pod draining');
      } catch {
        // Already gone.
      }
      this.log.log('[WorkerTunnel] Replacement pod is draining — retrying the rotation');
      this.scheduleRotationRetry();
      return;
    }
    if (this.ws === socket) {
      this.log.log(
        `[WorkerTunnel] Cloud pod is draining${graceS > 0 ? ` (${graceS}s grace)` : ''} — rotating the tunnel`,
      );
      this.maybeRotate('server drain', WS_ROTATE_RETRY_MS + Math.floor(Math.random() * 1_000));
    }
  }

  private scheduleRotationRetry(): void {
    if (this.stopped) return;
    if (this.wsRotateDelayTimer) clearTimeout(this.wsRotateDelayTimer);
    const delay = WS_ROTATE_RETRY_MS + Math.floor(Math.random() * 1_000);
    const retry = () => {
      this.wsRotateDelayTimer = null;
      this.wsRotateDelayFn = null;
      this.maybeRotate('drain retry');
    };
    this.wsRotateDelayFn = retry;
    this.wsRotateDelayTimer = setTimeout(retry, delay);
  }

  private armMaxAgeTimer(): void {
    if (this.wsMaxAgeTimer) clearTimeout(this.wsMaxAgeTimer);
    const jitter = Math.floor(Math.random() * WS_MAX_AGE_JITTER_MS);
    this.wsMaxAgeTimer = setTimeout(
      () => this.maybeRotate('max age'),
      WS_MAX_AGE_MS + jitter,
    );
  }

  private clearReadyTimer(): void {
    if (this.wsReadyTimer) {
      clearTimeout(this.wsReadyTimer);
      this.wsReadyTimer = null;
    }
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
    for (const timer of [this.wsMaxAgeTimer, this.wsRotateDelayTimer, this.wsReadyTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.wsMaxAgeTimer = null;
    this.wsRotateDelayTimer = null;
    this.wsRotateDelayFn = null;
    this.wsReadyTimer = null;
    for (const [, controller] of this.activeAbortControllers) {
      try { controller.abort(); } catch { /* nothing to do */ }
    }
    this.activeAbortControllers.clear();
    // A replaced socket has nobody waiting on it: close it now rather than let
    // it outlive the tunnel it belonged to.
    for (const socket of [...this.wsRetired.keys()]) {
      this.closeRetiredSocket(socket, 'tunnel torn down');
    }
    this.wsRetired.clear();
    this.wsInflight.clear();
    this.wsPending = null;
    this.rotating = false;
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
      scheduleWsReconnect: (delayMs: number) => self.scheduleWsReconnect(delayMs),
      shouldReconnectWs: () => self.shouldReconnectWs(),
      cleanupWs: () => self.cleanupWs(),
      handleRequest: (msg: TunnelRequest, socket?: WebSocket | null) => self.handleRequest(msg, socket),
      installFakeWs: (fake: WebSocket) => {
        self.ws = fake;
      },
      installPendingWs: (fake: WebSocket | null) => {
        self.wsPending = fake;
      },
      maybeRotate: (reason: string, delayMs?: number) => self.maybeRotate(reason, delayMs),
      /** Run a rotation that a delay is holding back, without waiting it out. */
      flushRotationDelay: () => {
        const fn = self.wsRotateDelayFn;
        if (self.wsRotateDelayTimer) clearTimeout(self.wsRotateDelayTimer);
        self.wsRotateDelayTimer = null;
        self.wsRotateDelayFn = null;
        fn?.();
      },
      get rotateDelayPending() { return self.wsRotateDelayFn !== null; },
      confirmSocket: (socket: WebSocket) => self.confirmSocket(socket, 'test'),
      retireSocket: (socket: WebSocket) => self.retireSocket(socket),
      onServerDrain: (socket: WebSocket, graceMs?: number) =>
        self.onServerDrain(socket, { type: 'drain', graceMs }),
      closeRetiredSocket: (socket: WebSocket) => self.closeRetiredSocket(socket, 'test'),
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
      WS_RECONNECT_MAX_ATTEMPTS,
      WS_MAX_AGE_MS,
      WS_MAX_AGE_JITTER_MS,
      WS_ROTATE_READY_FALLBACK_MS,
      WS_ROTATE_RETRY_MS,
      WS_DRAIN_GRACE_MS,
      TUNNEL_PROTOCOL_VERSION,
      armMaxAgeTimer: () => self.armMaxAgeTimer(),
      openSocket: () => self.openSocket(),
      get currentPollInterval() { return self.currentPollInterval; },
      set currentPollInterval(v: number) { self.currentPollInterval = v; },
      get wsReconnectAttempt() { return self.wsReconnectAttempt; },
      set wsReconnectAttempt(v: number) { self.wsReconnectAttempt = v; },
      get wsLastActiveAt() { return self.wsLastActiveAt; },
      set wsLastActiveAt(v: number | null) { self.wsLastActiveAt = v; },
      get ws() { return self.ws; },
      get wsPending() { return self.wsPending; },
      get rotating() { return self.rotating; },
      get wsRetired() { return self.wsRetired; },
      get wsInflight() { return self.wsInflight; },
      get maxAgeTimer() { return self.wsMaxAgeTimer; },
      get stopped() { return self.stopped; },
      get serverPublishedWsUrl() { return self.serverPublishedWsUrl; },
      set serverPublishedWsUrl(v: string | null) { self.serverPublishedWsUrl = v; },
    };
  }
}
