// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pins {@link WorkerRuntimeManager.waitForHealth} against the three
 * readiness signals it now considers and the diagnostic behavior on
 * timeout. The historical bug this protects against: agent-runtime
 * cold boots on Windows with `bun --conditions=development run
 * packages/agent-runtime/src/server.ts` routinely take 30-45s just
 * to JIT-compile the TS dep graph (shared-runtime + generators +
 * tools + hooks + gateway). The kernel-level TCP listener is up
 * within ~1-2s of spawn (the moment `Bun.serve()` reads its default
 * export), but the event loop is still saturated for tens of seconds
 * after that, so the old HTTP-only /health gate timed out, SIGTERM'd
 * the still-booting child, and the restart-loop chewed through
 * `MAX_CONSECUTIVE_RESTARTS` before giving up — leaving chat stuck
 * with "Connection timed out — The agent runtime could not be
 * reached".
 *
 * The contracts pinned here:
 *
 *   1. HTTP /health 200 returns immediately — the happy path is
 *      unchanged for healthy runtimes.
 *   2. TCP-listening + recent stdout activity returns successfully
 *      even when /health never responds — handles the cold-boot
 *      saturation case.
 *   3. TCP-listening but stdout silent past STDOUT_PROGRESS_WINDOW_MS
 *      does NOT short-circuit — a truly-wedged process still hits
 *      the hard timeout.
 *   4. Process death (exitCode/signalCode/killed) short-circuits
 *      immediately with the exit info, instead of waiting the full
 *      timeout window.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { WorkerRuntimeManager } from '../runtime-manager.ts';

interface FakeProc {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  pid: number;
}

interface SlotShape {
  projectId: string;
  agentPort: number;
  apiServerPort: number;
  status: string;
  proc: FakeProc;
  pid: number;
  startedAt: number;
  lastStdoutAt: number;
  lastUsedAt: number;
  restarts: number;
  consecutiveFailures: number;
  lastFailureAt: number;
  graceTimer: null;
  restartTimer: null;
  idleTimer: null;
  spawnConfig: unknown;
  startPromise: null;
}

function makeSlot(overrides: Partial<SlotShape> = {}): SlotShape {
  const now = Date.now();
  const proc: FakeProc = {
    exitCode: null,
    signalCode: null,
    killed: false,
    pid: 12345,
  };
  return {
    projectId: 'proj-test',
    agentPort: 41234,
    apiServerPort: 41235,
    status: 'starting',
    proc,
    pid: proc.pid,
    startedAt: now,
    lastStdoutAt: now,
    lastUsedAt: now,
    restarts: 0,
    consecutiveFailures: 0,
    lastFailureAt: 0,
    graceTimer: null,
    restartTimer: null,
    idleTimer: null,
    spawnConfig: {},
    startPromise: null,
    ...overrides,
  };
}

const SILENT = { log: () => {}, warn: () => {}, error: () => {} } as const;

function callWaitForHealth(
  mgr: WorkerRuntimeManager,
  slot: SlotShape,
  timeoutMs: number,
): Promise<void> {
  return (mgr as unknown as {
    waitForHealth: (s: SlotShape, t: number) => Promise<void>;
  }).waitForHealth(slot, timeoutMs);
}

function stubTcpProbe(mgr: WorkerRuntimeManager, listening: boolean | (() => boolean)): void {
  (mgr as unknown as { tcpProbe: (port: number) => Promise<boolean> }).tcpProbe = async () =>
    typeof listening === 'function' ? listening() : listening;
}

const ORIGINAL_FETCH = globalThis.fetch;

