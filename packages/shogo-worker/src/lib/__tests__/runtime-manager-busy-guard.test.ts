// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The cap must never be paid for with someone's work (SHO-143).
 *
 * Before this, the LRU asked the runtime "are you busy?" with a 3-second HTTP
 * probe at the exact moment it wanted to kill it, and read a timeout as "no".
 * On a host busy with builds that meant every victim looked idle: 146
 * background evictions in 24h, 0 keeps. These tests make the probe hang, fail
 * and lie, and require the runtime to survive each one.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { WorkerRuntimeManager } from '../runtime-manager.ts';
import { ZERO_COUNTS } from '../runtime-activity.ts';

type Line = string;
const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function logs() {
  const lines: Line[] = [];
  const logger = {
    log: (m: string) => lines.push(m),
    warn: (m: string) => lines.push(m),
    error: (m: string) => lines.push(m),
  };
  return { lines, logger };
}

function fakeProc() {
  const proc = {
    exitCode: null as number | null,
    signalCode: null,
    killed: false,
    pid: 4242,
    kill() {
      proc.killed = true;
      return true;
    },
    once() {
      return proc;
    },
    on() {
      return proc;
    },
  };
  return proc;
}

function insertSlot(mgr: WorkerRuntimeManager, projectId: string, extra: Record<string, unknown> = {}) {
  const slot = {
    projectId,
    agentPort: 0,
    apiServerPort: 0,
    status: 'running',
    proc: fakeProc(),
    pid: 4242,
    startedAt: Date.now() - 10 * 60_000,
    lastUsedAt: Date.now() - 10 * 60_000,
    restarts: 0,
    consecutiveFailures: 0,
    lastFailureAt: 0,
    restartTimestamps: [] as number[],
    breakerTrips: 0,
    restartTimer: null as ReturnType<typeof setTimeout> | null,
    idleTimer: null as ReturnType<typeof setTimeout> | null,
    graceTimer: null,
    limitWatchdog: null,
    spawnConfig: {} as never,
    startPromise: null,
    runtimeToken: 'tok',
    ...extra,
  };
  (mgr as unknown as { runtimes: Map<string, typeof slot> }).runtimes.set(projectId, slot);
  return slot;
}

