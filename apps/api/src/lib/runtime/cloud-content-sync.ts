// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cloud ↔ desktop project-CONTENT sync (auto on open).
 *
 * This is the desktop's orchestration of the same content-sync stack the
 * CLI worker uses — `cloneProject` / `CloudFileTransport` for the initial
 * pull and `CloudSyncWatcher` to push local edits back. The worker drives
 * it from `maybeAutoPull` (which assumes a `<projectsDir>/<projectId>`
 * model and an unset `projectDir`); the desktop can't use that path
 * directly because its runtime always pre-seeds `projectDir` and builds
 * merged-root workspaces / installs deps around it. So we call the same
 * building blocks here, from inside the desktop runtime adapter's
 * `ensureProjectDirectory`, and keep the rest of the desktop pipeline
 * intact.
 *
 * Responsibilities:
 *   - Registry: which local projects are "cloud-linked" (1:1, keyed by the
 *     cloud project id). Persisted in `localConfig` so it survives restarts
 *     without a schema migration.
 *   - Pull: git clone (smart-HTTP) when git is available + the dir is empty,
 *     else the Files API `downloadAll`; tops up gitignored `.shogo/` SQLite
 *     state after a git clone (mirrors the worker).
 *   - Watch: one `CloudSyncWatcher` per project, pushing debounced edits.
 *   - Status: pulling / watching / pushing / error / offline, surfaced to UX.
 *   - Safety: offline soft-fail, and a one-writer warning when the same
 *     project is also pinned to a running cloud worker.
 *
 * Everything network/git/fs-touching is injectable so the orchestration is
 * unit-testable without a real cloud, git binary, or filesystem watcher.
 */

import { mkdirSync, readdirSync } from 'node:fs'
import { CloudFileTransport } from '@shogo-ai/sdk/cloud-file-transport'
import { CloudSyncWatcher } from '@shogo-ai/worker/cloud-sync-watcher'
import {
  cloneProject as defaultCloneProject,
  gitIsAvailable as defaultGitIsAvailable,
  isGitRepo as defaultIsGitRepo,
} from '@shogo-ai/worker/git-cloner'
import { prisma } from '../prisma'
import { lookupCloudInstance } from '../federated-upstream'

type Logger = Pick<Console, 'log' | 'warn' | 'error'>

export type CloudSyncMode = 'git' | 'files'
export type CloudSyncState =
  | 'idle'
  | 'pulling'
  | 'watching'
  | 'pushing'
  | 'error'
  | 'offline'

export interface CloudSyncStatus {
  projectId: string
  state: CloudSyncState
  mode?: CloudSyncMode
  lastError?: string
  /** Epoch ms of the last successful push-back, if any. */
  lastPushAt?: number
  /** Commit sha of the last git-mode push, if any. */
  lastPushCommit?: string
  /** Set when this project is ALSO pinned to a running cloud worker
   *  (one-writer rule — concurrent writers risk push conflicts). */
  conflictWarning?: string
  updatedAt: number
}

// ─── helpers ────────────────────────────────────────────────────────────────

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Heuristic: did this failure look like the box being offline rather than
 *  a hard auth/server error? Used purely to pick the status label. */
function looksOffline(err: unknown): boolean {
  const m = msg(err).toLowerCase()
  return (
    m.includes('fetch failed') ||
    m.includes('econnrefused') ||
    m.includes('enotfound') ||
    m.includes('etimedout') ||
    m.includes('network') ||
    m.includes('getaddrinfo') ||
    m.includes('timed out')
  )
}

// ─── cloud-linked registry (localConfig-backed, migration-free) ──────────────

const REGISTRY_KEY = 'CLOUD_LINKED_PROJECTS'
const LINK_CACHE_TTL_MS = 5_000

export interface RegistryStore {
  read(): Promise<string[]>
  write(ids: string[]): Promise<void>
}

