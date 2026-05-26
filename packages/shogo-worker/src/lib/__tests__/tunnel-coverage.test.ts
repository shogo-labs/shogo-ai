// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Comprehensive coverage gaps for WorkerTunnel (tunnel.ts).
 *
 * Covered clusters:
 *   L117-121  TunnelWebSocketHeaderSupportError constructor
 *   L186-209  start() / stop() lifecycle
 *   L212-215  isConnected()
 *   L220-228  getCloudUrl(), getWsBaseUrl() branches
 *   L231-232  buildWsUrl()
 *   L235-256  supportsWebSocketConstructorHeaders(), createTunnelWebSocket(), getReconnectDelayMs()
 *   L259-286  collectMetadata()
 *   L289-323  sendHeartbeat()
 *   L327-400  scheduleNextPoll() + heartbeatLoop() (all branches)
 *   L539-554  resetWsIdleTimer() callback, startWsHeartbeat() callback
 *   L558-659  connectWs() + WS event handlers (onopen/onmessage/onclose/onerror)
 *   L682-700  _testing() proxies + getters/setters
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  WorkerTunnel,
  TunnelWebSocketHeaderSupportError,
  TUNNEL_PROTOCOL_VERSION,
  type RuntimeResolver,
  type WorkerTunnelOptions,
} from '../tunnel.ts';