/** An activity endpoint that answers correctly, counts calls, or hangs. */
function activityServer(opts: {
  response?: () => Record<string, unknown>;
  hangMs?: number;
  status?: number;
  token?: string;
}) {
  const seen: number[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      seen.push(Date.now());
      if ((req.headers.get('x-runtime-token') ?? '') !== (opts.token ?? 'tok')) {
        return new Response('unauthorized', { status: 401 });
      }
      if (opts.hangMs) await new Promise((r) => setTimeout(r, opts.hangMs));
      if (opts.status && opts.status >= 400) return new Response('boom', { status: opts.status });
      return Response.json({
        idleSeconds: 0,
        activeSessions: 1,
        activeTurns: 0,
        activeTasks: 0,
        activeStreams: 0,
        activeChildren: 0,
        ...(opts.response?.() ?? {}),
      });
    },
  });
  servers.push(server);
  return { port: server.port as number, seen };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WorkerRuntimeManager — a busy runtime is never the LRU victim', () => {
  it('does not evict a runtime whose activity probe hangs (the Samsara case)', async () => {
    // The probe never answers inside the 3s budget, exactly like a host
    // saturated by Unreal builds. The runtime is running a task.
    const hung = activityServer({ hangMs: 6_000 });
    const idle = activityServer({ response: () => ({}) });
    const { lines, logger } = logs();
    const gone: string[] = [];
    const mgr = new WorkerRuntimeManager({ logger, maxRuntimes: 1, onRuntimeGone: (id) => gone.push(id) });

    insertSlot(mgr, 'busy-hung-probe', { agentPort: hung.port, lastUsedAt: Date.now() - 20 * 60_000 });
    insertSlot(mgr, 'settled-idle', { agentPort: idle.port, lastUsedAt: Date.now() - 10 * 60_000 });
    insertSlot(mgr, 'just-started');

    (mgr as unknown as { enforceMaxRuntimes: (k: string) => void }).enforceMaxRuntimes('just-started');
    // The pass samples every candidate in parallel, so it settles when the
    // hung probe hits its 3s budget.
    await sleep(3_800);

    // The runtime we could not question is kept; the one we could question and
    // that answered "nothing running" is the one that goes.
    expect(gone).toEqual(['settled-idle']);
    expect(lines.some((l) => l.includes('keeping busy-hung-probe') && l.includes('unknown'))).toBe(true);
    expect(lines.some((l) => l.includes('LRU-evicting settled-idle') && l.includes('turns=0'))).toBe(true);
  }, 15_000);

  it('does not evict a runtime whose activity endpoint reports no task counts (older runtime)', async () => {
    // An older runtime answers liveness only. Zeros would make it look idle, so
    // the answer is treated as unknown and the runtime is kept.
    const legacy = activityServer({
      response: () => ({
        activeTurns: undefined,
        activeTasks: undefined,
        activeStreams: undefined,
        activeChildren: undefined,
      }),
    });
    const { lines, logger } = logs();
    const gone: string[] = [];
    const mgr = new WorkerRuntimeManager({ logger, maxRuntimes: 1, onRuntimeGone: (id) => gone.push(id) });
    insertSlot(mgr, 'legacy', { agentPort: legacy.port, lastUsedAt: Date.now() - 20 * 60_000 });
    insertSlot(mgr, 'new');

    (mgr as unknown as { enforceMaxRuntimes: (k: string) => void }).enforceMaxRuntimes('new');
    await sleep(300);

    expect(gone).toEqual([]);
    expect(lines.some((l) => l.includes('keeping legacy') && l.includes('unknown'))).toBe(true);
  }, 15_000);

  it('does not evict a runtime whose activity endpoint answers 500', async () => {
    const broken = activityServer({ status: 500 });
    const { logger } = logs();
    const gone: string[] = [];
    const mgr = new WorkerRuntimeManager({ logger, maxRuntimes: 1, onRuntimeGone: (id) => gone.push(id) });
    insertSlot(mgr, 'broken', { agentPort: broken.port, lastUsedAt: Date.now() - 20 * 60_000 });
    insertSlot(mgr, 'new');

    (mgr as unknown as { enforceMaxRuntimes: (k: string) => void }).enforceMaxRuntimes('new');
    await sleep(300);

    expect(gone).toEqual([]);
  });

  it('keeps a runtime that is within its startup grace, before any sample exists', async () => {
    const { logger } = logs();
    const gone: string[] = [];
    const mgr = new WorkerRuntimeManager({ logger, onRuntimeGone: (id) => gone.push(id) });
    const slot = insertSlot(mgr, 'booting', { status: 'starting', startedAt: Date.now(), agentPort: 0 });

    const decision = mgr.activityDecision('booting');
    expect(decision.busy).toBe(true);
    expect(decision.reason).toBe('grace');
    expect(gone).toEqual([]);
    expect(slot.status).toBe('starting');
  });

  it('keeps a runtime mid-turn — the regression for 146 evictions / 0 keeps', async () => {
    const midTurn = activityServer({ response: () => ({ activeTurns: 1 }) });
    const { logger } = logs();
    const gone: string[] = [];
    const mgr = new WorkerRuntimeManager({ logger, maxRuntimes: 1, onRuntimeGone: (id) => gone.push(id) });
    insertSlot(mgr, 'mid-turn', { agentPort: midTurn.port, lastUsedAt: Date.now() - 20 * 60_000 });
    insertSlot(mgr, 'new');

    (mgr as unknown as { enforceMaxRuntimes: (k: string) => void }).enforceMaxRuntimes('new');
    await sleep(300);

    expect(gone).toEqual([]);
  });
});

describe('WorkerRuntimeManager — the decision reads a cached sample', () => {
  it('sampling on the timer, not at eviction time, is what the verdict uses', async () => {
    const server = activityServer({ response: () => ({ activeTasks: 1, activeChildren: 1 }) });
    const { logger } = logs();
    const mgr = new WorkerRuntimeManager({ logger });
    const slot = insertSlot(mgr, 'p', { agentPort: server.port });

    await mgr.sampleAllActivity();
    const afterSample = server.seen.length;

    const decision = mgr.activityDecision('p');
    expect(decision.busy).toBe(true);
    expect(decision.reason).toBe('work');
    expect(decision.countsText).toBe('turns=0 tasks=1 streams=0 children=1');
    // No probe at decision time at all.
    expect(server.seen.length).toBe(afterSample);
    expect(slot.activity?.ok).toBe(true);
  });

  it('records a failed sample as unknown rather than as zero work', async () => {
    const server = activityServer({ hangMs: 5_000 });
    const { logger } = logs();
    const mgr = new WorkerRuntimeManager({ logger });
    const slot = insertSlot(mgr, 'p', { agentPort: server.port });

    await mgr.sampleActivity(slot);

    expect(slot.activity?.ok).toBe(false);
    expect(mgr.activityDecision('p').busy).toBe(true);
    expect(mgr.activityDecision('p').reason).toBe('unknown');
  }, 10_000);

  it('reaps a runtime whose process is gone as dead, not as an eviction', async () => {
    const { logger } = logs();
    const stopped: string[] = [];
    const mgr = new WorkerRuntimeManager({ logger, maxRuntimes: 1 });
    insertSlot(mgr, 'dead', { proc: null, status: 'running' });
    insertSlot(mgr, 'new');

    const decision = mgr.activityDecision('dead');
    expect(decision.dead).toBe(true);

    const originalStop = (mgr as unknown as { stop: (id: string, signal?: string, reason?: string) => Promise<void> }).stop;
    (mgr as unknown as { stop: (id: string, signal?: string, reason?: string) => Promise<void> }).stop = async (
      id: string,
      _signal?: string,
      reason?: string,
    ) => {
      stopped.push(`${id}:${reason}`);
      void originalStop;
    };

    (mgr as unknown as { enforceMaxRuntimes: (k: string) => void }).enforceMaxRuntimes('new');
    await sleep(200);

    expect(stopped).toEqual(['dead:dead']);
  });
});

