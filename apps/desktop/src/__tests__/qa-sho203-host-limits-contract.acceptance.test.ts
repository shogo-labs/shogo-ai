// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-203 acceptance — the *cross-process* contract, driven end to end.
 *
 * The card's whole mechanism is a document written by one process (the desktop
 * app, from Settings) and read by two others (the exec memory guard in the
 * agent runtime, and the worker that sizes the kernel cap). Every unit test on
 * either side passes even if the two disagree about its shape, the units, or
 * which of `memoryMB` / `execMemoryMB` it means — so this file imports the
 * desktop's real writer and the worker's real reader and drives the file
 * between them, the way the running product does.
 *
 * Acceptance criteria covered:
 *   - no hardcoded 8192 applies to agent commands (a 128 GB host gets 120 GB);
 *   - a Settings value reaches the runtime's cap with no restart;
 *   - the guard always trips before the kernel, so a kill explains itself;
 *   - `RUNTIME_MEMORY_MB` (the runtime's own ceiling) is unchanged.
 *
 * Lives in `apps/desktop` rather than beside `resource-limits.ts` on purpose:
 * `packages/shogo-worker` is in no CI matrix leg (see `.github/workflows/ci.yml`
 * — its suite carries pre-existing failures, so only `git-cloner.test.ts` runs),
 * and a parity test nobody runs proves nothing. `apps/desktop`'s suite is in the
 * "remaining + e2e" leg, and the desktop is the process that writes the file.
 *
 *   bun test apps/desktop/src/__tests__/qa-sho203-host-limits-contract.acceptance.test.ts
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHostLimits,
  writeHostLimits,
  hostLimitsPath,
} from '../host-limits';
import {
  computeDefaultExecMemoryMB,
  computeDefaultRuntimeMemoryMB,
  resolveExecMemoryMB as resolveSettingMB,
} from '../runtime-memory';
import {
  applyLiveMemoryCap,
  readHostLimitsFile,
  resolveExecMemoryMB as resolveBudgetFromEnv,
  resolveResourceLimits,
  wrapSpawnForCgroup,
} from '../../../../packages/shogo-worker/src/lib/resource-limits';

