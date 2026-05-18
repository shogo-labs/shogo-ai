// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Coverage for `WorkerRuntimeManager` idle eviction.
 *
 * The "chat cut mid-stream" symptom in production was: the agent-proxy
 * never refreshed `lastUsedAt` on a long stream, so a 16-minute Opus
 * turn looked identical to a 16-minute idle slot to the manager and
 * `stop()` fired mid-stream. The reaper itself is correct — it's
 * `lastUsedAt` that wasn't being kept fresh by the surrounding HTTP
 * code.
 *
 * The reproduction here pins both halves of the contract:
 *
 *   1. With NO `touch()` calls inside the idle window, the reaper
 *      DOES fire — the slot is killed, the process is SIGTERM'd, and
 *      the runtimes map is cleared. This is the bug surface.
 *
 *   2. With periodic `touch()` calls (modelling the agent-proxy
 *      forwarding chunks / the AI proxy receiving tool-call requests),
 *      the reaper NEVER fires across multiple idle windows — each
 *      touch resets the timer.
 *
 * The remaining tests pin the desktop / `SHOGO_LOCAL_MODE=true` opt-out:
 * `idleMs: 0` (or any non-finite value) disables the reaper without
 * ever arming a timer, so a long chat in local mode is not bounded by
 * the cloud's 15-minute window even if a touch hook breaks somewhere.
 */
import { describe, expect, it } from 'bun:test';
import { WorkerRuntimeManager } from '../runtime-manager.ts';

interface FakeProc {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  pid: number;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  once: (event: string, cb: (...args: unknown[]) => void) => FakeProc;
  on: (event: string, cb: (...args: unknown[]) => void) => FakeProc;
}

function makeFakeProc(): FakeProc {
  const proc: FakeProc = {
    // `waitForExit` short-circuits when `exitCode !== null`, so a
    // synchronous "already exited" fake keeps stop() from blocking on
    // an exit listener that never fires.
    exitCode: 0,
    signalCode: null,
    killed: false,
    pid: 99999,
    kill(_signal?: NodeJS.Signals | number) {
      proc.killed = true;
      return true;
    },
    once(_event, _cb) {
      return proc;
    },
    on(_event, _cb) {
      return proc;
    },
  };
  return proc;
}

function insertRunningSlot(mgr: WorkerRuntimeManager, projectId: string) {
  const proc = makeFakeProc();
  const slot = {
    projectId,
    // 0 short-circuits releasePort and avoids polluting usedPorts.
    agentPort: 0,
    apiServerPort: 0,
    status: 'running' as const,
    proc,
    startedAt: Date.now(),
    lastUsedAt: Date.now(),
    restarts: 0,
    restartTimer: null,
    idleTimer: null,
    spawnConfig: {} as never,
    startPromise: null,
  };
  // The runtimes map and armIdleTimer are private; tests reach in
  // deliberately because the public surface (ensureRunning) requires a
  // real binary on disk.
  (mgr as unknown as { runtimes: Map<string, typeof slot> }).runtimes.set(
    projectId,
    slot,
  );
  return slot;
}

function armIdle(mgr: WorkerRuntimeManager, slot: ReturnType<typeof insertRunningSlot>): void {
  (mgr as unknown as { armIdleTimer: (s: typeof slot) => void }).armIdleTimer(slot);
}

const SILENT = { log: () => {}, warn: () => {}, error: () => {} } as const;