describe('WorkerRuntimeManager — a stale verdict is refreshed before it kills anything', () => {
  it('re-probes a runtime whose cached "idle" aged out, and keeps it when the turn has started since', async () => {
    // The timer sampled `turns=0` a minute ago; a turn started inside that gap.
    // Evicting on the stale verdict is exactly the SHO-143 failure.
    const server = activityServer({ response: () => ({ activeTurns: 1 }) });
    const { lines, logger } = logs();
    const gone: string[] = [];
    const mgr = new WorkerRuntimeManager({ logger, maxRuntimes: 1, onRuntimeGone: (id) => gone.push(id) });
    insertSlot(mgr, 'stale-idle', {
      agentPort: server.port,
      lastUsedAt: Date.now() - 20 * 60_000,
      activity: { counts: { ...ZERO_COUNTS }, at: Date.now() - 60_000, ok: true },
    });
    insertSlot(mgr, 'new');

    (mgr as unknown as { enforceMaxRuntimes: (k: string) => void }).enforceMaxRuntimes('new');
    await sleep(400);

    expect(gone).toEqual([]);
    expect(server.seen.length).toBe(1);
    expect(lines.some((l) => l.includes('keeping stale-idle') && l.includes('turns=1'))).toBe(true);
  }, 15_000);

  it('does not probe a runtime whose verdict is fresh, so eviction never waits on the wire', async () => {
    const server = activityServer({ response: () => ({}) });
    const { logger } = logs();
    const gone: string[] = [];
    const mgr = new WorkerRuntimeManager({ logger, maxRuntimes: 1, onRuntimeGone: (id) => gone.push(id) });
    insertSlot(mgr, 'fresh-idle', {
      agentPort: server.port,
      lastUsedAt: Date.now() - 20 * 60_000,
      activity: { counts: { ...ZERO_COUNTS }, at: Date.now(), ok: true },
    });
    insertSlot(mgr, 'new');

    (mgr as unknown as { enforceMaxRuntimes: (k: string) => void }).enforceMaxRuntimes('new');
    await sleep(200);

    expect(gone).toEqual(['fresh-idle']);
    expect(server.seen.length).toBe(0);
  });

  it('refreshActivity re-reads only when the cached sample is stale', async () => {
    const server = activityServer({ response: () => ({ activeTurns: 1 }) });
    const { logger } = logs();
    const mgr = new WorkerRuntimeManager({ logger });
    const slot = insertSlot(mgr, 'p', {
      agentPort: server.port,
      activity: { counts: { ...ZERO_COUNTS }, at: Date.now(), ok: true },
    });

    await mgr.refreshActivity('p');
    expect(server.seen.length).toBe(0);

    slot.activity = { ...(slot.activity as { counts: typeof ZERO_COUNTS; ok: boolean }), at: Date.now() - 60_000 };
    await mgr.refreshActivity('p');

    expect(server.seen.length).toBe(1);
    expect(mgr.activityDecision('p').reason).toBe('work');
  }, 15_000);
});

describe('WorkerRuntimeManager — unexplained exits say why', () => {
  it('logs the exit code, the uptime, the last activity and the stderr tail', async () => {
    const { lines, logger } = logs();
    const mgr = new WorkerRuntimeManager({ logger });
    const slot = insertSlot(mgr, 'crasher');
    (slot as unknown as { stderrTail: string[] }).stderrTail = ['FATAL heap out of memory', 'killed'];

    (mgr as unknown as { handleExit: (s: unknown, c: number | null, sig: string | null) => void }).handleExit(
      slot,
      1,
      null,
    );

    const line = lines.find((l) => l.includes('exited WITHOUT a stop request'));
    expect(line).toBeDefined();
    expect(line).toContain('code=1');
    expect(line).toContain('last activity turns=0');
    expect(line).toContain('FATAL heap out of memory');
    expect(line).toContain('killed');
  });

  it('does not warn when the stop was ours', async () => {
    const { lines, logger } = logs();
    const mgr = new WorkerRuntimeManager({ logger });
    const slot = insertSlot(mgr, 'stopping');
    slot.status = 'stopping';

    (mgr as unknown as { handleExit: (s: unknown, c: number | null, sig: string | null) => void }).handleExit(
      slot,
      0,
      null,
    );

    expect(lines.some((l) => l.includes('exited WITHOUT a stop request'))).toBe(false);
  });
});