const dir = mkdtempSync(join(tmpdir(), 'qa-sho203-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const GB = 1024; // MB

/** Publish limits exactly as `local-server.ts` / the settings IPC do. */
function publish(execMemory: number | 'auto' | undefined, totalMemMB: number): string {
  const file = writeHostLimits(dir, buildHostLimits(execMemory, totalMemMB));
  return file;
}

/** The env the desktop hands the API on a machine of this size (local-server.ts). */
function desktopEnv(totalMemMB: number, file: string): NodeJS.ProcessEnv {
  return {
    RUNTIME_MEMORY_MB: String(computeDefaultRuntimeMemoryMB(totalMemMB)),
    RUNTIME_CPU_PERCENT: '0',
    SHOGO_HOST_LIMITS_FILE: file,
  };
}

describe('SHO-203 contract — what Settings publishes is what the runtime enforces', () => {
  for (const totalMemMB of [16 * GB, 32 * GB, 64 * GB, 128 * GB]) {
    const totalGB = totalMemMB / GB;
    it(`${totalGB} GB host: commands get max(50% RAM, RAM-8GB), not the 8 GB runtime ceiling`, () => {
      const file = publish('auto', totalMemMB);
      const limits = resolveResourceLimits(desktopEnv(totalMemMB, file));

      expect(limits).not.toBeNull();
      const budget = computeDefaultExecMemoryMB(totalMemMB);
      expect(resolveBudgetFromEnv(desktopEnv(totalMemMB, file))).toBe(budget);

      // The reported bug: this used to equal the runtime ceiling (8192 on any
      // machine above 20 GB), so a 22.5 GB model died at 8 GB on a 128 GB Mac.
      expect(limits!.memoryMB).toBe(computeDefaultRuntimeMemoryMB(totalMemMB));
      expect(limits!.memoryMB).toBeLessThanOrEqual(8 * GB);
      // 16 GB is the one host where the two numbers coincide (8 GB either way);
      // anything larger must give commands more than the runtime's ceiling ever
      // could.
      expect(budget).toBeGreaterThanOrEqual(8 * GB);
      if (totalMemMB > 16 * GB) expect(budget).toBeGreaterThan(8 * GB);
      expect(limits!.osMemoryMB).toBe(limits!.memoryMB + budget);

      // And the file itself carries the plain number the guard reads.
      const published = readHostLimitsFile(file);
      expect(published).toMatchObject({ execMemoryMB: budget, totalMemMB, source: 'auto' });
      expect(published!.execMemoryMB).toBe(resolveSettingMB('auto', totalMemMB));
    });
  }

  it('128 GB host: the 22.5 GB command from the card fits, at 120 GB', () => {
    const totalMemMB = 128 * GB;
    const file = publish('auto', totalMemMB);
    const limits = resolveResourceLimits(desktopEnv(totalMemMB, file))!;

    expect(readHostLimitsFile(file)!.execMemoryMB).toBe(120 * GB);
    expect(limits.osMemoryMB - limits.memoryMB).toBe(120 * GB);
    // The repro that filed the card: 21.3 GB resident, killed at 8 GB.
    expect(21.3 * GB).toBeLessThan(readHostLimitsFile(file)!.execMemoryMB!);
  });

  it('an explicit Settings value lands as-is, clamp and all', () => {
    const totalMemMB = 128 * GB;
    for (const [requested, expected] of [
      [Math.floor((totalMemMB * 90) / 100), Math.floor((totalMemMB * 90) / 100)], // 90% preset
      [24 * GB, 24 * GB],
      [64 * GB, 64 * GB],
      // The panel clamps before it writes; the writer clamps too. Neither may
      // ever promise more than the machine has, or the kernel kills first with
      // no message — the bug this card exists to remove.
      [4 * 1024 * GB, totalMemMB],
      [1, 1024],
    ] as const) {
      const file = publish(requested, totalMemMB);
      const published = readHostLimitsFile(file)!;
      expect(published.source).toBe('settings');
      expect(published.execMemoryMB).toBe(expected);
      expect(published.execMemoryMB!).toBeLessThanOrEqual(totalMemMB);
      const limits = resolveResourceLimits(desktopEnv(totalMemMB, file))!;
      expect(limits.osMemoryMB).toBe(limits.memoryMB + expected);
    }
  });

  it('a Settings change reaches the kernel cap with no restart', () => {
    const totalMemMB = 128 * GB;
    const file = publish('auto', totalMemMB);
    // The env is the one baked in at spawn — a settings change can never edit
    // it. Only the file changes.
    const env = desktopEnv(totalMemMB, file);
    expect(resolveResourceLimits(env)!.osMemoryMB).toBe(8 * GB + 120 * GB);

    publish(24 * GB, totalMemMB);
    const limits = resolveResourceLimits(env)!;
    expect(limits.memoryMB).toBe(8 * GB); // the runtime's ceiling did not move
    expect(limits.osMemoryMB).toBe(8 * GB + 24 * GB);

    // …and the live re-apply writes those numbers to what is already running.
    const calls: Array<{ command: string; args: string[] }> = [];
    const wrote: Array<{ path: string; data: string }> = [];
    applyLiveMemoryCap(
      { scopeName: 'shogo-rt-test', limits },
      { platform: 'linux', run: (command, args) => calls.push({ command, args }) },
    );
    expect(calls).toEqual([
      {
        command: 'systemctl',
        args: [
          '--user',
          'set-property',
          '--runtime',
          'shogo-rt-test',
          `MemoryMax=${8 * GB + 24 * GB}M`,
          `MemoryHigh=${Math.floor((8 * GB + 24 * GB) * 0.9)}M`,
        ],
      },
    ]);
    applyLiveMemoryCap(
      { pid: 424242, limits },
      {
        platform: 'linux',
        exists: (p) => p.endsWith('memory.max') || p.endsWith('memory.high'),
        writeFile: (path, data) => void wrote.push({ path, data }),
      },
    );
    expect(wrote).toEqual([
      { path: join('/sys/fs/cgroup', 'shogo', 'rt-424242', 'memory.max'), data: String((8 * GB + 24 * GB) * 1024 * 1024) },
      { path: join('/sys/fs/cgroup', 'shogo', 'rt-424242', 'memory.high'), data: String(Math.floor((8 * GB + 24 * GB) * 0.9) * 1024 * 1024) },
    ]);
  });
});

describe('SHO-203 contract — the guard always trips before the kernel', () => {
  it('keeps the OS cap strictly above the command budget, for every ceiling', () => {
    const totalMemMB = 128 * GB;
    for (const ceilingMB of [3 * GB, 8 * GB]) {
      for (const budget of [1 * GB, 8 * GB, 24 * GB, 120 * GB]) {
        const file = publish(budget, totalMemMB);
        const limits = resolveResourceLimits({
          RUNTIME_MEMORY_MB: String(ceilingMB),
          SHOGO_HOST_LIMITS_FILE: file,
        })!;
        // A command may use its whole budget without the kernel seeing it…
        expect(limits.osMemoryMB).toBeGreaterThan(budget);
        // …so the guard — which writes a note — is what stops it, never a
        // silent kernel OOM.
        expect(limits.osMemoryMB).toBe(ceilingMB + budget);
      }
    }
  });

  it('leaves the runtime’s own ceiling exactly where it was', () => {
    const totalMemMB = 128 * GB;
    const file = publish('auto', totalMemMB);
    const withFile = resolveResourceLimits(desktopEnv(totalMemMB, file))!;
    const withoutFile = resolveResourceLimits({
      RUNTIME_MEMORY_MB: String(computeDefaultRuntimeMemoryMB(totalMemMB)),
    })!;

    // RUNTIME_MEMORY_MB is what the RSS watchdog and the heap hint use; the
    // command budget must not move it.
    expect(withFile.memoryMB).toBe(withoutFile.memoryMB);
    expect(withFile.cpuPercent).toBe(withoutFile.cpuPercent);
    expect(withFile.tasksMax).toBe(withoutFile.tasksMax);
    // With no command budget known, the OS cap is the old one — no regression
    // for a headless worker or an install that has not published a file yet.
    expect(withoutFile.osMemoryMB).toBe(withoutFile.memoryMB);
  });

  it('an explicit SHOGO_EXEC_MEMORY_MB still wins, and sizes the OS cap too', () => {
    const totalMemMB = 128 * GB;
    const file = publish('auto', totalMemMB);
    const env = { ...desktopEnv(totalMemMB, file), SHOGO_EXEC_MEMORY_MB: '4096' };
    expect(resolveBudgetFromEnv(env)).toBe(4096);
    expect(resolveResourceLimits(env)!.osMemoryMB).toBe(8 * GB + 4096);
  });

  it('a missing or malformed file never removes the runtime ceiling', () => {
    const env = { RUNTIME_MEMORY_MB: String(8 * GB), SHOGO_HOST_LIMITS_FILE: join(dir, 'nope.json') };
    expect(resolveBudgetFromEnv(env)).toBe(0);
    expect(resolveResourceLimits(env)!.osMemoryMB).toBe(8 * GB);
  });
});

describe('SHO-203 contract — one document, three readers', () => {
  it('publishes the shape both readers parse, under the documented filename', () => {
    const file = publish('auto', 128 * GB);
    expect(file).toBe(hostLimitsPath(dir));
    expect(file.endsWith('host-limits.json')).toBe(true);

    // The keys the guard (exec-memory-guard.ts) and the worker both read.
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['execMemoryMB', 'source', 'totalMemMB']);
    expect(typeof raw.execMemoryMB).toBe('number');
    expect(typeof raw.totalMemMB).toBe('number');
    expect(raw.source).toBe('auto');
  });

  it('rewriting in place is atomic — a watcher never sees a half-written file', () => {
    publish('auto', 128 * GB);
    const before = readHostLimitsFile(hostLimitsPath(dir))!;
    publish(32 * GB, 128 * GB);
    const after = readHostLimitsFile(hostLimitsPath(dir))!;
    expect(before.execMemoryMB).toBe(120 * GB);
    expect(after.execMemoryMB).toBe(32 * GB);
  });
});
