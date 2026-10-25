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
import { execFile, spawnSync } from './child-process.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RuntimeResourceLimits {
  /** Per-project RAM ceiling in MB for the runtime's OWN processes. Always > 0
   *  when limits are active. Not the budget for the commands an agent runs. */
  memoryMB: number;
  /** Hard OS cap for the whole process tree in MB: {@link memoryMB} plus the
   *  agent-command budget. The exec guard (which writes a note) must trip before
   *  the kernel (which writes nothing), so the kernel cap has to sit above it. */
  osMemoryMB: number;
  /** CPU ceiling as percent of ONE core (100 = one full core). 0 = no cap. */
  cpuPercent: number;
  /** Max tasks/pids in the group (cgroup pids.max). */
  tasksMax: number;
}

type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

/** cgroup CPU period in microseconds (100ms), the systemd/cgroup default. */
const CPU_PERIOD_US = 100_000;

/** `host-limits.json`, as published by the desktop app (SHO-203). */
export interface HostLimitsFile {
  /** MB the agent's `exec` commands may use. */
  execMemoryMB?: number;
  /** Total physical RAM of the machine, for messages. */
  totalMemMB?: number;
  source?: 'auto' | 'settings';
}

/** Parse `host-limits.json`. Missing or malformed reads as `null`. */
export function readHostLimitsFile(path: string): HostLimitsFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as HostLimitsFile;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The command budget from the environment: an explicit `SHOGO_EXEC_MEMORY_MB`
 * (headless worker, tests) wins, otherwise the watched `host-limits.json`.
 * 0 = no budget known.
 */
export function resolveExecMemoryMB(env: NodeJS.ProcessEnv): number {
  const explicit = parseInt(env.SHOGO_EXEC_MEMORY_MB || '', 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (!env.SHOGO_HOST_LIMITS_FILE) return 0;
  const mb = readHostLimitsFile(env.SHOGO_HOST_LIMITS_FILE)?.execMemoryMB;
  return typeof mb === 'number' && Number.isFinite(mb) && mb > 0 ? Math.floor(mb) : 0;
}

/**
 * Resolve the active resource limits from the environment. Returns `null` when
 * no ceiling is configured (`RUNTIME_MEMORY_MB` unset or <= 0), which disables
 * all enforcement for backwards compatibility.
 *
 * `memoryMB` stays the runtime's own leak ceiling (the RSS watchdog and the heap
 * cap use it). `osMemoryMB` is the kernel-level cap for the whole tree, raised
 * by the agent-command budget so a big `exec` command is stopped by the guard —
 * which writes an actionable note — instead of silently OOM-killed (SHO-203).
 */
export function resolveResourceLimits(env: NodeJS.ProcessEnv): RuntimeResourceLimits | null {
  const mb = parseInt(env.RUNTIME_MEMORY_MB || '', 10);
  if (!Number.isFinite(mb) || mb <= 0) return null;

  const cpuRaw = parseInt(env.RUNTIME_CPU_PERCENT || '0', 10);
  const cpuPercent = Number.isFinite(cpuRaw) && cpuRaw > 0 ? cpuRaw : 0;

  const tasksRaw = parseInt(env.RUNTIME_TASKS_MAX || '', 10);
  const tasksMax = Number.isFinite(tasksRaw) && tasksRaw > 0 ? tasksRaw : 4096;

  return { memoryMB: mb, osMemoryMB: mb + resolveExecMemoryMB(env), cpuPercent, tasksMax };
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
 *
 * The cap is `limits.osMemoryMB` (runtime ceiling + agent-command budget): the
 * scope holds the runtime's own processes *and* the `exec` shells it spawns, so
 * sized to the runtime ceiling alone it killed a 22.5 GB command on a 128 GB
 * machine with no message (SHO-203).
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
    '-p', `MemoryMax=${limits.osMemoryMB}M`,
    // MemoryHigh throttles + reclaims before the hard OOM at MemoryMax, so a
    // spiky build is slowed rather than instantly killed.
    '-p', `MemoryHigh=${memoryHighMB(limits.osMemoryMB)}M`,
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
  logger?.log(`[resource-limits] wrapping spawn in systemd scope ${scopeName} (MemoryMax=${limits.osMemoryMB}M)`);
  return { command: 'systemd-run', args: wrappedArgs, wrapped: true };
}

/** Soft cap for a hard cap: 10% below, so reclaim starts before the OOM. */
function memoryHighMB(memoryMB: number): number {
  return Math.max(128, Math.floor(memoryMB * 0.9));
}

/** The cgroup v2 directory {@link attachDirectCgroup} puts a runtime in. */
export function directCgroupDir(pid: number): string {
  return join('/sys/fs/cgroup', 'shogo', `rt-${pid}`);
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

  const dir = directCgroupDir(pid);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'memory.max'), String(limits.osMemoryMB * 1024 * 1024));
    if (limits.cpuPercent > 0) {
      const quota = Math.floor((limits.cpuPercent / 100) * CPU_PERIOD_US);
      writeFileSync(join(dir, 'cpu.max'), `${quota} ${CPU_PERIOD_US}`);
    }
    try { writeFileSync(join(dir, 'pids.max'), String(limits.tasksMax)); } catch { /* controller may be absent */ }
    // Moving the pid in also captures children forked after this point.
    writeFileSync(join(dir, 'cgroup.procs'), String(pid));
    logger?.log(`[resource-limits] attached pid ${pid} to cgroup ${dir} (memory.max=${limits.osMemoryMB}M)`);
    return true;
  } catch (err: any) {
    logger?.warn(`[resource-limits] direct cgroup attach failed for pid ${pid}: ${err?.message ?? err}`);
    return false;
  }
}

