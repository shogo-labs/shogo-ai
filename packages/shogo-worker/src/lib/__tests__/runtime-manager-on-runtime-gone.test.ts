// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `onRuntimeGone` contract: hosts that cache the agent port (the desktop
 * API's RuntimeManager) must hear about every terminal teardown — idle/LRU
 * eviction, explicit stop, clean exit, breaker trip — and must NOT hear about
 * a transient crash-restart, which the worker brings back on the same port.
 */
import { describe, expect, it } from 'bun:test';
import { WorkerRuntimeManager, type RuntimeGoneInfo } from '../runtime-manager.ts';

const SILENT = { log: () => {}, warn: () => {}, error: () => {} } as const;

function makeFakeProc() {
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
    proc: makeFakeProc(),
    pid: null,
    startedAt: Date.now(),
    lastUsedAt: Date.now(),
    restarts: 0,
    consecutiveFailures: 0,
    lastFailureAt: 0,
    restartTimestamps: [] as number[],
    breakerTrips: 0,
    restartTimer: null as ReturnType<typeof setTimeout> | null,
    idleTimer: null,
    graceTimer: null,
    limitWatchdog: null,
    spawnConfig: {} as never,
    startPromise: null,
    ...extra,
  };
  (mgr as unknown as { runtimes: Map<string, typeof slot> }).runtimes.set(projectId, slot);
  return slot;
}

function handleExit(mgr: WorkerRuntimeManager, slot: unknown, code: number | null, signal: NodeJS.Signals | null) {
  (mgr as unknown as { handleExit: (s: unknown, c: number | null, sig: NodeJS.Signals | null) => void })
    .handleExit(slot, code, signal);
}

function recordingManager(opts: Record<string, unknown> = {}) {
  const calls: Array<[string, RuntimeGoneInfo]> = [];
  const mgr = new WorkerRuntimeManager({
    logger: SILENT,
    onRuntimeGone: (id, info) => calls.push([id, info]),
    ...opts,
  });
  return { mgr, calls };
}

describe('WorkerRuntimeManager onRuntimeGone', () => {
  it('fires with reason=idle-evict when the idle reaper stops a runtime', async () => {
    const { mgr, calls } = recordingManager({ idleMs: 30 });
    const slot = insertSlot(mgr, 'proj-idle');
    (mgr as unknown as { armIdleTimer: (s: unknown) => void }).armIdleTimer(slot);

    await new Promise((r) => setTimeout(r, 100));

    expect(calls).toEqual([['proj-idle', { reason: 'idle-evict' }]]);
  });

  it('fires with reason=stop on an explicit stop()', async () => {
    const { mgr, calls } = recordingManager();
    insertSlot(mgr, 'proj-stop');

    await mgr.stop('proj-stop');

    expect(calls).toEqual([['proj-stop', { reason: 'stop' }]]);
  });

  it('does not fire for a stop() of an unknown project', async () => {
    const { mgr, calls } = recordingManager();
    await mgr.stop('nope');
    expect(calls).toEqual([]);
  });

  it('fires with reason=exited on a clean exit', () => {
    const { mgr, calls } = recordingManager();
    const slot = insertSlot(mgr, 'proj-clean');

    handleExit(mgr, slot, 0, null);

    expect(calls).toEqual([['proj-clean', { reason: 'exited', code: 0, signal: null }]]);
  });

  it('does not fire on a transient crash that the worker will restart', () => {
    const { mgr, calls } = recordingManager();
    const slot = insertSlot(mgr, 'proj-crash');

    handleExit(mgr, slot, null, 'SIGKILL');

    expect(slot.status).toBe('restarting');
    expect(calls).toEqual([]);
    if (slot.restartTimer) clearTimeout(slot.restartTimer);
  });

  it('fires with reason=failed when the circuit breaker trips', () => {
    const { mgr, calls } = recordingManager();
    const slot = insertSlot(mgr, 'proj-loop', {
      consecutiveFailures: 7,
      lastFailureAt: Date.now(),
    });

    handleExit(mgr, slot, null, 'SIGKILL');

    expect(slot.status).toBe('failed');
    expect(calls).toEqual([['proj-loop', { reason: 'failed', code: null, signal: 'SIGKILL' }]]);
  });

  it('swallows errors thrown by the callback', async () => {
    const mgr = new WorkerRuntimeManager({
      logger: SILENT,
      onRuntimeGone: () => { throw new Error('boom'); },
    });
    insertSlot(mgr, 'proj-throw');

    await expect(mgr.stop('proj-throw')).resolves.toBeUndefined();
  });
});