const prismaStore: RegistryStore = {
  async read() {
    try {
      const row = await (prisma as any).localConfig
        .findUnique({ where: { key: REGISTRY_KEY } })
        .catch(() => null)
      if (!row?.value) return []
      const parsed = JSON.parse(row.value)
      return Array.isArray(parsed) ? parsed.filter((x: unknown): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  },
  async write(ids) {
    const value = JSON.stringify(Array.from(new Set(ids)))
    await (prisma as any).localConfig.upsert({
      where: { key: REGISTRY_KEY },
      update: { value },
      create: { key: REGISTRY_KEY, value },
    })
  },
}

let store: RegistryStore = prismaStore
let linkedCache: { ids: Set<string>; expiresAt: number } | null = null

async function readLinked(): Promise<Set<string>> {
  const now = Date.now()
  if (linkedCache && linkedCache.expiresAt > now) return linkedCache.ids
  const ids = new Set(await store.read())
  linkedCache = { ids, expiresAt: now + LINK_CACHE_TTL_MS }
  return ids
}

/** Is this local project linked to (and synced from) a cloud project? */
export async function isProjectCloudLinked(projectId: string): Promise<boolean> {
  if (!projectId) return false
  return (await readLinked()).has(projectId)
}

export async function getCloudLinkedProjectIds(): Promise<string[]> {
  return Array.from(await readLinked())
}

export async function markProjectCloudLinked(projectId: string): Promise<void> {
  if (!projectId) return
  const ids = await store.read()
  if (!ids.includes(projectId)) {
    ids.push(projectId)
    await store.write(ids)
  }
  linkedCache = null
}

export async function unmarkProjectCloudLinked(projectId: string): Promise<void> {
  const ids = (await store.read()).filter((id) => id !== projectId)
  await store.write(ids)
  linkedCache = null
}

// ─── sync-status registry (in-memory, surfaced to UX) ────────────────────────

const statusByProject = new Map<string, CloudSyncStatus>()

export function getCloudSyncStatus(projectId: string): CloudSyncStatus {
  return statusByProject.get(projectId) ?? { projectId, state: 'idle', updatedAt: 0 }
}

export function getAllCloudSyncStatuses(): CloudSyncStatus[] {
  return Array.from(statusByProject.values())
}

function setStatus(projectId: string, patch: Partial<CloudSyncStatus>): CloudSyncStatus {
  const prev = statusByProject.get(projectId) ?? { projectId, state: 'idle' as CloudSyncState, updatedAt: 0 }
  const next: CloudSyncStatus = { ...prev, ...patch, projectId, updatedAt: Date.now() }
  statusByProject.set(projectId, next)
  return next
}

// ─── active watchers + cloud-sync gate ───────────────────────────────────────

const activeWatchers = new Map<string, { stop(): Promise<void> }>()
const activeSyncProjects = new Set<string>()

/**
 * True when this project's content is being kept in sync with cloud (it was
 * pulled and/or is being watched). The desktop spawn path uses this to set
 * `SHOGO_CLOUD_SYNC=1` so the agent-runtime skips its own S3Sync/checkpoint
 * inserts — only for cloud-synced projects, never local-only ones.
 */
export function isCloudSyncActive(projectId: string): boolean {
  return activeSyncProjects.has(projectId)
}

// ─── pull (clone or files) ───────────────────────────────────────────────────

interface SyncStatsLike {
  downloaded: number
  errors: unknown[]
}

interface TransportLike {
  downloadAll(): Promise<SyncStatsLike>
  listManifest(): Promise<Array<{ path: string }>>
  downloadFiles(files: Array<{ path: string }>): Promise<SyncStatsLike>
}

export interface CloudContentSyncDeps {
  cloneProject: typeof defaultCloneProject
  gitIsAvailable: (force?: boolean) => Promise<boolean>
  isGitRepo: (dir: string) => boolean
  makeTransport: (opts: { apiUrl: string; apiKey: string; projectId: string; localDir: string }) => TransportLike
  makeWatcher: (opts: ConstructorParameters<typeof CloudSyncWatcher>[0]) => { start(): void; stop(): Promise<void> }
  mkdir: (dir: string) => void
  dirIsEmpty: (dir: string) => boolean
}

const defaultDeps: CloudContentSyncDeps = {
  cloneProject: defaultCloneProject,
  gitIsAvailable: defaultGitIsAvailable,
  isGitRepo: defaultIsGitRepo,
  makeTransport: (o) => new CloudFileTransport(o) as unknown as TransportLike,
  makeWatcher: (o) => new CloudSyncWatcher(o),
  mkdir: (d) => mkdirSync(d, { recursive: true }),
  dirIsEmpty: (d) => {
    try {
      return readdirSync(d).filter((n) => n !== '.' && n !== '..').length === 0
    } catch {
      return true
    }
  },
}

export interface PullCloudProjectOptions {
  projectId: string
  projectDir: string
  cloudUrl: string
  apiKey: string
  /** Prefer git smart-HTTP (default true); falls back to the Files API. */
  useGit?: boolean
  logger?: Logger
  deps?: Partial<CloudContentSyncDeps>
}

export interface PullCloudProjectResult {
  pulled: boolean
  mode: CloudSyncMode | null
  reason?: 'no-credentials' | 'offline' | 'error'
}

async function fileTransportClone(
  deps: CloudContentSyncDeps,
  o: { cloudUrl: string; apiKey: string; projectId: string; projectDir: string },
  log: Logger,
): Promise<void> {
  const transport = deps.makeTransport({ apiUrl: o.cloudUrl, apiKey: o.apiKey, projectId: o.projectId, localDir: o.projectDir })
  const stats = await transport.downloadAll()
  log.log(`[CloudContentSync] ${o.projectId} downloaded ${stats.downloaded} files (${stats.errors.length} errors)`)
}

async function topUpShogoState(
  deps: CloudContentSyncDeps,
  o: { cloudUrl: string; apiKey: string; projectId: string; projectDir: string },
  log: Logger,
): Promise<void> {
  try {
    const transport = deps.makeTransport({ apiUrl: o.cloudUrl, apiKey: o.apiKey, projectId: o.projectId, localDir: o.projectDir })
    const manifest = await transport.listManifest()
    const shogoEntries = manifest.filter((e) => e.path === '.shogo' || e.path.startsWith('.shogo/'))
    if (shogoEntries.length === 0) return
    const stats = await transport.downloadFiles(shogoEntries)
    log.log(`[CloudContentSync] ${o.projectId} .shogo/ top-up: ${stats.downloaded} files (${stats.errors.length} errors)`)
  } catch (err) {
    // Non-fatal: the runtime will create a fresh SQLite db if needed.
    log.warn(`[CloudContentSync] .shogo top-up failed for ${o.projectId}: ${msg(err)}`)
  }
}

/**
 * Pull a cloud project's workspace files into `projectDir`. Soft-fails: on
 * any error (offline, auth, etc.) it returns `{ pulled: false }` and records
 * the failure on the status registry — the caller falls back to seeding a
 * template so the project still opens locally.
 */
export async function pullCloudProject(opts: PullCloudProjectOptions): Promise<PullCloudProjectResult> {
  const { projectId, projectDir, cloudUrl, apiKey } = opts
  const log = opts.logger ?? console
  const deps: CloudContentSyncDeps = { ...defaultDeps, ...(opts.deps ?? {}) }

  if (!cloudUrl || !apiKey) {
    setStatus(projectId, { state: 'error', lastError: 'missing cloud credentials' })
    return { pulled: false, mode: null, reason: 'no-credentials' }
  }

  setStatus(projectId, { state: 'pulling', lastError: undefined })

  try {
    deps.mkdir(projectDir)
    const isEmpty = deps.dirIsEmpty(projectDir)
    const alreadyGitRepo = deps.isGitRepo(projectDir)
    const wantGit = opts.useGit !== false
    const gitAvailable = wantGit ? await deps.gitIsAvailable() : false
    let mode: CloudSyncMode = gitAvailable && (isEmpty || alreadyGitRepo) ? 'git' : 'files'

    if (mode === 'git') {
      if (isEmpty) {
        try {
          const res = await deps.cloneProject({
            apiUrl: cloudUrl,
            apiKey,
            projectId,
            localDir: projectDir,
            shallow: true,
            logger: log,
          })
          log.log(`[CloudContentSync] cloned ${projectId} at ${res.commitSha.slice(0, 8)}`)
        } catch (err) {
          // Git clone failed — try the file transport as a fallback. The
          // mode flip is sticky for this pull so we don't bounce.
          log.warn(`[CloudContentSync] git clone failed for ${projectId} (${msg(err)}); falling back to Files API`)
          mode = 'files'
          await fileTransportClone(deps, { cloudUrl, apiKey, projectId, projectDir }, log)
        }
      } else if (alreadyGitRepo) {
        log.log(`[CloudContentSync] ${projectId} already cloned; skipping clone`)
      }
      // `.shogo/` is gitignored — top it up via the file transport so the
      // agent-runtime sees consistent SQLite state on first spawn.
      if (mode === 'git') {
        await topUpShogoState(deps, { cloudUrl, apiKey, projectId, projectDir }, log)
      }
    } else if (isEmpty) {
      await fileTransportClone(deps, { cloudUrl, apiKey, projectId, projectDir }, log)
    } else {
      log.log(`[CloudContentSync] ${projectId} workspace already populated; skipping clone`)
    }

    setStatus(projectId, { state: 'watching', mode })
    return { pulled: true, mode }
  } catch (err) {
    const offline = looksOffline(err)
    setStatus(projectId, { state: offline ? 'offline' : 'error', lastError: msg(err) })
    log.warn(`[CloudContentSync] pull failed for ${projectId}: ${msg(err)}`)
    return { pulled: false, mode: null, reason: offline ? 'offline' : 'error' }
  }
}

// ─── watcher ─────────────────────────────────────────────────────────────────

export interface StartWatcherOptions {
  projectId: string
  projectDir: string
  cloudUrl: string
  apiKey: string
  mode: CloudSyncMode
  /** Watcher debounce window in ms (forwarded to CloudSyncWatcher). */
  debounceMs?: number
  logger?: Logger
  deps?: Partial<CloudContentSyncDeps>
}

/**
 * Start one `CloudSyncWatcher` for the project (idempotent — a second call
 * for the same project is a no-op). Edits flush back to cloud and update the
 * sync status via the watcher's `onFlush` callback.
 */
export function startCloudSyncWatcher(opts: StartWatcherOptions): void {
  const { projectId, projectDir, cloudUrl, apiKey, mode } = opts
  const log = opts.logger ?? console
  const deps: CloudContentSyncDeps = { ...defaultDeps, ...(opts.deps ?? {}) }

  if (activeWatchers.has(projectId)) {
    activeSyncProjects.add(projectId)
    return
  }

  try {
    const transport = deps.makeTransport({ apiUrl: cloudUrl, apiKey, projectId, localDir: projectDir })
    const watcher = deps.makeWatcher({
      rootDir: projectDir,
      transport: transport as unknown as CloudFileTransport,
      logger: log,
      mode,
      debounceMs: opts.debounceMs,
      git: mode === 'git' ? { apiUrl: cloudUrl, apiKey, projectId } : undefined,
      onFlush: (e) => {
        if (e.errors > 0) {
          setStatus(projectId, { state: 'error', lastError: `${e.errors} upload error(s)`, mode })
        } else {
          setStatus(projectId, { state: 'watching', mode, lastPushAt: Date.now(), lastPushCommit: e.commitSha })
        }
      },
    })
    watcher.start()
    activeWatchers.set(projectId, watcher)
    activeSyncProjects.add(projectId)
    setStatus(projectId, { state: 'watching', mode })
  } catch (err) {
    setStatus(projectId, { state: 'error', lastError: msg(err) })
    log.warn(`[CloudContentSync] watcher start failed for ${projectId}: ${msg(err)}`)
  }
}

export async function stopCloudSyncWatcher(projectId: string): Promise<void> {
  const w = activeWatchers.get(projectId)
  activeWatchers.delete(projectId)
  activeSyncProjects.delete(projectId)
  if (w) {
    try {
      await w.stop()
    } catch {
      /* best effort — final flush already attempted by the watcher */
    }
  }
}

export async function stopAllCloudSyncWatchers(): Promise<void> {
  const ids = Array.from(activeWatchers.keys())
  await Promise.all(ids.map((id) => stopCloudSyncWatcher(id)))
}

// ─── pull + watch orchestration (the entry point the runtime adapter uses) ───

export interface SyncCloudProjectOptions extends PullCloudProjectOptions {
  /** Watcher debounce window in ms (forwarded to CloudSyncWatcher). */
  debounceMs?: number
}

/**
 * Pull the project then, on success, start the push-back watcher. Returns the
 * pull result. On pull failure NO watcher is started — that avoids clobbering
 * the cloud copy with a local template fallback (the caller seeds a template
 * locally so the project still opens, but we never push that template up).
 */
export async function syncCloudProjectIntoDir(opts: SyncCloudProjectOptions): Promise<PullCloudProjectResult> {
  const res = await pullCloudProject(opts)
  if (res.pulled && res.mode) {
    startCloudSyncWatcher({
      projectId: opts.projectId,
      projectDir: opts.projectDir,
      cloudUrl: opts.cloudUrl,
      apiKey: opts.apiKey,
      mode: res.mode,
      debounceMs: opts.debounceMs,
      logger: opts.logger,
      deps: opts.deps,
    })
    // Best-effort one-writer guard (non-blocking).
    void checkSingleWriterWarning(opts.projectId, opts.logger)
  }
  return res
}

// ─── one-writer safety ───────────────────────────────────────────────────────

/**
 * The checkpoint model requires a single writer per project. If this project
 * is also pinned to a *running* cloud worker (`preferredInstanceId`), warn —
 * concurrent writers can produce conflicting pushes. Returns the warning
 * string (also stored on the status) or null. Best-effort; never throws.
 */
export async function checkSingleWriterWarning(projectId: string, logger?: Logger): Promise<string | null> {
  const log = logger ?? console
  try {
    const project = await (prisma as any).project
      .findUnique({ where: { id: projectId }, select: { preferredInstanceId: true } })
      .catch(() => null)
    const instanceId: string | undefined = project?.preferredInstanceId || undefined
    if (!instanceId) return null

    const inst = await lookupCloudInstance(instanceId)
    const status = String(inst?.status ?? '').toLowerCase()
    const online = inst != null && (status === 'online' || status === 'connected' || status === 'ready' || status === 'active')
    if (!online) return null

    const warning =
      `Project is also pinned to cloud worker "${inst?.name ?? instanceId}". ` +
      `Editing it in both places at once can cause push conflicts (one writer per project).`
    log.warn(`[CloudContentSync] one-writer: ${projectId} — ${warning}`)
    setStatus(projectId, { conflictWarning: warning })
    return warning
  } catch {
    return null
  }
}

// ─── test seams ──────────────────────────────────────────────────────────────

/** Replace the localConfig-backed registry store (tests). Pass null to reset. */
export function _setRegistryStoreForTests(s: RegistryStore | null): void {
  store = s ?? prismaStore
  linkedCache = null
}

/** Reset all in-memory state (tests). */
export function _resetCloudContentSyncForTests(): void {
  statusByProject.clear()
  activeWatchers.clear()
  activeSyncProjects.clear()
  linkedCache = null
  store = prismaStore
}
