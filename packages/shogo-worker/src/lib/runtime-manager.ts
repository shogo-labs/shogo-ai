// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WorkerRuntimeManager — multi-project agent-runtime spawner.
 *
 * License boundary: this module locates the agent-runtime via
 * `runtime-resolver` and invokes it with `Bun.spawn` (or `child_process.spawn`
 * as a fallback). It does NOT import `@shogo/agent-runtime` — the AGPL
 * runtime runs as a separate OS process, communicating with the worker
 * over HTTP-on-localhost only. See packages/shogo-worker/README.md
 * "Process boundary" section for the full rationale.
 *
 * Responsibilities:
 *   - Allocate a free localhost port per projectId (range 37100-37900,
 *     mirroring the desktop runtime so port conflicts surface the same
 *     way for users running both locally).
 *   - Spawn the runtime binary with the env it expects (PROJECT_ID,
 *     PORT, API_SERVER_PORT, SKILL_SERVER_PORT, RUNTIME_AUTH_SECRET,
 *     WEBHOOK_TOKEN, SHOGO_API_URL, SHOGO_API_KEY, AI_PROXY_URL,
 *     AI_PROXY_TOKEN, NODE_ENV).
 *   - Wait for /health to respond before declaring `running`.
 *   - Restart with exponential backoff on unexpected exits.
 *   - Idle-evict per-project runtimes after RUNTIME_IDLE_MS of inactivity.
 *   - Stop everything on SIGINT/SIGTERM via `stopAll()`.
 *
 * What this manager does NOT do (vs the desktop one in apps/api):
 *   - No Vite spawning. The cloud-attached worker only serves agent
 *     traffic; previews are owned by the cloud preview path.
 *   - No workspace template seeding. The runtime assumes the workspace
 *     is already at PROJECT_DIR (cloud sets this before invoking).
 *   - No Prisma reads. All policy comes from the spawn config.
 *   - No security policy build. Cloud signs the policy and sends it.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveRuntime, type ResolvedRuntime } from './runtime-resolver.ts';
import {
  RssWatchdog,
  applyHeapEnvCap,
  attachDirectCgroup,
  resolveResourceLimits,
  tryAttachJobObject,
  wrapSpawnForCgroup,
  type RuntimeResourceLimits,
} from './resource-limits.ts';
import type { ResolveRejection, RuntimeResolver } from './tunnel.ts';
import { CloudFileTransport } from '@shogo-ai/sdk/cloud-file-transport';
import { killViteWatchFromPidfile } from '@shogo-ai/sdk/vite-watch';
import { CloudSyncWatcher } from './cloud-sync-watcher.ts';
import { cloneProject, gitIsAvailable, isGitRepo } from './git-cloner.ts';

/** Port range for random allocation (mirrors apps/api desktop manager). */
const PORT_RANGE_START = 37100;
const PORT_RANGE_END = 37900;
const API_PORT_OFFSET = 1; // API server port = agentPort + 1.

/**
 * Offset (from the agent port) of the workspace preview sidecar base.
 *
 * A workspace runtime serves N attached projects, each with its own preview
 * sidecar (`server.tsx`) on `WORKSPACE_API_PORT_BASE + projectIndex`. We anchor
 * that base at `agentPort + 2` (agentPort=+0, its API/skill server=+1) so every
 * runtime gets a DISTINCT sidecar range. Before warm-multiple, only one runtime
 * ran at a time and all of them could share the fixed default base (3101); now
 * that several runtimes stay warm concurrently they were all binding 3101 and
 * crash-looping (force-killing each other's leaked sidecars), which SIGKILLed
 * the agent-runtime and restart-looped it.
 */
const PREVIEW_API_BASE_OFFSET = 2;

/**
 * Contiguous ports reserved per runtime: agent(+0), API/skill server(+1) and
 * the preview sidecars (+2 … +RUNTIME_PORT_BLOCK-1). Reserving the whole block
 * (rather than just the two eagerly-bound ports) guarantees no OTHER runtime's
 * block overlaps this one's sidecar range. 16 supports up to 14 attached
 * projects per workspace; the 800-port range still fits 50 such blocks (>> the
 * default maxRuntimes of 10).
 */
const RUNTIME_PORT_BLOCK = 16;

/** Default idle eviction window — unused runtimes get killed after this. */
const RUNTIME_IDLE_MS = 15 * 60 * 1000;

/**
 * A runtime touched within this window is treated as "actively in use"
 * (likely mid-stream — the agent-proxy/ai-proxy refresh `lastUsedAt` on
 * every forwarded chunk) and is never picked as an LRU eviction victim
 * by {@link WorkerRuntimeManager.enforceMaxRuntimes}, even when the cap
 * is exceeded. Better to briefly run one over the cap than to SIGKILL a
 * live chat stream out from under the user.
 */
const STREAM_ACTIVE_WINDOW_MS = 30 * 1000;

/** Restart backoff bounds. */
const RESTART_BACKOFF_BASE_MS = 1_000;
const RESTART_BACKOFF_MAX_MS = 60_000;

/**
 * Circuit breaker. After this many *consecutive* non-clean exits within
 * {@link RESTART_FAILURE_WINDOW_MS}, the manager stops respawning and
 * parks the slot in `'failed'`. Without this cap a project that the OS
 * keeps OOM-killing (macOS jetsam SIGKILL is the canonical case) burns
 * forever at ~1/minute, with every cycle re-spawning bun + vite +
 * tsserver + pyright and (on posix) leaking the children of any
 * incarnation the manager couldn't kill in its own process group.
 *
 * 8 across a 5-minute window means "we tried for at least
 * (8 * BASE_BACKOFF capped at MAX) = ~7m of escalating backoff before
 * we gave up", which is long enough to ride out a transient port-bind
 * race or a one-shot dependency upgrade and short enough that an
 * operator chasing runaway RSS on their laptop notices the loop
 * stopping before the next memory-pressure cycle.
 */
const MAX_CONSECUTIVE_RESTARTS = 8;
const RESTART_FAILURE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Second, independent trip condition: too many restarts in a long rolling
 * window, regardless of the gaps between them.
 *
 * `MAX_CONSECUTIVE_RESTARTS`/`RESTART_FAILURE_WINDOW_MS` only catches a
 * *tight* crash loop — repeated exits closer together than
 * {@link STARTUP_GRACE_MS} (60s), which is what resets `consecutiveFailures`
 * back to 0. A real production episode (main.log, 2026-09-19 19:44–20:52)
 * showed macOS jetsam SIGKILLing several unrelated project runtimes (AND an
 * idle warm-pool slot) in lockstep every 1–17 minutes for 68 minutes
 * straight — individually every gap cleared the 60s grace window, so
 * `consecutiveFailures` kept resetting to 0/1 and the tight breaker NEVER
 * tripped, even after 15 restarts. Every one of those restarts still killed
 * whatever chat turn was in flight.
 *
 * `slot.restartTimestamps` tracks restarts independently of the grace
 * timer — pruned to this window, not reset by a "survived 60s" incarnation
 * — so a slow, sustained bleed like that episode also trips the breaker
 * (and gets the same auto-heal cooldown as a tight loop) instead of
 * silently degrading chat for over an hour with no safety valve.
 */
const SLOW_BLEED_WINDOW_MS = 60 * 60 * 1000;
const SLOW_BLEED_MAX_RESTARTS = 8;

/**
 * Self-heal cooldown for a `'failed'` (circuit-broken) slot.
 *
 * The breaker tripping is not evidence the project is permanently broken —
 * the dominant real-world cause (see {@link MAX_CONSECUTIVE_RESTARTS}'s
 * comment) is a transient jetsam OOM sweep that can clear itself up within
 * minutes once memory pressure elsewhere on the box eases. Without this,
 * `'failed'` was a terminal state: nothing ever called `resetFailure()`
 * (no caller wires it to a route or the UI), so a project's chat was dead
 * until the whole app/worker restarted — indistinguishable from a real bug
 * to the end user.
 *
 * `ensureRunning()` treats a `'failed'` slot whose cooldown has elapsed as
 * an implicit `resetFailure()` + fresh spawn attempt, with the SAME full
 * `MAX_CONSECUTIVE_RESTARTS` budget (the cooldown itself is the rate
 * limit — a project that's actually broken re-trips almost immediately and
 * pays an escalating cooldown instead of hammering the OS every retry).
 *
 * Escalates 2m → 4m → 8m → 15m(cap) per repeated trip via
 * {@link breakerCooldownMs}, and resets back to the 2m base the next time
 * the project survives a full {@link STARTUP_GRACE_MS} healthy run (see
 * `armGraceTimer`) — a project that recovers for good isn't penalized by
 * cooldowns it earned months ago.
 */
const CIRCUIT_BREAKER_COOLDOWN_BASE_MS = 2 * 60 * 1000;
const CIRCUIT_BREAKER_COOLDOWN_MAX_MS = 15 * 60 * 1000;
/**
 * If a runtime stays up at least this long after the /health-gated
 * `'running'` transition, we treat it as "recovered" and reset the
 * consecutive-failure counter. This is the contract that lets a
 * project that crashed twice on cold start (e.g. waiting for the API
 * port to release) but then ran healthily for ten minutes start over
 * with a fresh budget the next time it hiccups.
 */
const STARTUP_GRACE_MS = 60_000;

/** Health check poll interval while waiting for /health. */
const HEALTH_POLL_MS = 500;
/**
 * Absolute ceiling on how long we'll wait for a freshly-spawned
 * agent-runtime to respond 2xx on /health. After the 2026-05 fix
 * (`runtime-log-writer` async batched writes, deferred LSP +
 * IndexEngine start, /health fast-path in the outer fetch handler),
 * a Windows cold boot is ~8-12 s; macOS/Linux are ~3-5 s. 30 s gives
 * a comfortable margin without hiding real hangs.
 *
 * Why we don't short-circuit on TCP-listening + stdout activity any
 * more (the historical fast path that bypassed /health entirely):
 * declaring "ready" while the event loop is saturated tricks the UI
 * into starting to load the preview iframe and the API server into
 * starting the agent-proxy, both of which then hit their own (much
 * shorter) timeouts and surface as the "Connection timed out — The
 * agent runtime could not be reached" toast and "[AgentProxy] PATCH
 * /agent/config timeout" retries. Waiting for a real 2xx is slower
 * but the resulting `'running'` status actually means "responsive to
 * HTTP", which is what every caller of `status === 'running'` already
 * assumes. The progress logger keeps devs informed during the slow
 * path so the wait isn't a silent black-box.
 */
const HEALTH_BOOT_TIMEOUT_MS = 30_000;
/**
 * If `STDOUT_PROGRESS_WINDOW_MS` elapses without any new stdout AND
 * TCP-listening is true AND /health still hasn't responded, the
 * child is considered wedged and the wait short-circuits with the
 * "stdout silent" error so the restart loop has a chance to recover.
 * Note: this is the ONLY purpose of the window now — it does not
 * declare the runtime ready on its own. See HEALTH_BOOT_TIMEOUT_MS.
 *
 * Sized at 25 s — short of the 30 s HEALTH_BOOT_TIMEOUT_MS so a
 * wedged child surfaces with the more informative "stdout silent for
 * Xms" message instead of the generic timeout. After the 2026-05
 * cold-boot investigation we deferred LSP startup + IndexEngine
 * pre-warm out of the critical path and got Windows cold boot down
 * to ~8-12 s (with macOS at ~3-5 s), so a 25 s silent window is now
 * a real anomaly worth respawning for.
 */
const STDOUT_PROGRESS_WINDOW_MS = 25_000;
/**
 * Log a "still waiting for /health" progress line at most this
 * often, so operators / devs watching `[dev:all]` see something
 * happening during the slow Windows cold-boot path instead of a
 * silent 30-90s gap.
 */
