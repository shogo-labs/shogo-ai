// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pins {@link WorkerRuntimeManager.waitForHealth} against the readiness
 * contract every downstream caller of `status === 'running'` assumes:
 * the agent runtime can actually serve HTTP, not just "the kernel
 * accepted a TCP listener on the port". The historical context:
 *
 *   - First pass (pre-2026-05): HTTP /health was the only signal. Bun
 *     on Windows takes 30-45s to JIT the runtime TS dep graph during
 *     cold boot, and /health was starved on the busy event loop the
 *     whole time, so the 30s timeout SIGTERM'd the still-booting
 *     child and the restart loop chewed through `MAX_CONSECUTIVE_RESTARTS`.
 *   - Second pass: added a TCP-listening + recent stdout fast path
 *     that returned "ready" as soon as `Bun.serve()` bound the port
 *     and the child kept emitting log lines. This stopped the SIGTERM
 *     storm but tricked `/sandbox/url` into reporting ready before
 *     HTTP actually worked, so the canvas iframe and AgentProxy
 *     started chasing a black hole and surfaced as "Connection timed
 *     out — The agent runtime could not be reached".
 *   - Current pass (2026-05): keep waiting for a real /health 2xx with
 *     HEALTH_BOOT_TIMEOUT_MS=30 s (now realistic on Windows because
 *     LSP + IndexEngine were moved out of the critical-path boot
 *     sequence in agent-runtime). TCP-listening + silent stdout >
 *     STDOUT_PROGRESS_WINDOW_MS=25 s acts as a *wedge detector* —
 *     a child that bound the port but stopped producing output for
 *     25 s is genuinely stuck and the restart loop should recover
 *     it instead of waiting for the hard timeout.
 *
 * The contracts pinned here:
 *
 *   1. HTTP /health 200 returns immediately — the happy path.
 *   2. /health that never responds (with TCP up + stdout fresh) keeps
 *      waiting until the timeout, instead of declaring ready early.
 *   3. TCP-listening but stdout silent past STDOUT_PROGRESS_WINDOW_MS
 *      throws the "wedged" error so restart-with-backoff fires.
 *   4. Neither TCP nor HTTP ever come up → clean timeout error.
 *   5. Process death (exitCode/signalCode/killed) short-circuits
 *      immediately with the exit info.
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
    'keeps waiting for /health even when TCP is up and stdout is fresh',
    async () => {
      // Reproduces the Windows cold-boot saturation pattern: Bun.serve
      // has bound the port and the child is still emitting log lines
      // (LSP-TS init, preview-manager spawn, vite build), but /health
      // never gets event-loop time. The wait must NOT declare the
      // runtime ready on TCP+stdout alone any more — see the file
      // docstring for the canvas-iframe "Connection timed out"
      // regression that fast-path caused. It should keep polling
      // /health and eventually hit the deadline.
      globalThis.fetch = (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch;
      stubTcpProbe(mgr, true);

      const slot = makeSlot();
      // Keep stdout "fresh" so the wedge detector stays quiet — we
      // want to exercise the hard timeout, not the wedge bail-out.
      const bumper = setInterval(() => {
        slot.lastStdoutAt = Date.now();
      }, 200);

      const startedAt = Date.now();
      try {
        await expect(callWaitForHealth(mgr, slot, 1_500)).rejects.toThrow(
          /Timeout waiting for agent-runtime \/health on port 41234.*tcpListening=true/s,
        );
      } finally {
        clearInterval(bumper);
      }
      const elapsed = Date.now() - startedAt;
      // Should have spent close to the full 1.5s window polling
      // /health, not short-circuited early.
      expect(elapsed).toBeGreaterThanOrEqual(1_400);
    },
    5_000,
  );

  it(
    'throws "wedged" when TCP is up and stdout is silent past the progress window',
    async () => {
      // The silent-but-bound case mimics a process that bound the
      // port and then wedged (infinite loop in top-level code, native
      // crash mid-init that didn't propagate to the parent). Bail
      // out fast with a "wedged" error so the restart-with-backoff
      // loop in handleExit() can SIGTERM and respawn, instead of
      // spinning the full HEALTH_BOOT_TIMEOUT_MS for a process that
      // will never recover.
      globalThis.fetch = (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch;
      stubTcpProbe(mgr, true);

      const slot = makeSlot({
        // Pre-age the stdout timestamp so the wedge detector trips
        // on the first iteration. Must exceed STDOUT_PROGRESS_WINDOW_MS
        // (25 s) to fire.
        lastStdoutAt: Date.now() - 30_000,
      });

      // Generous outer timeout — the wedge detector should fire
      // immediately, well before the 30s timeout would.
      const startedAt = Date.now();
      await expect(callWaitForHealth(mgr, slot, 30_000)).rejects.toThrow(
        /agent-runtime wedged on port 41234.*stdout silent for/s,
      );
      expect(Date.now() - startedAt).toBeLessThan(2_500);
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
