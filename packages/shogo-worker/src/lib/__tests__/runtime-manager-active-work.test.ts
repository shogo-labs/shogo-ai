// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Idle and LRU eviction must ask the runtime whether it is working before
 * stopping it: schedule runs, heartbeats and background tasks don't flow
 * through the host's touch() hooks, so lastUsedAt alone undercounts.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { WorkerRuntimeManager } from '../runtime-manager.ts';

const SILENT = { log: () => {}, warn: () => {}, error: () => {} } as const;

type Activity = { activeTurns?: number; activeTasks?: number; activeStreams?: number };

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function activityServer(activity: () => Activity, token = 'tok') {
  const seen: Array<string | null> = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const got = req.headers.get('x-runtime-token');
      seen.push(got);
      if (got !== token) return new Response('unauthorized', { status: 401 });
      return Response.json({ idleSeconds: 0, activeSessions: 1, ...activity() });
    },
  });
  servers.push(server);
  return { port: server.port as number, seen };
}

function fakeProc() {
  const proc = {
    exitCode: 0 as number | null,
    signalCode: null,
    killed: false,
    pid: 99999,
    kill() { proc.killed = true; return true; },
    once() { return proc; },
    on() { return proc; },
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
    pid: null,
    // Ten minutes up, i.e. past the 2-minute startup grace: a runtime that just
    // started is never an eviction victim (SHO-143), and these tests are about
    // what happens once it is settled.
    startedAt: Date.now() - 10 * 60_000,
    lastUsedAt: Date.now(),
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

function armIdle(mgr: WorkerRuntimeManager, slot: unknown) {
  (mgr as unknown as { armIdleTimer: (s: unknown) => void }).armIdleTimer(slot);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WorkerRuntimeManager active-work gating', () => {
  it('hasActiveWork reports turns, tasks and streams and sends the runtime token', async () => {
    let activity: Activity = { activeTurns: 1 };
    const { port, seen } = activityServer(() => activity);
    const mgr = new WorkerRuntimeManager({ logger: SILENT });
    insertSlot(mgr, 'p', { agentPort: port });

    expect(await mgr.hasActiveWork('p')).toBe(true);
    activity = { activeTasks: 2 };
    expect(await mgr.hasActiveWork('p')).toBe(true);
    activity = { activeStreams: 1 };
    expect(await mgr.hasActiveWork('p')).toBe(true);
    activity = { activeTurns: 0, activeTasks: 0, activeStreams: 0 };
    expect(await mgr.hasActiveWork('p')).toBe(false);
    expect(seen.every((t) => t === 'tok')).toBe(true);
  });

  it('hasActiveWork is false for unknown, unreachable or unauthorized runtimes', async () => {
    const { port } = activityServer(() => ({ activeTurns: 1 }), 'other');
    const mgr = new WorkerRuntimeManager({ logger: SILENT });
    insertSlot(mgr, 'bad-token', { agentPort: port });
    insertSlot(mgr, 'no-port');

    expect(await mgr.hasActiveWork('missing')).toBe(false);
    expect(await mgr.hasActiveWork('no-port')).toBe(false);
    expect(await mgr.hasActiveWork('bad-token')).toBe(false);
  });

  it('idle timer keeps a runtime that is mid-turn and evicts it once idle', async () => {
    let activity: Activity = { activeTurns: 1 };
    const { port } = activityServer(() => activity);
    const gone: string[] = [];
    const mgr = new WorkerRuntimeManager({
      logger: SILENT,
      idleMs: 40,
      onRuntimeGone: (id) => gone.push(id),
    });
    const slot = insertSlot(mgr, 'busy', { agentPort: port });
    armIdle(mgr, slot);

    await sleep(150);
    expect(gone).toEqual([]);
    expect(slot.status).toBe('running');
    expect(slot.idleTimer).not.toBeNull();

    // A current runtime always reports its counts; zeros are what "idle" means.
    activity = { activeTurns: 0, activeTasks: 0, activeStreams: 0 };
    // The reaper decides from the cached sample and only re-asks once that
    // sample has aged out (SHO-143: never probe because we just decided to
    // kill). Age it the way the sampler would on its next tick.
    ;(slot as unknown as { activity?: { at: number } }).activity = {
      counts: { turns: 1, tasks: 0, streams: 0, children: 0 },
      at: Date.now() - 60_000,
      ok: true,
    };
    await sleep(200);
    expect(gone).toEqual(['busy']);
  });

  it('LRU cap skips busy runtimes and evicts the idle one', async () => {
    const busy = activityServer(() => ({ activeTasks: 1 }));
    const idle = activityServer(() => ({ activeTurns: 0, activeTasks: 0, activeStreams: 0 }));
    const gone: string[] = [];
    const mgr = new WorkerRuntimeManager({
      logger: SILENT,
      maxRuntimes: 1,
      onRuntimeGone: (id) => gone.push(id),
    });
    const old = Date.now() - 10 * 60_000;
    insertSlot(mgr, 'oldest-busy', { agentPort: busy.port, lastUsedAt: old });
    insertSlot(mgr, 'older-idle', { agentPort: idle.port, lastUsedAt: old + 1000 });
    insertSlot(mgr, 'new');

    (mgr as unknown as { enforceMaxRuntimes: (k: string) => void }).enforceMaxRuntimes('new');
    await sleep(150);

    expect(gone).toEqual(['older-idle']);
  });
});