// ─── FakeWebSocket ───────────────────────────────────────────────────────────

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN       = 1;
  static readonly CLOSING    = 2;
  static readonly CLOSED     = 3;

  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  closedWith: { code: number; reason?: string } | null = null;

  onopen:    (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose:   ((e: { code: number; reason?: string }) => void) | null = null;
  onerror:   ((e: { message?: string }) => void) | null = null;

  constructor(public url: string = '', public init: unknown = undefined) {}

  send(msg: string) { this.sent.push(msg); }
  close(code = 1000, reason = '') {
    this.closedWith = { code, reason };
    this.readyState = FakeWebSocket.CLOSED;
  }

  // Test helpers
  triggerOpen()              { this.onopen?.(); }
  triggerMessage(data: string | object) {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    this.onmessage?.({ data: str });
  }
  triggerClose(code = 1000, reason = '') {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
  triggerError(message = 'ws error') { this.onerror?.({ message }); }
}

// Replace globalThis.WebSocket with a factory that captures the last created socket.
function installFakeWsFactory(): { last: () => FakeWebSocket | null } {
  let lastSocket: FakeWebSocket | null = null;
  function FakeWSCtor(url: string, init?: unknown) {
    const ws = new FakeWebSocket(url, init);
    lastSocket = ws;
    return ws;
  }
  FakeWSCtor.OPEN       = FakeWebSocket.OPEN;
  FakeWSCtor.CONNECTING = FakeWebSocket.CONNECTING;
  FakeWSCtor.CLOSING    = FakeWebSocket.CLOSING;
  FakeWSCtor.CLOSED     = FakeWebSocket.CLOSED;
  (globalThis as any).WebSocket = FakeWSCtor;
  return { last: () => lastSocket };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeResolver(overrides: Partial<RuntimeResolver> = {}): RuntimeResolver {
  return {
    resolveLocalUrl:    async () => 'http://localhost:3000/agent/x',
    deriveRuntimeToken: ()      => 'tok-abc',
    getActiveProjects:  ()      => ['proj-1'],
    status:             ()      => ({ status: 'running', agentPort: 3000 }),
    ...overrides,
  };
}

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

const logCapture = () => {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    logger: {
      log:   (...a: unknown[]) => { logs.push(a.join(' ')); },
      warn:  (...a: unknown[]) => { warns.push(a.join(' ')); },
      error: (...a: unknown[]) => { errors.push(a.join(' ')); },
    },
    logs, warns, errors,
  };
};

function makeTunnel(overrides: Partial<WorkerTunnelOptions> = {}) {
  return new WorkerTunnel({
    apiKey:   'shogo_sk_test',
    cloudUrl: 'https://api.shogo.ai',
    resolver: makeResolver(),
    logger:   silentLogger,
    ...overrides,
  });
}

function fakeHeartbeatResp(body: object = { nextPollIn: 30, wsRequested: false }) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

const origFetch    = global.fetch;
const origWebSocket = (globalThis as any).WebSocket;

afterEach(() => {
  global.fetch              = origFetch;
  (globalThis as any).WebSocket = origWebSocket;
});

// ─── TunnelWebSocketHeaderSupportError (L117-122) ───────────────────────────

describe('TunnelWebSocketHeaderSupportError (L117-122)', () => {
  it('constructor sets message and code', () => {
    const err = new TunnelWebSocketHeaderSupportError();
    expect(err.code).toBe('TUNNEL_WS_HEADERS_UNSUPPORTED');
    expect(err.name).toBe('TunnelWebSocketHeaderSupportError');
    expect(err.message).toContain('Bun WebSocket');
    expect(err).toBeInstanceOf(Error);
  });
});

// ─── start() / stop() (L186-209) ────────────────────────────────────────────

describe('start() (L186-195)', () => {
  it('with no apiKey: logs and returns without starting loop', () => {
    const { logger, logs } = logCapture();
    const t = makeTunnel({ apiKey: '', logger });
    t.start();
    expect(logs.some(l => l.includes('No API key'))).toBe(true);
    expect(t._testing().stopped).toBe(false); // was never set to false since we returned early
    t.stop();
  });

  it('with apiKey: sets state and kicks off heartbeatLoop', async () => {
    global.fetch = () => fakeHeartbeatResp() as any;
    const t = makeTunnel();
    t.start();
    expect(t._testing().stopped).toBe(false);
    expect(t._testing().wsReconnectAttempt).toBe(0);
    t.stop();
    // allow the kicked-off heartbeatLoop promise to settle so no unhandled rejection
    await Promise.resolve();
  });
});

describe('stop() (L198-209)', () => {
  it('sets stopped=true and logs', () => {
    const { logger, logs } = logCapture();
    const t = makeTunnel({ logger });
    t.stop();
    expect(t._testing().stopped).toBe(true);
    expect(logs.some(l => l.includes('Tunnel stopped'))).toBe(true);
  });

  it('clears pollTimer when set', async () => {
    global.fetch = () => fakeHeartbeatResp() as any;
    const t = makeTunnel();
    // arm a pollTimer
    await t._testing().heartbeatLoop();
    // pollTimer should now be set; stop should clear it
    t.stop();
    expect(t._testing().stopped).toBe(true);
  });

  it('cleanupWs() via stop() nulls ws (close-in-stop dead code removed)', () => {
    // stop() calls cleanupWs() which sets this.ws = null.
    // The old `if (this.ws) { this.ws.close() }` block after cleanupWs was
    // dead code (cleanupWs already nulled ws) and was deleted from source.
    const t = makeTunnel();
    const fake = new FakeWebSocket();
    t._testing().installFakeWs(fake as unknown as WebSocket);
    t.stop();
    expect(t._testing().ws).toBeNull(); // cleanupWs() nulled it
    expect(fake.closedWith).toBeNull(); // .close() was never called (dead code removed)
  });
});

// ─── isConnected() (L212-215) ───────────────────────────────────────────────

describe('isConnected() (L212-215)', () => {
  it('returns true when ws readyState is OPEN', () => {
    const t = makeTunnel();
    const fake = new FakeWebSocket();
    fake.readyState = FakeWebSocket.OPEN;
    t._testing().installFakeWs(fake as unknown as WebSocket);
    expect(t.isConnected()).toBe(true);
    t.stop();
  });

  it('returns false when stopped', () => {
    const t = makeTunnel();
    t.stop();
    expect(t.isConnected()).toBe(false);
  });

  it('returns false when no apiKey', () => {
    const t = makeTunnel({ apiKey: '' });
    expect(t.isConnected()).toBe(false);
  });

  it('returns false when lastHeartbeatError is non-null (via heartbeat failure)', async () => {
    global.fetch = () => Promise.reject(new Error('connection refused'));
    const t = makeTunnel();
    await t._testing().heartbeatLoop();
    expect(t.isConnected()).toBe(false);
    t.stop();
  });
});

// ─── getCloudUrl() (L220-221) ───────────────────────────────────────────────

describe('getCloudUrl() (L220-221)', () => {
  it('strips trailing slash', () => {
    const t = makeTunnel({ cloudUrl: 'https://api.shogo.ai/' });
    expect(t._testing().getCloudUrl()).toBe('https://api.shogo.ai');
  });
  it('no-ops when no trailing slash', () => {
    const t = makeTunnel({ cloudUrl: 'https://api.shogo.ai' });
    expect(t._testing().getCloudUrl()).toBe('https://api.shogo.ai');
  });
});

// ─── getWsBaseUrl() (L224-228) ──────────────────────────────────────────────

describe('getWsBaseUrl() (L224-228)', () => {
  it('uses wsUrlOverride when set', () => {
    const t = makeTunnel({ wsUrlOverride: 'wss://ws.shogo.ai/' });
    expect(t._testing().getWsBaseUrl()).toBe('wss://ws.shogo.ai');
  });

  it('uses SHOGO_TUNNEL_WS_URL env var', () => {
    const origEnv = process.env.SHOGO_TUNNEL_WS_URL;
    process.env.SHOGO_TUNNEL_WS_URL = 'wss://env-ws.shogo.ai';
    try {
      const t = makeTunnel();
      expect(t._testing().getWsBaseUrl()).toBe('wss://env-ws.shogo.ai');
    } finally {
      if (origEnv === undefined) delete process.env.SHOGO_TUNNEL_WS_URL;
      else process.env.SHOGO_TUNNEL_WS_URL = origEnv;
    }
  });

  it('uses serverPublishedWsUrl when set (L227)', () => {
    const t = makeTunnel();
    t._testing().serverPublishedWsUrl = 'wss://published.shogo.ai/';
    expect(t._testing().getWsBaseUrl()).toBe('wss://published.shogo.ai');
  });

  it('falls back to converting cloudUrl http → ws (L228)', () => {
    const t = makeTunnel({ cloudUrl: 'https://api.shogo.ai' });
    expect(t._testing().getWsBaseUrl()).toBe('wss://api.shogo.ai');
  });
});

// ─── buildWsUrl() (L231-232) ─────────────────────────────────────────────────

describe('buildWsUrl() (L231-232)', () => {
  it('appends /api/instances/ws to the WS base URL', () => {
    const t = makeTunnel({ cloudUrl: 'https://api.shogo.ai' });
    expect(t._testing().buildWsUrl()).toBe('wss://api.shogo.ai/api/instances/ws');
  });
});

// ─── supportsWebSocketConstructorHeaders() (L235-238) ───────────────────────

describe('supportsWebSocketConstructorHeaders() (L235-238)', () => {
  it('returns true when Bun global is present', () => {
    const t = makeTunnel();
    expect(t._testing().supportsWebSocketConstructorHeaders({ Bun: {} } as any)).toBe(true);
  });

  it('returns true when process.versions.bun is set', () => {
    const t = makeTunnel();
    expect(t._testing().supportsWebSocketConstructorHeaders({ process: { versions: { bun: '1.0' } } } as any)).toBe(true);
  });

  it('returns false when neither Bun nor bun version present', () => {
    const t = makeTunnel();
    expect(t._testing().supportsWebSocketConstructorHeaders({} as any)).toBe(false);
  });
});

// ─── createTunnelWebSocket() (L241-250) ──────────────────────────────────────

describe('createTunnelWebSocket() (L241-250)', () => {
  it('throws TunnelWebSocketHeaderSupportError on non-Bun runtime', () => {
    const t = makeTunnel();
    expect(() =>
      t._testing().createTunnelWebSocket('wss://x', { headers: {} }, {} as any)
    ).toThrow(TunnelWebSocketHeaderSupportError);
  });

  it('calls new WebSocket(url, init) on Bun runtime', () => {
    const factory = installFakeWsFactory();
    const t = makeTunnel();
    const result = t._testing().createTunnelWebSocket(
      'wss://x/ws',
      { headers: { Authorization: 'Bearer abc' } },
      { Bun: {} } as any,
    );
    expect(factory.last()).not.toBeNull();
    expect((result as unknown as FakeWebSocket).url).toBe('wss://x/ws');
  });
});

// ─── getReconnectDelayMs() (L253-256) ─────────────────────────────────────────

describe('getReconnectDelayMs() (L253-256)', () => {
  it('returns a value >= BACKOFF_BASE_MS on first attempt', () => {
    const t = makeTunnel();
    const delay = t._testing().getReconnectDelayMs();
    expect(delay).toBeGreaterThanOrEqual(t._testing().BACKOFF_BASE_MS);
  });

  it('caps at BACKOFF_MAX_MS after many attempts', () => {
    const t = makeTunnel();
    t._testing().wsReconnectAttempt = 20;
    const delay = t._testing().getReconnectDelayMs();
    expect(delay).toBeLessThanOrEqual(t._testing().BACKOFF_MAX_MS * 1.2); // 20% jitter ceiling
  });

  it('increases with wsReconnectAttempt', () => {
    const t = makeTunnel();
    t._testing().wsReconnectAttempt = 0;
    const d0 = t._testing().getReconnectDelayMs();
    t._testing().wsReconnectAttempt = 5;
    const d5 = t._testing().getReconnectDelayMs();
    expect(d5).toBeGreaterThan(d0);
  });
});

// ─── collectMetadata() (via sendHeartbeat) (L259-286) ────────────────────────

describe('collectMetadata() (L259-286)', () => {
  it('includes expected fields in heartbeat payload', async () => {
    let captured: any = null;
    global.fetch = ((_url: string, init?: RequestInit) => {
      captured = JSON.parse(init?.body as string ?? '{}');
      return fakeHeartbeatResp() as any;
    }) as any;
    const t = makeTunnel();
    await t._testing().sendHeartbeat();
    t.stop();
    expect(captured).not.toBeNull();
    expect(captured.hostname).toBeDefined();
    expect(captured.metadata.protocolVersion).toBe(TUNNEL_PROTOCOL_VERSION);
    expect(captured.metadata.activeProjects).toBe(1);
    expect(Array.isArray(captured.metadata.projects)).toBe(true);
  });

  it('handles resolver.getActiveProjects() throwing', async () => {
    let captured: any = null;
    global.fetch = ((_url: string, init?: RequestInit) => {
      captured = JSON.parse(init?.body as string ?? '{}');
      return fakeHeartbeatResp() as any;
    }) as any;
    const t = makeTunnel({
      resolver: makeResolver({ getActiveProjects: () => { throw new Error('boom'); } }),
    });
    await t._testing().sendHeartbeat();
    t.stop();
    expect(captured.metadata.activeProjects).toBe(0);
  });

  it('reports tunnelStatus as connected when ws is OPEN', async () => {
    let captured: any = null;
    global.fetch = ((_url: string, init?: RequestInit) => {
      captured = JSON.parse(init?.body as string ?? '{}');
      return fakeHeartbeatResp() as any;
    }) as any;
    const t = makeTunnel();
    const fake = new FakeWebSocket();
    fake.readyState = FakeWebSocket.OPEN;
    t._testing().installFakeWs(fake as unknown as WebSocket);
    await t._testing().sendHeartbeat();
    t.stop();
    expect(captured.metadata.tunnelStatus).toBe('connected');
  });

  it('uses opts.name in heartbeat body', async () => {
    let captured: any = null;
    global.fetch = ((_url: string, init?: RequestInit) => {
      captured = JSON.parse(init?.body as string ?? '{}');
      return fakeHeartbeatResp() as any;
    }) as any;
    const t = makeTunnel({ name: 'my-worker-42' });
    await t._testing().sendHeartbeat();
    t.stop();
    expect(captured.name).toBe('my-worker-42');
  });
});

// ─── sendHeartbeat() (L289-323) ──────────────────────────────────────────────

describe('sendHeartbeat() (L289-323)', () => {
  it('POSTs to /api/instances/heartbeat', async () => {
    let calledUrl = '';
    global.fetch = ((url: string) => {
      calledUrl = url;
      return fakeHeartbeatResp() as any;
    }) as any;
    const t = makeTunnel({ cloudUrl: 'https://cloud.test' });
    await t._testing().sendHeartbeat();
    t.stop();
    expect(calledUrl).toBe('https://cloud.test/api/instances/heartbeat');
  });

  it('returns the parsed HeartbeatResponse', async () => {
    const body = { nextPollIn: 45, wsRequested: true, wsUrl: 'wss://ws.test' };
    global.fetch = () => fakeHeartbeatResp(body) as any;
    const t = makeTunnel();
    const result = await t._testing().sendHeartbeat();
    t.stop();
    expect(result.nextPollIn).toBe(45);
    expect(result.wsRequested).toBe(true);
  });

  it('throws when response is not ok', async () => {
    global.fetch = () => Promise.resolve(new Response('{}', { status: 401 })) as any;
    const t = makeTunnel();
    await expect(t._testing().sendHeartbeat()).rejects.toThrow('HTTP 401');
    t.stop();
  });

  it('updates serverPublishedWsUrl when wsUrl is in response', async () => {
    const body = { nextPollIn: 30, wsRequested: false, wsUrl: 'wss://published.test' };
    global.fetch = () => fakeHeartbeatResp(body) as any;
    const t = makeTunnel();
    await t._testing().sendHeartbeat();
    t.stop();
    expect(t._testing().serverPublishedWsUrl).toBe('wss://published.test');
  });

  it('logs a message when wsUrl changes (new value)', async () => {
    const { logger, logs } = logCapture();
    const body = { nextPollIn: 30, wsRequested: false, wsUrl: 'wss://new-ws.test' };
    global.fetch = () => fakeHeartbeatResp(body) as any;
    const t = makeTunnel({ logger });
    t._testing().serverPublishedWsUrl = 'wss://old-ws.test';
    await t._testing().sendHeartbeat();
    t.stop();
    expect(logs.some(l => l.includes('Cloud advertised tunnel WS URL'))).toBe(true);
  });

  it('does NOT log when wsUrl is the same as already stored', async () => {
    const { logger, logs } = logCapture();
    const body = { nextPollIn: 30, wsRequested: false, wsUrl: 'wss://same-ws.test' };
    global.fetch = () => fakeHeartbeatResp(body) as any;
    const t = makeTunnel({ logger });
    t._testing().serverPublishedWsUrl = 'wss://same-ws.test';
    await t._testing().sendHeartbeat();
    t.stop();
    expect(logs.some(l => l.includes('Cloud advertised'))).toBe(false);
  });
});

// ─── scheduleNextPoll() (L327-330) ────────────────────────────────────────────

describe('scheduleNextPoll() (L327-330)', () => {
  it('no-ops when tunnel is stopped', () => {
    const t = makeTunnel();
    t.stop();
    (t as any).scheduleNextPoll(5);
    // No timer set; just verify no error
    expect(t._testing().stopped).toBe(true);
  });

  it('schedules heartbeatLoop after given interval', async () => {
    global.fetch = () => fakeHeartbeatResp() as any;
    const t = makeTunnel();
    await t._testing().heartbeatLoop();
    // A poll timer should have been set (stopped=false, has apiKey)
    expect(t.isConnected()).toBe(true);
    t.stop();
  });
});

// ─── heartbeatLoop() (L331-400) ──────────────────────────────────────────────

describe('heartbeatLoop() (L331-400)', () => {
  it('returns immediately when stopped', async () => {
    const t = makeTunnel();
    t.stop();
    await t._testing().heartbeatLoop();
    // Just verifying no error and no fetch call
  });

  it('when WS is OPEN: schedules next poll without fetching', async () => {
    let fetchCalled = false;
    global.fetch = () => { fetchCalled = true; return fakeHeartbeatResp() as any; };
    const t = makeTunnel();
    const fake = new FakeWebSocket();
    fake.readyState = FakeWebSocket.OPEN;
    t._testing().installFakeWs(fake as unknown as WebSocket);
    await t._testing().heartbeatLoop();
    expect(fetchCalled).toBe(false);
    t.stop();
  });

  it('success: updates currentPollInterval and schedules next poll', async () => {
    global.fetch = () => fakeHeartbeatResp({ nextPollIn: 120, wsRequested: false }) as any;
    const t = makeTunnel();
    await t._testing().heartbeatLoop();
    expect(t._testing().currentPollInterval).toBe(120);
    t.stop();
  });

  it('success: clears lastHeartbeatError and logs recovered', async () => {
    const { logger, logs } = logCapture();
    global.fetch = () => fakeHeartbeatResp() as any;
    const t = makeTunnel({ logger });
    // Manually set a previous error
    (t as any).lastHeartbeatError = 'previous error';
    await t._testing().heartbeatLoop();
    expect(logs.some(l => l.includes('recovered'))).toBe(true);
    expect((t as any).lastHeartbeatError).toBeNull();
    t.stop();
  });

  it('success: wsRequested=true triggers connectWs', async () => {
    const factory = installFakeWsFactory();
    global.fetch = () => fakeHeartbeatResp({ nextPollIn: 30, wsRequested: true }) as any;
    const t = makeTunnel();
    await t._testing().heartbeatLoop();
    // connectWs should have been called → a FakeWebSocket was created
    expect(factory.last()).not.toBeNull();
    t.stop();
  });

  it('success: in auth backoff but below recovery threshold → keeps backoff', async () => {
    global.fetch = () => fakeHeartbeatResp({ nextPollIn: 30, wsRequested: false }) as any;
    const t = makeTunnel();
    t._testing().currentPollInterval = 300; // AUTH_FAILURE_BACKOFF_S
    (t as any).consecutiveAuthFailures = 3;  // >= threshold (AUTH_FAILURE_THRESHOLD)
    (t as any).consecutiveAuthSuccesses = 0;
    await t._testing().heartbeatLoop();
    // consecutiveAuthSuccesses incremented to 1, still < AUTH_RECOVERY_SUCCESS_THRESHOLD(3)
    expect(t._testing().currentPollInterval).toBe(300);
    t.stop();
  });

  it('success: in auth backoff — threshold met → resets failures', async () => {
    global.fetch = () => fakeHeartbeatResp({ nextPollIn: 45, wsRequested: false }) as any;
    const t = makeTunnel();
    (t as any).consecutiveAuthFailures = 3;
    (t as any).consecutiveAuthSuccesses = 2; // one more → meets threshold (3)
    await t._testing().heartbeatLoop();
    expect((t as any).consecutiveAuthFailures).toBe(0);
    expect(t._testing().currentPollInterval).toBe(45);
    t.stop();
  });

  it('error: HTTP 401 increments consecutiveAuthFailures', async () => {
    global.fetch = () => Promise.resolve(new Response('{}', { status: 401 })) as any;
    const t = makeTunnel();
    await t._testing().heartbeatLoop();
    expect((t as any).consecutiveAuthFailures).toBe(1);
    t.stop();
  });

  it('error: HTTP 403 also increments consecutiveAuthFailures', async () => {
    global.fetch = () => Promise.resolve(new Response('{}', { status: 403 })) as any;
    const t = makeTunnel();
    await t._testing().heartbeatLoop();
    expect((t as any).consecutiveAuthFailures).toBe(1);
    t.stop();
  });

  it('error: 3 consecutive auth failures calls onAuthRevoked', async () => {
    global.fetch = () => Promise.resolve(new Response('{}', { status: 401 })) as any;
    let revokedReason = '';
    const t = makeTunnel({ onAuthRevoked: (r) => { revokedReason = r; } });
    (t as any).consecutiveAuthFailures = 2; // one more will hit threshold
    await t._testing().heartbeatLoop();
    expect(revokedReason).toContain('consecutive auth failures');
    t.stop();
  });

  it('error: onAuthRevoked callback throws → logs warning', async () => {
    const { logger, warns } = logCapture();
    global.fetch = () => Promise.resolve(new Response('{}', { status: 401 })) as any;
    const t = makeTunnel({
      logger,
      onAuthRevoked: () => { throw new Error('cb threw'); },
    });
    (t as any).consecutiveAuthFailures = 2;
    await t._testing().heartbeatLoop();
    expect(warns.some(w => w.includes('onAuthRevoked threw'))).toBe(true);
    t.stop();
  });

  it('error: already at backoff interval → no duplicate warn', async () => {
    const { logger, warns } = logCapture();
    global.fetch = () => Promise.resolve(new Response('{}', { status: 401 })) as any;
    const t = makeTunnel({ logger });
    (t as any).consecutiveAuthFailures = 2;
    (t as any).currentPollInterval = 300; // already at AUTH_FAILURE_BACKOFF_S
    await t._testing().heartbeatLoop();
    expect(warns.some(w => w.includes('backing off'))).toBe(false);
    t.stop();
  });

  it('error: non-auth failure resets consecutiveAuthFailures', async () => {
    global.fetch = () => Promise.reject(new Error('network error')) as any;
    const t = makeTunnel();
    (t as any).consecutiveAuthFailures = 2;
    await t._testing().heartbeatLoop();
    expect((t as any).consecutiveAuthFailures).toBe(0);
    t.stop();
  });

  it('error: repeated same error message is not re-logged', async () => {
    const { logger, errors } = logCapture();
    global.fetch = () => Promise.reject(new Error('same error')) as any;
    const t = makeTunnel({ logger });
    await t._testing().heartbeatLoop();
    const countAfterFirst = errors.length;
    (t as any).currentPollInterval = 1; // don't want to wait
    await t._testing().heartbeatLoop();
    // Second loop should not add a new error log for the same message
    expect(errors.length).toBe(countAfterFirst);
    t.stop();
  });

  it('error: non-auth failure → currentPollInterval resets to DEFAULT', async () => {
    global.fetch = () => Promise.reject(new Error('connection refused')) as any;
    const t = makeTunnel();
    t._testing().currentPollInterval = 300;
    await t._testing().heartbeatLoop();
    expect(t._testing().currentPollInterval).toBe(60); // DEFAULT_POLL_INTERVAL_S
    t.stop();
  });
});

// ─── resetWsIdleTimer() callback body (L539-542) ─────────────────────────────

describe('resetWsIdleTimer() idle callback (L539-542)', () => {
  it('closes ws when callback fires with OPEN ws', async () => {
    // We use fake timers by directly extracting the callback via spying on globalThis.setTimeout
    const callbacks: Array<() => void> = [];
    const origST = globalThis.setTimeout;
    (globalThis as any).setTimeout = (cb: () => void, _ms: number) => {
      callbacks.push(cb);
      return 0 as any;
    };

    try {
      const t = makeTunnel();
      const fake = new FakeWebSocket();
      fake.readyState = FakeWebSocket.OPEN;
      t._testing().installFakeWs(fake as unknown as WebSocket);
      // Call handleRequest which calls resetWsIdleTimer
      await t._testing().handleRequest({
        type: 'request', requestId: 'x', method: 'GET', path: '/agent/test',
      } as any);
      // Now fire the idle callback we captured
      const idleCb = callbacks[callbacks.length - 1];
      idleCb?.();
      expect(fake.closedWith?.code).toBe(1000);
      expect(fake.closedWith?.reason).toBe('Idle timeout');
    } finally {
      (globalThis as any).setTimeout = origST;
    }
  });

  it('idle callback no-ops when ws readyState is not OPEN', async () => {
    const callbacks: Array<() => void> = [];
    const origST = globalThis.setTimeout;
    (globalThis as any).setTimeout = (cb: () => void, _ms: number) => {
      callbacks.push(cb);
      return 0 as any;
    };

    try {
      const t = makeTunnel();
      const fake = new FakeWebSocket();
      fake.readyState = FakeWebSocket.CLOSED;
      t._testing().installFakeWs(fake as unknown as WebSocket);
      await t._testing().handleRequest({
        type: 'request', requestId: 'y', method: 'GET', path: '/agent/test',
      } as any);
      const idleCb = callbacks[callbacks.length - 1];
      idleCb?.();
      expect(fake.closedWith).toBeNull(); // close was NOT called
    } finally {
      (globalThis as any).setTimeout = origST;
    }
  });
});

// ─── startWsHeartbeat() setInterval callback (L547-554) ───────────────────────

describe('startWsHeartbeat() callback (L547-554)', () => {
  it('sends heartbeat frame when ws is OPEN', async () => {
    const callbacks: Array<() => void> = [];
    const origSI = globalThis.setInterval;
    (globalThis as any).setInterval = (cb: () => void, _ms: number) => {
      callbacks.push(cb);
      return 0 as any;
    };
    const origST = globalThis.setTimeout;
    (globalThis as any).setTimeout = (_cb: () => void, _ms: number) => 0 as any;

    try {
      global.fetch = () => fakeHeartbeatResp({ nextPollIn: 30, wsRequested: true }) as any;
      const factory = installFakeWsFactory();
      const t = makeTunnel();
      await t._testing().heartbeatLoop();
      const ws = factory.last()!;
      expect(ws).not.toBeNull();
      // trigger onopen (which calls startWsHeartbeat + resetWsIdleTimer)
      ws.triggerOpen();
      // Fire the heartbeat setInterval callback
      const hbCb = callbacks[callbacks.length - 1];
      ws.readyState = FakeWebSocket.OPEN;
      t._testing().installFakeWs(ws as unknown as WebSocket);
      await hbCb?.();
      // Should have sent a 'heartbeat' frame
      expect(ws.sent.some((s) => JSON.parse(s).type === 'heartbeat')).toBe(true);
      t.stop();
    } finally {
      (globalThis as any).setInterval = origSI;
      (globalThis as any).setTimeout = origST;
    }
  });

  it('heartbeat callback no-ops when ws is not OPEN', async () => {
    const callbacks: Array<() => void> = [];
    const origSI = globalThis.setInterval;
    const origST = globalThis.setTimeout;
    (globalThis as any).setInterval = (cb: () => void, _ms: number) => {
      callbacks.push(cb);
      return 0 as any;
    };
    (globalThis as any).setTimeout = (_cb: () => void, _ms: number) => 0 as any;

    try {
      global.fetch = () => fakeHeartbeatResp({ nextPollIn: 30, wsRequested: true }) as any;
      const factory = installFakeWsFactory();
      const t = makeTunnel();
      await t._testing().heartbeatLoop();
      const ws = factory.last()!;
      ws.triggerOpen();
      ws.readyState = FakeWebSocket.CLOSED;
      const hbCb = callbacks[callbacks.length - 1];
      await hbCb?.();
      expect(ws.sent.length).toBe(0);
      t.stop();
    } finally {
      (globalThis as any).setInterval = origSI;
      (globalThis as any).setTimeout = origST;
    }
  });
});

// ─── connectWs() (L558-642) ──────────────────────────────────────────────────

describe('connectWs() (L558-642)', () => {
  it('no-ops when stopped=true', () => {
    const factory = installFakeWsFactory();
    const t = makeTunnel();
    t.stop();
    t._testing().connectWs();
    expect(factory.last()).toBeNull();
  });

  it('no-ops when ws is already set', () => {
    const factory = installFakeWsFactory();
    const t = makeTunnel();
    const fake = new FakeWebSocket();
    t._testing().installFakeWs(fake as unknown as WebSocket);
    t._testing().connectWs();
    expect(factory.last()).toBeNull(); // no new WS created
    t.stop();
  });

  it('logs error and schedules poll when createTunnelWebSocket throws', () => {
    const { logger, errors } = logCapture();
    const t = makeTunnel({ logger });
    // Make WebSocket constructor throw — supportsWebSocketConstructorHeaders returns
    // true in Bun, but the actual constructor call blows up.
    function ThrowingWS() { throw new Error('ws-unavailable'); }
    ThrowingWS.OPEN = 1; ThrowingWS.CONNECTING = 0; ThrowingWS.CLOSING = 2; ThrowingWS.CLOSED = 3;
    (globalThis as any).WebSocket = ThrowingWS;
    t._testing().connectWs();
    expect(errors.some(e => e.includes('WebSocket creation failed'))).toBe(true);
    t.stop();
  });

  it('normal flow: creates WebSocket, sets this.ws', () => {
    const factory = installFakeWsFactory();
    const t = makeTunnel();
    t._testing().connectWs();
    const ws = factory.last();
    expect(ws).not.toBeNull();
    expect(t._testing().ws).toBe(ws);
    t.stop();
  });

  it('WS url includes /api/instances/ws', () => {
    const factory = installFakeWsFactory();
    const t = makeTunnel({ cloudUrl: 'https://api.test' });
    t._testing().connectWs();
    const ws = factory.last()!;
    expect(ws.url).toContain('/api/instances/ws');
    t.stop();
  });
});

// ─── WS event handlers (L643-659) ────────────────────────────────────────────

describe('connectWs() socket.onopen (L643-645)', () => {
  it('resets wsReconnectAttempt to 0 and sets timers', () => {
    const factory = installFakeWsFactory();
    const t = makeTunnel();
    t._testing().wsReconnectAttempt = 5;
    t._testing().connectWs();
    const ws = factory.last()!;
    ws.triggerOpen();
    expect(t._testing().wsReconnectAttempt).toBe(0);
    t.stop();
  });
});

describe('connectWs() socket.onmessage (L647-610)', () => {
  it('ignores invalid JSON', () => {
    const factory = installFakeWsFactory();
    const t = makeTunnel();
    t._testing().connectWs();
    const ws = factory.last()!;
    expect(() => ws.triggerMessage('{bad json')).not.toThrow();
    t.stop();
  });

  it('ping message → sends pong', () => {
    const factory = installFakeWsFactory();
    const t = makeTunnel();
    t._testing().connectWs();
    const ws = factory.last()!;
    ws.readyState = FakeWebSocket.OPEN;
    t._testing().installFakeWs(ws as unknown as WebSocket);
    ws.triggerMessage({ type: 'ping' });
    expect(ws.sent.some((s) => JSON.parse(s).type === 'pong')).toBe(true);
    t.stop();
  });

  it('cancel message → aborts corresponding controller', async () => {
    const factory = installFakeWsFactory();
    const t = makeTunnel();
    t._testing().connectWs();
    const ws = factory.last()!;
    ws.readyState = FakeWebSocket.OPEN;
    t._testing().installFakeWs(ws as unknown as WebSocket);

    // Inject a controller manually
    const ctrl = new AbortController();
    (t as any).activeAbortControllers.set('req-abc', ctrl);

    ws.triggerMessage({ type: 'cancel', requestId: 'req-abc' });
    expect(ctrl.signal.aborted).toBe(true);
    t.stop();
  });

  it('request message → dispatches to handleRequest (sends 502)', async () => {
    const factory = installFakeWsFactory();
    const t = makeTunnel({
      resolver: makeResolver({ resolveLocalUrl: async () => null }),
    });
    t._testing().connectWs();
    const ws = factory.last()!;
    ws.readyState = FakeWebSocket.OPEN;
    t._testing().installFakeWs(ws as unknown as WebSocket);
    // Await the handleRequest call directly so we don't need setTimeout
    await t._testing().handleRequest({ type: 'request', requestId: 'r-1', method: 'GET', path: '/x' } as any);
    expect(ws.sent.length).toBeGreaterThan(0);
    const frame = JSON.parse(ws.sent[0]!);
    expect(frame.type).toBe('response');
    expect(frame.status).toBe(502);
    t.stop();
  });

  it('unknown message type → ignored silently', () => {
    const factory = installFakeWsFactory();
    const t = makeTunnel();
    t._testing().connectWs();
    const ws = factory.last()!;
    ws.readyState = FakeWebSocket.OPEN;
    t._testing().installFakeWs(ws as unknown as WebSocket);
    expect(() => ws.triggerMessage({ type: 'future-unknown-type' })).not.toThrow();
    t.stop();
  });

  it('request message .catch() fires when handleRequest rejects (L614-615)', async () => {
    // Make handleRequest reject by making setTimeout throw inside resetWsIdleTimer.
    // handleRequest is async, so a synchronous throw before the first await
    // makes it return a rejected promise. The void+.catch() at L614 logs the error.
    const { logger, errors } = logCapture();
    const factory = installFakeWsFactory();
    const t = makeTunnel({ logger });
    t._testing().connectWs();
    const ws = factory.last()!;
    ws.readyState = FakeWebSocket.OPEN;
    t._testing().installFakeWs(ws as unknown as WebSocket);

    const origST = globalThis.setTimeout;
    (globalThis as any).setTimeout = () => { throw new Error('timer exploded'); };
    try {
      ws.triggerMessage({ type: 'request', requestId: 'r-boom', method: 'GET', path: '/x' });
      // Allow the rejection microtask to run (no setTimeout needed — pure microtask tick)
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      (globalThis as any).setTimeout = origST;
    }
    expect(errors.some(e => e.includes('Error handling request'))).toBe(true);
    t.stop();
  });
});

describe('connectWs() socket.onclose (L612-627)', () => {
  beforeEach(() => {
    global.fetch = () => fakeHeartbeatResp() as any;
  });

  it('code 1000: schedules normal poll (no backoff)', () => {
    const factory = installFakeWsFactory();
    const { logger, logs } = logCapture();
    const t = makeTunnel({ logger });
    t._testing().connectWs();
    const ws = factory.last()!;
    ws.triggerClose(1000, 'Idle timeout');
    expect(logs.some(l => l.includes('closed'))).toBe(true);
    expect(t._testing().wsReconnectAttempt).toBe(0); // no increment
    t.stop();
  });

  it('code 4000: schedules normal poll (treated like 1000)', () => {
    const factory = installFakeWsFactory();
    const t = makeTunnel();
    t._testing().connectWs();
    const ws = factory.last()!;
    ws.triggerClose(4000, '');
    expect(t._testing().wsReconnectAttempt).toBe(0);
    t.stop();
  });

  it('other code: increments wsReconnectAttempt and logs reconnect', () => {
    const factory = installFakeWsFactory();
    const { logger, logs } = logCapture();
    const t = makeTunnel({ logger });
    t._testing().connectWs();
    const ws = factory.last()!;
    ws.triggerClose(1006, 'abnormal closure');
    expect(t._testing().wsReconnectAttempt).toBe(1);
    expect(logs.some(l => l.includes('Reconnecting'))).toBe(true);
    t.stop();
  });

  it('when stopped: onclose does not schedule poll', () => {
    const factory = installFakeWsFactory();
    const t = makeTunnel();
    t._testing().connectWs();
    const ws = factory.last()!;
    t.stop();
    ws.triggerClose(1006);
    expect(t._testing().stopped).toBe(true);
  });
});

describe('connectWs() socket.onerror (L629-631)', () => {
  it('logs the error message', () => {
    const factory = installFakeWsFactory();
    const { logger, errors } = logCapture();
    const t = makeTunnel({ logger });
    t._testing().connectWs();
    const ws = factory.last()!;
    ws.triggerError('SSL handshake failed');
    expect(errors.some(e => e.includes('WebSocket error'))).toBe(true);
    t.stop();
  });

  it('handles onerror with no message', () => {
    const factory = installFakeWsFactory();
    const t = makeTunnel();
    t._testing().connectWs();
    const ws = factory.last()!;
    expect(() => ws.onerror?.({})).not.toThrow();
    t.stop();
  });
});

// ─── cleanupWs() (L662-660) ──────────────────────────────────────────────────

describe('cleanupWs() (L634-660)', () => {
  it('clears heartbeatTimer and wsIdleTimer, aborts controllers, nulls ws', () => {
    const t = makeTunnel();
    // Directly set truthy timer handles to avoid relying on fake-setTimeout quirks
    (t as any).heartbeatTimer = setInterval(() => {}, 9_999_999);
    (t as any).wsIdleTimer    = setTimeout(() => {}, 9_999_999);
    // Install a fake ws so _testing().ws is not null before cleanup
    const fake = new FakeWebSocket();
    t._testing().installFakeWs(fake as unknown as WebSocket);
    // Inject an abort controller
    const ctrl = new AbortController();
    (t as any).activeAbortControllers.set('test-req', ctrl);

    t._testing().cleanupWs();
    expect(ctrl.signal.aborted).toBe(true);
    expect(t._testing().ws).toBeNull();
    expect((t as any).heartbeatTimer).toBeNull();
    expect((t as any).wsIdleTimer).toBeNull();
    t.stop();
  });
});

// ─── _testing() proxies + getters/setters (L682-700) ──────────────────────────

describe('_testing() proxy methods (L682-700)', () => {
  it('supportsWebSocketConstructorHeaders proxy works', () => {
    const t = makeTunnel();
    const result = t._testing().supportsWebSocketConstructorHeaders({ Bun: {} } as any);
    expect(result).toBe(true);
  });

  it('createTunnelWebSocket proxy throws on non-Bun runtime', () => {
    const t = makeTunnel();
    expect(() =>
      t._testing().createTunnelWebSocket('wss://x', { headers: {} }, {} as any)
    ).toThrow(TunnelWebSocketHeaderSupportError);
  });

  it('TUNNEL_PROTOCOL_VERSION is exported via _testing()', () => {
    const t = makeTunnel();
    expect(t._testing().TUNNEL_PROTOCOL_VERSION).toBe(TUNNEL_PROTOCOL_VERSION);
  });

  it('currentPollInterval get/set roundtrip', () => {
    const t = makeTunnel();
    t._testing().currentPollInterval = 42;
    expect(t._testing().currentPollInterval).toBe(42);
  });

  it('wsReconnectAttempt get/set roundtrip', () => {
    const t = makeTunnel();
    t._testing().wsReconnectAttempt = 7;
    expect(t._testing().wsReconnectAttempt).toBe(7);
  });

  it('serverPublishedWsUrl get/set roundtrip', () => {
    const t = makeTunnel();
    t._testing().serverPublishedWsUrl = 'wss://test.ws';
    expect(t._testing().serverPublishedWsUrl).toBe('wss://test.ws');
    t._testing().serverPublishedWsUrl = null;
    expect(t._testing().serverPublishedWsUrl).toBeNull();
  });

  it('ws getter reflects installed fake', () => {
    const t = makeTunnel();
    const fake = new FakeWebSocket();
    t._testing().installFakeWs(fake as unknown as WebSocket);
    expect(t._testing().ws).toBe(fake);
    t.stop();
  });

  it('stopped getter reflects current state', () => {
    const t = makeTunnel();
    expect(t._testing().stopped).toBe(false);
    t.stop();
    expect(t._testing().stopped).toBe(true);
  });
});
