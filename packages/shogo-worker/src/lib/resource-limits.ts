// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cross-platform resource limits for host-spawned agent-runtime process groups.
 *
 * A single project runtime is a tree: `bun run agent-runtime` -> vite build
 * --watch, `bun run server.tsx`, tsserver, pyright, expo, etc. Left unbounded
 * its RSS climbs until the OS OOM-kills it (macOS jetsam SIGKILL is the
 * canonical case), taking the whole app's memory with it. We cap each tree,
 * using the strongest primitive each platform offers:
 *
 *   - Linux:   cgroup v2. Prefer a transient `systemd-run --scope` (no root,
 *              hard `memory.max`/`cpu.max`/`pids.max`), fall back to writing a
 *              cgroup directly, fall back to the RSS watchdog.
 *   - Windows: a Job Object with ProcessMemoryLimit + KILL_ON_JOB_CLOSE via an
 *              optional native helper; fall back to the RSS watchdog.
 *   - macOS:   no cgroups and RLIMIT_AS is unreliable for JIT/mmap-heavy Bun,
 *              so an RSS watchdog samples the process group and asks the
 *              manager to restart on breach.
 *
 * The JS-heap env cap (see {@link applyHeapEnvCap}) is a secondary hint layered
 * on top everywhere — OS-level limits are the real enforcement.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RuntimeResourceLimits {
  /** Per-project RAM ceiling in MB. Always > 0 when limits are active. */
  memoryMB: number;
  /** CPU ceiling as percent of ONE core (100 = one full core). 0 = no cap. */
  cpuPercent: number;
  /** Max tasks/pids in the group (cgroup pids.max). */
  tasksMax: number;
}

type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

/** cgroup CPU period in microseconds (100ms), the systemd/cgroup default. */
const CPU_PERIOD_US = 100_000;

/**
 * Resolve the active resource limits from the environment. Returns `null` when
 * no ceiling is configured (`RUNTIME_MEMORY_MB` unset or <= 0), which disables
 * all enforcement for backwards compatibility.
 */
export function resolveResourceLimits(env: NodeJS.ProcessEnv): RuntimeResourceLimits | null {
  const mb = parseInt(env.RUNTIME_MEMORY_MB || '', 10);
  if (!Number.isFinite(mb) || mb <= 0) return null;

  const cpuRaw = parseInt(env.RUNTIME_CPU_PERCENT || '0', 10);
  const cpuPercent = Number.isFinite(cpuRaw) && cpuRaw > 0 ? cpuRaw : 0;

  const tasksRaw = parseInt(env.RUNTIME_TASKS_MAX || '', 10);
  const tasksMax = Number.isFinite(tasksRaw) && tasksRaw > 0 ? tasksRaw : 4096;

  return { memoryMB: mb, cpuPercent, tasksMax };
}

/**
 * Append a JS-heap ceiling to `NODE_OPTIONS` (mutates `env` in place).
 *
 * This bounds the V8/JSC old-space of Node children (tsserver, vite, esbuild)
 * and modern Bun, which honours `--max-old-space-size`. It does NOT bound
 * native RSS, so it is only a hint — the OS-level limit is the real cap. We
 * size it below the RSS ceiling (~75%) so the heap limit trips (recoverable
 * JS OOM) before the native RSS watchdog / cgroup kill does.
 */
export function applyHeapEnvCap(env: NodeJS.ProcessEnv, memoryMB: number): void {
  const heapMB = Math.max(256, Math.floor(memoryMB * 0.75));
  const flag = `--max-old-space-size=${heapMB}`;
  const existing = env.NODE_OPTIONS?.trim();
  if (existing) {
    if (/--max-old-space-size=/.test(existing)) return; // caller already set one
    env.NODE_OPTIONS = `${existing} ${flag}`;
  } else {
    env.NODE_OPTIONS = flag;
  }
}

// ─── Linux: cgroup v2 ────────────────────────────────────────────────