// ─── Live re-apply (SHO-203) ─────────────────────────────────────────

export interface LiveMemoryCapOptions {
  /** Runtime process group id, used for a direct cgroup. */
  pid?: number | null;
  /** `systemd-run --scope` unit name, when the spawn was cgroup-wrapped. */
  scopeName?: string | null;
  limits: RuntimeResourceLimits;
  logger?: Logger;
}

/** Swappable effects, so the generated `systemctl` args / file write are testable. */
export interface LiveMemoryCapDeps {
  platform?: NodeJS.Platform;
  run?: (command: string, args: string[]) => void;
  writeFile?: (path: string, data: string) => void;
  exists?: (path: string) => boolean;
}

/**
 * Re-apply the memory cap to a runtime that is already running, after the
 * agent-command budget changed. Without this a raised budget would only land
 * on the next spawn — an app restart — which is exactly the complaint in
 * SHO-203.
 *
 *   - Linux + systemd scope: `systemctl --user set-property --runtime`.
 *   - Linux + direct cgroup: rewrite `memory.max` (and `memory.high`).
 *   - Windows: the Job Object's limit is fixed at assign time; there is no API
 *     to change it in place, so it lands on the next spawn (the RSS watchdog
 *     covers the gap).
 *   - macOS: the watchdog reads the budget from the limits file itself, so
 *     nothing to do here.
 */
export function applyLiveMemoryCap(
  opts: LiveMemoryCapOptions,
  deps: LiveMemoryCapDeps = {},
): boolean {
  const platform = deps.platform ?? process.platform;
  const { limits, logger } = opts;
  if (platform === 'win32') {
    logger?.log('[resource-limits] Job Object memory limit applies on the next runtime spawn');
    return false;
  }
  if (platform !== 'linux') return false;

  if (opts.scopeName) {
    const args = [
      '--user',
      'set-property',
      '--runtime',
      opts.scopeName,
      `MemoryMax=${limits.osMemoryMB}M`,
      `MemoryHigh=${memoryHighMB(limits.osMemoryMB)}M`,
    ];
    if (deps.run) {
      deps.run('systemctl', args);
      return true;
    }
    execFile('systemctl', args, { timeout: 5000 }, (err) => {
      if (err) {
        logger?.warn(`[resource-limits] set-property ${opts.scopeName} failed: ${err.message}`);
      } else {
        logger?.log(`[resource-limits] ${opts.scopeName} MemoryMax=${limits.osMemoryMB}M`);
      }
    });
    return true;
  }

  if (!opts.pid) return false;
  const dir = directCgroupDir(opts.pid);
  const exists = deps.exists ?? existsSync;
  const write = deps.writeFile ?? writeFileSync;
  try {
    if (!exists(join(dir, 'memory.max'))) return false;
    write(join(dir, 'memory.max'), String(limits.osMemoryMB * 1024 * 1024));
    if (exists(join(dir, 'memory.high'))) {
      write(join(dir, 'memory.high'), String(memoryHighMB(limits.osMemoryMB) * 1024 * 1024));
    }
    logger?.log(`[resource-limits] raised cgroup ${dir} memory.max to ${limits.osMemoryMB}M`);
    return true;
  } catch (err: any) {
    logger?.warn(`[resource-limits] live cgroup update failed for ${dir}: ${err?.message ?? err}`);
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
      memoryBytes: limits.osMemoryMB * 1024 * 1024,
      killOnClose: true,
    });
    if (ok) {
      logger?.log(`[resource-limits] attached pid ${pid} to Job Object (${limits.osMemoryMB}M)`);
    }
    return ok;
  } catch {
    // Helper not installed — expected on stock installs. Watchdog covers us.
    return false;
  }
}

