// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-203 acceptance — "applied live, with no app or runtime restart".
 *
 * The unit tests cover the pieces: the writer, the reader, the `systemctl` args.
 * This one covers the wiring that only exists at runtime — `WorkerRuntimeManager`
 * noticing the desktop rewrote `host-limits.json` while a runtime is already
 * running, re-resolving the limits so the next spawn and the kernel cap both see
 * the new number, and stopping the watch on shutdown instead of leaking a poller.
 *
 * Without the watch, a Settings change would only land at the next spawn: the
 * exact "you have to restart the app and nothing says so" complaint in the card.
 *
 * Lives in `apps/desktop` for the same reason as the contract test: the worker
 * package is not in any CI matrix leg, so a test there never runs.
 *
 *   bun test apps/desktop/src/__tests__/qa-sho203-live-reapply.acceptance.test.ts
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHostLimits,
  writeHostLimits,
} from '../host-limits';
import { resolveResourceLimits } from '../../../../packages/shogo-worker/src/lib/resource-limits';
import { WorkerRuntimeManager } from '../../../../packages/shogo-worker/src/lib/runtime-manager';

const GB = 1024; // MB
const TOTAL_MB = 128 * GB;

const dir = mkdtempSync(join(tmpdir(), 'qa-sho203-live-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Logged = { lines: string[]; logger: Pick<Console, 'log' | 'warn' | 'error'> };

function capture(): Logged {
  const lines: string[] = [];
  const push = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  return { lines, logger: { log: push, warn: push, error: push } };
}

/** The env the desktop's local-server hands the API on boot (local-server.ts). */
function desktopEnv(file: string): NodeJS.ProcessEnv {
  return {
    RUNTIME_MEMORY_MB: String(8 * GB),
    RUNTIME_CPU_PERCENT: '0',
    SHOGO_HOST_LIMITS_FILE: file,
  };
}

/** Poll until `predicate` holds, or fail with what we did see. */
async function until(predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const changedLines = (lines: string[]) => lines.filter((line) => line.includes('agent-command budget changed'));

describe('SHO-203 live apply — the worker watches the file Settings writes', () => {
  it('re-applies a budget change to a running worker without a restart', async () => {
    const file = writeHostLimits(dir, buildHostLimits('auto', TOTAL_MB)); // 120 GB budget
    const { lines, logger } = capture();
    const mgr = new WorkerRuntimeManager({ env: desktopEnv(file), logger });

    try {
      // A runtime is already up. `cgroupScope: null` keeps this test free of
      // real systemctl/cgroup side effects — the args that path generates are
      // covered in resource-limits-exec-budget.test.ts; what is under test here
      // is that the manager notices the change and walks its live runtimes.
      const runtimes = (mgr as unknown as { runtimes: Map<string, unknown> }).runtimes;
      runtimes.set('proj-live-apply', {
        projectId: 'proj-live-apply',
        pid: 999_999,
        status: 'running',
        cgroupScope: null,
      });

      // What a fresh spawn resolves to before the user touches Settings.
      expect(resolveResourceLimits(desktopEnv(file))!.osMemoryMB).toBe(8 * GB + 120 * GB);

      // The user moves Settings → Memory for agent commands. Only the file
      // changes; the env is the one baked in at spawn and cannot.
      writeHostLimits(dir, buildHostLimits(32 * GB, TOTAL_MB));

      await until(() => changedLines(lines).length > 0, 'the manager to notice the new budget');

      expect(changedLines(lines).join('\n')).toContain(`memory cap now ${8 * GB + 32 * GB}M`);
      expect(changedLines(lines).join('\n')).toContain(`${8 * GB}M runtime + ${32 * GB}M commands`);

      // Future spawns read the re-resolved limits (the memo the manager keeps),
      // so the cgroup/Job Object cap on a restart matches the file too.
      expect(resolveResourceLimits(desktopEnv(file))!.osMemoryMB).toBe(8 * GB + 32 * GB);
      // …and the runtime's own ceiling is untouched by any of it.
      expect(resolveResourceLimits(desktopEnv(file))!.memoryMB).toBe(8 * GB);
    } finally {
      (mgr as unknown as { runtimes: Map<string, unknown> }).runtimes.clear();
      await mgr.stopAll();
    }
  }, 30_000);

  it('stops watching on shutdown, so a stopped worker is not woken by a file write', async () => {
    const file = writeHostLimits(dir, buildHostLimits('auto', TOTAL_MB));
    const { lines, logger } = capture();
    const mgr = new WorkerRuntimeManager({ env: desktopEnv(file), logger });
    await mgr.stopAll();

    writeHostLimits(dir, buildHostLimits(16 * GB, TOTAL_MB));
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(changedLines(lines)).toEqual([]);
  }, 30_000);

  it('a headless worker with no limits file keeps the runtime ceiling for commands', () => {
    // The desktop publishes a file; a `shogo-worker` on a server does not, and
    // must keep its old behaviour (the runtime ceiling bounds commands) rather
    // than silently ending up with no budget at all.
    const limits = resolveResourceLimits({ RUNTIME_MEMORY_MB: String(8 * GB) })!;
    expect(limits.memoryMB).toBe(8 * GB);
    expect(limits.osMemoryMB).toBe(8 * GB);
  });

  it('a worker pointed at a limits file that has not been written yet does not fall back to 8 GB', () => {
    // The desktop sets the path before the first write on a fresh install. The
    // budget must read as "unknown" (guard falls back to the file, cap stays at
    // the ceiling) — never as the runtime's 8 GB ceiling borrowed for commands,
    // which is the bug this card removed.
    const missing = join(dir, 'not-written-yet.json');
    writeFileSync(join(dir, 'unrelated.json'), '{}');
    const limits = resolveResourceLimits({
      RUNTIME_MEMORY_MB: String(8 * GB),
      SHOGO_HOST_LIMITS_FILE: missing,
    })!;
    expect(limits.memoryMB).toBe(8 * GB);
    expect(limits.osMemoryMB).toBe(8 * GB);
  });
});