/** True if `systemd-run` is usable for a rootless `--user --scope` unit. */
export function hasSystemdRun(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const r = spawnSync('systemd-run', ['--version'], { stdio: 'ignore', timeout: 3000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Wrap a spawn command in a transient rootless cgroup v2 scope via
 * `systemd-run --user --scope`. The child (and everything it forks) runs inside
 * a scope unit with hard `MemoryMax`/`CPUQuota`/`TasksMax`. Returns the original
 * command untouched (`wrapped: false`) on non-Linux or when systemd-run is
 * absent — the caller then falls back to {@link attachDirectCgroup} or the
 * watchdog.
 */
export function wrapSpawnForCgroup(opts: {
  command: string;
  args: string[];
  limits: RuntimeResourceLimits;
  scopeName: string;
  logger?: Logger;
}): { command: string; args: string[]; wrapped: boolean } {
  const { command, args, limits, scopeName, logger } = opts;
  if (process.platform !== 'linux' || !hasSystemdRun()) {
    return { command, args, wrapped: false };
  }

  const props = [
    '-p', `MemoryMax=${limits.memoryMB}M`,
    // MemoryHigh throttles + reclaims before the hard OOM at MemoryMax, so a
    // spiky build is slowed rather than instantly killed.
    '-p', `MemoryHigh=${Math.max(128, Math.floor(limits.memoryMB * 0.9))}M`,
    '-p', `TasksMax=${limits.tasksMax}`,
  ];
  if (limits.cpuPercent > 0) props.push('-p', `CPUQuota=${limits.cpuPercent}%`);

  const wrappedArgs = [
    '--user',
    '--scope',
    '--quiet',
    '--collect', // GC the transient unit as soon as it exits
    `--unit=${scopeName}`,
    ...props,
    '--',
    command,
    ...args,
  ];
  logger?.log(`[resource-limits] wrapping spawn in systemd scope ${scopeName} (MemoryMax=${limits.memoryMB}M)`);
  return { command: 'systemd-run', args: wrappedArgs, wrapped: true };
}

/**
 * Fallback for Linux hosts without systemd: write a cgroup v2 directly and move
 * `pid` (plus its future children) into it. Best-effort — returns `false` when
 * cgroup v2 is unavailable or not writable (the common non-root, non-delegated
 * case), so the caller can start the watchdog instead.
 */
export function attachDirectCgroup(opts: {
  pid: number;
  limits: RuntimeResourceLimits;
  logger?: Logger;
}): boolean {
  const { pid, limits, logger } = opts;
  if (process.platform !== 'linux') return false;

  const root = '/sys/fs/cgroup';
  // cgroup v2 unified hierarchy exposes cgroup.controllers at the root.
  if (!existsSync(join(root, 'cgroup.controllers'))) return false;

  const dir = join(root, 'shogo', `rt-${pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'memory.max'), String(limits.memoryMB * 1024 * 1024));
    if (limits.cpuPercent > 0) {
      const quota = Math.floor((limits.cpuPercent / 100) * CPU_PERIOD_US);
      writeFileSync(join(dir, 'cpu.max'), `${quota} ${CPU_PERIOD_US}`);
    }
    try { writeFileSync(join(dir, 'pids.max'), String(limits.tasksMax)); } catch { /* controller may be absent */ }
    // Moving the pid in also captures children forked after this point.
    writeFileSync(join(dir, 'cgroup.procs'), String(pid));
    logger?.log(`[resource-limits] attached pid ${pid} to cgroup ${dir} (memory.max=${limits.memoryMB}M)`);
    return true;
  } catch (err: any) {
    logger?.warn(`[resource-limits] direct cgroup attach failed for pid ${pid}: ${err?.message ?? err}`);
    return false;
  }
}

// ─── Windows: Job Object (optional native helper) ────────────────────

/**
 * Assign `pid` to a Windows Job Object with a hard process-memory limit and
 * KILL_ON_JOB_CLOSE, using an optional native helper. Node has no built-in Job
 * Object API, so we load a helper lazily:
 *
 *   - a module path in `SHOGO_WINJOB_HELPER`, or
 *   - a `@shogo/winjob` package if installed,
 *
 * exposing `limitProcess(pid, { memoryBytes, killOnClose }): boolean`.
 *
 * Returns `false` when no helper is available so the caller falls back to the
 * RSS watchdog (which also enforces the ceiling on Windows, just via sampling).
 */
export function tryAttachJobObject(opts: {
  pid: number;
  limits: RuntimeResourceLimits;
  logger?: Logger;
}): boolean {
  const { pid, limits, logger } = opts;
  if (process.platform !== 'win32') return false;

  const helperPath = process.env.SHOGO_WINJOB_HELPER || '@shogo/winjob';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const helper = require(helperPath) as {
      limitProcess?: (pid: number, o: { memoryBytes: number; killOnClose: boolean }) => boolean;
    };
    if (typeof helper.limitProcess !== 'function') return false;
    const ok = helper.limitProcess(pid, {
      memoryBytes: limits.memoryMB * 1024 * 1024,
      killOnClose: true,
    });
    if (ok) {
      logger?.log(`[resource-limits] attached pid ${pid} to Job Object (${limits.memoryMB}M)`);
    }
    return ok;
  } catch {
    // Helper not installed — expected on stock installs. Watchdog covers us.
    return false;
  }
}

// ─── RSS watchdog (macOS always; Windows / Linux fallback) ───────────

/**
 * Sum the resident-set size (KB) of the process group led by `pid`.
 *
 *   - POSIX: `ps -o rss= -g <pgid>` (pid is the group leader because the
 *     runtime is spawned `detached`), summed across the group.
 *   - Windows: a PowerShell pass that sums WorkingSet64 of `pid` and all of its
 *     descendants (walking Win32_Process.ParentProcessId).
 *
 * Returns `null` when sampling fails (process gone, tool missing) so the
 * watchdog treats it as "no reading" rather than "0".
 */
export function samplePgidRssKb(pid: number, platform: NodeJS.Platform = process.platform): number | null {
  try {
    if (platform === 'win32') {
      const script =
        `$ErrorActionPreference='SilentlyContinue';` +
        `$root=${pid};` +
        `$all=Get-CimInstance Win32_Process;` +
        `$seen=@{};$stack=New-Object System.Collections.Stack;$stack.Push($root);$sum=0;` +
        `while($stack.Count -gt 0){$id=$stack.Pop();if($seen[$id]){continue};$seen[$id]=$true;` +
        `foreach($p in $all){if($p.ProcessId -eq $id){$sum+=$p.WorkingSetSize};` +
        `if($p.ParentProcessId -eq $id){$stack.Push($p.ProcessId)}}};` +
        `[math]::Floor($sum/1024)`;
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf-8',
        timeout: 10_000,
        windowsHide: true,
      });
      if (r.status !== 0 || !r.stdout) return null;
      const kb = parseInt(r.stdout.trim(), 10);
      return Number.isFinite(kb) ? kb : null;
    }

    // POSIX: sum RSS (KB) of every process in the group.
    const r = spawnSync('ps', ['-o', 'rss=', '-g', String(pid)], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    if (r.status !== 0 || !r.stdout) return null;
    let total = 0;
    let sawRow = false;
    for (const line of r.stdout.split('\n')) {
      const v = parseInt(line.trim(), 10);
      if (Number.isFinite(v)) { total += v; sawRow = true; }
    }
    return sawRow ? total : null;
  } catch {
    return null;
  }
}

/**
 * Periodically samples a process group's RSS and invokes `onBreach` once the
 * ceiling has been exceeded for {@link RssWatchdogOptions.strikes} consecutive
 * samples (so a single transient spike doesn't trigger a restart). Used where
 * no kernel-level cap is available.
 */
export interface RssWatchdogOptions {
  pid: number;
  ceilingMB: number;
  platform?: NodeJS.Platform;
  intervalMs?: number;
  /** Consecutive over-ceiling samples required before onBreach fires. */
  strikes?: number;
  logger?: Logger;
  /** Called with the observed RSS (MB) when the ceiling is breached. */
  onBreach: (rssMB: number) => void;
}

export class RssWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutive = 0;
  private fired = false;
  private readonly pid: number;
  private readonly ceilingMB: number;
  private readonly platform: NodeJS.Platform;
  private readonly intervalMs: number;
  private readonly strikes: number;
  private readonly logger?: Logger;
  private readonly onBreach: (rssMB: number) => void;

  constructor(opts: RssWatchdogOptions) {
    this.pid = opts.pid;
    this.ceilingMB = opts.ceilingMB;
    this.platform = opts.platform ?? process.platform;
    this.intervalMs = opts.intervalMs ?? parseInt(process.env.RUNTIME_RSS_WATCHDOG_MS || '15000', 10);
    this.strikes = opts.strikes ?? parseInt(process.env.RUNTIME_RSS_WATCHDOG_STRIKES || '2', 10);
    this.logger = opts.logger;
    this.onBreach = opts.onBreach;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sample(), Math.max(2000, this.intervalMs));
    try { this.timer.unref?.(); } catch { /* unref is best-effort */ }
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private sample(): void {
    if (this.fired) return;
    const kb = samplePgidRssKb(this.pid, this.platform);
    if (kb == null) { this.consecutive = 0; return; }
    const rssMB = Math.floor(kb / 1024);
    if (rssMB <= this.ceilingMB) { this.consecutive = 0; return; }

    this.consecutive += 1;
    this.logger?.warn(
      `[resource-limits] pid ${this.pid} RSS ${rssMB}MB over ceiling ${this.ceilingMB}MB ` +
        `(strike ${this.consecutive}/${this.strikes})`,
    );
    if (this.consecutive >= this.strikes) {
      this.fired = true;
      this.stop();
      this.onBreach(rssMB);
    }
  }
}