describe('WorkerRuntimeManager idle eviction', () => {
  it('reproduction: with no touches inside the idle window, the reaper kills the runtime (mid-stream cut)', async () => {
    // 50ms idle window stands in for the production 15min — what we
    // want to pin is "no `touch()` for >= idleMs ⇒ stop() fires", not
    // the magnitude.
    const mgr = new WorkerRuntimeManager({ idleMs: 50, logger: SILENT });
    const slot = insertRunningSlot(mgr, 'proj-stream');

    armIdle(mgr, slot);
    expect(slot.idleTimer).not.toBeNull();

    // Simulate an agent-proxy that forwards bytes for >idleMs but
    // never calls `touch()` — exactly the production bug. The
    // manager has no notion of in-flight HTTP, so it evicts.
    await new Promise((r) => setTimeout(r, 120));

    const runtimes = (mgr as unknown as { runtimes: Map<string, unknown> }).runtimes;
    expect(runtimes.has('proj-stream')).toBe(false);
    expect(slot.proc.killed).toBe(true);
  });

  it('fix: periodic touch() inside the idle window keeps the runtime alive across multiple windows', async () => {
    const idleMs = 50;
    const mgr = new WorkerRuntimeManager({ idleMs, logger: SILENT });
    const slot = insertRunningSlot(mgr, 'proj-active');

    armIdle(mgr, slot);

    // Models the activity hooks the API server will install:
    //   - agent-proxy `touch(projectId)` on each forwarded SSE chunk,
    //   - AI proxy `touch(projectId)` after token decode.
    // We tick every (idleMs / 5) for ~3x the idle window so the
    // assertion lands well past where an unfixed reaper would fire.
    const touchInterval = setInterval(() => mgr.touch('proj-active'), Math.max(5, idleMs / 5));
    await new Promise((r) => setTimeout(r, idleMs * 3));
    clearInterval(touchInterval);

    const runtimes = (mgr as unknown as { runtimes: Map<string, unknown> }).runtimes;
    expect(runtimes.has('proj-active')).toBe(true);
    expect(slot.proc.killed).toBe(false);

    // Sanity: once activity stops, the reaper does fire — the slot is
    // not somehow "stuck alive". This pins the resume-eviction-on-idle
    // half of the contract so a future regression that disables the
    // reaper outright still gets caught.
    await new Promise((r) => setTimeout(r, idleMs * 3));
    expect(runtimes.has('proj-active')).toBe(false);
    expect(slot.proc.killed).toBe(true);
  });

  it('touch() on an unknown projectId is a safe no-op', () => {
    const mgr = new WorkerRuntimeManager({ idleMs: 50, logger: SILENT });
    expect(() => mgr.touch('does-not-exist')).not.toThrow();
  });

  it('idleMs=0 disables the reaper (no timer is armed) — desktop opt-out', async () => {
    const mgr = new WorkerRuntimeManager({ idleMs: 0, logger: SILENT });
    const slot = insertRunningSlot(mgr, 'proj-local');

    armIdle(mgr, slot);
    expect(slot.idleTimer).toBeNull();

    await new Promise((r) => setTimeout(r, 50));
    const runtimes = (mgr as unknown as { runtimes: Map<string, unknown> }).runtimes;
    expect(runtimes.has('proj-local')).toBe(true);
    expect(slot.proc.killed).toBe(false);
  });

  it('idleMs=Infinity also disables the reaper', () => {
    const mgr = new WorkerRuntimeManager({
      idleMs: Number.POSITIVE_INFINITY,
      logger: SILENT,
    });
    const slot = insertRunningSlot(mgr, 'proj-inf');

    armIdle(mgr, slot);
    expect(slot.idleTimer).toBeNull();
  });

  it('negative idleMs disables the reaper (defensive)', () => {
    const mgr = new WorkerRuntimeManager({ idleMs: -1, logger: SILENT });
    const slot = insertRunningSlot(mgr, 'proj-neg');

    armIdle(mgr, slot);
    expect(slot.idleTimer).toBeNull();
  });

  it('idleMs > 0 still arms a timer (cloud regression)', () => {
    const mgr = new WorkerRuntimeManager({ idleMs: 1_000, logger: SILENT });
    const slot = insertRunningSlot(mgr, 'proj-cloud');

    armIdle(mgr, slot);
    expect(slot.idleTimer).not.toBeNull();
    if (slot.idleTimer) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = null;
    }
  });
});