// ─── RSS watchdog (macOS always; Windows / Linux fallback) ───────────

/**
 * Read the PIDs the agent runtime publishes at SHOGO_EXEC_PIDS_FILE: a JSON
 * `{ "pids": number[] }` of its live `exec` shells. Missing or malformed files
 * read as no PIDs.
 */
export function readExecPidsFile(path: string): number[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { pids?: unknown };
    if (!Array.isArray(parsed.pids)) return [];
    return parsed.pids.filter((p): p is number => Number.isInteger(p) && (p as number) > 0);
  } catch {
    return [];
  }
}

/** One process in a {@link snapshotProcesses} table. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Process group id. Always 0 on Windows, which has no groups. */
  pgid: number;
  /** Resident memory: RSS on POSIX, working set on Windows. */
  kb: number;
}

const SNAPSHOT_TIMEOUT_MS = 20_000;

const WINDOWS_SNAPSHOT_SCRIPT =
  `$ErrorActionPreference='SilentlyContinue';` +
  `foreach($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize){` +
  `"$($p.ProcessId) $($p.ParentProcessId) $([math]::Floor($p.WorkingSetSize/1024))"}`;

/**
 * Every process on the machine with its parent, group and memory, read in one
 * asynchronous OS query: one PowerShell pass over Win32_Process on Windows,
 * one `ps` elsewhere. On desktop this runs in the API process, so it must not
 * block: a synchronous PowerShell launch stalls every request for ~0.7s.
 * Resolves `null` when the query fails.
 */
export function snapshotProcesses(platform: NodeJS.Platform = process.platform): Promise<ProcessRow[] | null> {
  const [command, args] = platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SNAPSHOT_SCRIPT]]
    : ['ps', ['-A', '-o', 'pid=,ppid=,pgid=,rss=']];
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf-8', timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) { resolve(null); return; }
      const rows: ProcessRow[] = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/).map((v) => parseInt(v, 10));
        if (cols.some((v) => !Number.isFinite(v))) continue;
        if (platform === 'win32' && cols.length === 3) rows.push({ pid: cols[0]!, ppid: cols[1]!, pgid: 0, kb: cols[2]! });
        else if (platform !== 'win32' && cols.length === 4) rows.push({ pid: cols[0]!, ppid: cols[1]!, pgid: cols[2]!, kb: cols[3]! });
      }
      resolve(rows.length ? rows : null);
    });
  });
}

/**
 * Resident memory (KB) of the runtime tree rooted at `pid`, from a snapshot.
 *
 *   - POSIX: the process group led by `pid` (the runtime is spawned
 *     `detached`, so it leads its group).
 *   - Windows: `pid` and all of its descendants, by ParentProcessId.
 *
 * `excludePids` (Windows only) prunes those subtrees from the walk. The agent
 * runtime's `exec` shells are listed there: they are the user's workload and
 * the runtime budgets them itself (see SHOGO_EXEC_MEMORY_MB). On POSIX they
 * are already outside the sum, because each exec shell leads its own group.
 *
 * Returns `null` when `pid` is not in the snapshot, so the watchdog treats it
 * as "no reading" rather than "0".
 */