const HEALTH_PROGRESS_LOG_MS = 5_000;
/**
 * Per-attempt TCP connect budget for the kernel-level readiness
 * probe. Connect attempts only need a TCP SYN/SYN-ACK roundtrip on
 * loopback — anything past ~50ms means the kernel doesn't have the
 * listener bound yet (the agent-runtime hasn't reached the
 * Bun.serve() default-export evaluation), so 500ms is comfortably
 * above the noise floor without prolonging probe iterations.
 */
const TCP_CONNECT_TIMEOUT_MS = 500;
const PERF_LOG_ENABLED = process.env.SHOGO_PERF_LOG === '1';

function perfLog(
  phase: string,
  projectId: string,
  openAttemptId: string | undefined,
  extra?: Record<string, unknown>,
): void {
  if (!PERF_LOG_ENABLED) return;
  console.log(`[shogo-perf] ${JSON.stringify({
    perf: 'open',
    source: 'worker',
    phase,
    projectId,
    openAttemptId,
    atMs: Date.now(),
    ...extra,
  })}`);
}

export type RuntimeStatus =
  | 'starting'
  | 'running'
  | 'restarting'
  | 'stopping'
  | 'stopped'
  | 'error'
  /**
   * The circuit breaker tripped. The slot stays in the `runtimes` map
   * (so `status(projectId)` keeps reporting it) and refuses new spawns
   * — but this is NOT terminal: the next `ensureRunning()` call after
   * {@link CIRCUIT_BREAKER_COOLDOWN_BASE_MS} (escalating per repeat
   * trip, see `breakerCooldownMs`) auto-heals it and tries again with a
   * fresh budget. Callers that want to skip the wait can still call
   * {@link WorkerRuntimeManager.resetFailure} directly, or `stop()` to
   * give up on the project entirely.
   */
  | 'failed';

export interface RuntimeStatusInfo {
  projectId: string;
  status: RuntimeStatus;
  agentPort?: number;
  apiServerPort?: number;
  pid?: number;
  startedAt?: number;
  lastUsedAt?: number;
  restarts: number;
  lastError?: string;
}

export interface ProjectSpawnConfig {
  /** Cloud URL the runtime should hit for backend services. */
  cloudUrl: string;
  /** Worker's API key, forwarded so the runtime can authenticate to the cloud. */
  apiKey: string;
  /** Workspace dir on disk for this project. Cloud sets this before invoking. */
  projectDir?: string;
  /** Optional AI proxy URL the runtime should use (cloud-managed). */
  aiProxyUrl?: string;
  /** Optional AI proxy token (per-project, short-lived). */
  aiProxyToken?: string;
  /** Tech-stack id (for runtime to seed correct template if PROJECT_DIR is empty). */
  techStackId?: string;
  /** Friendly project name. */
  name?: string;
  /** Workspace id for this project. */
  workspaceId?: string;
  /** Extra env to merge in last (advanced; usually unused). */
  extraEnv?: Record<string, string>;
}

/**
 * Translate a resolved runtime binary path into the actual spawn
 * command. Default returns `{ command: bin, args: [] }` (compiled
 * binary). The desktop AGPL adapter overrides this to spawn
 * `bun run packages/agent-runtime/src/server.ts` from source so it
 * doesn't have to download a prebuilt binary in dev.
 */
export type SpawnCommandFactory = (binPath: string) => { command: string; args: string[] };

export const defaultSpawnCommand: SpawnCommandFactory = (bin) => ({ command: bin, args: [] });

/**
 * Override how the runtime binary is located. Default uses the
 * `runtime-resolver` priority chain (--runtime-bin > env > ~/.shogo >
 * PATH). The desktop AGPL adapter overrides this to point at the
 * monorepo source (`packages/agent-runtime/src/server.ts`).
 */
export type RuntimeBinResolver = () => ResolvedRuntime | null;

export interface WorkerRuntimeManagerOptions {
  /** `--runtime-bin <path>` flag value if any (forwarded to resolveRuntime). */
  runtimeBin?: string;
  /**
   * Idle window in ms before evicting an unused runtime (default 15min).
   *
   * Pass `0`, a negative number, or `Infinity` to disable idle eviction
   * entirely. The desktop / `SHOGO_LOCAL_MODE=true` path uses this to
   * keep long-running chat streams alive past 15min of agent-proxy
   * silence — eviction in that environment cuts the user's stream
   * mid-flight (only one user, no resource pressure to recycle for).
   * Cloud workers leave this unset so the default still fires.
   */
  idleMs?: number;
  /**
   * Hard ceiling on the number of concurrently-running runtimes. Once
   * exceeded, `ensureRunning` LRU-evicts the least-recently-used slot
   * that has not been touched within {@link STREAM_ACTIVE_WINDOW_MS}
   * (i.e. is not mid-stream). Pass `0`, a negative number, or a
   * non-finite value to disable the cap (the historical behaviour —
   * runtimes were then bounded only by idle eviction). Defaults to
   * disabled when unset.
   */
  maxRuntimes?: number;
  /** Optional logger. Defaults to console. */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** Working directory for spawned runtimes. Defaults to OS tmpdir/shogo-runtime. */
  runtimeWorkDir?: string;
  /** Override env (for tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * How to translate the resolved binary path into spawn argv. Default
   * spawns the binary directly. The desktop AGPL adapter overrides this
   * to wrap it in `bun run`.
   */
  spawnCommand?: SpawnCommandFactory;
  /**
   * Override binary resolution. Default uses the `runtime-resolver`
   * priority chain. The desktop AGPL adapter passes a resolver that
   * points at the monorepo source so dev builds don't need a prebuilt
   * AGPL binary on disk.
   */
  resolveBin?: RuntimeBinResolver;
  /**
   * Default spawn config used when the manager is acting as a
   * `RuntimeResolver` (i.e. asked to ensureRunning by the tunnel,
   * which doesn't carry per-project config). The runtime can fetch
   * everything else it needs from the cloud using its api key.
   */
  defaultSpawnConfig?: ProjectSpawnConfig;
  /**
   * Optional callback to enrich the spawn config for a given projectId
   * just before spawning. Lets the desktop adapter inject per-project
   * Prisma-derived secrets (AI proxy token, security policy, etc.).
   */
  enrichSpawnConfig?: (projectId: string, base: ProjectSpawnConfig) => Promise<ProjectSpawnConfig>;
  /**
   * Auto-pull configuration. When enabled, the manager will clone a
   * project's workspace from Shogo Cloud into `<projectsDir>/<projectId>/`
   * on first request, then keep edits in sync via a {@link CloudSyncWatcher}.
   *
   * This is what makes "pin a staging project to a paired VPS, send a
   * webhook" work end-to-end without the user manually running
   * `shogo project pull` first.
   */
  autoPull?: AutoPullOptions;
  /**
   * Called when a runtime is no longer serving on its agent port and the
   * manager will NOT bring it back on its own: an explicit or idle/LRU
   * `stop()`, a clean exit, or a circuit-breaker trip into `'failed'`.
   * Transient crash-restarts (same port) do not fire it. Hosts that cache
   * the agent port (the desktop API's RuntimeManager) use this to drop
   * their entry instead of proxying to a dead port. Errors thrown by the
   * callback are swallowed.
   */
  onRuntimeGone?: (projectId: string, info: RuntimeGoneInfo) => void;
}

export interface RuntimeGoneInfo {
  reason: RuntimeStopReason | 'exited' | 'failed';
  code?: number | null;
  signal?: NodeJS.Signals | null;
}

export type RuntimeStopReason = 'stop' | 'idle-evict' | 'lru-evict';

export interface AutoPullOptions {
  /** Master switch. Defaults to false; the `worker start` command flips
   *  it on for `cli_worker` instances unless `--no-auto-pull` is passed. */
  enabled: boolean;
  /** Directory under which each project's workspace lives. Required when enabled. */
  projectsDir: string;
  /** Watch the pulled workspace and push edits back to cloud. Default: true. */
  watch?: boolean;
  /**
   * Prefer the git smart-HTTP backend over the file transport for the
   * initial clone and the watcher's flush path. Defaults to `true`:
   * the worker will probe `git --version` and fall back to the file
   * transport if git isn't installed. Set to `false` (via `--no-git` on
   * `worker start`) to force the file-transport path even when git is
   * available — useful for environments where outbound HTTPS to git's
   * pack RPC endpoints is blocked at the firewall.
   */
  useGit?: boolean;
  /** Optional logger. Defaults to the manager's logger. */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** Test seam: swap in fakes for the git-cloner ops without resorting
   *  to module-level mocking (which leaks across bun:test files). Each
   *  field falls back to the real implementation when not provided. */
  gitOps?: Partial<GitOpsAdapter>;
}

/** Subset of git-cloner that the runtime-manager actually calls. */
export interface GitOpsAdapter {
  cloneProject: typeof cloneProject;
  gitIsAvailable: typeof gitIsAvailable;
  isGitRepo: typeof isGitRepo;
}

/** Per-project sync strategy. Recorded so the watcher (or stopAll) can
 *  branch on it without re-probing `git --version`. */
export type SyncMode = 'git' | 'files';

/** Internal per-project runtime record. */
interface InternalRuntime {
  projectId: string;
  agentPort: number;
  apiServerPort: number;
  status: RuntimeStatus;
  proc: ChildProcess | null;
  /**
   * PID of the most recent spawn, retained after `proc` is nulled in
   * {@link WorkerRuntimeManager.handleExit}. On posix, the runtime is
   * spawned as a process group leader (`detached: true`), so this is
   * also the PGID — `process.kill(-pid, ...)` cascades to the runtime's
   * descendants such as its API server, tsserver and pyright. Vite's
   * intentionally separate process group is reaped through its pidfile.
   */
  pid: number | null;
  startedAt: number;
  /**
   * Wall-clock timestamp of the most recent stdout/stderr line emitted
   * by `proc`. Read by {@link WorkerRuntimeManager.waitForHealth} as a
   * "process is making forward progress" signal that lets a slow boot
   * clear the readiness gate even when /health hasn't responded yet.
   * See the {@link STDOUT_PROGRESS_WINDOW_MS} doc and the comment block
   * inside `waitForHealth` for the full rationale (Windows
   * `--conditions=development` cold-boot pattern where Bun
   * JIT-compiles the entire TS dep graph on first request and the
   * 30s HTTP /health budget vanishes before the first response).
   */
  lastStdoutAt: number;
  lastUsedAt: number;
  restarts: number;
  /** Consecutive non-clean exits since the last healthy run. */
  consecutiveFailures: number;
  /** Timestamp (Date.now) of the most recent non-clean exit. Used to
   *  detect "loop within the failure window" for the circuit breaker,
   *  and (once tripped) as the cooldown clock for auto-heal. */
  lastFailureAt: number;
  /**
   * Number of times the circuit breaker has tripped into `'failed'` for
   * this project since it last survived a full {@link STARTUP_GRACE_MS}
   * healthy run. Drives the escalating auto-heal cooldown in
   * {@link WorkerRuntimeManager.breakerCooldownMs} — repeat offenders back
   * off further instead of retrying every 2 minutes forever.
   */
  breakerTrips: number;
  /**
   * Wall-clock timestamps (Date.now) of the last several non-clean-exit
   * restarts, pruned to {@link SLOW_BLEED_WINDOW_MS}. Independent of
   * `consecutiveFailures` (which the 60s startup grace resets on every
   * incarnation that survives a minute) — this is what catches a crash
   * that recurs every few minutes for an hour: individually every gap
   * clears the tight breaker, but the rolling count here keeps growing.
   */
  restartTimestamps: number[];
  /** Timer that resets `consecutiveFailures` to 0 once a fresh run has
   *  survived for {@link STARTUP_GRACE_MS}. */
  graceTimer: ReturnType<typeof setTimeout> | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /**
   * RSS watchdog enforcing the per-project memory ceiling where no kernel-level
   * cap is available (macOS always; Windows without the Job Object helper;
   * Linux without cgroup access). Null when a cgroup/Job Object handles the cap
   * or when no limit is configured. Stopped on exit/stop.
   */
  limitWatchdog: RssWatchdog | null;
  lastError?: string;
  spawnConfig: ProjectSpawnConfig;
  /**
   * Promise of an in-flight start so concurrent ensureRunning() calls
   * dedupe instead of double-spawning.
   */
  startPromise: Promise<InternalRuntime> | null;
}