describe('WorkerRuntimeManager.waitForHealth (private)', () => {
  let mgr: WorkerRuntimeManager;

  beforeEach(() => {
    mgr = new WorkerRuntimeManager({ logger: SILENT });
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('returns immediately when /health responds 200', async () => {
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch;
    // Even with TCP probe returning false the HTTP fast path wins.
    stubTcpProbe(mgr, false);

    const slot = makeSlot();
    const startedAt = Date.now();
    await callWaitForHealth(mgr, slot, 5_000);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it(
    'accepts TCP-listening + recent stdout activity as ready when /health keeps failing',
    async () => {
      // Reproduces the Windows `--conditions=development` cold-boot:
      // Bun.serve has bound the port (kernel-level listener up) and
      // the child is still emitting log lines (LSP-TS init,
      // preview-manager spawn, vite build), but /health is starved
      // because the event loop is busy JIT-compiling. The wait
      // should accept this as ready instead of timing out for 30s
      // and SIGTERM'ing a still-booting process.
      globalThis.fetch = (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch;
      stubTcpProbe(mgr, true);

      const slot = makeSlot();
      // Keep stdout "fresh" so the progress window stays open.
      const bumper = setInterval(() => {
        slot.lastStdoutAt = Date.now();
      }, 200);

      const startedAt = Date.now();
      try {
        await callWaitForHealth(mgr, slot, 30_000);
      } finally {
        clearInterval(bumper);
      }
      const elapsed = Date.now() - startedAt;
      // Should return within the first iteration or two — TCP probe
      // succeeds + stdout fresh = ready. Hard cap well below the 30s
      // timeout to catch a regression to the legacy 30s spin.
      expect(elapsed).toBeLessThan(5_000);
    },
    15_000,
  );

  it(
    'does NOT accept TCP-listening alone when stdout is silent past the progress window',
    async () => {
      // The silent-but-bound case mimics a process that bound the
      // port and then wedged (infinite loop in top-level code, native
      // crash mid-init that didn't propagate to the parent). The
      // progress window correctly refuses to short-circuit here so
      // the restart loop has a chance to recover.
      globalThis.fetch = (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch;
      stubTcpProbe(mgr, true);

      const slot = makeSlot({
        // Pre-age the stdout timestamp so the window is already
        // closed before the first iteration.
        lastStdoutAt: Date.now() - 60_000,
      });

      await expect(callWaitForHealth(mgr, slot, 1_200)).rejects.toThrow(
        /Timeout waiting for agent-runtime \/health on port 41234.*tcpListening=true/s,
      );
    },
    5_000,
  );

  it('times out cleanly when neither TCP nor HTTP ever come up', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    stubTcpProbe(mgr, false);

    const slot = makeSlot();
    await expect(callWaitForHealth(mgr, slot, 1_200)).rejects.toThrow(
      /Timeout waiting for agent-runtime \/health on port 41234.*tcpListening=false/s,
    );
  });

  it('short-circuits with exit info when the child dies mid-wait', async () => {
    // Without the short-circuit the wait would spin for the full
    // 30s and surface a generic timeout — the operator's first clue
    // to "the process crashed during boot" should be a clear exit
    // code, not the same boilerplate error as a network failure.
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    stubTcpProbe(mgr, false);

    const slot = makeSlot();
    setTimeout(() => {
      slot.proc.exitCode = 1;
    }, 400);

    const startedAt = Date.now();
    await expect(callWaitForHealth(mgr, slot, 30_000)).rejects.toThrow(
      /agent-runtime exited \(code=1, signal=null\) before becoming healthy on port 41234/,
    );
    // 2s is a comfortable ceiling: the inner setTimeout for exitCode
    // fires at 400ms and the wait should observe it within one
    // HEALTH_POLL_MS (500ms) tick.
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  });

  it('detects SIGKILL-style deaths where exitCode stays null', async () => {
    // Mirrors the jetsam-on-macOS case and the `cleanupStaleProcesses`
    // SIGKILL of a previous run that the manager itself fired —
    // exitCode never gets a number, only signalCode flips.
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    stubTcpProbe(mgr, false);

    const slot = makeSlot();
    setTimeout(() => {
      slot.proc.signalCode = 'SIGKILL';
    }, 400);

    await expect(callWaitForHealth(mgr, slot, 30_000)).rejects.toThrow(
      /agent-runtime exited \(code=null, signal=SIGKILL\) before becoming healthy on port 41234/,
    );
  });
});
