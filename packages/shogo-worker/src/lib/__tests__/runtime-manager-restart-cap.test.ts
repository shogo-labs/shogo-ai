// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Coverage for the {@link WorkerRuntimeManager} circuit breaker and
 * process-group reaping introduced after a single user's project ran
 * away with 54 consecutive `signal=SIGKILL` jetsam exits, each cycle
 * leaking the agent-runtime's vite / preview-manager / LSP children
 * (see main.log lines 5258–7093 for the prod reproduction).
 *
 * The unfixed code:
 *   - Spawned the runtime with `detached: false` and only ever called
 *     `proc.kill(...)` on the parent, so the kernel left the child
 *     subprocess tree alive after each jetsam SIGKILL of the parent.
 *     Symptom: `Force-killed leaked process N on port 37273` 10 times
 *     in a row, EADDRINUSE on the next spawn.
 *   - Had no max-restart cap; `handleExit` incremented forever, so
 *     once jetsam fired the first time the worker was locked into a
 *     ~1/minute respawn loop until the user quit the app. Symptom:
 *     `restart #54` in the same project's log.
 *
 * This file pins four contracts:
 *
 *   1. Every non-clean exit reaps the runtime's process group via the
 *      recorded PID (the orphan-sweep that wasn't happening before).
 *   2. After {@link MAX_CONSECUTIVE_RESTARTS} consecutive non-clean
 *      exits within {@link RESTART_FAILURE_WINDOW_MS}, the slot
 *      transitions to `'failed'` and the manager stops scheduling
 *      restarts.
 *   3. A clean exit (code=0, signal=null) does NOT increment the
 *      failure budget — bounded chat sessions that exit normally
 *      after their work is done should leave the slot in the same
 *      "healthy" state they found it in.
 *   4. A `'failed'` slot is NOT terminal: it self-heals. A tripped
 *      breaker refuses `ensureRunning(...)` immediately, but once an
 *      escalating cooldown (2m/4m/8m/15m-cap, see `breakerCooldownMs`)
 *      elapses, the NEXT `ensureRunning(...)` call auto-clears it and
 *      attempts a fresh spawn with a full failure budget — no operator
 *      or caller has to remember to invoke `resetFailure(...)`, though
 *      it remains available for an immediate manual retry.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
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

function makeFakeProc(pid = 99999): FakeProc {
  const proc: FakeProc = {
    exitCode: null,
    signalCode: null,
    killed: false,
    pid,
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

function insertRunningSlot(mgr: WorkerRuntimeManager, projectId: string, pid = 99999) {
  const proc = makeFakeProc(pid);
  const slot = {
    projectId,
    agentPort: 0,
    apiServerPort: 0,
    status: 'running' as const,
    proc,
    pid,
    startedAt: Date.now(),
    lastUsedAt: Date.now(),
    restarts: 0,
    consecutiveFailures: 0,
    lastFailureAt: 0,
    breakerTrips: 0,
    restartTimestamps: [] as number[],
    graceTimer: null,
    restartTimer: null,
    idleTimer: null,
    spawnConfig: {} as never,
    startPromise: null,
  };
  (mgr as unknown as { runtimes: Map<string, typeof slot> }).runtimes.set(projectId, slot);
  return slot;
}

function handleExit(
  mgr: WorkerRuntimeManager,
  slot: ReturnType<typeof insertRunningSlot>,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  (mgr as unknown as {
    handleExit: (s: typeof slot, c: number | null, sg: NodeJS.Signals | null) => void;
  }).handleExit(slot, code, signal);
}

const SILENT = { log: () => {}, warn: () => {}, error: () => {} } as const;

// Capture process.kill calls so we can pin that handleExit reaps the
// process group (negative pid argument) instead of just the parent.
type KillCall = { target: number; signal: NodeJS.Signals | number | undefined };
let killCalls: KillCall[] = [];
const realProcessKill = process.kill;

beforeEach(() => {
  killCalls = [];
  // Replace process.kill with a spy that ALSO doesn't actually signal
  // anything (the fake pid 99999 might collide with a real process on
  // the CI host).
  (process as unknown as { kill: typeof process.kill }).kill = ((
    pid: number,
    signal?: NodeJS.Signals | number,
  ) => {
    killCalls.push({ target: pid, signal });
    return true;
  }) as typeof process.kill;
});

afterEach(() => {
  (process as unknown as { kill: typeof process.kill }).kill = realProcessKill;
});

describe('WorkerRuntimeManager process-group reaping on non-clean exit', () => {
  it('non-clean exit fires SIGKILL at the negative pid (the process group)', () => {
    const mgr = new WorkerRuntimeManager({ logger: SILENT });
    const slot = insertRunningSlot(mgr, 'proj-reap', 12345);

    handleExit(mgr, slot, null, 'SIGKILL');

    const pgKills = killCalls.filter((c) => c.target === -12345);
    if (process.platform === 'win32') {
      // killProcessGroup is a no-op on Windows; the inner preview-manager
      // owns its own port-scoped reaper there.
      expect(pgKills).toHaveLength(0);
    } else {
      expect(pgKills).toHaveLength(1);
      expect(pgKills[0]!.signal).toBe('SIGKILL');
    }
  });

  it('clean exit (code=0, signal=null) does NOT reap the process group', () => {
    const mgr = new WorkerRuntimeManager({ logger: SILENT });
    const slot = insertRunningSlot(mgr, 'proj-clean', 12346);

    handleExit(mgr, slot, 0, null);

    expect(killCalls.filter((c) => c.target === -12346)).toHaveLength(0);
    // Slot is removed from the map on clean exit.
    const runtimes = (mgr as unknown as { runtimes: Map<string, unknown> }).runtimes;
    expect(runtimes.has('proj-clean')).toBe(false);
  });

  it('handleExit clears the recorded pid so a follow-up call is a no-op', () => {
    const mgr = new WorkerRuntimeManager({ logger: SILENT });
    const slot = insertRunningSlot(mgr, 'proj-pid-clear', 12347);

    handleExit(mgr, slot, null, 'SIGKILL');
    expect(slot.pid).toBeNull();

    killCalls = [];
    handleExit(mgr, slot, null, 'SIGKILL');
    // No pid recorded → no further -pid kills should be issued.
    expect(killCalls.filter((c) => c.target === -12347)).toHaveLength(0);
  });
});

describe('WorkerRuntimeManager circuit breaker on consecutive failures', () => {
  it('parks the slot in failed after MAX_CONSECUTIVE_RESTARTS consecutive jetsam SIGKILLs', () => {
    const mgr = new WorkerRuntimeManager({ logger: SILENT });
    const slot = insertRunningSlot(mgr, 'proj-jetsam', 22222);

    // 8 is the constant in runtime-manager.ts; if it changes the
    // assertion below has to follow. Hard-coding the expected count
    // here surfaces the contract change at review time.
    for (let i = 0; i < 8; i++) {
      handleExit(mgr, slot, null, 'SIGKILL');
    }

    expect(slot.status).toBe('failed');
    expect(slot.consecutiveFailures).toBe(8);
    expect(slot.restartTimer).toBeNull();
    expect(slot.lastError).toMatch(/Circuit breaker tripped/);
    // The port is released so a future resetFailure() can re-allocate
    // from a clean state.
    expect(slot.agentPort).toBe(0);
    expect(slot.apiServerPort).toBe(0);
  });

  it('still schedules a restart on the Nth non-clean exit when N < MAX', () => {
    const mgr = new WorkerRuntimeManager({ logger: SILENT });
    const slot = insertRunningSlot(mgr, 'proj-retry', 22223);

    for (let i = 0; i < 3; i++) {
      handleExit(mgr, slot, null, 'SIGKILL');
    }

    expect(slot.status).toBe('restarting');
    expect(slot.consecutiveFailures).toBe(3);
    expect(slot.restartTimer).not.toBeNull();
    // Clean up the scheduled timer so the test runner exits.
    if (slot.restartTimer) {
      clearTimeout(slot.restartTimer);
      slot.restartTimer = null;
    }
  });

  it('clean exit between failures does NOT increment the failure budget', () => {
    const mgr = new WorkerRuntimeManager({ logger: SILENT });
    const slot = insertRunningSlot(mgr, 'proj-mixed', 22224);

    handleExit(mgr, slot, null, 'SIGKILL');
    expect(slot.consecutiveFailures).toBe(1);

    // A clean exit removes the slot from the map. Re-insert a fresh
    // slot to model "user reopened the project after a healthy
    // shutdown" — its failure budget should be the default zero, not
    // a continuation of the previous slot's counter.
    handleExit(mgr, slot, 0, null);
    const runtimes = (mgr as unknown as { runtimes: Map<string, unknown> }).runtimes;
    expect(runtimes.has('proj-mixed')).toBe(false);

    const freshSlot = insertRunningSlot(mgr, 'proj-mixed', 22225);
    expect(freshSlot.consecutiveFailures).toBe(0);
  });

  it('a failure OUTSIDE the rolling window resets the counter to 1', () => {
    const mgr = new WorkerRuntimeManager({ logger: SILENT });
    const slot = insertRunningSlot(mgr, 'proj-window', 22226);

    handleExit(mgr, slot, null, 'SIGKILL');
    expect(slot.consecutiveFailures).toBe(1);
    if (slot.restartTimer) { clearTimeout(slot.restartTimer); slot.restartTimer = null; }

    // Backdate the last failure to outside the window (default 5min).
    // Date.now() is stable enough inside one test run; we just shift
    // the recorded timestamp into the past.
    slot.lastFailureAt = Date.now() - (10 * 60 * 1000);

    handleExit(mgr, slot, null, 'SIGKILL');
    expect(slot.consecutiveFailures).toBe(1);
    if (slot.restartTimer) { clearTimeout(slot.restartTimer); slot.restartTimer = null; }
  });

  it('exits triggered by stop() (status=stopping) do NOT count toward the failure budget', () => {
    const mgr = new WorkerRuntimeManager({ logger: SILENT });
    const slot = insertRunningSlot(mgr, 'proj-stop', 22227);
    slot.status = 'stopping';

    handleExit(mgr, slot, null, 'SIGTERM');

    expect(slot.consecutiveFailures).toBe(0);
    expect(slot.status).toBe('stopped');
    // And the process group is NOT re-reaped — stop() already did that
    // before signalling the parent.
    expect(killCalls.filter((c) => c.target === -22227)).toHaveLength(0);
  });
});

describe('WorkerRuntimeManager resetFailure', () => {
  it('clears a failed slot so the next ensureRunning can re-spawn', () => {
    const mgr = new WorkerRuntimeManager({ logger: SILENT });
    const slot = insertRunningSlot(mgr, 'proj-reset', 33333);
    for (let i = 0; i < 8; i++) handleExit(mgr, slot, null, 'SIGKILL');
    expect(slot.status).toBe('failed');

    const reset = mgr.resetFailure('proj-reset');
    expect(reset).toBe(true);

    const runtimes = (mgr as unknown as { runtimes: Map<string, unknown> }).runtimes;
    expect(runtimes.has('proj-reset')).toBe(false);
  });

  it('returns false for a running slot — guard against accidental resets', () => {
    const mgr = new WorkerRuntimeManager({ logger: SILENT });
    insertRunningSlot(mgr, 'proj-running', 33334);

    expect(mgr.resetFailure('proj-running')).toBe(false);
    const runtimes = (mgr as unknown as { runtimes: Map<string, unknown> }).runtimes;
    // Slot is preserved when resetFailure is a no-op.
    expect(runtimes.has('proj-running')).toBe(true);
  });

  it('returns false for an unknown projectId', () => {
    const mgr = new WorkerRuntimeManager({ logger: SILENT });
    expect(mgr.resetFailure('does-not-exist')).toBe(false);
  });
});

describe('WorkerRuntimeManager.ensureRunning refuses failed slots', () => {
  it('throws a directive error pointing at resetFailure when the slot is parked', async () => {
    const mgr = new WorkerRuntimeManager({ logger: SILENT });
    const slot = insertRunningSlot(mgr, 'proj-locked', 44444);
    for (let i = 0; i < 8; i++) handleExit(mgr, slot, null, 'SIGKILL');

    // The fake spawn config isn't reached — ensureRunning guards on
    // status before doStart — so we can pass an empty object.
    await expect(
      mgr.ensureRunning('proj-locked', {
        cloudUrl: 'https://example.invalid',
        apiKey: 'unused',
      }),
    ).rejects.toThrow(/Circuit breaker tripped|resetFailure/);
  });
});

const spawnConfig = {
  cloudUrl: 'https://example.invalid',
  apiKey: 'unused',
} as never;

describe('WorkerRuntimeManager auto-heal (self-healing circuit breaker)', () => {
  it('still refuses a failed slot before its cooldown has elapsed', async () => {
    const mgr = new WorkerRuntimeManager({ logger: SILENT });
    const slot = insertRunningSlot(mgr, 'proj-too-soon', 55551);
    for (let i = 0; i < 8; i++) handleExit(mgr, slot, null, 'SIGKILL');
    expect(slot.status).toBe('failed');
    expect(slot.breakerTrips).toBe(1);

    await expect(mgr.ensureRunning('proj-too-soon', spawnConfig)).rejects.toThrow(
      /Will auto-retry in ~\d+s/,
    );
    // Refusing doesn't itself count as another trip.
    expect(slot.breakerTrips).toBe(1);
    expect(slot.status).toBe('failed');
  });

  it('auto-heals once the cooldown elapses, without anyone calling resetFailure', async () => {
    const mgr = new WorkerRuntimeManager({ logger: SILENT });
    const slot = insertRunningSlot(mgr, 'proj-cooldown', 55552);
    for (let i = 0; i < 8; i++) handleExit(mgr, slot, null, 'SIGKILL');
    expect(slot.status).toBe('failed');

    // Backdate past the 2-minute base cooldown for trip #1.
    slot.lastFailureAt = Date.now() - (2 * 60 * 1000 + 1_000);

    // No `autoPull`/`projectDir` is configured on this bare manager, so
    // the call still fails — but on a DIFFERENT, unrelated error (a
    // workspace-misconfiguration, not the circuit breaker). That proves
    // `ensureRunning` fell through the breaker guard and actually
    // attempted a fresh start instead of refusing outright.
    let caught: Error | null = null;
    try {
      await mgr.ensureRunning('proj-cooldown', spawnConfig);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).not.toMatch(/cannot ensureRunning|Circuit breaker tripped/);
    // The slot moved off `'failed'` — the breaker is no longer open.
    expect(slot.status).not.toBe('failed');
  });

  it('escalates the cooldown on repeated trips (2m -> 4m)', async () => {
    const mgr = new WorkerRuntimeManager({ logger: SILENT });
    const slot = insertRunningSlot(mgr, 'proj-escalate', 55553);
    for (let i = 0; i < 8; i++) handleExit(mgr, slot, null, 'SIGKILL');
    expect(slot.breakerTrips).toBe(1);

    // Elapse the first (2m) cooldown and let it auto-heal + immediately
    // re-trip (still no projectDir configured, but that's irrelevant here
    // — we only care about the breaker bookkeeping around the 2nd trip).
    slot.lastFailureAt = Date.now() - (2 * 60 * 1000 + 1_000);
    try { await mgr.ensureRunning('proj-escalate', spawnConfig); } catch { /* expected */ }

    // Re-insert as a running slot (ensureRunning's failed attempt didn't
    // leave it running) and drive it back into `'failed'` a second time.
    const slot2 = insertRunningSlot(mgr, 'proj-escalate', 55554);
    slot2.breakerTrips = slot.breakerTrips; // carry the trip count forward
    for (let i = 0; i < 8; i++) handleExit(mgr, slot2, null, 'SIGKILL');
    expect(slot2.breakerTrips).toBe(2);

    // Trip #2's cooldown should be double trip #1's (4m, not 2m): backdating
    // by just over 2m must NOT be enough to auto-heal yet.
    slot2.lastFailureAt = Date.now() - (2 * 60 * 1000 + 1_000);
    await expect(mgr.ensureRunning('proj-escalate', spawnConfig)).rejects.toThrow(
      /Will auto-retry/,
    );
    expect(slot2.status).toBe('failed');
  });

  it('healBreaker gives the project a fresh consecutiveFailures budget', async () => {
    const mgr = new WorkerRuntimeManager({ logger: SILENT });
    const slot = insertRunningSlot(mgr, 'proj-fresh-budget', 55555);
    for (let i = 0; i < 8; i++) handleExit(mgr, slot, null, 'SIGKILL');
    expect(slot.consecutiveFailures).toBe(8);

    slot.lastFailureAt = Date.now() - (2 * 60 * 1000 + 1_000);
    try { await mgr.ensureRunning('proj-fresh-budget', spawnConfig); } catch { /* expected */ }

    expect(slot.consecutiveFailures).toBe(0);
  });
});