/**
 * Per-worker signing secret used to derive `RUNTIME_AUTH_SECRET` and
 * `WEBHOOK_TOKEN` for each project. Generated lazily on first need and
 * persisted nowhere — secrets exist for the worker's process lifetime.
 *
 * The cloud already authenticated the tunneled request; the runtime
 * token only protects the localhost surface from co-tenants on shared
 * dev machines, so a per-process random is sufficient.
 */
let workerSigningSecret: string | null = null;
function getWorkerSigningSecret(): string {
  if (!workerSigningSecret) {
    workerSigningSecret = randomBytes(32).toString('hex');
  }
  return workerSigningSecret;
}

function deriveRuntimeToken(projectId: string): string {
  return createHmac('sha256', getWorkerSigningSecret()).update(`runtime:${projectId}`).digest('hex');
}

function deriveWebhookToken(projectId: string): string {
  return createHmac('sha256', getWorkerSigningSecret()).update(`webhook:${projectId}`).digest('hex');
}

function splitPathAndQuery(pathWithQuery: string): { pathname: string; search: string } {
  const q = pathWithQuery.indexOf('?');
  if (q === -1) return { pathname: pathWithQuery, search: '' };
  return { pathname: pathWithQuery.slice(0, q), search: pathWithQuery.slice(q) };
}

/** True if the directory exists and contains no entries (or doesn't exist). */
function isDirEmpty(dir: string): boolean {
  try {
    const entries = readdirSync(dir);
    return entries.length === 0;
  } catch {
    return true;
  }
}

/**
 * Render the operator-facing multi-line error the worker raises when it
 * cannot determine a real on-disk workspace for a project.
 *
 * Why it's verbose: every branch here represents a real misconfig the
 * operator has to fix before the worker can serve traffic, and the
 * runtime's own `WORKSPACE_DIR fell back to '/app/workspace'` warning
 * is only visible in the spawned child's stderr (often hidden behind
 * the worker's logging seam). Surfacing the full menu of fixes — flag,
 * env var, manual `shogo project pull` — at the throw site means an
 * operator's first sight of the failure is also their fix.
 */
export function formatWorkspaceMisconfigError(
  projectId: string,
  reason: 'no-auto-pull-config' | 'no-projects-dir' | 'auto-pull-disabled',
  expectedDir: string | null,
): string {
  const lines: string[] = [];
  lines.push(`Cannot spawn agent-runtime for project ${projectId}: no workspace directory available.`);
  lines.push('');
  switch (reason) {
    case 'no-auto-pull-config':
      lines.push(
        '  Reason: WorkerRuntimeManager was constructed without an `autoPull` config and ' +
          'no caller-provided `projectDir` was found on disk.',
      );
      lines.push(
        '          This usually means a programmatic embedder forgot to wire up enrichSpawnConfig ' +
          'or autoPull. CLI users should not see this — please file a bug.',
      );
      break;
    case 'no-projects-dir':
      lines.push(
        '  Reason: auto-pull is configured but `projectsDir` is empty. The worker needs a ' +
          'persistent root directory under which it can store cloned project workspaces.',
      );
      break;
    case 'auto-pull-disabled':
      lines.push(
        '  Reason: auto-pull was disabled (--no-auto-pull) and the expected pre-pulled ' +
          `workspace at ${expectedDir} is missing or empty.`,
      );
      break;
  }
  lines.push('');
  lines.push('  How to fix (pick one):');
  lines.push('    1. Re-enable auto-pull (default).  Drop the --no-auto-pull flag and restart');
  lines.push('       the worker.  The first inbound request for this project will clone its');
  lines.push('       workspace from Shogo Cloud into <projectsDir>/<projectId>/.');
  lines.push('');
  lines.push('    2. Pre-pull manually with `shogo project pull <projectId>` before starting');
  lines.push('       the worker.  Use this when you want full control over when the clone runs');
  lines.push('       (slow links, scheduled maintenance windows, etc.).');
  lines.push('');
  lines.push('    3. Point the worker at an existing workspace by setting either:');
  lines.push('         --projects-dir <path>           (per-invocation flag)');
  lines.push('         SHOGO_PROJECTS_DIR=<path>       (env var, persists across restarts)');
  lines.push('         shogo config set projectsDir <path>');
  lines.push('       Whichever path you pick must contain a subdirectory named after the ');
  lines.push(`       project id (e.g. <path>/${projectId}/) populated with the project's source.`);
  lines.push('');
  lines.push('  Docs: https://shogo.ai/docs/self-hosted-worker#workspace-seeding');
  return lines.join('\n');
}

export class WorkerRuntimeManager implements RuntimeResolver {
  private readonly opts: WorkerRuntimeManagerOptions;
  private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly runtimes = new Map<string, InternalRuntime>();
  private readonly usedPorts = new Set<number>();
  private readonly spawnCommand: SpawnCommandFactory;
  private resolved: ResolvedRuntime | null = null;
  private stopped = false;
  /**
   * Per-project resource limits (memory/CPU ceiling) read once from the
   * environment. `undefined` = not yet resolved; `null` = no limit configured.
   */
  private resolvedLimits: RuntimeResourceLimits | null | undefined = undefined;

  /** Active watchers per projectId, keyed by projectId. Stopped in stopAll. */
  private readonly watchers = new Map<string, CloudSyncWatcher>();
  /** Projects we've already pulled (or attempted to pull) this lifetime. */
  private readonly pulledProjects = new Set<string>();
  /** Which sync strategy each project ended up using. Used by the watcher
   *  to pick between git commit-push and file-transport flush modes. */
  private readonly syncModes = new Map<string, SyncMode>();

  constructor(opts: WorkerRuntimeManagerOptions = {}) {
    this.opts = opts;
    this.log = opts.logger ?? console;
    this.spawnCommand = opts.spawnCommand ?? defaultSpawnCommand;
    this.sweepOrphanedViteWatches();
  }

  /**
   * Resolve and cache the runtime binary path. Called eagerly by
   * `shogo worker start` so the user sees the missing-binary error
   * immediately rather than on the first inbound request.
   */
  resolveBinary(): ResolvedRuntime | null {
    if (!this.resolved) {
      this.resolved = this.opts.resolveBin
        ? this.opts.resolveBin()
        : resolveRuntime({ flag: this.opts.runtimeBin, env: this.opts.env });
    }
    return this.resolved;
  }

  // ─── RuntimeResolver implementation (used by WorkerTunnel) ──────

  /**
   * Resolve a tunneled path to a local URL. /agent/* paths trigger an
   * on-demand spawn for the projectId; non-agent paths return null
   * (the worker doesn't host an apps/api locally — the desktop adapter
   * subclasses this to add that fallback).
   */
  async resolveLocalUrl(pathWithQuery: string, projectId?: string): Promise<string | null> {
    const { pathname, search } = splitPathAndQuery(pathWithQuery);
    if (!(pathname.startsWith('/agent/') || pathname === '/agent')) return null;
    if (!projectId) {
      // Without a projectId we can't pick a runtime; pick the first active
      // one if there's exactly one — matches the desktop's permissive fallback.
      const active = this.getActiveProjects();
      if (active.length !== 1) return null;
      projectId = active[0]!;
    }
    const config = await this.spawnConfigFor(projectId);
    if (!config) {
      this.log.warn(`[WorkerRuntimeManager] No spawn config for ${projectId} — set defaultSpawnConfig or enrichSpawnConfig`);
      return null;
    }
    const status = await this.ensureRunning(projectId, config);
    if (!status.agentPort) return null;
    this.touch(projectId);
    return `http://127.0.0.1:${status.agentPort}${pathname}${search}`;
  }

  deriveRuntimeToken(projectId: string): string | null {
    return deriveRuntimeToken(projectId);
  }

  /**
   * Tell the {@link WorkerTunnel} why we returned `null` from
   * `resolveLocalUrl`. The tunnel echoes this into the structured 502
   * body so a Studio client reading the response can tell whether the
   * request hit a path the worker has no opinion about
   * (`/api/projects`) versus an /agent path that lacked a project
   * context.
   *
   * Stable codes:
   *   CLI_WORKER_HAS_NO_DATA_API     — non-/agent path; cli-worker
   *                                    instances are execution targets,
   *                                    not data sources. Studio is
   *                                    expected to gate stateful API
   *                                    routing on `instance.kind` and
   *                                    fall back to cloud for these.
   *   CLI_WORKER_NO_PROJECT_FOR_PATH — /agent path arrived without a
   *                                    `projectId` and we don't have a
   *                                    single active project to fall
   *                                    back to.
   */
  describeRejection(pathWithQuery: string, projectId?: string): ResolveRejection {
    const { pathname } = splitPathAndQuery(pathWithQuery);
    if (!(pathname.startsWith('/agent/') || pathname === '/agent')) {
      return {
        code: 'CLI_WORKER_HAS_NO_DATA_API',
        message: `cli-worker only serves /agent/* paths; tried: ${pathname}`,
      };
    }
    return {
      code: 'CLI_WORKER_NO_PROJECT_FOR_PATH',
      message:
        `cli-worker received an /agent path without a single active project; ` +
        `projectId=${projectId ?? 'none'}, path=${pathname}`,
    };
  }

  private async spawnConfigFor(projectId: string): Promise<ProjectSpawnConfig | null> {
    const base = this.opts.defaultSpawnConfig;
    if (!base) return null;
    if (this.opts.enrichSpawnConfig) {
      try {
        return await this.opts.enrichSpawnConfig(projectId, base);
      } catch (err: any) {
        this.log.warn(
          `[WorkerRuntimeManager] enrichSpawnConfig failed for ${projectId}: ${err?.message ?? err}`,
        );
      }
    }
    return base;
  }

