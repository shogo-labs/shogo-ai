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
import { type ChildProcess, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveRuntime, type ResolvedRuntime } from './runtime-resolver.ts';
import type { ResolveRejection, RuntimeResolver } from './tunnel.ts';
import { CloudFileTransport } from '@shogo-ai/sdk';
import { CloudSyncWatcher } from './cloud-sync-watcher.ts';
import { cloneProject, gitIsAvailable, isGitRepo } from './git-cloner.ts';

/** Port range for random allocation (mirrors apps/api desktop manager). */
const PORT_RANGE_START = 37100;
const PORT_RANGE_END = 37900;
const API_PORT_OFFSET = 1; // API server port = agentPort + 1.

/** Default idle eviction window — unused runtimes get killed after this. */
const RUNTIME_IDLE_MS = 15 * 60 * 1000;

/** Restart backoff bounds. */
const RESTART_BACKOFF_BASE_MS = 1_000;
const RESTART_BACKOFF_MAX_MS = 60_000;

/** Health check poll interval while waiting for /health. */
const HEALTH_POLL_MS = 500;
/** Total timeout waiting for first /health success after spawn. */
const HEALTH_BOOT_TIMEOUT_MS = 30_000;

export type RuntimeStatus = 'starting' | 'running' | 'restarting' | 'stopping' | 'stopped' | 'error';

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
  /** Template id passed through to the runtime. */
  templateId?: string;
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
  /** Idle window in ms before evicting an unused runtime (default 15min). */
  idleMs?: number;
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
}

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
  startedAt: number;
  lastUsedAt: number;
  restarts: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
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
      return this.snapshot(r);
    } finally {
      slot.startPromise = null;
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
      const shogoEntries = manifest.filter((e) => e.path === '.shogo' || e.path.startsWith('.shogo/'));
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

  async stop(projectId: string, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const r = this.runtimes.get(projectId);
    if (!r) return;
    r.status = 'stopping';
    if (r.restartTimer) { clearTimeout(r.restartTimer); r.restartTimer = null; }
    if (r.idleTimer) { clearTimeout(r.idleTimer); r.idleTimer = null; }
    if (r.proc) {
      try { r.proc.kill(signal); } catch { /* already gone */ }
      await this.waitForExit(r.proc, 5000);
    }
    this.releasePort(r.agentPort);
    this.runtimes.delete(projectId);
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
      startedAt: 0,
      lastUsedAt: Date.now(),
      restarts: 0,
      restartTimer: null,
      idleTimer: null,
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
    const { command, args } = this.spawnCommand(resolved.path);

    this.log.log(
      `[WorkerRuntimeManager] Spawning agent-runtime for ${slot.projectId} ` +
        `via ${command} ${args.join(' ')} (port=${slot.agentPort}, source=${resolved.source})`,
    );

    const proc = spawn(command, args, {
      cwd,
      env,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    slot.proc = proc;
    slot.status = 'starting';
    slot.startedAt = Date.now();

    proc.on('error', (err) => {
      slot.lastError = err?.message ?? String(err);
      this.log.error(`[WorkerRuntimeManager] spawn error for ${slot.projectId}: ${slot.lastError}`);
    });

    proc.on('exit', (code, signal) => {
      this.handleExit(slot, code, signal);
    });

    const prefix = `[runtime:${slot.projectId.slice(0, 8)}]`;
    proc.stdout?.on('data', (data) => {
      for (const line of data.toString().trimEnd().split('\n')) {
        if (line) this.log.log(`${prefix} ${line}`);
      }
    });
    proc.stderr?.on('data', (data) => {
      for (const line of data.toString().trimEnd().split('\n')) {
        if (line) this.log.error(`${prefix} ${line}`);
      }
    });

    try {
      await this.waitForHealth(slot.agentPort, slot.proc, HEALTH_BOOT_TIMEOUT_MS);
      slot.status = 'running';
      slot.lastUsedAt = Date.now();
      this.armIdleTimer(slot);
      return slot;
    } catch (err: any) {
      slot.status = 'error';
      slot.lastError = err?.message ?? String(err);
      try { proc.kill('SIGTERM'); } catch { /* nothing */ }
      this.releasePort(slot.agentPort);
      slot.agentPort = 0;
      slot.apiServerPort = 0;
      throw err;
    }
  }

  private buildEnv(slot: InternalRuntime, runtimeBinPath: string): NodeJS.ProcessEnv {
    const cfg = slot.spawnConfig;
    const env: NodeJS.ProcessEnv = {
      ...(this.opts.env ?? process.env),
      PROJECT_ID: slot.projectId,
      PORT: String(slot.agentPort),
      API_SERVER_PORT: String(slot.apiServerPort),
      SKILL_SERVER_PORT: String(slot.apiServerPort),
      NODE_ENV: 'production',
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
    if (this.opts.autoPull?.enabled) {
      env.SHOGO_CLOUD_SYNC = '1';
    }
    if (cfg.aiProxyUrl) env.AI_PROXY_URL = cfg.aiProxyUrl;
    if (cfg.aiProxyToken) env.AI_PROXY_TOKEN = cfg.aiProxyToken;
    if (cfg.techStackId) env.TECH_STACK_ID = cfg.techStackId;
    if (cfg.templateId) env.TEMPLATE_ID = cfg.templateId;
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
    return env;
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

    if (slot.status === 'stopping' || this.stopped) {
      slot.status = 'stopped';
      this.releasePort(slot.agentPort);
      slot.agentPort = 0;
      slot.apiServerPort = 0;
      return;
    }

    if (exitedClean) {
      slot.status = 'stopped';
      this.releasePort(slot.agentPort);
      slot.agentPort = 0;
      slot.apiServerPort = 0;
      this.runtimes.delete(slot.projectId);
      return;
    }

    slot.restarts += 1;
    slot.lastError = `exited code=${code} signal=${signal}`;
    const delay = this.restartBackoffMs(slot.restarts);
    slot.status = 'restarting';
    this.log.warn(
      `[WorkerRuntimeManager] restarting ${slot.projectId} in ${Math.round(delay / 1000)}s ` +
        `(restart #${slot.restarts})`,
    );
    if (slot.restartTimer) clearTimeout(slot.restartTimer);
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = null;
      slot.startPromise = this.doStart(slot).then((r) => {
        slot.startPromise = null;
        return r;
      }).catch((err) => {
        slot.startPromise = null;
        this.log.error(`[WorkerRuntimeManager] restart of ${slot.projectId} failed: ${err?.message ?? err}`);
        return slot;
      });
    }, delay);
  }

  private restartBackoffMs(restarts: number): number {
    const base = Math.min(RESTART_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, restarts - 1)), RESTART_BACKOFF_MAX_MS);
    const jitter = base * 0.2 * Math.random();
    return base + jitter;
  }

  private armIdleTimer(slot: InternalRuntime): void {
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    const idleMs = this.opts.idleMs ?? RUNTIME_IDLE_MS;
    slot.idleTimer = setTimeout(() => {
      const since = Date.now() - slot.lastUsedAt;
      if (since < idleMs) {
        // Got touched between scheduling and firing — re-arm.
        this.armIdleTimer(slot);
        return;
      }
      this.log.log(`[WorkerRuntimeManager] idle-evicting ${slot.projectId} after ${Math.round(since / 1000)}s`);
      void this.stop(slot.projectId).catch((err) => {
        this.log.warn(`[WorkerRuntimeManager] idle stop failed: ${err?.message ?? err}`);
      });
    }, idleMs);
  }

  private async allocatePort(): Promise<number> {
    const range = PORT_RANGE_END - PORT_RANGE_START;
    const maxAttempts = Math.min(range, 50);
    for (let i = 0; i < maxAttempts; i++) {
      const candidate = PORT_RANGE_START + Math.floor(Math.random() * range);
      if (this.usedPorts.has(candidate) || this.usedPorts.has(candidate + API_PORT_OFFSET)) continue;
      const agentInUse = await this.isPortListening(candidate);
      const apiInUse = await this.isPortListening(candidate + API_PORT_OFFSET);
      if (agentInUse || apiInUse) continue;
      this.usedPorts.add(candidate);
      this.usedPorts.add(candidate + API_PORT_OFFSET);
      return candidate;
    }
    throw new Error(
      `Cannot allocate port in range ${PORT_RANGE_START}-${PORT_RANGE_END} after ${maxAttempts} attempts`,
    );
  }

  private releasePort(port: number): void {
    if (!port) return;
    this.usedPorts.delete(port);
    this.usedPorts.delete(port + API_PORT_OFFSET);
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

  private async waitForHealth(
    port: number,
    proc: ChildProcess,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null || proc.signalCode != null || proc.killed) {
        throw new Error(
          `agent-runtime exited (code=${proc.exitCode}, signal=${proc.signalCode}) before becoming healthy on port ${port}`,
        );
      }
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 1500);
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/health`, {
          method: 'GET',
          signal: controller.signal,
        });
        clearTimeout(t);
        if (resp.ok) return;
      } catch {
        clearTimeout(t);
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }
    throw new Error(`Timeout waiting for agent-runtime /health on port ${port}`);
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