export function treeRssKb(
  rows: readonly ProcessRow[],
  pid: number,
  platform: NodeJS.Platform = process.platform,
  excludePids: readonly number[] = [],
): number | null {
  if (platform !== 'win32') {
    const group = rows.filter((r) => r.pgid === pid);
    return group.length ? group.reduce((sum, r) => sum + r.kb, 0) : null;
  }
  if (!rows.some((r) => r.pid === pid)) return null;
  const exclude = new Set(excludePids.filter((p) => p !== pid));
  const children = new Map<number, ProcessRow[]>();
  for (const r of rows) {
    if (r.pid === r.ppid) continue;
    const list = children.get(r.ppid);
    if (list) list.push(r);
    else children.set(r.ppid, [r]);
  }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const seen = new Set<number>();
  const stack = [pid];
  let sum = 0;
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    sum += byPid.get(id)?.kb ?? 0;
    for (const child of children.get(id) ?? []) {
      if (!exclude.has(child.pid)) stack.push(child.pid);
    }
  }
  return sum;
}

/** Resident memory (KB) of one runtime tree. See {@link treeRssKb}. */
export async function samplePgidRssKb(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  excludePids: readonly number[] = [],
): Promise<number | null> {
  const rows = await snapshotProcesses(platform);
  return rows ? treeRssKb(rows, pid, platform, excludePids) : null;
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
  /** PIDs whose subtrees are left out of each sample (see {@link samplePgidRssKb}). */
  excludePids?: () => readonly number[];
  logger?: Logger;
  /** Called with the observed RSS (MB) when the ceiling is breached. */
  onBreach: (rssMB: number) => void;
}

interface Sampler {
  key: string;
  timer: ReturnType<typeof setInterval>;
  watchdogs: Set<RssWatchdog>;
  sampling: boolean;
}

/**
 * Watchdogs on the same platform and interval share one timer and one process
 * snapshot per tick, so N runtimes cost one OS query instead of N.
 */
const samplers = new Map<string, Sampler>();

function joinSampler(watchdog: RssWatchdog, platform: NodeJS.Platform, intervalMs: number): Sampler {
  const key = `${platform}:${intervalMs}`;
  let sampler = samplers.get(key);
  if (!sampler) {
    const created: Sampler = { key, watchdogs: new Set(), sampling: false, timer: setInterval(() => { void tick(created, platform); }, intervalMs) };
    try { created.timer.unref?.(); } catch { /* unref is best-effort */ }
    samplers.set(key, created);
    sampler = created;
  }
  sampler.watchdogs.add(watchdog);
  return sampler;
}

async function tick(sampler: Sampler, platform: NodeJS.Platform): Promise<void> {
  if (sampler.sampling) return;
  sampler.sampling = true;
  try {
    const rows = await snapshotProcesses(platform);
    for (const watchdog of [...sampler.watchdogs]) watchdog.observe(rows);
  } finally {
    sampler.sampling = false;
  }
}

export class RssWatchdog {
  private sampler: Sampler | null = null;
  private consecutive = 0;
  private fired = false;
  private readonly pid: number;
  private readonly ceilingMB: number;
  private readonly platform: NodeJS.Platform;
  private readonly intervalMs: number;
  private readonly strikes: number;
  private readonly excludePids?: () => readonly number[];
  private readonly logger?: Logger;
  private readonly onBreach: (rssMB: number) => void;

  constructor(opts: RssWatchdogOptions) {
    this.pid = opts.pid;
    this.ceilingMB = opts.ceilingMB;
    this.platform = opts.platform ?? process.platform;
    this.intervalMs = opts.intervalMs ?? parseInt(process.env.RUNTIME_RSS_WATCHDOG_MS || '15000', 10);
    this.strikes = opts.strikes ?? parseInt(process.env.RUNTIME_RSS_WATCHDOG_STRIKES || '2', 10);
    this.excludePids = opts.excludePids;
    this.logger = opts.logger;
    this.onBreach = opts.onBreach;
  }

  start(): void {
    if (this.sampler) return;
    this.sampler = joinSampler(this, this.platform, Math.max(2000, this.intervalMs));
  }

  stop(): void {
    this.sampler?.watchdogs.delete(this);
    if (this.sampler?.watchdogs.size === 0) {
      clearInterval(this.sampler.timer);
      samplers.delete(this.sampler.key);
    }
    this.sampler = null;
  }

  /** Judge one snapshot. The shared sampler calls this; exposed for tests. */
  observe(rows: readonly ProcessRow[] | null): void {
    if (this.fired) return;
    const kb = rows ? treeRssKb(rows, this.pid, this.platform, this.excludePids?.() ?? []) : null;
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