  /**
   * Idempotently ensure a runtime exists for this projectId. Concurrent
   * callers share the in-flight spawn promise.
   *
   * Side effect: if `opts.autoPull.enabled` is true and this is the first
   * time we've seen this projectId, we'll clone the workspace from cloud
   * BEFORE spawning the runtime. Failures are non-fatal — the runtime
   * still spawns and falls back to template-seeded defaults so the worker
   * never bricks because the cloud Files API was momentarily down.
   */
  async ensureRunning(projectId: string, config: ProjectSpawnConfig): Promise<RuntimeStatusInfo> {
    if (this.stopped) throw new Error('WorkerRuntimeManager is stopped');

    // A circuit-broken slot gets one chance to heal itself before we
    // refuse it: if its cooldown has elapsed, treat this call as an
    // implicit resetFailure() and fall through to a fresh spawn attempt
    // below. Otherwise refuse BEFORE auto-pull so we don't churn the
    // network/disk on a project we already know we won't spawn — the
    // parked-state message (with a concrete retry ETA) lets the caller
    // (tunnel proxy, desktop UI) render an actionable error instead of a
    // generic auto-pull / spawn failure.
    const failedExisting = this.runtimes.get(projectId);
    if (failedExisting?.status === 'failed') {
      const cooldownMs = this.breakerCooldownMs(failedExisting.breakerTrips);
      const sinceTripMs = Date.now() - failedExisting.lastFailureAt;
      if (sinceTripMs >= cooldownMs) {
        this.log.log(
          `[WorkerRuntimeManager] auto-heal: ${projectId} cooldown elapsed ` +
            `(${Math.round(sinceTripMs / 1000)}s since trip #${failedExisting.breakerTrips}) — ` +
            `clearing circuit breaker and attempting a fresh spawn`,
        );
        this.healBreaker(failedExisting);
        // Falls through — `failedExisting` is the same object referenced
        // below as `existing`, now with status reset off `'failed'`.
      } else {
        const retryInMs = cooldownMs - sinceTripMs;
        throw new Error(
          `[WorkerRuntimeManager] cannot ensureRunning(${projectId}): ` +
          `${failedExisting.lastError ?? 'runtime is in failed state'} ` +
          `Will auto-retry in ~${Math.ceil(retryInMs / 1000)}s; ` +
          `call resetFailure(${projectId}) to retry immediately, or stop(${projectId}) to give up.`,
        );
      }
    }

    // Apply auto-pull before any runtime spawn so the runtime's PROJECT_DIR
    // points at a fully-cloned workspace. Idempotent: subsequent calls hit
    // the `pulledProjects` short-circuit.
    config = await this.maybeAutoPull(projectId, config);

    const existing = this.runtimes.get(projectId);
    if (existing?.status === 'running') {
      this.touch(projectId);
      return this.snapshot(existing);
    }
    if (existing?.startPromise) {
      const r = await existing.startPromise;
      return this.snapshot(r);
    }

    const slot: InternalRuntime = existing ?? this.makeSlot(projectId, config);
    if (!existing) this.runtimes.set(projectId, slot);
    slot.spawnConfig = config;
    slot.startPromise = this.doStart(slot);
    try {
      const r = await slot.startPromise;
      // We just brought a (possibly new) runtime up — enforce the hard
      // ceiling now so a busy multi-project session can't accumulate
      // runtimes without bound. Never evicts the one we just started.
      this.enforceMaxRuntimes(projectId);
      return this.snapshot(r);
    } finally {
      slot.startPromise = null;
    }
  }

  /**
   * Enforce {@link WorkerRuntimeManagerOptions.maxRuntimes} by LRU-evicting
   * the least-recently-used running slot until the count is at/under the
   * cap. Skips:
   *   - the slot we just started (`keepProjectId`),
   *   - any slot touched within {@link STREAM_ACTIVE_WINDOW_MS} (treated as
   *     mid-stream — we never cut a live chat),
   *   - non-running slots (starting/restarting/stopping/failed don't count
   *     against the cap and aren't safe to tear down here).
   *
   * If every over-cap slot is actively streaming we stop early and let the
   * count ride briefly over the cap rather than killing a live stream — the
   * next ensureRunning (or idle eviction) reclaims it once it goes quiet.
   *
   * Fire-and-forget: eviction `stop()` is async (process-group kill +
   * grace window) but we don't await it — the caller shouldn't block its
   * own spawn on tearing down someone else's idle runtime.
   */
  private enforceMaxRuntimes(keepProjectId: string): void {
    const cap = this.opts.maxRuntimes;
    if (cap == null || !Number.isFinite(cap) || cap <= 0) return;

    const now = Date.now();
    const running = Array.from(this.runtimes.values()).filter((r) => r.status === 'running');
    if (running.length <= cap) return;

    // LRU order: oldest lastUsedAt first.
    const candidates = running
      .filter((r) => r.projectId !== keepProjectId && now - r.lastUsedAt >= STREAM_ACTIVE_WINDOW_MS)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

    let overBy = running.length - cap;
    for (const victim of candidates) {
      if (overBy <= 0) break;
      const idleMs = now - victim.lastUsedAt;
      this.log.log(
        `[WorkerRuntimeManager] maxRuntimes=${cap} exceeded (${running.length} running) — ` +
          `LRU-evicting ${victim.projectId} (idle ${Math.round(idleMs / 1000)}s)`,
      );
      void this.stop(victim.projectId, 'SIGTERM', 'lru-evict').catch((err: any) => {
        this.log.warn(
          `[WorkerRuntimeManager] maxRuntimes eviction of ${victim.projectId} failed: ${err?.message ?? err}`,
        );
      });
      overBy--;
    }

    if (overBy > 0) {
      this.log.log(
        `[WorkerRuntimeManager] maxRuntimes=${cap} still exceeded by ${overBy} after eviction pass — ` +
          `remaining over-cap slots are mid-stream; will retry on next spawn / idle reap`,
      );
    }
  }

  /**
   * Public entry point for tests + the `worker start` command to pre-warm
   * a project's workspace without spawning anything. Internally idempotent.
   */
  async ensurePulled(projectId: string, config: ProjectSpawnConfig): Promise<ProjectSpawnConfig> {
    return this.maybeAutoPull(projectId, config);
  }

  private async maybeAutoPull(projectId: string, config: ProjectSpawnConfig): Promise<ProjectSpawnConfig> {
    const auto = this.opts.autoPull;

    // ── Workspace-locatability invariants for the cli-worker ──
    //
    // The agent-runtime hard-falls-back to `/app/workspace` (a Docker
    // convention) when none of WORKSPACE_DIR / AGENT_DIR / PROJECT_DIR
    // are set. On a self-hosted VPS that path doesn't exist, so the
    // runtime boots but every project-aware route silently serves
    // empty state. To keep that bug from ever shipping again, the
    // worker spawn path is required to either:
    //
    //   (a) populate `cfg.projectDir` itself before reaching here
    //       (desktop AGPL adapter does this through `enrichSpawnConfig`,
    //       cloud sets WORKSPACE_DIR via Knative env vars), OR
    //   (b) carry an `autoPull` config with a `projectsDir` so this
    //       method can synthesise a per-project workspace path on
    //       disk and clone the cloud snapshot into it.
    //
    // Anything else is a misconfiguration — the runtime would either
    // not find the workspace or scribble into a co-tenant's tree —
    // so we throw with a multi-line operator-facing message instead
    // of letting the agent-runtime print a deceptively-mild warning.
    //
    // The bypass for `enrichSpawnConfig` callers is deliberate: the
    // desktop AGPL adapter wires up its own per-project Prisma-derived
    // workspace path and does NOT need autoPull. We honour `projectDir`
    // when the directory actually exists.
    if (config.projectDir && existsSync(config.projectDir)) {
      return config;
    }

    if (!auto) {
      throw new Error(formatWorkspaceMisconfigError(projectId, 'no-auto-pull-config', null));
    }

    if (!auto.projectsDir) {
      throw new Error(formatWorkspaceMisconfigError(projectId, 'no-projects-dir', null));
    }

    if (!auto.enabled) {
      // Operator opted out of auto-pull. Honour a pre-pulled workspace
      // (`shogo project pull <id>` lays one down at the canonical path);
      // anything else is a misconfig because the runtime has nothing to
      // operate on.
      const candidate = join(auto.projectsDir, projectId);
      if (existsSync(candidate) && !isDirEmpty(candidate)) {
        return { ...config, projectDir: candidate };
      }
      throw new Error(formatWorkspaceMisconfigError(projectId, 'auto-pull-disabled', candidate));
    }

    if (this.pulledProjects.has(projectId)) {
      // Already attempted in this process — return the canonical path
      // so a previous failure doesn't strand the runtime on the
      // /app/workspace fallback.
      return { ...config, projectDir: join(auto.projectsDir, projectId) };
    }

    const projectDir = join(auto.projectsDir, projectId);
    const log = auto.logger ?? this.log;
    const git = {
      cloneProject: auto.gitOps?.cloneProject ?? cloneProject,
      gitIsAvailable: auto.gitOps?.gitIsAvailable ?? gitIsAvailable,
      isGitRepo: auto.gitOps?.isGitRepo ?? isGitRepo,
    };

    // Mark before attempting so failures don't cause repeated re-pulls
    // on every single request — the runtime will still start with an
    // empty WORKSPACE_DIR and seed templates as a fallback.
    this.pulledProjects.add(projectId);

    try {
      mkdirSync(projectDir, { recursive: true });
      const isEmpty = isDirEmpty(projectDir);
      const alreadyGitRepo = git.isGitRepo(projectDir);

      // Strategy:
      //   1. If git is available AND the dir is empty (no .git, no files):
      //        clone via smart-HTTP, then top-up `.shogo/` (SQLite, gitignored)
      //        via the file transport.
      //   2. If git is available AND the dir already has a .git/: trust
      //        the existing clone. The watcher / a later `shogo project
      //        checkout` brings refs forward.
      //   3. Otherwise (git unavailable, useGit=false, OR the dir has
      //        non-empty content with no .git/): fall back to file transport.
      const wantGit = auto.useGit !== false;
      const gitAvailable = wantGit ? await git.gitIsAvailable() : false;
      const mode: SyncMode = (gitAvailable && (isEmpty || alreadyGitRepo)) ? 'git' : 'files';
      this.syncModes.set(projectId, mode);

      if (mode === 'git') {
        if (isEmpty) {
          log.log(`[WorkerRuntimeManager] auto-pull: git clone project ${projectId} into ${projectDir}`);
          try {
            const res = await git.cloneProject({
              apiUrl: config.cloudUrl,
              apiKey: config.apiKey,
              projectId,
              localDir: projectDir,
              shallow: true,
              logger: log,
            });
            log.log(`[WorkerRuntimeManager] auto-pull: ${projectId} cloned at ${res.commitSha.slice(0, 8)}`);
          } catch (err: any) {
            // Git clone failed — try the file transport as a fallback.
            // We DON'T retry git on subsequent runs: the mode flip is
            // sticky for this projectId's lifetime to avoid bouncing.
            log.warn(
              `[WorkerRuntimeManager] auto-pull: git clone failed for ${projectId} (${err?.message ?? err}); ` +
                `falling back to CloudFileTransport.downloadAll`,
            );
            this.syncModes.set(projectId, 'files');
            await this.fileTransportClone(projectId, projectDir, config, log);
          }
        } else if (alreadyGitRepo) {
          log.log(`[WorkerRuntimeManager] auto-pull: ${projectId} already has .git/; skipping clone`);
        }

        // After a git clone, top-up gitignored `.shogo/` SQLite state via
        // the file transport. `.shogo/` is excluded from git but the
        // agent-runtime requires it for state continuity across pins.
        if (this.syncModes.get(projectId) === 'git') {
          await this.topUpShogoState(projectId, projectDir, config, log);
        }
      } else if (isEmpty) {
        // Pure file-transport path (git unavailable or disabled).
        await this.fileTransportClone(projectId, projectDir, config, log);
      } else {
        log.log(`[WorkerRuntimeManager] auto-pull: ${projectId} workspace already populated; skipping clone`);
      }

      // Spin up a watcher so locally written files sync back to cloud.
      // We only need ONE watcher per project regardless of how many
      // runtimes spawn for it. The watcher's mode mirrors the chosen
      // sync strategy: git → commit+push on flush, files → PUT per file.
      if (auto.watch !== false && !this.watchers.has(projectId)) {
        try {
          const transport = new CloudFileTransport({
            apiUrl: config.cloudUrl,
            apiKey: config.apiKey,
            projectId,
            localDir: projectDir,
          });
          const finalMode = this.syncModes.get(projectId) ?? 'files';
          const watcher = new CloudSyncWatcher({
            rootDir: projectDir,
            transport,
            logger: log,
            mode: finalMode,
            git: finalMode === 'git'
              ? {
                  apiUrl: config.cloudUrl,
                  apiKey: config.apiKey,
                  projectId,
                }
              : undefined,
          });
          watcher.start();
          this.watchers.set(projectId, watcher);
        } catch (err: any) {
          log.warn(`[WorkerRuntimeManager] auto-pull: watcher start failed for ${projectId}: ${err?.message ?? err}`);
        }
      }
    } catch (err: any) {
      log.warn(
        `[WorkerRuntimeManager] auto-pull: failed for ${projectId} — runtime will fall back to template defaults. ` +
          `(${err?.message ?? err})`,
      );
    }

    // Always set projectDir so the runtime points at the (possibly empty)
    // persistent location instead of a tmpdir. This keeps the runtime
    // crash-resilient — restarts find the same workspace.
    return { ...config, projectDir };
  }

