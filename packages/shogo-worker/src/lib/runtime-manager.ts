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
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRuntime, type ResolvedRuntime } from './runtime-resolver.ts';
import type { RuntimeResolver } from './tunnel.ts';

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
}

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

export class WorkerRuntimeManager implements RuntimeResolver {
  private readonly opts: WorkerRuntimeManagerOptions;
  private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly runtimes = new Map<string, InternalRuntime>();
  private readonly usedPorts = new Set<number>();
  private readonly spawnCommand: SpawnCommandFactory;
  private resolved: ResolvedRuntime | null = null;
  private stopped = false;

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
   */
  async ensureRunning(projectId: string, config: ProjectSpawnConfig): Promise<RuntimeStatusInfo> {
    if (this.stopped) throw new Error('WorkerRuntimeManager is stopped');

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

    const env = this.buildEnv(slot);
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

  private buildEnv(slot: InternalRuntime): NodeJS.ProcessEnv {
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
    if (cfg.aiProxyUrl) env.AI_PROXY_URL = cfg.aiProxyUrl;
    if (cfg.aiProxyToken) env.AI_PROXY_TOKEN = cfg.aiProxyToken;
    if (cfg.techStackId) env.TECH_STACK_ID = cfg.techStackId;
    if (cfg.templateId) env.TEMPLATE_ID = cfg.templateId;
    if (cfg.name) env.AGENT_NAME = cfg.name;
    if (cfg.workspaceId) env.WORKSPACE_ID = cfg.workspaceId;

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