  /** File-transport clone of an entire project workspace into `projectDir`. */
  private async fileTransportClone(
    projectId: string,
    projectDir: string,
    config: ProjectSpawnConfig,
    log: Pick<Console, 'log' | 'warn' | 'error'>,
  ): Promise<void> {
    log.log(`[WorkerRuntimeManager] auto-pull: file-transport clone of ${projectId} into ${projectDir}`);
    const transport = new CloudFileTransport({
      apiUrl: config.cloudUrl,
      apiKey: config.apiKey,
      projectId,
      localDir: projectDir,
    });
    const stats = await transport.downloadAll();
    log.log(
      `[WorkerRuntimeManager] auto-pull: ${projectId} downloaded ${stats.downloaded} files ` +
        `(${stats.errors.length} errors)`,
    );
  }

  /**
   * After a git clone, the worker's workspace is missing `.shogo/`
   * (the per-project SQLite state directory) because `.shogo/` is
   * gitignored. Pull just those entries via the file transport so the
   * agent-runtime sees consistent DB state on first spawn.
   */
  private async topUpShogoState(
    projectId: string,
    projectDir: string,
    config: ProjectSpawnConfig,
    log: Pick<Console, 'log' | 'warn' | 'error'>,
  ): Promise<void> {
    try {
      const transport = new CloudFileTransport({
        apiUrl: config.cloudUrl,
        apiKey: config.apiKey,
        projectId,
        localDir: projectDir,
      });
      const manifest = await transport.listManifest();
      const shogoEntries = manifest.filter((e: { path: string }) => e.path === '.shogo' || e.path.startsWith('.shogo/'));
      if (shogoEntries.length === 0) return;
      const stats = await transport.downloadFiles(shogoEntries);
      log.log(
        `[WorkerRuntimeManager] auto-pull: ${projectId} .shogo/ top-up downloaded ${stats.downloaded} ` +
          `files (${stats.errors.length} errors)`,
      );
    } catch (err: any) {
      // Non-fatal: the runtime will create a fresh SQLite db if needed.
      log.warn(`[WorkerRuntimeManager] auto-pull: .shogo top-up failed for ${projectId}: ${err?.message ?? err}`);
    }
  }

  /**
   * Whether the spawned runtime for `projectId` should defer its own
   * S3Sync + checkpoint inserts to the worker's cloud sync (sets
   * `SHOGO_CLOUD_SYNC=1`). True only when auto-pull is enabled AND this
   * project was actually pulled (so a watcher is running for it) — a
   * pre-seeded / operator-pinned / template-seeded project keeps the
   * runtime's own sync. Public so the wiring is unit-testable without
   * spawning a runtime.
   */
  shouldDeferToCloudSync(projectId: string): boolean {
    return !!this.opts.autoPull?.enabled && this.pulledProjects.has(projectId);
  }

  status(projectId: string): RuntimeStatusInfo | null {
    const r = this.runtimes.get(projectId);
    return r ? this.snapshot(r) : null;
  }

  getActiveProjects(): string[] {
    return Array.from(this.runtimes.keys()).filter((id) => {
      const r = this.runtimes.get(id);
      return r && (r.status === 'running' || r.status === 'starting' || r.status === 'restarting');
    });
  }

  /** Mark the runtime as recently used. Resets the idle eviction timer. */
  touch(projectId: string): void {
    const r = this.runtimes.get(projectId);
    if (!r) return;
    r.lastUsedAt = Date.now();
    this.armIdleTimer(r);
  }

  async stop(
    projectId: string,
    signal: NodeJS.Signals = 'SIGTERM',
    reason: RuntimeStopReason = 'stop',
  ): Promise<void> {
    const r = this.runtimes.get(projectId);
    if (!r) return;
    r.status = 'stopping';
    if (r.restartTimer) { clearTimeout(r.restartTimer); r.restartTimer = null; }
    if (r.idleTimer) { clearTimeout(r.idleTimer); r.idleTimer = null; }
    if (r.graceTimer) { clearTimeout(r.graceTimer); r.graceTimer = null; }
    if (r.limitWatchdog) { r.limitWatchdog.stop(); r.limitWatchdog = null; }
    if (r.proc) {
      // Send the requested signal to the whole process group first so
      // children (vite, preview-manager's API server, LSPs) start their
      // own graceful shutdown in parallel with the parent.
      this.killProcessGroup(r, signal);
      this.killViteWatch(r);
      try { r.proc.kill(signal); } catch { /* already gone */ }
      await this.waitForExit(r.proc, 5000);
      // Belt-and-suspenders: if the grace window elapsed without a
      // clean exit, `waitForExit` already SIGKILL'd the parent — chase
      // the rest of the group too in case any child ignored SIGTERM.
      this.killProcessGroup(r, 'SIGKILL');
      this.killViteWatch(r);
    }
    r.pid = null;
    this.releasePort(r.agentPort);
    this.runtimes.delete(projectId);
    this.notifyGone(projectId, { reason });
  }

  private notifyGone(projectId: string, info: RuntimeGoneInfo): void {
    const cb = this.opts.onRuntimeGone;
    if (!cb) return;
    try {
      cb(projectId, info);
    } catch (err: any) {
      this.log.warn(`[WorkerRuntimeManager] onRuntimeGone(${projectId}) threw: ${err?.message ?? err}`);
    }
  }

  /**
   * Re-arm a runtime that the circuit breaker parked in `'failed'`,
   * bypassing the auto-heal cooldown (see `breakerCooldownMs`) for an
   * IMMEDIATE retry. Drops the slot from the map so the next
   * `ensureRunning(projectId, …)` call performs a fresh `doStart()` with a
   * zeroed failure budget (though `breakerTrips` — and therefore the NEXT
   * cooldown if it re-trips — carries over; only a full healthy run via
   * `armGraceTimer` resets that).
   *
   * `ensureRunning()` itself now auto-heals a `'failed'` slot once its
   * cooldown elapses, so this is no longer the only way out of `'failed'`
   * — it's for callers that don't want to wait: the desktop's "reopen
   * project" flow, or an operator who fixed whatever was crashing the
   * runtime (e.g. freed memory, deleted a corrupted workspace file) and
   * wants to retry right now without tearing down the whole worker. No-op
   * if the project isn't in `'failed'`.
   */
  resetFailure(projectId: string): boolean {
    const r = this.runtimes.get(projectId);
    if (!r || r.status !== 'failed') return false;
    if (r.restartTimer) { clearTimeout(r.restartTimer); r.restartTimer = null; }
    if (r.idleTimer) { clearTimeout(r.idleTimer); r.idleTimer = null; }
    if (r.graceTimer) { clearTimeout(r.graceTimer); r.graceTimer = null; }
    if (r.limitWatchdog) { r.limitWatchdog.stop(); r.limitWatchdog = null; }
    this.runtimes.delete(projectId);
    this.log.log(`[WorkerRuntimeManager] resetFailure: ${projectId} cleared, next ensureRunning will respawn`);
    return true;
  }

  /**
   * Escalating cooldown for the Nth breaker trip: 2m, 4m, 8m, 15m(cap), …
   * `tripCount` is `breakerTrips` *before* incrementing for this trip (so
   * the very first trip — `tripCount === 0` going into `handleExit`, which
   * increments it to `1` — cools down for the base 2m, not 4m).
   */
  private breakerCooldownMs(tripCount: number): number {
    const exponent = Math.max(0, tripCount - 1);
    const scaled = CIRCUIT_BREAKER_COOLDOWN_BASE_MS * Math.pow(2, exponent);
    return Math.min(scaled, CIRCUIT_BREAKER_COOLDOWN_MAX_MS);
  }

  /**
   * Clear a `'failed'` slot's breaker state in place (used by both the
   * auto-heal path in `ensureRunning` and could be called directly by a
   * future explicit "retry now" caller). Unlike {@link resetFailure} this
   * does NOT remove the slot from `this.runtimes` — the caller is about to
   * reuse the same object as the `existing` slot for a fresh `doStart()`,
   * so timers/state on it are about to be overwritten by that path anyway.
   * `breakerTrips` and `restartTimestamps` are deliberately left alone:
   * they're what makes cooldowns escalate for a project that keeps
   * re-tripping, and `armGraceTimer` is what resets them back to zero once
   * the project actually recovers.
   */
  private healBreaker(slot: InternalRuntime): void {
    slot.status = 'stopped';
    slot.consecutiveFailures = 0;
  }

  async stopAll(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    this.stopped = true;
    // Stop watchers FIRST so their final flush has a chance to PUT before
    // we tear down processes. We don't await individual stops in parallel
    // with runtime stops because watcher.stop() does network IO and we
    // want it to complete before the runtime kill.
    const watcherIds = Array.from(this.watchers.keys());
    await Promise.all(watcherIds.map(async (id) => {
      const w = this.watchers.get(id);
      this.watchers.delete(id);
      if (w) {
        try { await w.stop(); } catch (err: any) {
          this.log.warn(`[WorkerRuntimeManager] watcher stop ${id}: ${err?.message ?? err}`);
        }
      }
    }));

    const ids = Array.from(this.runtimes.keys());
    await Promise.all(ids.map((id) => this.stop(id, signal).catch((err) => {
      this.log.error(`[WorkerRuntimeManager] Failed to stop ${id}: ${err?.message ?? err}`);
    })));
  }

  // ─── Internals ──────────────────────────────────────────────────

  private makeSlot(projectId: string, config: ProjectSpawnConfig): InternalRuntime {
    return {
      projectId,
      agentPort: 0,
      apiServerPort: 0,
      status: 'starting',
      proc: null,
      pid: null,
      startedAt: 0,
      lastStdoutAt: 0,
      lastUsedAt: Date.now(),
      restarts: 0,
      consecutiveFailures: 0,
      lastFailureAt: 0,
      breakerTrips: 0,
      restartTimestamps: [],
      graceTimer: null,
      restartTimer: null,
      idleTimer: null,
      limitWatchdog: null,
      spawnConfig: config,
      startPromise: null,
    };
  }

  private async doStart(slot: InternalRuntime): Promise<InternalRuntime> {
    const resolved = this.resolveBinary();
    if (!resolved) {
      slot.status = 'error';
      slot.lastError = 'agent-runtime binary not found (run `shogo runtime install`)';
      throw new Error(slot.lastError);
    }

    if (!slot.agentPort) {
      slot.agentPort = await this.allocatePort();
      slot.apiServerPort = slot.agentPort + API_PORT_OFFSET;
    }

    const env = this.buildEnv(slot, resolved.path);
    const cwd = this.resolveCwd(slot);
    const baseSpawn = this.spawnCommand(resolved.path);

    // Resource limits: on Linux, prefer wrapping the spawn in a rootless
    // systemd cgroup scope (hard memory.max/cpu.max). The other platforms and
    // the systemd-absent fallback are handled post-spawn in applyPostSpawnLimits.
    const limits = this.resolveLimits();
    let command = baseSpawn.command;
    let args = baseSpawn.args;
    let cgroupWrapped = false;
    if (limits) {
      const wrapped = wrapSpawnForCgroup({
        command: baseSpawn.command,
        args: baseSpawn.args,
        limits,
        scopeName: `shogo-rt-${slot.projectId.slice(0, 8)}-${Date.now().toString(36)}`,
        logger: this.log,
      });
      command = wrapped.command;
      args = wrapped.args;
      cgroupWrapped = wrapped.wrapped;
    }

    this.log.log(
      `[WorkerRuntimeManager] Spawning agent-runtime for ${slot.projectId} ` +
        `via ${command} ${args.join(' ')} (port=${slot.agentPort}, source=${resolved.source}` +
        `${limits ? `, memCeil=${limits.memoryMB}M` : ''})`,
    );

    // Spawn the runtime as its own process group leader (posix only —
    // Windows has no equivalent and Node's child_process docs warn that
    // `detached: true` there gives you a separate console window, not a
    // PGID). Mirrors what apps/desktop/src/local-server.ts already does
    // for the outer API server so a single kill at teardown reaches the
    // bun child + every subprocess it spawned (vite, the inner
    // preview-manager API server, tsserver, pyright). Without this,
    // jetsam SIGKILL of the bun parent leaves all of those orphans
    // alive — they keep their listening sockets, the next respawn
    // races into EADDRINUSE, and RSS climbs forever (see the storm
    // pattern in main.log lines 5258–7093 where preview-manager has to
    // walk the API port and `Force-killed leaked process` 10 times in
    // a row).
    const useProcessGroup = process.platform !== 'win32';
    const proc = spawn(command, args, {
      cwd,
      env,
      detached: useProcessGroup,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (useProcessGroup) {
      // The detached child would otherwise keep the parent's event
      // loop alive even after we've removed it from `runtimes` —
      // matches the apps/desktop precedent at local-server.ts:412.
      try { proc.unref(); } catch { /* unref is best-effort */ }
    }

    slot.proc = proc;
    slot.pid = proc.pid ?? null;
    slot.status = 'starting';
    slot.startedAt = Date.now();
    const openAttemptId = slot.spawnConfig.extraEnv?.SHOGO_OPEN_ID;
    perfLog('agent-spawned', slot.projectId, openAttemptId, {
      pid: slot.pid,
      command,
      args,
      source: resolved.source,
    });

    // Enforce the per-project memory/CPU ceiling on the freshly-spawned group
    // (cgroup direct-write / Windows Job Object / RSS watchdog fallback). No-op
    // when the systemd scope above already caps it or no limit is configured.
    if (limits) {
      try {
        this.applyPostSpawnLimits(slot, limits, cgroupWrapped);
      } catch (err: any) {
        this.log.warn(
          `[WorkerRuntimeManager] failed to apply resource limits for ${slot.projectId}: ${err?.message ?? err}`,
        );
      }
    }
    // Seed the progress timestamp at spawn so a child that emits its
    // first line within `STDOUT_PROGRESS_WINDOW_MS` is treated as
    // "making progress since spawn" without the readiness check having
    // to special-case the cold-start gap.
    slot.lastStdoutAt = slot.startedAt;

    proc.on('error', (err) => {
      slot.lastError = err?.message ?? String(err);
      this.log.error(`[WorkerRuntimeManager] spawn error for ${slot.projectId}: ${slot.lastError}`);
    });

    proc.on('exit', (code, signal) => {
      this.handleExit(slot, code, signal);
    });

    const prefix = `[runtime:${slot.projectId.slice(0, 8)}]`;
    let firstOutput = true;
    // Each output line bumps `lastStdoutAt` — used by waitForHealth as
    // a forward-progress signal so a long-but-still-booting child
    // (LSP spawn, optimizeDeps, hook registration) doesn't get
    // SIGTERM'd mid-boot just because /health hasn't responded yet.
    proc.stdout?.on('data', (data) => {
      slot.lastStdoutAt = Date.now();
      if (firstOutput) {
        firstOutput = false;
        perfLog('agent-first-output', slot.projectId, openAttemptId, {
          elapsedMs: Date.now() - (slot.startedAt ?? Date.now()),
        });
      }
      for (const line of data.toString().trimEnd().split('\n')) {
        if (line) this.log.log(`${prefix} ${line}`);
      }
    });
    proc.stderr?.on('data', (data) => {
      slot.lastStdoutAt = Date.now();
      if (firstOutput) {
        firstOutput = false;
        perfLog('agent-first-output', slot.projectId, openAttemptId, {
          elapsedMs: Date.now() - (slot.startedAt ?? Date.now()),
          stream: 'stderr',
        });
      }
      for (const line of data.toString().trimEnd().split('\n')) {
        if (line) this.log.error(`${prefix} ${line}`);
      }
    });

    try {
      await this.waitForHealth(slot, HEALTH_BOOT_TIMEOUT_MS);
      perfLog('agent-health-ready', slot.projectId, openAttemptId, {
        elapsedMs: Date.now() - (slot.startedAt ?? Date.now()),
        agentPort: slot.agentPort,
      });
      slot.status = 'running';
      slot.lastUsedAt = Date.now();
      this.armIdleTimer(slot);
      this.armGraceTimer(slot);
      return slot;
    } catch (err: any) {
      slot.status = 'error';
      slot.lastError = err?.message ?? String(err);
      // The /health wait timed out (or the spawn itself failed). Tear
      // down the whole process group rather than just the parent so we
      // don't leave a half-booted preview-manager + vite running on
      // the allocated ports.
      this.killProcessGroup(slot, 'SIGTERM');
      this.killViteWatch(slot);
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      this.releasePort(slot.agentPort);
      slot.agentPort = 0;
      slot.apiServerPort = 0;
      throw err;
    }
  }

  /**
   * Kill every process in `slot.pid`'s process group / job tree.
   * Best-effort: if the group is already gone (everyone exited cleanly)
   * this is a no-op.
   *
   * Why we use the recorded PID and not `slot.proc.pid`: by the time
   * {@link handleExit} runs, `proc` has already fired its `'exit'`
   * event and we've nulled it. The kernel keeps the process group
   * intact until the *last* member of the group exits, so the PGID
   * we captured at spawn is still valid for reaping the orphans even
   * after the group leader is gone.
   *
   * Windows: `process.kill(-pid, ...)` is unsupported and Node's
   * `child.kill('SIGTERM')` is just `TerminateProcess` on the parent,
   * which does NOT cascade to grandchildren — vite, the inner
   * preview-manager API server, tsserver, pyright, and `server.tsx`
   * all survive as orphans (each holding chokidar watcher handles
   * that wedge the next spawn's event loop). We use `taskkill /F /T`
   * to walk the process tree by parent PID instead.
   */
  /** Memoized per-project resource limits from the environment. */
  private resolveLimits(): RuntimeResourceLimits | null {
    if (this.resolvedLimits === undefined) {
      this.resolvedLimits = resolveResourceLimits(this.opts.env ?? process.env);
    }
    return this.resolvedLimits;
  }

  /**
   * Apply the strongest available OS-level cap to a freshly-spawned runtime,
   * or start the RSS watchdog as a fallback. Called right after spawn so most
   * of the runtime's children inherit the cgroup/Job Object.
   *
   * @param cgroupWrapped true when the spawn was already wrapped in a
   *   `systemd-run` scope (Linux), in which case the cap is already enforced.
   */
  private applyPostSpawnLimits(
    slot: InternalRuntime,
    limits: RuntimeResourceLimits,
    cgroupWrapped: boolean,
  ): void {
    const pid = slot.pid;
    if (!pid) return;

    if (process.platform === 'linux') {
      if (cgroupWrapped) return; // systemd scope already enforces the cap
      if (attachDirectCgroup({ pid, limits, logger: this.log })) return;
      // fall through to watchdog
    } else if (process.platform === 'win32') {
      if (tryAttachJobObject({ pid, limits, logger: this.log })) return;
      // fall through to watchdog
    }

    // macOS always, or a fallback from the branches above: sample RSS and
    // restart the group on sustained breach.
    slot.limitWatchdog = new RssWatchdog({
      pid,
      ceilingMB: limits.memoryMB,
      logger: this.log,
      onBreach: (rssMB) => this.handleLimitBreach(slot, rssMB, limits.memoryMB),
    });
    slot.limitWatchdog.start();
  }

  /**
   * React to a memory-ceiling breach reported by the RSS watchdog: tear the
   * process group down gracefully. The existing `handleExit` path then treats
   * this as a non-clean exit and restarts with backoff (a project that keeps
   * ballooning will trip the circuit breaker, exactly as with an OOM loop).
   */
  private handleLimitBreach(slot: InternalRuntime, rssMB: number, ceilingMB: number): void {
    this.log.warn(
      `[WorkerRuntimeManager] runtime ${slot.projectId} exceeded memory ceiling ` +
        `(${rssMB}MB > ${ceilingMB}MB) — restarting`,
    );
    slot.lastError = `memory ceiling exceeded (${rssMB}MB > ${ceilingMB}MB)`;
    if (slot.limitWatchdog) { slot.limitWatchdog.stop(); slot.limitWatchdog = null; }
    this.killProcessGroup(slot, 'SIGTERM');
    this.killViteWatch(slot);
    try { slot.proc?.kill('SIGTERM'); } catch { /* already gone */ }
    // Escalate to SIGKILL if the group ignores SIGTERM within the grace window.
    const killTimer = setTimeout(() => {
      this.killProcessGroup(slot, 'SIGKILL');
      this.killViteWatch(slot);
    }, 5000);
    try { killTimer.unref?.(); } catch { /* unref is best-effort */ }
  }

  private killProcessGroup(slot: InternalRuntime, signal: NodeJS.Signals): void {
    if (!slot.pid) return;
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(slot.pid)], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        // taskkill missing or the tree already collapsed — either way
        // we have no recourse and the parent .kill() above (or the
        // belt-and-suspenders SIGKILL in waitForExit) is the best we
        // can still do.
      }
      return;
    }
    try {
      process.kill(-slot.pid, signal);
    } catch {
      // ESRCH (no such process group) is the happy path here — it
      // means every child exited with their parent and the kernel
      // already reaped the group. EPERM is the only other plausible
      // case; swallow it because the caller has no recourse anyway.
    }
  }

  /**
   * Arm a timer that resets `consecutiveFailures` once a fresh run has
   * survived for {@link STARTUP_GRACE_MS}. Re-armed on every successful
   * /health transition; cleared on any non-clean exit so a crash
   * inside the grace window counts toward the circuit breaker.
   *
   * Also resets `breakerTrips` and `restartTimestamps` on that same
   * survived-a-full-grace-window signal: a project that's actually
   * recovered for good shouldn't carry an escalated auto-heal cooldown
   * (see `breakerCooldownMs`) or slow-bleed history from an incident
   * months ago into its next unrelated hiccup.
   */
  private armGraceTimer(slot: InternalRuntime): void {
    if (slot.graceTimer) {
      clearTimeout(slot.graceTimer);
      slot.graceTimer = null;
    }
    slot.graceTimer = setTimeout(() => {
      slot.graceTimer = null;
      if (slot.consecutiveFailures > 0) {
        slot.consecutiveFailures = 0;
      }
      slot.breakerTrips = 0;
      slot.restartTimestamps = [];
    }, STARTUP_GRACE_MS);
    try { slot.graceTimer.unref?.(); } catch { /* unref is best-effort */ }
  }

  private buildEnv(slot: InternalRuntime, runtimeBinPath: string): NodeJS.ProcessEnv {
    const cfg = slot.spawnConfig;
    const env: NodeJS.ProcessEnv = {
      ...(this.opts.env ?? process.env),
      PROJECT_ID: slot.projectId,
      PORT: String(slot.agentPort),
      API_SERVER_PORT: String(slot.apiServerPort),
      SKILL_SERVER_PORT: String(slot.apiServerPort),
      // Per-runtime base for workspace preview sidecars (server.tsx). Anchored
      // at agentPort+2 so each warm runtime owns a distinct sidecar range and
      // they can't all collide on the fixed default (3101) — the cause of the
      // preview-manager crash-loop / agent-runtime SIGKILL restart storm when
      // multiple projects are kept warm at once.
      WORKSPACE_API_PORT_BASE: String(slot.agentPort + PREVIEW_API_BASE_OFFSET),
      NODE_ENV: 'production',
      STARTUP_TIME: String(Date.now()),
      SHOGO_CLOUD_URL: cfg.cloudUrl,
      SHOGO_API_URL: cfg.cloudUrl,
      SHOGO_API_KEY: cfg.apiKey,
      RUNTIME_AUTH_SECRET: deriveRuntimeToken(slot.projectId),
      WEBHOOK_TOKEN: deriveWebhookToken(slot.projectId),
    };

    if (cfg.projectDir) {
      env.PROJECT_DIR = cfg.projectDir;
      env.WORKSPACE_DIR = cfg.projectDir;
    }
    // Tell the agent-runtime to skip its built-in S3Sync — the worker is
    // already running a CloudFileTransport watcher against this WORKSPACE_DIR.
    // Without this both sides upload the same files and the watcher loops on
    // its own writes.
    //
    // Gate on whether THIS project was actually auto-pulled, not just on the
    // global `autoPull.enabled` flag: a worker can serve a pre-pulled or
    // operator-pinned `projectDir` that auto-pull skipped (line 777), and a
    // desktop-style embed enables auto-pull globally but still seeds some
    // projects from a local template. Those projects have no watcher, so they
    // must keep the runtime's own S3Sync/checkpoint behavior.
    if (this.shouldDeferToCloudSync(slot.projectId)) {
      env.SHOGO_CLOUD_SYNC = '1';
    }
    if (cfg.aiProxyUrl) env.AI_PROXY_URL = cfg.aiProxyUrl;
    if (cfg.aiProxyToken) env.AI_PROXY_TOKEN = cfg.aiProxyToken;
    if (cfg.techStackId) env.TECH_STACK_ID = cfg.techStackId;
    if (cfg.name) env.AGENT_NAME = cfg.name;
    if (cfg.workspaceId) env.WORKSPACE_ID = cfg.workspaceId;

    // Belt-and-suspenders: explicitly point the spawned agent-runtime at
    // the WASM sidecar that ships next to its binary. The runtime's own
    // `code-extractor.ts:getWasmDir()` would derive the same path from
    // `dirname(process.execPath)` as a fallback, but exporting it here:
    //
    //   (a) makes the resolved location observable via `env | grep
    //       TREE_SITTER` for an operator debugging a self-hosted box,
    //   (b) survives a future build-script regression that breaks the
    //       sidecar copy on a per-platform basis (the env var still
    //       points to the expected directory, so the loud failure in
    //       `code-extractor.ts:getLanguage()` reports the right path),
    //   (c) keeps explicit operator overrides working — the runtime
    //       reads `process.env.TREE_SITTER_WASM_DIR` first, so an
    //       operator who sets it externally still wins.
    //
    // We do NOT verify the directory exists here. The runtime's
    // resolver does that check; if it's missing we want the loud
    // runtime error (which lists every override knob), not a silent
    // worker-side `process.env` deletion that hides the bundling bug.
    if (!env.TREE_SITTER_WASM_DIR) {
      env.TREE_SITTER_WASM_DIR = join(dirname(runtimeBinPath), 'tree-sitter-wasm');
    }

    if (cfg.extraEnv) Object.assign(env, cfg.extraEnv);

    // Secondary hint: cap the JS heap of Node children (tsserver, vite/esbuild)
    // and Bun below the RSS ceiling so a JS OOM (recoverable) trips before the
    // OS-level cap/watchdog kills the whole group. OS limits are the real cap.
    const limits = this.resolveLimits();
    if (limits) applyHeapEnvCap(env, limits.memoryMB);

    return env;
  }

  private killViteWatch(slot: InternalRuntime): void {
    const workspaceDir = slot.spawnConfig.projectDir;
    if (!workspaceDir) return;
    try {
      killViteWatchFromPidfile(workspaceDir, { logger: this.log });
    } catch (err: any) {
      this.log.warn(
        `[WorkerRuntimeManager] Vite watch cleanup for ${slot.projectId} failed: ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Clean pidfiles left by a previous worker process before this manager
   * starts accepting projects. The command-line verification in
   * killViteWatchFromPidfile prevents a reused PID from being signalled.
   */
  private sweepOrphanedViteWatches(): void {
    const projectsDir = this.opts.autoPull?.projectsDir;
    if (!projectsDir) return;

    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || this.runtimes.has(entry.name)) continue;
      const workspaceDir = join(projectsDir, entry.name);
      try {
        const reaped = killViteWatchFromPidfile(workspaceDir, { logger: this.log });
        if (reaped) {
          this.log.log(
            `[WorkerRuntimeManager] Reaped orphaned Vite watch for ${entry.name} (pid=${reaped.pid})`,
          );
        }
      } catch (err: any) {
        this.log.warn(
          `[WorkerRuntimeManager] Vite watch startup sweep failed for ${entry.name}: ${err?.message ?? err}`,
        );
      }
    }
  }

  private resolveCwd(slot: InternalRuntime): string {
    const cfg = slot.spawnConfig;
    if (cfg.projectDir && existsSync(cfg.projectDir)) return cfg.projectDir;
    const fallback = this.opts.runtimeWorkDir ?? join(tmpdir(), 'shogo-runtime', slot.projectId);
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }

  private handleExit(slot: InternalRuntime, code: number | null, signal: NodeJS.Signals | null): void {
    const exitedClean = signal === null && code === 0;
    this.log.log(
      `[WorkerRuntimeManager] runtime ${slot.projectId} exited (code=${code}, signal=${signal})`,
    );
    slot.proc = null;
    if (slot.graceTimer) {
      clearTimeout(slot.graceTimer);
      slot.graceTimer = null;
    }
    // The process (and its group) is gone — stop sampling its RSS. A fresh
    // watchdog is armed by the next doStart() if the runtime restarts.
    if (slot.limitWatchdog) { slot.limitWatchdog.stop(); slot.limitWatchdog = null; }
    // PreviewManager.stop() normally removes this, but a runtime killed by
    // jetsam or SIGKILL cannot run its JS teardown. Reap the detached Vite
    // group from the durable pidfile before deciding whether to restart.
    this.killViteWatch(slot);

    if (slot.status === 'stopping' || this.stopped) {
      // We initiated the stop; the orphan reap was already done by
      // stop()/stopAll(). Just clear bookkeeping.
      slot.status = 'stopped';
      slot.pid = null;
      this.releasePort(slot.agentPort);
      slot.agentPort = 0;
      slot.apiServerPort = 0;
      return;
    }

    if (exitedClean) {
      slot.status = 'stopped';
      slot.pid = null;
      this.releasePort(slot.agentPort);
      slot.agentPort = 0;
      slot.apiServerPort = 0;
      this.runtimes.delete(slot.projectId);
      this.notifyGone(slot.projectId, { reason: 'exited', code, signal });
      return;
    }

    // Non-clean exit. Two failure shapes we care about:
    //   1. Parent died but children (vite, preview-manager API server,
    //      LSPs) are still alive in the same process group. Without
    //      reaping, the next doStart() races into EADDRINUSE on the
    //      same agent port and starts the storm.
    //   2. Repeated jetsam SIGKILL under memory pressure. Each cycle
    //      respawns the full child tree and leaks more RSS. The
    //      circuit breaker below stops that loop.
    this.killProcessGroup(slot, 'SIGKILL');
    this.killViteWatch(slot);
    slot.pid = null;

    const now = Date.now();
    const withinWindow = now - slot.lastFailureAt <= RESTART_FAILURE_WINDOW_MS;
    slot.consecutiveFailures = withinWindow ? slot.consecutiveFailures + 1 : 1;
    slot.lastFailureAt = now;
    slot.restarts += 1;
    slot.lastError = `exited code=${code} signal=${signal}`;

    // Slow-bleed tracking: independent of `consecutiveFailures`, which the
    // 60s startup grace timer resets on every incarnation that survives a
    // minute. Pruned to a rolling hour so a project that crashed a lot last
    // month doesn't stay flagged forever.
    slot.restartTimestamps.push(now);
    slot.restartTimestamps = slot.restartTimestamps.filter((t) => now - t <= SLOW_BLEED_WINDOW_MS);

    const tightLoopTripped = slot.consecutiveFailures >= MAX_CONSECUTIVE_RESTARTS;
    const slowBleedTripped = slot.restartTimestamps.length >= SLOW_BLEED_MAX_RESTARTS;

    if (tightLoopTripped || slowBleedTripped) {
      slot.status = 'failed';
      slot.breakerTrips += 1;
      const cooldownMs = this.breakerCooldownMs(slot.breakerTrips);
      const cause = tightLoopTripped
        ? `${slot.consecutiveFailures} consecutive non-clean exits within ${Math.round(RESTART_FAILURE_WINDOW_MS / 1000)}s`
        : `${slot.restartTimestamps.length} non-clean exits within the last ${Math.round(SLOW_BLEED_WINDOW_MS / 60_000)}m (slow-bleed loop — gaps between crashes kept clearing the tight-loop window)`;
      slot.lastError =
        `Circuit breaker tripped (trip #${slot.breakerTrips}): ${cause} ` +
        `(last: code=${code} signal=${signal}). Most recent on macOS is jetsam OOM ` +
        `(signal=SIGKILL with code=null); the previous incarnation's vite/tsserver/` +
        `preview-manager children were reaped to prevent further RSS growth. ` +
        `Will auto-retry in ~${Math.round(cooldownMs / 1000)}s; call resetFailure(${slot.projectId}) ` +
        `to retry immediately, or stop(${slot.projectId}) to give up.`;
      this.releasePort(slot.agentPort);
      slot.agentPort = 0;
      slot.apiServerPort = 0;
      if (slot.restartTimer) { clearTimeout(slot.restartTimer); slot.restartTimer = null; }
      if (slot.idleTimer) { clearTimeout(slot.idleTimer); slot.idleTimer = null; }
      this.log.error(`[WorkerRuntimeManager] ${slot.lastError}`);
      this.notifyGone(slot.projectId, { reason: 'failed', code, signal });
      return;
    }

    const delay = this.restartBackoffMs(slot.restarts);
    slot.status = 'restarting';
    this.log.warn(
      `[WorkerRuntimeManager] restarting ${slot.projectId} in ${Math.round(delay / 1000)}s ` +
        `(restart #${slot.restarts}, consecutive failures ${slot.consecutiveFailures}/${MAX_CONSECUTIVE_RESTARTS})`,
    );
    if (slot.restartTimer) clearTimeout(slot.restartTimer);
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = null;
      if (slot.status === 'failed' || this.stopped) return;
      slot.startPromise = this.doStart(slot).then((r) => {
        slot.startPromise = null;
        return r;
      }).catch((err) => {
        slot.startPromise = null;
        this.log.error(`[WorkerRuntimeManager] restart of ${slot.projectId} failed: ${err?.message ?? err}`);
        return slot;
      });
    }, delay);
    try { slot.restartTimer.unref?.(); } catch { /* unref is best-effort */ }
  }

  private restartBackoffMs(restarts: number): number {
    const base = Math.min(RESTART_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, restarts - 1)), RESTART_BACKOFF_MAX_MS);
    const jitter = base * 0.2 * Math.random();
    return base + jitter;
  }

  private armIdleTimer(slot: InternalRuntime): void {
    if (slot.idleTimer) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = null;
    }
    const idleMs = this.opts.idleMs ?? RUNTIME_IDLE_MS;
    // `idleMs <= 0` or non-finite disables eviction. Used by desktop /
    // `SHOGO_LOCAL_MODE=true` where reaping a "stale" runtime really
    // means killing the in-flight chat stream of the only user.
    if (!Number.isFinite(idleMs) || idleMs <= 0) return;
    slot.idleTimer = setTimeout(() => {
      const since = Date.now() - slot.lastUsedAt;
      if (since < idleMs) {
        // Got touched between scheduling and firing — re-arm.
        this.armIdleTimer(slot);
        return;
      }
      this.log.log(`[WorkerRuntimeManager] idle-evicting ${slot.projectId} after ${Math.round(since / 1000)}s`);
      void this.stop(slot.projectId, 'SIGTERM', 'idle-evict').catch((err) => {
        this.log.warn(`[WorkerRuntimeManager] idle stop failed: ${err?.message ?? err}`);
      });
    }, idleMs);
  }

  private async allocatePort(): Promise<number> {
    const range = PORT_RANGE_END - PORT_RANGE_START;
    const maxAttempts = Math.min(range, 50);
    for (let i = 0; i < maxAttempts; i++) {
      const candidate = PORT_RANGE_START + Math.floor(Math.random() * range);
      // Reserve a contiguous per-runtime block so the agent port, its API
      // server AND every preview sidecar (WORKSPACE_API_PORT_BASE + idx) live
      // in a range that no other warm runtime can overlap.
      if (candidate + RUNTIME_PORT_BLOCK - 1 > PORT_RANGE_END) continue;
      let blockFree = true;
      for (let off = 0; off < RUNTIME_PORT_BLOCK; off++) {
        if (this.usedPorts.has(candidate + off)) { blockFree = false; break; }
      }
      if (!blockFree) continue;
      // Liveness-probe only the two ports we bind eagerly (agent + its API
      // server). The sidecar ports are bound lazily by the agent-runtime and
      // guarded by its own leaked-process force-kill, so probing the whole
      // block here would just slow allocation down.
      const agentInUse = await this.isPortListening(candidate);
      const apiInUse = await this.isPortListening(candidate + API_PORT_OFFSET);
      if (agentInUse || apiInUse) continue;
      for (let off = 0; off < RUNTIME_PORT_BLOCK; off++) this.usedPorts.add(candidate + off);
      return candidate;
    }
    throw new Error(
      `Cannot allocate port in range ${PORT_RANGE_START}-${PORT_RANGE_END} after ${maxAttempts} attempts`,
    );
  }

  private releasePort(port: number): void {
    if (!port) return;
    for (let off = 0; off < RUNTIME_PORT_BLOCK; off++) this.usedPorts.delete(port + off);
  }

  private async isPortListening(port: number): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 250);
    try {
      await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD', signal: controller.signal });
      clearTimeout(timer);
      return true;
    } catch {
      clearTimeout(timer);
      return false;
    }
  }

  /**
   * Kernel-level TCP-accept probe. Resolves `true` if a TCP connection
   * to `127.0.0.1:port` succeeds within {@link TCP_CONNECT_TIMEOUT_MS},
   * `false` for any failure mode (refused, timed out, host unreachable).
   *
   * This is intentionally distinct from {@link isPortListening} (which
   * fires an HTTP HEAD): we want to know whether `Bun.serve()` has
   * bound the socket, NOT whether its request handler is responding.
   * Once the kernel has the listener, the agent-runtime's
   * `export default { port, fetch }` has been evaluated — which is
   * sufficient evidence to clear the boot gate even if the event loop
   * is still busy JIT-compiling the rest of the TS dep graph. Without
   * this distinction every `--conditions=development` cold boot on
   * Windows hits the HEALTH_BOOT_TIMEOUT_MS ceiling because /health
   * is the very last thing the saturated event loop gets to.
   */
  private tcpProbe(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch {
          /* socket may already be torn down */
        }
        resolve(ok);
      };
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(TCP_CONNECT_TIMEOUT_MS);
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('timeout', () => finish(false));
    });
  }

  /**
   * Wait for a freshly-spawned agent-runtime to be HTTP-responsive on
   * /health. This is the gate that drives the slot's `'starting'` →
   * `'running'` transition; every consumer of `status === 'running'`
   * (`/sandbox/url`, AgentProxy, the iframe preview readiness probe)
   * assumes the runtime can actually serve requests, so this gate
   * must mean exactly that — not "the kernel accepted a TCP listener
   * on the port".
   *
   * Loop semantics:
   *
   *   1. **HTTP /health 2xx → return.** Happy path; the event loop
   *      is responsive and the slot can transition to `'running'`.
   *
   *   2. **Child exits → throw.** Same as before — surface the
   *      exit code/signal so restart-with-backoff can recover from
   *      crashes-during-boot without burning the full timeout.
   *
   *   3. **TCP listening + stdout silent > {@link STDOUT_PROGRESS_WINDOW_MS}
   *      → throw.** TCP up but no log lines for 30s is "wedged":
   *      Bun is past `Bun.serve()` (so the kernel has the port) but
   *      something inside the runtime spun the event loop to death
   *      (infinite loop, deadlock). Bail so the restart loop can
   *      SIGTERM and respawn instead of spinning the full timeoutMs.
   *
   *   4. **`timeoutMs` elapsed → throw.** Final ceiling. After the
   *      2026-05 fix that deferred LSP + IndexEngine out of the
   *      critical-path boot sequence in agent-runtime, a healthy
   *      Windows cold boot is ~8-12 s; the 30 s budget gives a
   *      comfortable margin without hiding real hangs.
   *
   * Progress logging: every {@link HEALTH_PROGRESS_LOG_MS} we emit a
   * single line summarizing where the wait stands so the dev/operator
   * watching `[dev:all]` sees something happen during the slow path
   * instead of staring at a silent terminal for a minute.
   *
   * What changed vs the pre-2026-05 fast path: that revision returned
   * as soon as TCP-listening + recent stdout was true, treating "the
   * child is making progress" as ready. In practice the child was
   * still saturated for tens of seconds after that point, so the UI
   * would start its preview iframe load and the API server its agent
   * proxy, both of which then hit their own (4-15s) timeouts and
   * surfaced as the "Connection timed out — The agent runtime could
   * not be reached" toast plus "[AgentProxy] timeout, retrying" log
   * spam. The new gate trades 20-60s of additional boot wait for a
   * `'running'` signal the rest of the stack can actually trust.
   */
  private async waitForHealth(slot: InternalRuntime, timeoutMs: number): Promise<void> {
    const port = slot.agentPort;
    const proc = slot.proc;
    if (!proc) {
      throw new Error(`waitForHealth: slot ${slot.projectId} has no spawned process`);
    }
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let lastError: string | null = null;
    let lastTcpListening = false;
    let lastTcpAt = 0;
    let httpAttempts = 0;
    let tcpAttempts = 0;
    let iteration = 0;
    let lastProgressLogAt = startedAt;

    while (Date.now() < deadline) {
      iteration++;
      if (proc.exitCode !== null || proc.signalCode != null || proc.killed) {
        throw new Error(
          `agent-runtime exited (code=${proc.exitCode}, signal=${proc.signalCode}) before becoming healthy on port ${port}`,
        );
      }

      // Primary signal: HTTP /health. This is the only signal that
      // declares the runtime ready — TCP-listening alone is not enough
      // (see class docstring above for the rationale).
      httpAttempts++;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 1500);
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/health`, {
          method: 'GET',
          signal: controller.signal,
        });
        clearTimeout(t);
        if (resp.ok) {
          this.log.log(
            `[WorkerRuntimeManager] /health ready for ${slot.projectId} on port ${port} ` +
              `(HTTP ${resp.status} after ${Date.now() - startedAt}ms, ${iteration} iter, ${httpAttempts} http)`,
          );
          return;
        }
        // Non-2xx is recorded but doesn't short-circuit — the runtime
        // may briefly serve 503 while initializing post-bind.
        lastError = `HTTP /health returned ${resp.status}`;
      } catch (err: any) {
        clearTimeout(t);
        const name = err?.name ?? 'Error';
        const code = err?.code ?? err?.cause?.code;
        lastError = `HTTP /health failed: ${name}${code ? `(${code})` : ''}: ${err?.message ?? err}`;
      }

      // Secondary signal: TCP listener + stdout activity. Now used ONLY
      // as a wedge detector — if TCP is up but stdout has been silent
      // for the progress window, abandon the wait so the restart loop
      // can recover. Never declares the runtime ready on its own.
      tcpAttempts++;
      lastTcpListening = await this.tcpProbe(port);
      if (lastTcpListening) {
        lastTcpAt = Date.now();
        const sinceStdoutMs = Date.now() - slot.lastStdoutAt;
        if (sinceStdoutMs >= STDOUT_PROGRESS_WINDOW_MS) {
          throw new Error(
            `agent-runtime wedged on port ${port}: TCP listening but stdout silent for ` +
              `${sinceStdoutMs}ms (> ${STDOUT_PROGRESS_WINDOW_MS}ms window); ` +
              `${httpAttempts} /health attempts, last error: ${lastError ?? 'n/a'}`,
          );
        }
      }

      const now = Date.now();
      if (now - lastProgressLogAt >= HEALTH_PROGRESS_LOG_MS) {
        const elapsedMs = now - startedAt;
        const sinceStdoutMs = now - slot.lastStdoutAt;
        const sinceTcpMs = lastTcpAt > 0 ? now - lastTcpAt : null;
        this.log.log(
          `[WorkerRuntimeManager] still waiting for /health on ${slot.projectId} ` +
            `port ${port} (${(elapsedMs / 1000).toFixed(1)}s elapsed, ` +
            `tcpListening=${lastTcpListening}${sinceTcpMs != null ? `(${sinceTcpMs}ms ago)` : ''}, ` +
            `lastStdout=${sinceStdoutMs}ms ago, ${httpAttempts} http, ${tcpAttempts} tcp, ` +
            `lastError=${lastError ?? 'n/a'})`,
        );
        lastProgressLogAt = now;
      }

      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }

    if (proc.exitCode !== null || proc.signalCode != null || proc.killed) {
      throw new Error(
        `agent-runtime exited (code=${proc.exitCode}, signal=${proc.signalCode}) before becoming healthy on port ${port}`,
      );
    }
    throw new Error(
      `Timeout waiting for agent-runtime /health on port ${port} ` +
        `after ${iteration} iter (httpAttempts=${httpAttempts}, tcpAttempts=${tcpAttempts}, ` +
        `tcpListening=${lastTcpListening}, lastError=${lastError ?? 'n/a'})`,
    );
  }

  private async waitForExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
    if (proc.exitCode !== null || proc.signalCode != null || proc.killed) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        resolve();
      }, timeoutMs);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private snapshot(r: InternalRuntime): RuntimeStatusInfo {
    return {
      projectId: r.projectId,
      status: r.status,
      agentPort: r.agentPort || undefined,
      apiServerPort: r.apiServerPort || undefined,
      pid: r.proc?.pid,
      startedAt: r.startedAt || undefined,
      lastUsedAt: r.lastUsedAt,
      restarts: r.restarts,
      lastError: r.lastError,
    };
  }
}
