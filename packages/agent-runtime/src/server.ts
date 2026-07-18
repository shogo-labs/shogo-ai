// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent Runtime Server
 *
 * Runs inside each agent's Knative pod, providing:
 * - Claude Code agent with agent-building MCP tools
 * - Agent Gateway process (heartbeat, channels, skills)
 * - Health check endpoint for Kubernetes probes
 * - S3 file synchronization for persistent storage
 *
 * This mirrors runtime but replaces the Vite dev server
 * with an Agent Gateway that makes the configured agent "alive."
 */

import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'
import { resolve, dirname, join, extname, basename } from 'path'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
  statSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  rmSync,
  renameSync,
  cpSync,
  appendFileSync,
} from 'fs'
import { hydrateWorkspaceMembers, type MemberSync } from './workspace-hydration'
import {
  createRuntimeApp, traceOperation,
  initializeS3Sync,
  createS3SyncForProject,
  createPublishedDataSyncFromEnv,
  type PublishedDataSync,
  initializePostgresBackup,
  configureAIProxy,
  StreamBufferStore,
  encodeTurnCompleteFrame,
  isMacOSJunkName,
  isBinaryFilePath,
  GitWorkspaceSync,
  createGitSyncFromEnv,
  resolveCloudSyncMode,
  ensureWorkspaceRepo,
  syncLargeFiles,
  restoreLargeFiles,
  largeFileSyncConfigFromEnv,
  restoreRepoFromStore,
  persistRepoToStore,
  seedRepoIfAbsent,
  createTagLocal,
  deleteTagLocal,
  getHeadSha,
  repoStoreConfigFromEnv,
  gatherCommitMeta,
  ensureLfsRepoSetup,
  autoTrackLargeFiles,
  lfsPushAll,
  lfsPull,
  lfsRemoteConfigFromEnv,
  migrateOffloadedAssetsToLfs,
  extractTarFastNonBlocking,
  type CloudSyncMode,
} from '@shogo/shared-runtime'
import { getModelTier, resolveModelId, calculateDollarCost } from '@shogo/model-catalog'
import {
  seedWorkspaceDefaults,
  seedLSPConfig,
  seedRuntimeTemplate,
  ensureWorkspaceDeps,
  seedTechStack,
  runTechStackSetup,
  wipeProjectFiles,
  getTechStackPath,
  workspaceUsesVite,
} from './workspace-defaults'
import { runtimeDiagnosticsRoutes } from './runtime-diagnostics-routes'
import { runtimeLspRoutes } from './runtime-lsp-routes'
import { computePublishedReadiness } from './published-readiness'
import {
  walkFilesTree,
  WORKSPACE_TREE_HIDDEN_DIRS,
  WORKSPACE_TREE_LAZY_DIRS,
  WORKSPACE_TREE_HIDDEN_FILES,
} from './fs-tree-walker'
import { SkillServerManager } from './skill-server-manager'
import { runtimeTerminalRoutes } from './runtime-terminal-routes'
import { createPtyWsHandlers, type WsData } from './pty-ws-handler'
import { deriveApiUrl, getInternalHeaders, postCheckpointRecord, postWorktreeStatus } from './internal-api'
import { WORKTREE_BRANCH_PREFIX } from '@shogo/shared-runtime'
import { initTrustResolver, refreshTrust } from './trust-resolver'
import {
  isWorkspaceRuntimeMode,
  workspaceAttachedProjectIds,
  workspaceProjectsManifest,
  renderWorkspaceManifestMarkdown,
  shouldSkipManagedSeeding,
  shouldEnforceProjectIdSanity,
  shouldRunGitWorkspaceSync,
  parseWorkspacePreviewPath,
  buildWorkspacePreviewPath,
  parseWorkspacePreviewUrls,
  isAttachedProjectId,
} from './workspace-runtime-mode'
import { userMessage } from './pi-adapter'
import { fileURLToPath } from 'url'
import { WebChatAdapter } from './channels/webchat'
import { WebhookAdapter } from './channels/webhook'
import { pushCanvasRuntimeError, getCanvasRuntimeErrors, clearCanvasRuntimeErrors } from './canvas-runtime-errors'
import { recordCanvasRuntimeErrorEscaped } from './canvas-slo'
import {
  recordCanvasErrorEntry,
  recordConsoleEntry,
} from './runtime-log-dispatcher'
import { runtimeLogsRoutes } from './runtime-logs-routes'
import { subscribe as subscribeScreencast, getLastFrame as getLastScreencastFrame } from './screencast-broadcaster'
import { WhatsAppAdapter } from './channels/whatsapp'
import { TeamsAdapter } from './channels/teams'
import { saveUploadedFileParts, buildUploadedFilesNote } from './upload-attachments'
import { buildIdeContext, buildReferencedContext } from './reference-context'
import { maybeRunInteractive } from './interactive/entry'
import { evaluateServerBacked } from './published-detect'

// Interactive CLI mode. When this binary is invoked as `agent-runtime
// interactive` (or with SHOGO_INTERACTIVE=1) it runs the in-process REPL and
// exits before any HTTP listener / gateway boot below. For the normal server
// path this is a no-op that returns immediately. It MUST remain the first
// top-level statement so the heavy module body (trust resolver, route
// registration, `Bun.serve` via the default export) never executes — and the
// REPL never loads React/Ink — in the interactive path.
await maybeRunInteractive()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const MONOREPO_ROOT = resolve(__dirname, '../../..')

// =============================================================================
// Configuration
// =============================================================================

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || process.env.AGENT_DIR || process.env.PROJECT_DIR || '/app/workspace'
const SCHEMAS_PATH = process.env.SCHEMAS_PATH || '/app/.schemas'
const PORT = parseInt(process.env.PORT || '8080', 10)

/**
 * External (VS Code-style) project mode. When set to `'external'`, the
 * agent-runtime treats `WORKSPACE_DIR` as the user's primary linked
 * folder, skips template seeding / auto-install, and obeys the trust
 * level resolved live from the API by `trust-resolver.ts`.
 *
 * `LINKED_FOLDERS` is a JSON-encoded `string[]` of every host folder
 * the user has explicitly opened on this project — the union of these
 * paths plus `WORKSPACE_DIR` forms the agent's "allowed roots" set
 * (see `assertAllowedPath()` in gateway-tools.ts).
 */
const WORKING_MODE: 'managed' | 'external' =
  process.env.WORKING_MODE === 'external' ? 'external' : 'managed'

/**
 * Workspace-runtime mode: this runtime serves a merged tree of several
 * attached projects (WORKSPACE_DIR = the workspaces parent, each project
 * a top-level subfolder). Toggles off single-project assumptions in the
 * boot path — see workspace-runtime-mode.ts.
 */
const IS_WORKSPACE_RUNTIME = isWorkspaceRuntimeMode()
const WORKSPACE_RUNTIME_PROJECT_IDS = workspaceAttachedProjectIds()

/**
 * Server-backed published mode. When `SHOGO_PUBLISHED_MODE=true` this pod is
 * NOT a dev/agent runtime — it serves a *published* app at
 * `{PUBLISHED_SUBDOMAIN}.shogo.one`. We hydrate the source read-only from the
 * durable git repo (pinned to the published commit), run the project's
 * `server.tsx` so `/api/*` works in production, and persist only the writable
 * runtime state (the SQLite DB + upload dirs) to the published-data bucket via
 * `PublishedDataSync`. The agent gateway / loop and all editing surfaces stay
 * OFF — published pods never run the agent. See `initializePublished()`.
 */
const IS_PUBLISHED_MODE = process.env.SHOGO_PUBLISHED_MODE === 'true'
const PUBLISHED_SUBDOMAIN = process.env.PUBLISHED_SUBDOMAIN || ''

/**
 * The list of host folders the agent is allowed to read/write inside,
 * in addition to `WORKSPACE_DIR`. Parsed once at boot — folder set is
 * immutable for a runtime instance (changing it requires a restart).
 */
const parseFolderListEnv = (name: string): string[] => {
  const raw = process.env[name]
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((p): p is string => typeof p === 'string' && p.length > 0)
  } catch (err) {
    console.warn(`[agent-runtime] Could not parse ${name} env: ${err}`)
    return []
  }
}
const LINKED_FOLDERS: string[] = parseFolderListEnv('LINKED_FOLDERS')

/**
 * Subset of the allowed roots mounted READ-ONLY (attachments added with
 * `attachMode='readonly'`). Reads pass; writes/exec are denied under these
 * roots even when the runtime is trusted. Parsed once at boot — the set is
 * immutable for a runtime instance (changing it requires a restart).
 */
const READONLY_ROOTS: string[] = parseFolderListEnv('READONLY_ROOTS')

// Seed the live trust resolver with the immutable directory layout
// (workspaceDir, workingMode, linkedFolders). The initial trustLevel
// defaults to fail-closed for external projects; it will be reconciled
// with the DB by `refreshTrust()` below (fire-and-forget at boot,
// awaited at the start of every chat turn, refetched on demand via
// POST /internal/refresh-trust). See trust-resolver.ts for the
// architectural rationale — this replaces the old `TRUST_LEVEL` env
// snapshot that couldn't be updated for a running process and was the
// root cause of the "Trust folder still restricted" bug.
initTrustResolver({
  projectId: process.env.PROJECT_ID ?? null,
  workspaceDir: WORKSPACE_DIR,
  workingMode: WORKING_MODE,
  linkedFolders: LINKED_FOLDERS,
  readonlyRoots: READONLY_ROOTS,
  isWorkspaceRuntime: IS_WORKSPACE_RUNTIME,
})
refreshTrust().catch(() => {
  // Best-effort at boot; per-turn refresh in gateway.ts is the
  // authoritative gate, so a boot-time miss self-heals on the first
  // user message.
})

// Legacy global, kept for any out-of-tree consumer that may still read
// it. The directory triplet is authoritative here; trustLevel is NOT
// — that comes from the resolver. Removing the field entirely would
// be a soft-breaking change; instead we publish the immutable bits and
// stop advertising a stale trustLevel.
;(globalThis as any).__SHOGO_AGENT_RUNTIME_CONFIG__ = {
  workingMode: WORKING_MODE,
  linkedFolders: LINKED_FOLDERS,
  workspaceDir: WORKSPACE_DIR,
}

/**
 * Defensive sanity check on WORKSPACE_DIR.
 *
 * Backstory: the host-side RuntimeManager once defaulted its
 * `workspacesDir` to `process.cwd()` when `WORKSPACES_DIR` was unset,
 * which silently materialised project workspaces at
 * `<repo-root>/<projectId>` instead of `<repo-root>/workspaces/<projectId>`.
 * The agent-runtime then booted with `WORKSPACE_DIR` pointing at the
 * wrong directory and served an empty `.shogo` (no `quick-actions.json`,
 * no skills, no plans), with zero indication anything was wrong.
 *
 * Failing loud at startup is much cheaper than the user noticing
 * missing chips three days later.
 */
function checkWorkspaceDirSanity(): void {
  // External (VS Code-style) projects: WORKSPACE_DIR is the user's
  // primary linked folder by design (e.g. `/Users/jane/my-app`), not a
  // path ending in `<projectId>`. The historical sanity check would
  // emit a warning on every boot which would be noise the user can't
  // act on. Log an info line so we still have a breadcrumb in support
  // tickets without the alarming WARNING prefix.
  if (WORKING_MODE === 'external') {
    console.log(
      `[agent-runtime] External (folder-linked) project: WORKSPACE_DIR='${WORKSPACE_DIR}' ` +
        `(trust resolved from API; linkedFolders=${LINKED_FOLDERS.length})`,
    )
    return
  }

  // Workspace runtime: WORKSPACE_DIR is the workspaces parent and each
  // attached project is a top-level subfolder, so the single-PROJECT_ID
  // basename check does not apply. Log a breadcrumb instead.
  if (!shouldEnforceProjectIdSanity({ workingMode: WORKING_MODE, isWorkspaceRuntime: IS_WORKSPACE_RUNTIME })) {
    console.log(
      `[agent-runtime] Workspace runtime: WORKSPACE_DIR='${WORKSPACE_DIR}' ` +
        `WORKSPACE_ID='${process.env.WORKSPACE_ID ?? ''}' ` +
        `attachedProjects=${WORKSPACE_RUNTIME_PROJECT_IDS.length}`,
    )
    return
  }

  const expectedProjectId = process.env.PROJECT_ID
  const workspaceBase = basename(WORKSPACE_DIR.replace(/\/+$/, ''))
  const isContainerDefault = WORKSPACE_DIR === '/app/workspace'

  if (isContainerDefault && !process.env.WORKSPACE_DIR && !process.env.AGENT_DIR && !process.env.PROJECT_DIR) {
    console.warn(
      `[agent-runtime] WARNING: WORKSPACE_DIR fell back to '/app/workspace'. ` +
      `None of WORKSPACE_DIR / AGENT_DIR / PROJECT_DIR are set. ` +
      `Outside a container this almost certainly means the project workspace will not be found.`,
    )
  }

  if (expectedProjectId && workspaceBase !== expectedProjectId) {
    console.warn(
      `[agent-runtime] WARNING: WORKSPACE_DIR='${WORKSPACE_DIR}' does not end with PROJECT_ID='${expectedProjectId}'. ` +
      `This usually means the host RuntimeManager resolved 'workspacesDir' to the wrong directory ` +
      `(historically a process.cwd() fallback bug). The runtime will serve .shogo/, skills, plans, and ` +
      `quick-actions from '${WORKSPACE_DIR}' — verify this is actually the project workspace.`,
    )
  }
}
checkWorkspaceDirSanity()

async function reportHeartbeatComplete(projectId: string): Promise<void> {
  const apiUrl = deriveApiUrl()
  if (!apiUrl) return

  const url = `${apiUrl}/api/internal/heartbeat/complete`
  const res = await fetch(url, {
    method: 'POST',
    headers: getInternalHeaders(),
    body: JSON.stringify({ projectId }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw new Error(`Heartbeat complete report failed: HTTP ${res.status}`)
  }
}

// =============================================================================
// Shared Server Framework (handles OTEL, CORS, auth, health, pool/assign)
// =============================================================================

let agentGateway: any = null
let s3SyncInstance: import('@shogo/shared-runtime').S3Sync | null = null
let gitSyncInstance: GitWorkspaceSync | null = null
/** Writable-state sync for server-backed published apps (SHOGO_PUBLISHED_MODE). */
let publishedDataSyncInstance: PublishedDataSync | null = null
/**
 * Per-member S3 sync instances in WORKSPACE mode (cloud). Each member project
 * lives under `<WORKSPACE_DIR>/<id>/` with its own S3 prefix, so a single
 * workspace-rooted sync can't cover them — we keep one uploader/watcher per
 * member and flush them all on shutdown. Empty for single-project runtimes.
 */
let workspaceMemberSyncs: Map<string, import('@shogo/shared-runtime').S3Sync> = new Map()

/**
 * Whether real Git LFS is active for this pod. Scoped to `git_only` (the
 * pod-owned default): the LFS object-offload step is wired into that mode's
 * `afterCommit` durability path, and LFS attributes are only written for
 * these repos, so other modes (dual_shadow/s3) keep the legacy offload and
 * never accidentally LFS-ify files. LFS is always on for git_only — there is
 * no separate enable flag.
 */
function isLfsActive(): boolean {
  return resolveCloudSyncMode() === 'git_only'
}

/**
 * Persist `.git` to object storage, first offloading LFS object bytes to OCI
 * when LFS is active. The local `.git/lfs/objects` cache is excluded from the
 * tarball ONLY when the push succeeded — otherwise the bytes would be durable
 * nowhere, so we keep them in the tarball as a fallback. Shared by the
 * afterCommit, publish-tag, and shutdown durability paths.
 */
async function persistDurableRepo(): Promise<{ ok: boolean; changed: boolean; reason?: string }> {
  const repoCfg = repoStoreConfigFromEnv()
  if (!repoCfg) return { ok: true, changed: false, reason: 'no-store-config' }
  let excludeLfsObjects = false
  if (isLfsActive()) {
    const lfsCfg = lfsRemoteConfigFromEnv(WORKSPACE_DIR)
    if (lfsCfg) excludeLfsObjects = await lfsPushAll(lfsCfg)
  }
  return persistRepoToStore(WORKSPACE_DIR, repoCfg, { excludeLfsObjects })
}

/**
 * Offload large/binary assets to S3 and refresh `.git/info/exclude` so the
 * subsequent git push stays source-only. Fire-and-forget — paired with the
 * git push at the turn-complete boundary in `git_only` / `dual_shadow`.
 * No-op unless object storage is configured and a git sync is active.
 *
 * In Git LFS mode this legacy size-based offload is replaced by the LFS
 * clean filter (pointers) + `git lfs push` (bytes), so it no-ops.
 */
function triggerLargeFileSync(): void {
  if (!gitSyncInstance) return
  if (isLfsActive()) return
  const cfg = largeFileSyncConfigFromEnv(WORKSPACE_DIR)
  if (!cfg) return
  void syncLargeFiles(cfg).catch((err: any) =>
    console.warn('[agent-runtime] large-file sync threw:', err?.message ?? err),
  )
}

/**
 * Pod-owned `git_only` durability: after a local commit, persist `.git` to
 * object storage (the durable home of the repo) and record the
 * `ProjectCheckpoint` row via the API. Wired as GitWorkspaceSync's
 * `afterCommit`. A persist failure THROWS so the sync's retry/degrade path
 * re-arms S3 Layer 2; a checkpoint-record failure is best-effort (the commit
 * is already durable and the row can be reconciled on the next API hydrate).
 */
/**
 * BETA: per-chat git worktrees. Record a `ProjectCheckpoint` for a worktree
 * merge into the default branch. The `.git` is already persisted by the merge
 * path; this just writes the history row. Best-effort.
 */
async function recordWorktreeMergeCheckpoint(_chatSessionId: string, sha?: string): Promise<void> {
  const projectId = process.env.PROJECT_ID
  if (!projectId || !sha) return
  try {
    const meta = await gatherCommitMeta(WORKSPACE_DIR, sha)
    if (meta) {
      await postCheckpointRecord(projectId, {
        commitSha: meta.sha,
        commitMessage: meta.message,
        branch: meta.branch,
        filesChanged: meta.filesChanged,
        additions: meta.additions,
        deletions: meta.deletions,
        isAutomatic: false,
      })
    }
  } catch (err: any) {
    console.warn('[agent-runtime] recordWorktreeMergeCheckpoint threw:', err?.message ?? err)
  }
}

/**
 * BETA: per-chat git worktrees. Run at the turn-complete boundary for a chat
 * that owns a worktree:
 *  - If a merge is in progress (a conflict-resolution turn) and the agent has
 *    resolved all conflicts, finish the merge into the default branch, record a
 *    checkpoint, tear down the worktree, and mark the chat merged.
 *  - Otherwise commit the agent's edits onto the chat branch and persist `.git`.
 */
async function finalizeWorktreeTurn(chatSessionId: string): Promise<void> {
  if (!agentGateway) return
  if (await agentGateway.isWorktreeMergePending(chatSessionId)) {
    const res = await agentGateway.completeWorktreeMerge(chatSessionId)
    if (res.outcome === 'clean') {
      await recordWorktreeMergeCheckpoint(chatSessionId, res.mergedSha)
      await agentGateway.removeSessionWorktree(chatSessionId, { deleteBranch: true })
      await postWorktreeStatus(chatSessionId, { worktreeStatus: 'merged' })
    }
    // else: conflicts remain (the agent likely asked the user) — leave the
    // merge in progress; the next turn will try again.
    return
  }
  await agentGateway.commitAndPersistSessionWorktree(chatSessionId)
  await postWorktreeStatus(chatSessionId, {
    worktreeBranch: `${WORKTREE_BRANCH_PREFIX}${chatSessionId}`,
    worktreeStatus: 'active',
  })
}

async function persistAndRecordCheckpoint(sha: string): Promise<void> {
  if (repoStoreConfigFromEnv()) {
    // Offload LFS object bytes to OCI (when active) then persist `.git`.
    const res = await persistDurableRepo()
    if (!res.ok) throw new Error(`durable repo persist failed: ${res.reason}`)
  }
  // Record the checkpoint row (best-effort; the commit is already durable in
  // the persisted `.git`). Compute metadata locally then POST via the authed
  // internal channel (SA token in cluster, x-runtime-token locally).
  const projectId = process.env.PROJECT_ID
  if (projectId) {
    const meta = await gatherCommitMeta(WORKSPACE_DIR, sha)
    if (meta) {
      await postCheckpointRecord(projectId, {
        commitSha: meta.sha,
        commitMessage: meta.message,
        branch: meta.branch,
        filesChanged: meta.filesChanged,
        additions: meta.additions,
        deletions: meta.deletions,
        isAutomatic: true,
      })
    }
  }
}

const workspaceStatus: {
  templateSeeded: boolean
  depsInstalled: boolean
  serverMigrated?: {
    snapshotPath: string | null
    notesPath: string | null
    at: string | null
    mergedModels: string[]
    renamedModels: Array<{ from: string; to: string; reason: string }>
    customRoutesNeedReview: boolean
  }
  customRoutesExtracted?: {
    snapshotPath: string | null
    notesPath: string | null
    at: string | null
    hadMarker: boolean
    needsReview: boolean
  }
} = {
  templateSeeded: false,
  depsInstalled: false,
}

const { app, state, logTiming } = await createRuntimeApp({
  name: 'agent-runtime',
  workDir: WORKSPACE_DIR,
  runtimeType: 'unified',
  internalPaths: ['/agent/heartbeat/trigger'],
  authPrefixes: ['/agent', '/pool', '/diagnostics', '/terminal'],
  async onAssign(projectId, envVars) {
    const hostWorkspacesRoot = '/host-workspaces'
    const sentinelPath = '/tmp/shogo-current-project'

    // --- Re-assignment cleanup: remove orphaned state from previous project ---
    try {
      if (existsSync(sentinelPath)) {
        const oldProjectId = readFileSync(sentinelPath, 'utf-8').trim()
        if (oldProjectId && oldProjectId !== projectId) {
          const oldLocalState = `/tmp/shogo-local/${oldProjectId}`
          if (existsSync(oldLocalState)) {
            rmSync(oldLocalState, { recursive: true, force: true })
          }
          // If /workspace is a stale symlink, remove it so we can recreate below
          try {
            const st = lstatSync(WORKSPACE_DIR)
            if (st.isSymbolicLink()) unlinkSync(WORKSPACE_DIR)
          } catch {}
        }
      }
    } catch { /* best-effort cleanup */ }

    // Persist current project so the next re-assignment can clean up
    writeFileSync(sentinelPath, projectId, 'utf-8')

    // --- Decide mount mode: per-project env > boot-time flag ---
    // MOUNT_WORKSPACE comes from buildProjectEnv (per-project setting).
    // VM_WORKSPACE_MOUNTED is the boot-time indicator that 9p is available.
    const perProjectMount = process.env.MOUNT_WORKSPACE
    const ninePAvailable = process.env.VM_WORKSPACE_MOUNTED === 'true'
    let useMount = ninePAvailable && perProjectMount !== 'false'

    // Graceful fallback: if mount requested but 9p device is absent, warn and use overlay
    if (useMount && !existsSync(hostWorkspacesRoot)) {
      console.warn(`[onAssign] MOUNT_WORKSPACE requested but ${hostWorkspacesRoot} not found — falling back to overlay mode`)
      useMount = false
    }

    if (useMount) {
      // --- Mounted mode: symlink /workspace -> /host-workspaces/<projectId> ---
      const projectWorkspace = join(hostWorkspacesRoot, projectId)
      mkdirSync(projectWorkspace, { recursive: true })

      // Idempotent replace. The earlier code swallowed every error
      // here, which made the cleanup look harmless even when it
      // wasn't — see the .shogo block below for why that matters.
      let workspaceStat: ReturnType<typeof lstatSync> | null = null
      try { workspaceStat = lstatSync(WORKSPACE_DIR) } catch { /* doesn't exist */ }

      let workspaceAlreadyCorrect = false
      if (workspaceStat?.isSymbolicLink()) {
        try {
          if (readlinkSync(WORKSPACE_DIR) === projectWorkspace) workspaceAlreadyCorrect = true
        } catch { /* dangling */ }
      }

      if (!workspaceAlreadyCorrect && workspaceStat) {
        try {
          if (workspaceStat.isSymbolicLink() || workspaceStat.isFile()) {
            unlinkSync(WORKSPACE_DIR)
          } else if (workspaceStat.isDirectory()) {
            rmSync(WORKSPACE_DIR, { recursive: true, force: true })
          }
        } catch (err: any) {
          throw new Error(
            `[onAssign] Could not clear ${WORKSPACE_DIR} (${err?.message ?? err}) — ` +
              `cannot install /workspace -> ${projectWorkspace} symlink.`,
          )
        }
      }

      if (!workspaceAlreadyCorrect) {
        symlinkSync(projectWorkspace, WORKSPACE_DIR)
      }

      // Keep .shogo/ on the local overlay disk (SQLite doesn't work on
      // 9p — fcntl locking and file truncation semantics break the
      // SQLite journal). Replace `/workspace/.shogo` (which dereferences
      // through the 9p mount to the host's `.shogo`) with a symlink to
      // a per-project dir on the VM's local overlay disk.
      //
      // History: an earlier version did `rmSync(workspaceShogoDir,
      // {recursive, force})` inside `try {} catch {}` and then
      // `symlinkSync(...)`. The recursive remove failed silently on 9p
      // mounts — `.virtfs_metadata/` entries created by the
      // `security_model=mapped-file` 9p server, plus pre-existing
      // `.shogo/install-marker` and `.shogo/agent-state.json` files
      // from prior HOST-mode runs, would partially survive the rm.
      // The symlink then threw EEXIST and the whole assign 500'd, which
      // VMWarmPoolController counts as a boot failure. Three of those
      // and the pool permanently disables itself for the session,
      // which is exactly the symptom users saw (`VM warm pool
      // permanently disabled (3 boot failures)` in main.log). Fix:
      //   1. Idempotent fast path — if the symlink already points at
      //      localShogoDir, no-op.
      //   2. Single-syscall move-aside (renameSync) instead of a
      //      recursive rm. rename doesn't iterate children, so it
      //      sidesteps the 9p per-entry deletion failures entirely.
      //   3. Fall back to recursive rm if rename refuses.
      //   4. Throw with a useful message instead of catching silently
      //      so the caller (and the warm-pool failure counter) sees
      //      the actual cause.
      const localShogoDir = `/tmp/shogo-local/${projectId}/.shogo`
      mkdirSync(localShogoDir, { recursive: true })
      const workspaceShogoDir = join(WORKSPACE_DIR, '.shogo')

      let existingStat: ReturnType<typeof lstatSync> | null = null
      try { existingStat = lstatSync(workspaceShogoDir) } catch { /* doesn't exist — easy path */ }

      let alreadyCorrect = false
      if (existingStat?.isSymbolicLink()) {
        try {
          if (readlinkSync(workspaceShogoDir) === localShogoDir) alreadyCorrect = true
        } catch {
          // Dangling/bad symlink — fall through to the replace path
          // and let the move-aside clear it.
        }
      }

      if (!alreadyCorrect && existingStat) {
        const asidePath = join(WORKSPACE_DIR, `.shogo.host-bak-${Date.now()}`)
        let cleared = false
        let renameErrMsg = ''
        try {
          renameSync(workspaceShogoDir, asidePath)
          cleared = true
        } catch (err: any) {
          renameErrMsg = err?.message ?? String(err)
        }
        if (!cleared) {
          try {
            rmSync(workspaceShogoDir, { recursive: true, force: true })
            cleared = true
          } catch (err: any) {
            throw new Error(
              `[onAssign] Could not clear ${workspaceShogoDir} to install ` +
                `local-disk symlink (rename: ${renameErrMsg}; rm: ${err?.message ?? err}). ` +
                `VM assignment cannot proceed without this. The 9p mount may have a ` +
                `held lock or restricted permissions on .shogo/ contents — try closing ` +
                `the project on host first.`,
            )
          }
        }
      }

      if (!alreadyCorrect) {
        symlinkSync(localShogoDir, workspaceShogoDir)
      }

      // Suppress .virtfs_metadata in git (created by 9p security_model=mapped-file)
      try {
        const gitignorePath = join(WORKSPACE_DIR, '.gitignore')
        if (existsSync(gitignorePath)) {
          const content = readFileSync(gitignorePath, 'utf-8')
          if (!content.includes('.virtfs_metadata')) {
            writeFileSync(gitignorePath, content.trimEnd() + '\n.virtfs_metadata\n', 'utf-8')
          }
        }
      } catch { /* best-effort */ }
    } else {
      // --- Isolated mode: /workspace stays on overlay disk ---
      // Ensure /workspace is a real directory (not a stale symlink)
      try {
        const st = lstatSync(WORKSPACE_DIR)
        if (st.isSymbolicLink()) {
          unlinkSync(WORKSPACE_DIR)
          mkdirSync(WORKSPACE_DIR, { recursive: true })
        }
      } catch {
        mkdirSync(WORKSPACE_DIR, { recursive: true })
      }

      // Clean workspace to prevent cross-project file leakage
      for (const subdir of ['files', 'memory', 'skills']) {
        const dirPath = join(WORKSPACE_DIR, subdir)
        if (existsSync(dirPath)) {
          rmSync(dirPath, { recursive: true, force: true })
          mkdirSync(dirPath, { recursive: true })
        }
      }
    }

    // Run essential initialization (workspace files, S3 sync, config)
    await initializeEssentials()

    // Start gateway in background — don't block the assign response
    startGateway().catch((error) => {
      console.error(`[agent-runtime] Background gateway start failed for ${projectId}:`, error.message)
    })
  },
  getActivityStats() {
    const sm = agentGateway?.getSessionManager()
    const stats = sm?.getAllStats() ?? []
    const now = Date.now()
    const lastSessionActivity = stats.reduce(
      (max: number, s: any) => Math.max(max, now - (s.idleSeconds ?? 0) * 1000),
      state.poolAssignedAt ?? state.serverStartTime
    )
    return { activeSessions: stats.length, lastActivityAt: lastSessionActivity, activeStreams }
  },
  getHealthExtra: () => ({
    gateway: agentGateway?.getStatus() ?? null,
    workspace: workspaceStatus,
  }),
  // Called by /pool/refresh-env after a resume re-applies env and something
  // changed. The framework already reconfigured the AI proxy + token loop
  // in-process (fixes the gateway), but the project's API sidecar (server.tsx)
  // captured its env at spawn time — bounce it so it re-reads the fresh values
  // (e.g. a corrected SHOGO_API_URL / AI proxy URL). Only bounce a sidecar
  // that's actually up; a project with no running API server has nothing stale.
  async onRefreshEnv(projectId, changedKeys) {
    try {
      const pm = getPreviewManager()
      const st = pm.getStatus()
      if (st.apiServerPhase === 'healthy' || st.running) {
        console.log(
          `[agent-runtime] pool env refresh for ${projectId} changed [${changedKeys.join(', ')}] — restarting API sidecar`,
        )
        await pm.restartApiServerOnly()
      }
    } catch (err: any) {
      console.error(`[agent-runtime] onRefreshEnv sidecar restart failed: ${err?.message ?? err}`)
    }
  },
})

// Readiness probe.
//
// Returns 503 until either:
//   1. The agent gateway has finished starting (full init path), OR
//   2. The pool-mode warm pod has bound :8080 and is awaiting `/pool/assign`.
//
// Returning a fast 503 (instead of blocking on a healthy `200`) is what
// lets the Knative queue-proxy distinguish "still booting" from "process
// is hung" — the latter triggers the activator's 5-minute request
// timeout, which was cutting in-flight chats with `eof-without-turn-complete`.
app.get('/ready', (c) => {
  const poolModeUnassigned = state.isPoolMode && !state.poolAssigned
  const gatewayReady = agentGateway != null

  // Server-backed published apps: a static `dist/` is hydrated from git long
  // before the project's `server.tsx` (`/api/*`) is up, so accepting
  // `distReady` here would mark the pod routable while the API still returns
  // 503 `phase:idle` — exactly the cold-start that surfaced as
  // "Could not find <name>" to end users. Gate published readiness on the
  // inner API server instead so Knative's activator buffers the first request
  // through cold boot and the visitor gets a real 200. `apiReady` is
  // `hasApiServer === false || apiServerPhase === 'healthy'`, so a published
  // app with no sidecar (detected static-only) still reports ready.
  if (IS_PUBLISHED_MODE) {
    const { apiReady, apiServerPhase } = getPreviewManager().getStatus()
    const decision = computePublishedReadiness({ apiReady, apiServerPhase })
    return c.json(decision.body, decision.status)
  }

  // 2026-05-20 cold-start fix: also accept readiness when the static
  // serving path is functional (workspace `dist/index.html` exists).
  // This lets Knative add the pod to the routable endpoints as soon as
  // the project's prebuilt frontend can be served, which happens at
  // T+12s on a deps-cache-hit cold start — versus T+88s today, where
  // the gateway is blocked behind a 75s `tar -xzf` of node_modules
  // that user traffic doesn't actually need.
  //
  // Studio (which needs LSP + chat) should poll /ready/gateway below
  // for chat-readiness; Knative-level routing only cares that *some*
  // useful traffic can be served, which the static dist serves.
  const distReady = (() => {
    try {
      return existsSync(join(getDistDir(), 'index.html'))
    } catch {
      return false
    }
  })()

  if (poolModeUnassigned || gatewayReady || distReady) {
    return c.json({
      ready: true,
      gateway: gatewayReady,
      dist: distReady,
      poolMode: poolModeUnassigned,
    })
  }
  return c.json(
    {
      ready: false,
      reason: 'no dist, no gateway',
      workspace: workspaceStatus,
    },
    503,
  )
})

// Gateway-specific readiness probe. Studio polls this when it needs the
// agent (chat, LSP, MCP) to be alive — separate from /ready, which only
// gates Knative pod-level routability and accepts a static-only dist.
app.get('/ready/gateway', (c) => {
  const poolModeUnassigned = state.isPoolMode && !state.poolAssigned
  const gatewayReady = agentGateway != null
  if (poolModeUnassigned || gatewayReady) {
    return c.json({ ready: true, gateway: gatewayReady, poolMode: poolModeUnassigned })
  }
  return c.json(
    { ready: false, reason: 'agent-gateway not started', workspace: workspaceStatus },
    503,
  )
})

// =============================================================================
// Agent Workspace Bootstrap
// =============================================================================

/**
 * Move a file or directory from `src` to `dest`, working around a Windows-specific
 * failure mode: `renameSync` returns `EPERM` when the source tree has any file
 * handle open (e.g. a Vite file-watcher subscribing to `src/`). POSIX lets the
 * rename succeed in that case; NTFS does not.
 *
 * Falls back to a recursive copy plus a retrying `rmSync`. `rmSync` with
 * `maxRetries > 0` retries on EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM with a linear
 * backoff, which gives concurrent watchers time to release their handles.
 */
function safeMoveSync(src: string, dest: string): void {
  try {
    renameSync(src, dest)
    return
  } catch (err: any) {
    const code = err?.code
    if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY' && code !== 'EXDEV') {
      throw err
    }
  }
  cpSync(src, dest, { recursive: true, force: true, errorOnExist: false })
  rmSync(src, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

/**
 * Materialise the workspace project catalog at the merged-tree root:
 *
 *   - WORKSPACE.md         — human-readable, naturally surfaced to the
 *                            agent alongside AGENTS.md/MEMORY.md at root.
 *   - .shogo/workspace.json — machine-readable manifest for tools.
 *
 * Driven by the `WORKSPACE_PROJECTS` env the API attaches
 * (build-workspace-env.ts). Best-effort: a write failure must never
 * block boot.
 */
function writeWorkspaceManifest(workspaceDir: string): void {
  try {
    const projects = workspaceProjectsManifest()
    const workspaceId = process.env.WORKSPACE_ID || ''
    writeFileSync(join(workspaceDir, 'WORKSPACE.md'), renderWorkspaceManifestMarkdown(workspaceId, projects))
    const shogoDir = join(workspaceDir, '.shogo')
    mkdirSync(shogoDir, { recursive: true })
    writeFileSync(
      join(shogoDir, 'workspace.json'),
      JSON.stringify({ workspaceId, projects }, null, 2),
    )
    console.log(`[agent-runtime] Workspace catalog written (${projects.length} projects)`)
  } catch (err: any) {
    console.warn(`[agent-runtime] Could not write workspace manifest: ${err?.message ?? err}`)
  }
}

function ensureWorkspaceFiles(): void {
  // External (VS Code-style) projects: WORKSPACE_DIR is the user's
  // real repo on their machine. We MUST NOT run any of the seeding
  // / migration / template-overlay below — every branch is destructive
  // against a non-Shogo-shaped tree:
  //
  //   - `seedWorkspaceFromTemplate` / `seedRuntimeTemplate` would dump
  //     a Vite + React scaffold (`index.html`, `src/`, `tsconfig.json`,
  //     `vite.config.ts`, …) into the user's repo root, overwriting
  //     existing files.
  //   - The "legacy APP layout migration" further down would detect
  //     the user's own `package.json` + missing `AGENTS.md` and
  //     **move** the user's `package.json`, `bun.lock`, `.gitignore`,
  //     `src/`, `prisma/`, `dist/`, `public/`, `node_modules/` into a
  //     new `project/` subdirectory — surfaced on 2026-05-14 against
  //     `shogo-ai` itself, which lost ~50 prisma migrations to this path.
  //   - `seedTechStack` / `overlayAgentTemplateCodeDirs` similarly
  //     overlay starter files onto the user's tree.
  //   - `seedLSPConfig` writes a `pyrightconfig.json` the user never
  //     asked for.
  //
  // For external projects the `.shogo/{skills,plans,local}` skeleton
  // is already laid down by:
  //   - apps/api/src/routes/local-projects.ts (POST /from-folders)
  //   - RuntimeManager.ensureProjectDirectory (defense in depth)
  //
  // Re-running just the .shogo subdir creation here keeps the boot
  // idempotent for older bound folders that pre-date that scaffolding.
  if (shouldSkipManagedSeeding({ workingMode: WORKING_MODE, isWorkspaceRuntime: IS_WORKSPACE_RUNTIME })) {
    // External folder projects AND workspace runtimes: WORKSPACE_DIR is
    // not a fresh single-project sandbox. Seeding a Vite/React template
    // or running the legacy APP-layout migration here would corrupt the
    // user's repo (external) or the sibling project subfolders
    // (workspace). Lay down only the workspace-level `.shogo` skeleton.
    seedWorkspaceDefaults(WORKSPACE_DIR)
    if (IS_WORKSPACE_RUNTIME) {
      writeWorkspaceManifest(WORKSPACE_DIR)
    }
    workspaceStatus.templateSeeded = true
    logTiming(
      IS_WORKSPACE_RUNTIME
        ? 'Workspace runtime: skipped template seeding / legacy migration / LSP config'
        : 'External project: skipped template seeding / legacy migration / LSP config',
    )
    return
  }

  // Templates → marketplace consolidation (2026-05): the runtime no
  // longer reads TEMPLATE_ID or the `.template` marker file. Workspaces
  // are seeded by `copyWorkspaceFiles` at marketplace install time, so
  // by the time the runtime boots there is nothing template-specific
  // left for it to do — every workspace is just "the bundled defaults
  // plus whatever the install put on top". A leftover `.template`
  // marker from a pre-consolidation install is ignored (the file is
  // harmless and gets included in any future workspace snapshot
  // unchanged).
  seedWorkspaceDefaults(WORKSPACE_DIR)
  seedLSPConfig(WORKSPACE_DIR)
  logTiming('Workspace defaults seeded')

  // Migrate legacy APP layout: if package.json exists at workspace root (no AGENTS.md),
  // this is a legacy APP project — move app files into project/ subdirectory
  const legacyPkgJson = join(WORKSPACE_DIR, 'package.json')
  const agentsMd = join(WORKSPACE_DIR, 'AGENTS.md')
  if (existsSync(legacyPkgJson) && !existsSync(agentsMd)) {
    const projectDir = join(WORKSPACE_DIR, 'project')
    mkdirSync(projectDir, { recursive: true })
    const appFiles = ['package.json', 'bun.lock', 'tsconfig.json', 'vite.config.ts', 'tailwind.config.ts', 'postcss.config.js', 'components.json', '.gitignore']
    for (const f of appFiles) {
      const src = join(WORKSPACE_DIR, f)
      if (existsSync(src)) safeMoveSync(src, join(projectDir, f))
    }
    for (const d of ['src', 'prisma', 'dist', 'public', 'node_modules']) {
      const src = join(WORKSPACE_DIR, d)
      if (existsSync(src)) safeMoveSync(src, join(projectDir, d))
    }
    seedWorkspaceDefaults(WORKSPACE_DIR)
    logTiming('Migrated legacy APP layout into project/ subdirectory')
  }

  // Seed tech stack if specified via env var or marker file.
  // Projects without an explicit tech stack default to `react-app` (the
  // canvas v2 Vite + React + Tailwind workspace).
  const techStackMarker = join(WORKSPACE_DIR, '.tech-stack')
  const techStackIdFromEnv = process.env.TECH_STACK_ID
  const techStackIdFromFile = existsSync(techStackMarker) ? readFileSync(techStackMarker, 'utf-8').trim() : undefined
  let techStackId = techStackIdFromEnv || techStackIdFromFile || 'react-app'

  if (techStackId) {
    seedTechStack(WORKSPACE_DIR, techStackId)
    logTiming(`Tech stack seeded: ${techStackId}`)
  }

  // Seed runtime-template (Vite + React + Tailwind + shadcn/ui) if not already present
  // and the tech stack is a Vite-based stack. Other stacks bring their own
  // bundler / project layout via their own starter/ directory:
  //   - python-data       → Jupyter, no JS template
  //   - expo-app          → Metro + Expo Router
  //   - expo-three        → Metro + @react-three/fiber/native
  //   - unity-game        → .NET / Unity, no JS template
  const viteStacks = new Set(['react-app', 'threejs-game', 'phaser-game'])
  if (!techStackId || viteStacks.has(techStackId)) {
    const seeded = seedRuntimeTemplate(WORKSPACE_DIR)
    workspaceStatus.templateSeeded = seeded || existsSync(join(WORKSPACE_DIR, 'package.json'))
  } else {
    workspaceStatus.templateSeeded = true
  }

  // Agent template overlay used to live here (it pasted the bundled
  // `templates/<id>/src` over the runtime-template's `Project Ready`
  // App.tsx so the canvas matched the template surface). After the
  // templates → marketplace consolidation the workspace already arrives
  // with the right `src/` baked in via `copyWorkspaceFiles`, so the
  // overlay is a no-op for new projects. Existing template workspaces
  // stay correct because the listing version snapshot was produced
  // from the same overlay output.

  // One-shot migration: any workspace that still has `.shogo/server/` from
  // the legacy skill-server era is folded into root `prisma/schema.prisma`
  // + `server.tsx` here, before PreviewManager spins up the API server. The
  // migration is idempotent and silent on fresh workspaces.
  try {
    // require() (not dynamic import) so this stays synchronous —
    // ensureWorkspaceFiles() is called from sync code paths (boot +
    // /agent/seed handler) and the migration must finish before
    // PreviewManager looks at the schema.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { migrateSkillServerToRoot } = require('./migrations/skill-server-to-root') as typeof import('./migrations/skill-server-to-root')
    const result = migrateSkillServerToRoot(WORKSPACE_DIR)
    if (result.migrated) {
      workspaceStatus.serverMigrated = {
        snapshotPath: result.snapshotPath ?? null,
        notesPath: result.notesPath ?? null,
        at: result.at ?? null,
        mergedModels: result.mergedModels ?? [],
        renamedModels: result.renamedModels ?? [],
        customRoutesNeedReview: !!result.customRoutesNeedReview,
      }
      logTiming('Skill-server -> root migration complete')
    } else if (result.error) {
      console.error('[agent-runtime] Skill-server migration failed:', result.error)
    }
  } catch (err: any) {
    console.error('[agent-runtime] Skill-server migration import failed:', err.message)
  }

  // Second one-shot migration: any workspace from the brief "merged
  // server.tsx + custom-routes" era (between the skill-server retirement
  // and the SDK-emitted server.tsx restoration) has a hand-crafted or
  // skill-migrated `server.tsx` at the root. We pull anything custom
  // out into `custom-routes.ts` and let the SDK re-emit `server.tsx` on
  // the next `shogo generate`. Idempotent / silent when there's nothing
  // to extract — see `migrations/extract-custom-routes.ts`.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { extractCustomRoutes } = require('./migrations/extract-custom-routes') as typeof import('./migrations/extract-custom-routes')
    const result = extractCustomRoutes(WORKSPACE_DIR)
    if (result.migrated) {
      workspaceStatus.customRoutesExtracted = {
        snapshotPath: result.snapshotPath ?? null,
        notesPath: result.notesPath ?? null,
        at: result.at ?? null,
        hadMarker: !!result.hadMarker,
        needsReview: !!result.needsReview,
      }
      logTiming('extract-custom-routes migration complete')
    } else if (result.error) {
      console.error('[agent-runtime] extract-custom-routes failed:', result.error)
    }
  } catch (err: any) {
    console.error('[agent-runtime] extract-custom-routes import failed:', err.message)
  }
}

// AI proxy is configured by the shared framework (state.aiProxy)

// =============================================================================
// Agent Gateway Instance
// =============================================================================

let gatewayReadyResolve: (() => void) | null = null
let gatewayReadyPromise: Promise<void> | null = null

// Resolves once the workspace's `node_modules` are ready (installed or
// restored). The boot path no longer blocks the gateway on this: the install
// runs in the background while the gateway starts and accepts the first chat
// message. Work that genuinely needs deps (the LSP) awaits this instead.
// Defaults to already-resolved so callers never hang when no install is
// required (e.g. external projects, which own their own deps).
let workspaceDepsReadyPromise: Promise<void> = Promise.resolve()

/**
 * Kick off the workspace dependency install/restore in the background and
 * publish it via `workspaceDepsReadyPromise`.
 *
 * Callers MUST NOT await the returned promise on the gateway-start critical
 * path — the whole point is that the gateway comes up (and the first message
 * streams) while this runs. `bun install` here can race PreviewManager's own
 * `installDepsIfNeeded`; that is safe because both go through the per-workspace
 * install mutex (`runWorkspaceInstall`), which shares a single in-flight
 * install instead of running two concurrent `bun install`s.
 */
function startWorkspaceDepsInstall(opts: { afterS3Restore?: boolean } = {}): Promise<void> {
  const p = (async () => {
    if (opts.afterS3Restore && s3SyncInstance && !s3SyncInstance.areDepsReady()) {
      logTiming('Waiting for background deps restore...')
      await s3SyncInstance.waitForDeps()
      logTiming('Background deps restore ready')
    }
    try {
      const { didInstall } = await ensureWorkspaceDeps(WORKSPACE_DIR)
      workspaceStatus.depsInstalled = true
      // If an install actually ran (template deps didn't match the user's
      // package.json — common after a warm-pool assign where the template
      // stack differed), invalidate the pre-seeded marker so the next S3
      // sync uploads the freshly-installed deps + deps-hash.txt pointer.
      if (didInstall && s3SyncInstance) {
        s3SyncInstance.markDepsChanged()
      }
      logTiming('Workspace deps ready')
    } catch (err: any) {
      console.error('[agent-runtime] Workspace deps install failed:', err.message)
    }
  })()
  workspaceDepsReadyPromise = p
  return p
}

// =============================================================================
// Stream Buffer Store (SSE reconnect support)
// =============================================================================

const streamBufferStore = new StreamBufferStore()

// =============================================================================
// Stream Keep-Alive Utility
// =============================================================================

function wrapStreamWithKeepalive(
  stream: ReadableStream<Uint8Array>,
  intervalMs: number = 15_000
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const keepAliveMsg = encoder.encode(': keep-alive\n\n')
  let timer: ReturnType<typeof setInterval> | null = null
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null
  let closed = false
  const reader = stream.getReader()

  function cleanup() {
    if (timer) { clearInterval(timer); timer = null }
  }

  return new ReadableStream({
    start(c) {
      ctrl = c
      timer = setInterval(() => {
        if (closed || !ctrl) { cleanup(); return }
        try { ctrl.enqueue(keepAliveMsg) } catch { closed = true; cleanup() }
      }, intervalMs)
    },
    async pull(c) {
      try {
        const { done, value } = await reader.read()
        if (done) { closed = true; cleanup(); c.close(); return }
        c.enqueue(value)
      } catch (err) {
        closed = true; cleanup(); c.error(err)
      }
    },
    cancel() { closed = true; cleanup(); reader.cancel() },
  })
}

// Hono app, CORS, auth middleware, /health, /pool/activity, /pool/assign are
// provided by createRuntimeApp(). Agent-specific routes follow below.

// Register WhatsApp webhook routes (must be before any auth middleware)
WhatsAppAdapter.registerWebhookRoutes(app)

// Register Webhook/HTTP channel routes
WebhookAdapter.registerRoutes(app, () => {
  if (!agentGateway) return null
  const adapter = agentGateway.getChannel('webhook')
  return adapter && adapter.getStatus().connected ? adapter as any : null
})

// Hot-connect a channel at runtime (called by MCP tool after writing config.json)
app.post('/agent/channels/hot-connect', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const body = await c.req.json()
  const { type, config: channelConfig } = body as { type: string; config: Record<string, string> }

  if (!type) {
    return c.json({ error: 'Missing required field: type' }, 400)
  }

  try {
    await agentGateway.connectChannel(type, channelConfig || {})
    return c.json({ ok: true, message: `${type} channel connected` })
  } catch (err: any) {
    console.error(`[agent-runtime] Hot-connect ${type} failed:`, err.message)
    return c.json({ error: `Failed to connect ${type}: ${err.message}` }, 500)
  }
})

// Register Microsoft Teams messaging endpoint
TeamsAdapter.registerRoutes(app, () => {
  if (!agentGateway) return undefined
  return agentGateway.getChannel('teams') as any
})

// Register WebChat embeddable widget routes
WebChatAdapter.registerRoutes(app, () => {
  if (!agentGateway) return null
  const adapter = agentGateway.getChannel('webchat')
  return adapter && adapter.getStatus().connected ? adapter as any : null
})

// /health, /ready, /pool/activity, /pool/assign are provided by createRuntimeApp()

// Cloud API proxies /api/projects/:id/terminal/* to this runtime-local mount.
// Register before the static app fallback so POST /terminal/sessions cannot
// fall through to a generic 404 and GET /terminal/commands cannot return
// index.html.
const { router: terminalRouter, manager: ptyManager } = runtimeTerminalRoutes({
  workspaceDir: WORKSPACE_DIR,
})
app.route('/', terminalRouter)
const ptyWs = createPtyWsHandlers()

// Agent status (detailed)
app.get('/agent/status', (c) => {
  const status = agentGateway?.getStatus() ?? {
    running: false,
    heartbeat: { enabled: false, lastTick: null, nextTick: null },
    channels: [],
    skills: [],
  }
  return c.json(status)
})

// Return the current compacted-conversation summary for a single session,
// plus the metadata the StatusPanel needs to render its expanded view.
// Sessions live in memory on this pod; if the id has been evicted (TTL)
// or never existed, this returns 404.
app.get('/agent/sessions/:sessionId/summary', (c) => {
  const sm = agentGateway?.getSessionManager()
  if (!sm) return c.json({ error: 'Agent gateway not running' }, 503)
  const detail = sm.getDetail(c.req.param('sessionId'))
  if (!detail) return c.json({ error: 'session not found' }, 404)
  return c.json(detail)
})

// List the background shell processes still running for a chat thread. Used by
// the client to seed its process panel on thread load (live updates arrive via
// `data-process-update` SSE frames during a turn).
app.get('/agent/chat/:chatSessionId/processes', (c) => {
  if (!agentGateway) return c.json({ error: 'Agent gateway not running' }, 503)
  const processes = agentGateway.listSessionProcesses(c.req.param('chatSessionId'))
  return c.json({ processes })
})

// Kill (or dismiss, if stale) one tracked background process for a thread.
app.post('/agent/chat/:chatSessionId/processes/:runId/kill', (c) => {
  if (!agentGateway) return c.json({ error: 'Agent gateway not running' }, 503)
  const killed = agentGateway.killSessionProcess(
    c.req.param('chatSessionId'),
    c.req.param('runId'),
  )
  if (!killed) return c.json({ error: 'unknown run_id' }, 404)
  return c.json({ ok: true, processes: agentGateway.listSessionProcesses(c.req.param('chatSessionId')) })
})

// Read agent config
app.get('/agent/config', (c) => {
  const configPath = join(WORKSPACE_DIR, 'config.json')
  try {
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      return c.json(config)
    }
  } catch {}
  return c.json({})
})

// Update agent config — deep-merge fields into config.json and hot-reload the gateway
app.patch('/agent/config', async (c) => {
  const body = await c.req.json() as Record<string, unknown>
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Request body must be a JSON object' }, 400)
  }
  try {
    const configPath = join(WORKSPACE_DIR, 'config.json')
    let fileConfig: Record<string, unknown> = {}
    if (existsSync(configPath)) {
      try {
        fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
      } catch {
        fileConfig = {}
      }
    }

    // Support flat convenience aliases for the nested model key
    if (('modelName' in body || 'modelProvider' in body) && !('model' in body)) {
      const existing = (fileConfig.model ?? {}) as Record<string, string>
      body.model = {
        ...existing,
        ...(body.modelName ? { name: body.modelName as string } : {}),
        ...(body.modelProvider ? { provider: body.modelProvider as string } : {}),
      }
      delete body.modelName
      delete body.modelProvider
    }

    // Deep merge (one level) for known nested object keys so partial
    // updates like { model: { name: "..." } } preserve existing fields
    const NESTED_KEYS = ['model', 'quietHours', 'session', 'loopDetection', 'streamChunk', 'sandbox'] as const
    for (const key of NESTED_KEYS) {
      if (key in body && body[key] && typeof body[key] === 'object' && !Array.isArray(body[key])
          && fileConfig[key] && typeof fileConfig[key] === 'object' && !Array.isArray(fileConfig[key])) {
        body[key] = { ...(fileConfig[key] as any), ...(body[key] as any) }
      }
    }

    Object.assign(fileConfig, body)
    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8')
    agentGateway?.reloadConfig()

    // Sync heartbeat fields to the API's agent_configs DB table so the
    // local scheduler picks them up. Fire-and-forget.
    if ('heartbeatEnabled' in body || 'heartbeatInterval' in body) {
      const toolsProxyUrl = process.env.TOOLS_PROXY_URL
      const projectId = state.currentProjectId || process.env.PROJECT_ID
      const runtimeToken = process.env.RUNTIME_AUTH_SECRET
      if (toolsProxyUrl && projectId && runtimeToken) {
        const apiBase = toolsProxyUrl.replace(/\/api(\/.*)?$/, '/api')
        fetch(`${apiBase}/projects/${projectId}/heartbeat/sync`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'x-runtime-token': runtimeToken },
          body: JSON.stringify({
            heartbeatEnabled: fileConfig.heartbeatEnabled,
            heartbeatInterval: fileConfig.heartbeatInterval,
          }),
        }).catch(() => {})
      }
    }

    return c.json({ ok: true })
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to update config' }, 500)
  }
})

// ── BETA: per-chat git worktrees ───────────────────────────────────────────

// List the status of every chat worktree in this project (cross-chat overview).
app.get('/agent/worktrees', async (c) => {
  if (!agentGateway || !agentGateway.isWorktreesEnabled()) {
    return c.json({ enabled: false, worktrees: [] })
  }
  try {
    const worktrees = await agentGateway.listWorktreeStatuses()
    return c.json({ enabled: true, worktrees })
  } catch (err: any) {
    return c.json({ error: err?.message || 'Failed to list worktrees' }, 500)
  }
})

// Mark a chat done and merge its worktree branch back into the default branch.
// Clean merges complete here; conflicts are left in progress in the worktree
// for the agent to resolve in a follow-up chat turn (auto-finished at the next
// turn-complete via finalizeWorktreeTurn).
app.post('/agent/worktrees/:chatSessionId/merge', async (c) => {
  if (!agentGateway) return c.json({ error: 'Agent gateway not running' }, 503)
  if (!agentGateway.isWorktreesEnabled()) {
    return c.json({ error: 'Per-chat git worktrees are not enabled for this project' }, 400)
  }
  const chatSessionId = c.req.param('chatSessionId')
  if (!agentGateway.isWorktreeSession(chatSessionId)) {
    return c.json({ status: 'noop', message: 'No worktree exists for this chat yet.' })
  }
  try {
    await postWorktreeStatus(chatSessionId, { worktreeStatus: 'merging' })
    const result = await agentGateway.mergeSessionWorktree(chatSessionId)
    if (result.outcome === 'clean' || result.outcome === 'noop') {
      await recordWorktreeMergeCheckpoint(chatSessionId, result.mergedSha)
      await agentGateway.removeSessionWorktree(chatSessionId, { deleteBranch: true })
      await postWorktreeStatus(chatSessionId, { worktreeStatus: 'merged' })
      return c.json({ status: 'merged', mergedSha: result.mergedSha })
    }
    // Conflict — the merge is left in progress in the worktree. The caller
    // should prompt the agent (a normal chat turn) to resolve it; the
    // turn-complete handler finishes the merge once conflicts are gone.
    return c.json({
      status: 'conflict',
      conflictedFiles: result.conflictedFiles,
      message: result.message,
    })
  } catch (err: any) {
    await postWorktreeStatus(chatSessionId, { worktreeStatus: 'active' }).catch(() => {})
    return c.json({ error: err?.message || 'Merge failed' }, 500)
  }
})

// Channel connect — persist to config.json and hot-connect via the gateway
app.post('/agent/channels/connect', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const { type, config: channelConfig, model } = await c.req.json() as {
    type: string
    config: Record<string, string>
    model?: string
  }

  if (!type || !channelConfig) {
    return c.json({ error: 'type and config are required' }, 400)
  }

  const validTypes = ['telegram', 'discord', 'slack', 'whatsapp', 'email', 'webhook', 'webchat', 'teams']
  if (!validTypes.includes(type)) {
    return c.json({ error: `Invalid channel type: ${type}. Must be one of: ${validTypes.join(', ')}` }, 400)
  }

  const channelModel = (model === 'basic' || model === 'advanced') ? model : 'basic'

  if (channelModel === 'advanced') {
    const proxyUrl = process.env.AI_PROXY_URL
    const proxyToken = process.env.AI_PROXY_TOKEN
    if (proxyUrl && proxyToken) {
      try {
        const accessUrl = `${proxyUrl.replace(/\/chat\/completions$/, '').replace(/\/v1$/, '/v1')}/access`
        const accessRes = await fetch(accessUrl, {
          headers: { 'Authorization': `Bearer ${proxyToken}` },
          signal: AbortSignal.timeout(5000),
        })
        if (accessRes.ok) {
          const access = await accessRes.json() as { hasAdvancedModelAccess?: boolean }
          if (!access.hasAdvancedModelAccess) {
            return c.json({ error: 'Advanced model requires a Pro or higher subscription. Use "basic" or upgrade your plan.' }, 403)
          }
        }
      } catch {
        return c.json({ error: 'Unable to verify plan access. Please try again.' }, 503)
      }
    }
  }

  try {
    const configPath = join(WORKSPACE_DIR, 'config.json')
    let fileConfig: Record<string, any> = {}
    if (existsSync(configPath)) {
      try {
        fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
      } catch {
        console.error('[agent-runtime] config.json is invalid JSON, starting with empty config')
        fileConfig = {}
      }
    }

    fileConfig.channels = fileConfig.channels || []
    const channelEntry = { type, config: channelConfig, model: channelModel }
    const existing = fileConfig.channels.findIndex((ch: any) => ch.type === type)
    if (existing >= 0) {
      fileConfig.channels[existing] = channelEntry
    } else {
      fileConfig.channels.push(channelEntry)
    }

    await agentGateway.connectChannel(type, channelConfig)

    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8')

    return c.json({ ok: true, type, message: `${type} channel connected` })
  } catch (error: any) {
    return c.json({ error: error.message || `Failed to connect ${type}` }, 500)
  }
})

// Update channel model — change model tier without reconnecting
app.patch('/agent/channels/:type/model', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const type = c.req.param('type')
  const { model } = await c.req.json() as { model: string }

  if (!model || typeof model !== 'string') {
    return c.json({ error: 'model must be a valid model ID string' }, 400)
  }

  const resolvedModel = resolveModelId(model)
  const tier = getModelTier(resolvedModel)
  if (tier !== 'economy') {
    const proxyUrl = process.env.AI_PROXY_URL
    const proxyToken = process.env.AI_PROXY_TOKEN
    if (proxyUrl && proxyToken) {
      try {
        const accessUrl = `${proxyUrl.replace(/\/chat\/completions$/, '').replace(/\/v1$/, '/v1')}/access`
        const accessRes = await fetch(accessUrl, {
          headers: { 'Authorization': `Bearer ${proxyToken}` },
          signal: AbortSignal.timeout(5000),
        })
        if (accessRes.ok) {
          const access = await accessRes.json() as { hasAdvancedModelAccess?: boolean }
          if (!access.hasAdvancedModelAccess) {
            return c.json({ error: `Model '${model}' requires a Pro or higher subscription.` }, 403)
          }
        }
      } catch {
        return c.json({ error: 'Unable to verify plan access. Please try again.' }, 503)
      }
    }
  }

  try {
    const configPath = join(WORKSPACE_DIR, 'config.json')
    let fileConfig: Record<string, any> = {}
    if (existsSync(configPath)) {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
    }

    const channels = fileConfig.channels || []
    const idx = channels.findIndex((ch: any) => ch.type === type)
    if (idx < 0) {
      return c.json({ error: `Channel "${type}" not found in config` }, 404)
    }

    channels[idx].model = model
    fileConfig.channels = channels
    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8')
    agentGateway.reloadConfig()

    return c.json({ ok: true, type, model })
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to update model' }, 500)
  }
})

// Channel disconnect — remove from config.json and disconnect live adapter
app.post('/agent/channels/disconnect', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const { type } = await c.req.json() as { type: string }

  if (!type) {
    return c.json({ error: 'type is required' }, 400)
  }

  try {
    await agentGateway.disconnectChannel(type)

    const configPath = join(WORKSPACE_DIR, 'config.json')
    if (existsSync(configPath)) {
      try {
        const fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
        fileConfig.channels = (fileConfig.channels || []).filter((ch: any) => ch.type !== type)
        writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8')
      } catch {
        console.error('[agent-runtime] config.json is invalid JSON, skipping config update')
      }
    }

    return c.json({ ok: true, type, message: `${type} channel disconnected` })
  } catch (error: any) {
    return c.json({ error: error.message || `Failed to disconnect ${type}` }, 500)
  }
})

// Agent chat endpoint — send a message to the running agent.
// Accepts AI SDK v3 format: { messages: [{ role, parts: [{ type: 'text', text }] }] }
// Returns an AI SDK UI message stream so the frontend can use useChat().
app.post('/agent/chat', async (c) => {
  if (!agentGateway || gatewayReadyPromise) {
    if (gatewayReadyPromise) {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Gateway startup timeout')), 30_000)
      )
      try {
        await Promise.race([gatewayReadyPromise, timeout])
      } catch {
        return c.json({ error: 'Agent gateway still starting, please retry' }, 503)
      }
    }
    if (!agentGateway) {
      return c.json({ error: 'Agent gateway not running' }, 503)
    }
  }

  const body = await c.req.json()

  const allMessages = (body.messages || []) as Array<{ role: string; parts: Array<{ type: string; text?: string; mediaType?: string; url?: string; name?: string }> }>

  let userText: string | undefined
  let userFileParts: Array<{ type: string; mediaType?: string; url?: string; name?: string; savedPath?: string }> = []
  if (allMessages.length > 0) {
    const last = [...allMessages].reverse().find((m: any) => m.role === 'user')
    if (last?.parts && Array.isArray(last.parts)) {
      userText = last.parts
        .filter((p: any) => p.type === 'text')
        .map((p: any) => p.text)
        .join('\n')

      userFileParts = last.parts.filter(
        (p: any) => p.type === 'file' && p.url,
      )
    }
  }

  // Non-destructive continuation. When a turn ended incomplete (e.g. a model
  // call dropped and inference retries were exhausted), the client can ask the
  // agent to pick up from where it stopped WITHOUT re-sending the original user
  // message. The interrupted turn's completed tool calls were already persisted
  // to the session (see gateway: persist result.newMessages before UI cleanup),
  // so buildHistory replays them and the agent continues from that exact point.
  // We supply a crafted continuation instruction server-side rather than
  // re-running the original prompt (which would restart the work).
  const isContinueTurn = body.continue === true || body.continueTurn === true
  if (isContinueTurn && userFileParts.length === 0) {
    // The model receives a crafted continuation instruction regardless of any
    // short label the client rendered (e.g. a "Continue" bubble) so it resumes
    // the preserved work instead of re-running the original prompt.
    userText =
      'Continue from where you stopped. The previous response was interrupted ' +
      'mid-turn. Build on the tool results and progress already made in this ' +
      'conversation — do not restart, repeat completed steps, or re-run tools ' +
      'whose results are already present. Pick up exactly where you left off ' +
      'and finish the task.'
  }

  // Resolve IDE and "@" references into inline context before the empty-message
  // guard so context-only turns are valid. Skipped on continuation turns.
  if (!isContinueTurn) {
    const ideContext = buildIdeContext(body.ideContext)
    if (ideContext) {
      userText = userText ? `${userText}\n\n${ideContext}` : ideContext
    }
    const referencedContext = buildReferencedContext(body.references, WORKSPACE_DIR)
    if (referencedContext) {
      userText = userText ? `${userText}\n\n${referencedContext}` : referencedContext
    }
  }

  if (!userText && userFileParts.length === 0) {
    return c.json({ error: 'message is required — send { messages: [{ role: "user", parts: [{ type: "text", text: "..." }] }] }' }, 400)
  }

  // Save uploaded files to the agent's workspace so they're accessible to the
  // agent via its workspace tools (read_file, search, exec/unzip, etc.). Every
  // base64 data-URL part is persisted regardless of MIME type — even archives
  // and unknown binaries — and the saved path is annotated back onto the file
  // part so downstream parsing can surface it to the agent.
  if (userFileParts.length > 0) {
    const { saved, savedSummaries, zipUploaded } = saveUploadedFileParts({
      workspaceDir: WORKSPACE_DIR,
      parts: userFileParts,
    })

    for (const sf of saved) {
      if (sf.isZip) continue
      try { getIndexEngine().indexFile('files', sf.baseName).catch(() => {}) } catch { /* best-effort */ }
    }

    const note = buildUploadedFilesNote(savedSummaries, zipUploaded)
    if (note) {
      userText = userText ? `${userText}\n\n${note}` : note
    }
  }

  // Use the DB chatSessionId as the runtime session key so that different
  // chat sessions within the same project get isolated conversation history.
  //
  // No fallback: the runtime used to default to the literal string `'chat'`
  // when the caller omitted the id, but that silently collapsed every
  // no-id turn into a single shared `SessionManager` slot per pod, leaking
  // one chat's history into the next. The proxy (`apps/api/src/routes/
  // project-chat.ts`) already rejects requests without a chat session id;
  // this guard is the runtime-side belt-and-suspenders for tests, evals,
  // and any direct callers that bypass the proxy. See the regression test
  // at `__tests__/chat-session-fallback-leak.test.ts`.
  const headerChatSessionId = c.req.header('X-Chat-Session-Id')
  const rawChatSessionKey = (headerChatSessionId ?? body.chatSessionId) as unknown
  if (typeof rawChatSessionKey !== 'string' || rawChatSessionKey.trim() === '') {
    return c.json(
      { error: 'chatSessionId is required — send the X-Chat-Session-Id header or `chatSessionId` in the JSON body' },
      400
    )
  }
  const chatSessionKey = rawChatSessionKey

  // Seed the chat session with prior conversation history from the request.
  // AI SDK clients and eval runners send the full message array each turn;
  // the session is the authoritative store so we only seed when it's empty
  // to avoid duplicating messages on subsequent turns.
  if (allMessages.length > 1) {
    const sessionMgr = agentGateway!.getSessionManager()
    const session = sessionMgr.getOrCreate(chatSessionKey)
    if (session.messages.length === 0) {
      const priorMessages = allMessages.slice(0, -1)
      for (const msg of priorMessages) {
        const text = (msg.parts || [])
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text)
          .join('\n')

        if (msg.role === 'user') {
          const historyFileParts = (msg.parts || []).filter(
            (p: any) => p.type === 'file' && p.url,
          )
          if (historyFileParts.length > 0) {
            const imageCount = historyFileParts.filter((p: any) => p.mediaType?.startsWith('image/')).length
            const fileCount = historyFileParts.length - imageCount
            const notes: string[] = []
            if (imageCount > 0) notes.push(`[${imageCount} image(s) were attached]`)
            if (fileCount > 0) notes.push(`[${fileCount} file(s) were attached]`)
            const effectiveText = [text, ...notes].filter(Boolean).join('\n')
            if (!effectiveText) continue
            sessionMgr.addMessages(chatSessionKey, userMessage(effectiveText))
          } else {
            if (!text) continue
            sessionMgr.addMessages(chatSessionKey, userMessage(text))
          }
        } else if (msg.role === 'assistant') {
          if (!text) continue
          sessionMgr.addMessages(chatSessionKey, {
            role: 'assistant',
            content: [{ type: 'text', text }],
            api: 'anthropic-messages',
            provider: 'anthropic',
            model: 'history',
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop',
            timestamp: Date.now(),
          } as any)
        }
      }
    }
  }

  const modelOverride = (body.agentMode as string | undefined) || undefined
  // Native provider hint resolved by the API server from its model registry so
  // the gateway can route a DB model addressed by an opaque UUID to its real
  // provider's native endpoint instead of inferring `custom` from the id.
  // Optional — absent requests fall back to id-based inference.
  const modelProvider = (body.modelProvider as string | undefined) || undefined
  const interactionMode = body.interactionMode as 'agent' | 'plan' | 'ask' | undefined
  const confirmedPlan = body.confirmedPlan || undefined
  const dualPlan = body.dualPlan === true
  console.log(`[AgentRuntime][chat] received — interactionMode: ${interactionMode ?? '(undefined → defaults to agent)'}, agentMode: ${modelOverride ?? '(none)'}, modelProvider: ${modelProvider ?? '(none)'}, hasConfirmedPlan: ${!!confirmedPlan}, dualPlan: ${dualPlan}, sessionKey: ${chatSessionKey}, bodyKeys: ${Object.keys(body).join(',')}`)

  if (body.timezone && typeof body.timezone === 'string') {
    agentGateway!.setUserTimezone(body.timezone)
  }

  const chatUserId = c.req.header('X-User-Id') || body.userId || undefined

  // Create a buffer that lives independently of the HTTP connection.
  // The agent writes into this buffer via a background consumer so that
  // a client disconnect (e.g. page refresh) does NOT cancel the agent.
  console.log(`[AgentChat] Creating stream buffer for session: ${chatSessionKey}`)
  const bufWriter = streamBufferStore.create(chatSessionKey)
  const turnId = bufWriter.turnId

  trackStreamStart()
  // Tracks whether an explicit `data-turn-complete` terminal frame has been
  // emitted for this turn. The client's auto-resuming fetch keeps reconnecting
  // to `/stream?fromSeq=N` until it parses this frame; if the turn ends
  // abnormally (bg-reader transport error, process abort race) before the
  // try/catch below writes one, the buffer would be marked `completed` with NO
  // terminal frame and the client would replay the tail forever — pinning
  // `useChat().status` at `streaming` and wedging the composer on Stop/Queue.
  // The bgReader `finally` synthesizes one when this stays false.
  let terminalFrameWritten = false
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      let turnSucceeded = false
      // Periodic seq heartbeat. The client uses this to know how many
      // buffered chunks it has already received so it can resume with
      // `?fromSeq=N` on a premature disconnect without re-rendering text
      // it has already seen.
      const seqHeartbeat = setInterval(() => {
        const seq = bufWriter.lastSeq
        if (seq <= 0) return
        try {
          writer.write({
            type: 'data-turn-seq',
            data: { turnId, seq },
          } as any)
        } catch {
          clearInterval(seqHeartbeat)
        }
      }, 250)
      try {
        // Mark the start of this durable turn so a reconnecting client
        // can correlate replay frames against the right turn id.
        writer.write({
          type: 'data-turn-start',
          data: {
            turnId,
            chatSessionId: chatSessionKey,
            startedAt: Date.now(),
          },
        } as any)
        writer.write({ type: 'start-step' })
        await agentGateway!.processChatMessageStream(userText || '', writer, {
          modelOverride,
          modelProvider,
          fileParts: userFileParts.length > 0 ? userFileParts : undefined,
          userId: chatUserId,
          interactionMode,
          confirmedPlan,
          dualPlan,
          chatSessionId: chatSessionKey,
        })

        const usage = agentGateway!.consumeLastTurnUsage()
        if (usage) {
          const dollarCost = calculateDollarCost(
            usage.model,
            usage.inputTokens,
            usage.outputTokens,
            usage.cacheReadTokens,
            usage.cacheWriteTokens,
          )
          writer.write({
            type: 'data-usage',
            data: { ...usage, dollarCost },
          } as any)
        }

        writer.write({ type: 'finish-step' })
        // Explicit terminal marker the client uses to differentiate "really
        // done" from "stream EOF mid-turn". Anything past this point on the
        // wire is purely framing noise and should be ignored by clients.
        //
        // When the user clicked Stop, the agent loop unwinds with
        // `result.abortReason === 'external'` and the gateway sets
        // `usage.wasAborted`. We tag the terminal frame `status: 'aborted'`
        // so project-chat (and other consumers) can distinguish a
        // user-initiated stop from a clean turn end and bill the partial
        // usage that was just emitted.
        writer.write({
          type: 'data-turn-complete',
          data: {
            turnId,
            chatSessionId: chatSessionKey,
            status: usage?.wasAborted ? 'aborted' : 'completed',
            lastSeq: bufWriter.lastSeq,
            completedAt: Date.now(),
          },
        } as any)
        terminalFrameWritten = true
        writer.write({ type: 'finish', finishReason: usage?.wasAborted ? 'abort' : 'stop' })
        turnSucceeded = true

        // Per-turn git sync: in `dual_shadow` / `git_only` modes, sync
        // the workspace once the agent finishes its turn. This is the
        // natural ProjectCheckpoint granularity — one row per assistant
        // turn. In `git_only` (pod-owned) the commit is local and the
        // sync's afterCommit persists `.git` to object storage and records
        // the ProjectCheckpoint row via the internal API endpoint (see
        // persistAndRecordCheckpoint above). In `dual_shadow` it pushes to
        // the API origin, whose post-receive hook writes the row.
        //
        // We deliberately do NOT hook the S3Sync filesystem watcher
        // for git: that fires per file event and would commit 5–50
        // times per turn (every tool call, every edit). The
        // turn-complete site is the same boundary the checkpoints
        // system has always used.
        //
        // `triggerSync(false)` is debounced internally (~1.5s) and
        // returns immediately, so this is a fire-and-forget that
        // doesn't add latency to the turn-complete response.
        if (gitSyncInstance) {
          try {
            // Offload large/binary assets first (updates .git/info/exclude
            // synchronously so the debounced push below stays source-only).
            triggerLargeFileSync()
            gitSyncInstance.triggerSync(false)
          } catch (err: any) {
            console.warn('[agent-runtime] gitSync triggerSync at turn-complete threw:', err?.message ?? err)
          }
        }

        // BETA: per-chat git worktrees. When this session runs in an isolated
        // worktree, the agent's edits live on its branch (not the main tree),
        // so the main gitSync above no-ops. Commit the worktree (and, for a
        // conflict-resolution turn, finish the merge) here.
        if (agentGateway?.isWorktreeSession(chatSessionKey)) {
          void finalizeWorktreeTurn(chatSessionKey).catch((err: any) =>
            console.warn('[agent-runtime] finalizeWorktreeTurn at turn-complete threw:', err?.message ?? err),
          )
        }
      } catch (error: any) {
        writer.write({
          type: 'data-turn-complete',
          data: {
            turnId,
            chatSessionId: chatSessionKey,
            status: 'failed',
            error: error?.message || 'Agent chat error',
            lastSeq: bufWriter.lastSeq,
            completedAt: Date.now(),
          },
        } as any)
        terminalFrameWritten = true
        writer.write({ type: 'error', errorText: error.message || 'Agent chat error' } as any)
      } finally {
        clearInterval(seqHeartbeat)
        trackStreamEnd()
        if (!turnSucceeded) {
          // Best-effort marker so the snapshot reflects the failure state
          // for the grace window.
        }
      }
    },
  })

  const response = createUIMessageStreamResponse({ stream })
  if (response.body) {
    // Consume the agent's stream in the background, feeding chunks into
    // the buffer. This reader is NOT tied to the HTTP response — the agent
    // keeps running even if the client disconnects.
    const bgReader = response.body.getReader()
    ;(async () => {
      try {
        while (true) {
          const { done, value } = await bgReader.read()
          if (done) break
          bufWriter.append(value)
        }
        console.log(`[AgentChat] Background stream completed for session: ${chatSessionKey} (turn ${turnId}, seq=${bufWriter.lastSeq})`)
      } catch (err: any) {
        console.log(`[AgentChat] Background stream error for session: ${chatSessionKey}:`, err?.message || err)
      } finally {
        // Guarantee a terminal frame in the buffer. If the turn ended without
        // the try/catch above writing one (bg-reader transport error, abort
        // race, or any path that tore the agent stream before the terminal
        // marker), synthesize one now — WHILE the buffer is still `active`, so
        // `append` assigns it a seq and it reaches both live subscribers and
        // future `?fromSeq=N` replays. Without this, the client's
        // auto-resuming fetch never sees `data-turn-complete`, replays the
        // tail forever, and the composer stays wedged in `streaming`.
        if (!terminalFrameWritten) {
          try {
            bufWriter.append(
              encodeTurnCompleteFrame({
                turnId,
                chatSessionId: chatSessionKey,
                status: 'failed',
                error: 'stream ended without terminal frame',
                lastSeq: bufWriter.lastSeq,
                completedAt: Date.now(),
              }),
            )
            terminalFrameWritten = true
            console.log(`[AgentChat] Synthesized terminal frame for session: ${chatSessionKey} (turn ${turnId})`)
          } catch (sErr: any) {
            console.warn(`[AgentChat] Failed to synthesize terminal frame for ${chatSessionKey}:`, sErr?.message || sErr)
          }
        }
        bufWriter.complete()
      }
    })()

    // The client reads from a replay stream backed by the buffer.
    // If this client disconnects, only the replay subscriber is removed;
    // the background reader + agent keep running.
    const replayStream = streamBufferStore.createReplayStream(chatSessionKey)!
    const wrappedStream = wrapStreamWithKeepalive(replayStream, 15_000)
    const responseHeaders = new Headers(response.headers)
    responseHeaders.set('X-Turn-Id', turnId)
    responseHeaders.set('X-Chat-Session-Id', chatSessionKey)
    return new Response(wrappedStream, {
      status: response.status,
      headers: responseHeaders,
    })
  }
  return response
})

// Reconnect to an active (or recently completed) stream.
// URL pattern matches the AI SDK's default resume convention: ${api}/${chatId}/stream
//
// Optional query params:
//   - fromSeq: replay only frames with seq > fromSeq (delta resume so the
//              client doesn't render duplicates).
//
// Response headers always include:
//   - X-Turn-Id: the active turn this stream belongs to
//   - X-Last-Seq: the last seq the runtime has buffered at the time of attach
//   - X-Turn-Status: active | completed | failed | aborted
//
// Status code semantics:
//   - 200 with stream  → buffer exists. Stream replays frames > fromSeq, then
//                        either closes (terminal turn) or stays open for live
//                        frames (active turn).
//   - 204              → no buffer at all for this session (turn is unknown
//                        or expired beyond the grace window). The client
//                        should treat this as "nothing to resume" and stop.
app.get('/agent/chat/:chatSessionId/stream', (c) => {
  const chatSessionId = c.req.param('chatSessionId')
  const fromSeqRaw = c.req.query('fromSeq')
  const fromSeq = fromSeqRaw ? Math.max(0, parseInt(fromSeqRaw, 10) || 0) : 0
  const snapshot = streamBufferStore.snapshot(chatSessionId)
  console.log(`[AgentChat] Stream reconnect: session=${chatSessionId} fromSeq=${fromSeq} snapshot=${snapshot ? `${snapshot.status}@${snapshot.lastSeq}` : 'none'}`)

  if (!snapshot) {
    return new Response(null, { status: 204 })
  }

  const replayStream = streamBufferStore.createReplayStream(chatSessionId, { fromSeq })
  if (!replayStream) {
    return new Response(null, { status: 204 })
  }

  const wrappedStream = wrapStreamWithKeepalive(replayStream, 15_000)
  return new Response(wrappedStream, {
    headers: {
      'Content-Type': 'text/x-ai-sdk-ui-stream',
      'X-Accel-Buffering': 'no',
      'Cache-Control': 'no-cache',
      'X-Turn-Id': snapshot.turnId,
      'X-Last-Seq': String(snapshot.lastSeq),
      'X-Turn-Status': snapshot.status,
    },
  })
})

// Read-only durable-turn status endpoint. Lets a client poll for the current
// state of a turn without opening a stream — useful when deciding whether to
// reconnect. Mirrors the snapshot exposed by the StreamBufferStore.
app.get('/agent/chat/:chatSessionId/turn', (c) => {
  const chatSessionId = c.req.param('chatSessionId')
  const snapshot = streamBufferStore.snapshot(chatSessionId)
  if (!snapshot) {
    return c.json({ status: 'unknown' as const }, 404)
  }
  return c.json({
    chatSessionId,
    turnId: snapshot.turnId,
    status: snapshot.status,
    lastSeq: snapshot.lastSeq,
    terminal: snapshot.terminal,
    createdAt: snapshot.createdAt,
    completedAt: snapshot.completedAt,
    lastEventAt: snapshot.lastEventAt,
  })
})

// Live browser screencast for a running subagent instance.
// Frames are JPEG-base64, emitted by CDP `Page.startScreencast` from inside
// `createBrowserTool` whenever a subagent using the `browser` tool is spawned
// (see screencast-broadcaster.ts). The mobile `LiveBrowserView` subscribes
// here to render a running subagent's viewport under its card.
app.get('/agent/subagents/:instanceId/screencast', (c) => {
  const instanceId = c.req.param('instanceId')
  const debugScreencast = process.env.DEBUG_SCREENCAST === '1' || process.env.DEBUG_SCREENCAST === 'true'
  const scLog = (msg: string) => { if (debugScreencast) console.log(msg) }
  scLog(`[screencast] SSE open instanceId=${instanceId}`)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      let closed = false
      let sentFrames = 0
      const send = (payload: string) => {
        if (closed) return
        try { controller.enqueue(enc.encode(payload)) } catch { closed = true }
      }
      // Replay the most recent frame so new subscribers see something immediately.
      const last = getLastScreencastFrame(instanceId)
      if (last) {
        scLog(`[screencast] SSE replay last frame instanceId=${instanceId}`)
        send(`data: ${JSON.stringify(last)}\n\n`)
        sentFrames++
      } else {
        scLog(`[screencast] SSE no last frame yet instanceId=${instanceId}`)
      }
      const unsub = subscribeScreencast(instanceId, (frame) => {
        sentFrames++
        if (sentFrames === 1 || sentFrames % 60 === 0) {
          scLog(`[screencast] SSE send frame#${sentFrames} instanceId=${instanceId}`)
        }
        send(`data: ${JSON.stringify(frame)}\n\n`)
      })
      const iv = setInterval(() => send(`: keepalive\n\n`), 15_000)
      const teardown = () => {
        if (closed) return
        closed = true
        clearInterval(iv)
        try { unsub() } catch {}
        try { controller.close() } catch {}
        scLog(
          `[screencast] SSE close instanceId=${instanceId} sentFrames=${sentFrames}`,
        )
      }
      c.req.raw.signal.addEventListener('abort', teardown)
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})

// Retrieve chat history so the UI can restore past messages on reconnect
app.get('/agent/chat/history', async (c) => {
  if (!agentGateway) {
    return c.json({ messages: [] })
  }

  const session = await agentGateway.getSessionManager().getOrCreateAsync('chat')
  if (session.messages.length === 0) {
    return c.json({ messages: [] })
  }

  const simplified: Array<{ id: string; role: string; content: string }> = []
  for (const msg of session.messages) {
    if (msg.role === 'user') {
      const raw = typeof msg.content === 'string' ? msg.content : ''
      const userMatch = raw.match(/\[User Message\]\n([\s\S]+)$/)
      const chatMatch = raw.match(/\[Chat — User Message\]\n[\s\S]*?\n\n([\s\S]+)$/)
      const displayText = userMatch?.[1]?.trim() || chatMatch?.[1]?.trim() || raw
      simplified.push({ id: `h-${simplified.length}`, role: 'user', content: displayText })
    } else if (msg.role === 'assistant') {
      const parts = (msg as any).content as any[] | undefined
      const text = parts
        ?.filter((p: any) => p.type === 'text')
        .map((p: any) => p.text)
        .join('\n') || ''
      if (text) {
        simplified.push({ id: `h-${simplified.length}`, role: 'assistant', content: text })
      }
    }
  }

  const activeMode = agentGateway?.getActiveMode() || 'canvas'
  return c.json({ messages: simplified, activeMode })
})

// Get/set the active visual mode
app.get('/agent/mode', (c) => {
  if (!agentGateway) return c.json({ mode: 'none' })
  return c.json({
    mode: agentGateway.getActiveMode(),
    allowedModes: agentGateway.getAllowedModes(),
  })
})

app.post('/agent/mode', async (c) => {
  if (!agentGateway) return c.json({ error: 'Gateway not ready' }, 503)

  const body = await c.req.json<{ mode: string }>().catch(() => null)
  const mode = body?.mode
  if (mode !== 'canvas' && mode !== 'app' && mode !== 'none') {
    return c.json({ error: 'mode must be "canvas", "app", or "none"' }, 400)
  }

  const allowed = agentGateway.getAllowedModes()
  if (!allowed.includes(mode)) {
    return c.json({ error: `Mode "${mode}" not allowed. Available: ${allowed.join(', ')}` }, 403)
  }

  agentGateway.setActiveMode(mode)
  return c.json({ mode })
})

// ---------------------------------------------------------------------------
// Plans API
// ---------------------------------------------------------------------------

app.get('/agent/plans', async (c) => {
  const plansDir = join(WORKSPACE_DIR, '.shogo', 'plans')
  if (!existsSync(plansDir)) {
    return c.json({ plans: [] })
  }

  const plans: Array<{ filename: string; name: string; overview: string; createdAt: string; status: string }> = []
  try {
    for (const entry of readdirSync(plansDir)) {
      if (!entry.endsWith('.plan.md')) continue
      const filepath = join(plansDir, entry)
      const content = readFileSync(filepath, 'utf-8')
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
      if (!fmMatch) continue
      const fm = fmMatch[1]
      const getName = (s: string) => { const m = s.match(/^name:\s*"?([^"\n]*)"?/m); return m?.[1] || '' }
      const getOverview = (s: string) => { const m = s.match(/^overview:\s*"?([^"\n]*)"?/m); return m?.[1] || '' }
      const getCreatedAt = (s: string) => { const m = s.match(/^createdAt:\s*"?([^"\n]*)"?/m); return m?.[1] || '' }
      const getStatus = (s: string) => { const m = s.match(/^status:\s*(\S+)/m); return m?.[1] || 'pending' }
      plans.push({
        filename: entry,
        name: getName(fm),
        overview: getOverview(fm),
        createdAt: getCreatedAt(fm),
        status: getStatus(fm),
      })
    }
  } catch { /* directory unreadable */ }

  plans.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  return c.json({ plans })
})

app.get('/agent/plans/:filename', async (c) => {
  const filename = c.req.param('filename')
  if (!filename || !filename.endsWith('.plan.md')) {
    return c.json({ error: 'Invalid plan filename' }, 400)
  }
  const filepath = join(WORKSPACE_DIR, '.shogo', 'plans', filename)
  if (!existsSync(filepath)) {
    return c.json({ error: 'Plan not found' }, 404)
  }
  const content = readFileSync(filepath, 'utf-8')
  const { extractSummarySection } = await import('./plan-translation')
  const summary = extractSummarySection(content)
  return c.json({ filename, content, summary: summary ?? undefined })
})

app.put('/agent/plans/:filename', async (c) => {
  const filename = c.req.param('filename')
  if (!filename || !filename.endsWith('.plan.md')) {
    return c.json({ error: 'Invalid plan filename' }, 400)
  }
  const filepath = join(WORKSPACE_DIR, '.shogo', 'plans', filename)
  if (!existsSync(filepath)) {
    return c.json({ error: 'Plan not found' }, 404)
  }

  const body = await c.req.json().catch(() => ({} as any))
  const existing = readFileSync(filepath, 'utf-8')
  const fmMatch = existing.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) {
    return c.json({ error: 'Could not parse plan frontmatter' }, 500)
  }

  const fm = fmMatch[1]
  const existingName = fm.match(/name:\s*"?([^"\n]*)"?/)?.[1] ?? ''
  const existingOverview = fm.match(/overview:\s*"?([^"\n]*)"?/)?.[1] ?? ''
  const existingBody = existing.substring(existing.indexOf('---', 4) + 3).trim()
  const existingCreatedAt = fm.match(/createdAt:\s*"?([^"\n]*)"?/)?.[1] ?? new Date().toISOString()
  const existingStatus = fm.match(/status:\s*(\S+)/)?.[1] ?? 'pending'

  const updatedName = body.name ?? existingName
  const updatedOverview = body.overview ?? existingOverview
  const updatedBody = body.plan ?? existingBody.replace(/^#[^\n]*\n*/, '')

  let todosYaml: string
  if (body.todos && Array.isArray(body.todos)) {
    todosYaml = body.todos.map((t: any) =>
      `  - id: ${t.id}\n    content: ${JSON.stringify(t.content)}\n    status: ${t.status ?? 'pending'}`
    ).join('\n')
  } else {
    const todosMatch = fm.match(/todos:\n([\s\S]*)$/)
    todosYaml = todosMatch?.[1]?.trimEnd() ?? ''
  }

  const content = [
    '---',
    `name: ${JSON.stringify(updatedName)}`,
    `overview: ${JSON.stringify(updatedOverview)}`,
    `createdAt: ${JSON.stringify(existingCreatedAt)}`,
    `status: ${body.status ?? existingStatus}`,
    'todos:',
    todosYaml,
    '---',
    '',
    `# ${updatedName}`,
    '',
    updatedBody,
  ].join('\n')

  writeFileSync(filepath, content, 'utf-8')
  return c.json({ updated: true, filename })
})

app.delete('/agent/plans/:filename', async (c) => {
  const filename = c.req.param('filename')
  if (!filename || !filename.endsWith('.plan.md')) {
    return c.json({ error: 'Invalid plan filename' }, 400)
  }
  const filepath = join(WORKSPACE_DIR, '.shogo', 'plans', filename)
  if (!existsSync(filepath)) {
    return c.json({ error: 'Plan not found' }, 404)
  }
  unlinkSync(filepath)
  return c.json({ deleted: true })
})

// On-demand summary generation for an existing plan. Works for plans
// created BEFORE the Dual Plan feature existed (or with the toggle off) —
// the endpoint reads the current technical body, runs the fast-tier
// translator, and persists the result back into the same .plan.md file.
app.post('/agent/plans/:filename/summarize', async (c) => {
  const filename = c.req.param('filename')
  if (!filename || !filename.endsWith('.plan.md')) {
    return c.json({ error: 'Invalid plan filename' }, 400)
  }
  const filepath = join(WORKSPACE_DIR, '.shogo', 'plans', filename)
  if (!existsSync(filepath)) {
    return c.json({ error: 'Plan not found' }, 404)
  }

  const current = readFileSync(filepath, 'utf-8')
  const fmMatch = current.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) {
    return c.json({ error: 'Could not parse plan frontmatter' }, 500)
  }
  const fm = fmMatch[1]
  const name = fm.match(/name:\s*"?([^"\n]*)"?/)?.[1] ?? filename
  const overview = fm.match(/overview:\s*"?([^"\n]*)"?/)?.[1] ?? ''

  const {
    summarizePlan,
    upsertSummarySection,
    stripSummarySection,
  } = await import('./plan-translation')

  // The body for the summary must be the *technical* markdown only — strip
  // any previously-stored summary section first, then take everything
  // after the frontmatter and the leading `# Heading` line.
  const withoutSummary = stripSummarySection(current)
  const afterFrontmatter = withoutSummary.substring(withoutSummary.indexOf('---', 4) + 3).trim()
  const planMarkdown = afterFrontmatter.replace(/^#[^\n]*\n*/, '')

  try {
    // parentModel intentionally omitted: the fast tier maps to a concrete
    // model regardless of parent, so no need to surface a gateway hook.
    const summary = await summarizePlan({
      name,
      overview,
      planMarkdown,
    })
    const next = upsertSummarySection(current, summary)
    writeFileSync(filepath, next, 'utf-8')
    return c.json({ summary })
  } catch (err: any) {
    return c.json({ error: err?.message || 'Summary generation failed' }, 500)
  }
})

// Stop/interrupt the current agent turn (and any active code agent task)
app.post('/agent/stop', async (c) => {
  if (!agentGateway) return c.json({ error: 'Gateway not ready' }, 503)

  const body = await c.req.json().catch(() => ({} as any))
  // Same rule as `/agent/chat` — no implicit `'chat'` fallback. Stopping
  // the "default" bucket from a no-id caller would have aborted whatever
  // chat happened to have written into it last; reject up-front instead.
  const headerStopSessionId = c.req.header('X-Chat-Session-Id')
  const rawStopSessionKey = (headerStopSessionId ?? body.chatSessionId) as unknown
  if (typeof rawStopSessionKey !== 'string' || rawStopSessionKey.trim() === '') {
    return c.json(
      { error: 'chatSessionId is required — send the X-Chat-Session-Id header or `chatSessionId` in the JSON body' },
      400
    )
  }
  const stopSessionKey = rawStopSessionKey
  const aborted = agentGateway.abortCurrentTurn(stopSessionKey)

  // Also cancel every running subagent spawned via AgentManager. The main turn
  // signal does not reach these instances because each has its own AbortController.
  const cancelledSubagents = agentGateway.agentManager.cancelAll()

  // We deliberately do NOT call `streamBufferStore.abort(stopSessionKey)` here.
  // The agent loop, the `createUIMessageStream` execute callback, and the
  // background reader that drains it into `bufWriter` all keep running after
  // `abortCurrentTurn` flips the signal. Within ~ms they emit the trailing
  // `data-usage` (with whatever partial token counts were accumulated) and
  // `data-turn-complete{status:'aborted'}` frames, then the bgReader's
  // `finally` block calls `bufWriter.complete()` which closes the buffer
  // cleanly. Tearing the buffer down synchronously here would race those
  // wind-down writes against the abort, dropping the partial-usage frame on
  // the floor and causing project-chat's auto-resume to return 204 (which it
  // bills as a $0 stop-or-crash partial — see the comment in
  // `apps/api/src/routes/project-chat.ts`).
  return c.json({ stopped: aborted, cancelledSubagents })
})

// Cancel a single running subagent by AgentManager instance id
app.post('/agent/subagents/:instanceId/stop', async (c) => {
  if (!agentGateway) return c.json({ error: 'Gateway not ready' }, 503)
  const instanceId = c.req.param('instanceId')
  if (!instanceId) return c.json({ error: 'Missing instanceId' }, 400)
  const cancelled = agentGateway.agentManager.cancel(instanceId)
  return c.json({ cancelled, instanceId })
})

// ---------------------------------------------------------------------------
// Preview Manager (app mode — lazy init)
// ---------------------------------------------------------------------------

import { PreviewManager } from './preview-manager'
import { previewConsoleLogPath, ensureRuntimeLogDir } from './runtime-log-paths'
import { scheduleLogWrite, flushAllLogWrites } from './runtime-log-writer'

let previewManager: PreviewManager | null = null

/** In-memory mirror of `.shogo/logs/console.log` for `/console-log` + SSE (same lines as on disk). */
let consoleLogsRuntimeBuffer: string[] | null = null

function appendRuntimeConsoleLogLine(line: string): void {
  let buf = consoleLogsRuntimeBuffer
  if (!buf) {
    buf = []
    consoleLogsRuntimeBuffer = buf
  }
  buf.push(line)
  if (buf.length > 1000) buf.splice(0, 500)
  // Async batched write — runtime-log-writer handles mkdir on first call
  // and queues subsequent lines so this never blocks the event loop.
  // Previously this did mkdirSync + appendFileSync per line, which on
  // Windows with Defender added 5–30ms of sync I/O per console.log and
  // made /health unresponsive during boot.
  scheduleLogWrite(previewConsoleLogPath(WORKSPACE_DIR), `${line}\n`)
}

function clearRuntimeConsoleLogBuffer(): void {
  if (consoleLogsRuntimeBuffer) consoleLogsRuntimeBuffer.length = 0
}

function getConsoleLogsBuffer(): string[] {
  if (!consoleLogsRuntimeBuffer) consoleLogsRuntimeBuffer = []
  return consoleLogsRuntimeBuffer
}

/**
 * Mirror of `/console-log/append`'s body: write to the disk log + in-memory
 * buffer, then fan out to any SSE subscribers. Exposed in-process so
 * PreviewManager can forward Metro/Expo output without going over HTTP
 * to itself (which would also bypass `logStreamListeners`).
 *
 * Defined here rather than next to the route handler so it's hoisted
 * above `getPreviewManager()` — `logStreamListeners` is declared further
 * down the file, but TDZ doesn't apply to top-level `let` references
 * inside a function called only at runtime.
 */
function recordConsoleLogLine(line: string, stream: 'stdout' | 'stderr'): void {
  if (!line) return
  appendRuntimeConsoleLogLine(line)
  for (const listener of logStreamListeners) {
    try { listener(line) } catch {}
  }
  // Fan out to the typed dispatcher used by the new `/agent/runtime-logs`
  // endpoints. Existing `/console-log` + `/agent/logs/stream` callers see
  // no change in semantics; the dispatcher is purely additive.
  recordConsoleEntry(line, stream)
}

function getPreviewManager(): PreviewManager {
  if (!previewManager) {
    previewManager = new PreviewManager({
      // Pass the workspace root, not the legacy `project/` subdir. The
      // PreviewManager derives the bundler cwd from this — see
      // `resolveBundlerCwd()`. For Vite stacks that resolves to
      // `<workspace>/project/`; for Expo it resolves to `<workspace>/`.
      workspaceDir: WORKSPACE_DIR,
      runtimePort: parseInt(process.env.PORT || '8080', 10),
      // In k8s, the API sets PUBLIC_PREVIEW_URL to the externally-reachable
      // preview subdomain (preview--{id}.{env}.shogo.ai). Locally it's unset
      // and PreviewManager falls back to http://localhost:${runtimePort}/.
      publicUrl: process.env.PUBLIC_PREVIEW_URL,
      onConsoleLogReset: clearRuntimeConsoleLogBuffer,
      onLogLine: recordConsoleLogLine,
    })
  }
  return previewManager
}

// ---------------------------------------------------------------------------
// Workspace per-project PreviewManager registry (workspace runtime only)
//
// A workspace runtime serves N attached projects under one HTTP port,
// multiplexed by the `/p/<projectId>/…` path prefix. Each project gets its
// own PreviewManager rooted at its subfolder, with:
//   - a distinct API sidecar port (so the N `server.tsx` sidecars coexist)
//   - a vite `--base=/p/<projectId>/` so built asset URLs resolve under the
//     project's prefix instead of the shared runtime root
//   - its externally-reachable preview URL from `WORKSPACE_PREVIEW_URLS`
//     (cloud) or undefined (local → path-prefixed localhost fallback)
// ---------------------------------------------------------------------------

const workspacePreviewManagers = new Map<string, PreviewManager>()

/**
 * Deterministic per-project sidecar port: `WORKSPACE_API_PORT_BASE` (default
 * 3101) offset by the project's index in the attached list. Stable across a
 * runtime's lifetime so restarts reuse the same port.
 */
function workspaceProjectApiPort(projectId: string): number {
  const base = parseInt(process.env.WORKSPACE_API_PORT_BASE || '3101', 10)
  const idx = WORKSPACE_RUNTIME_PROJECT_IDS.indexOf(projectId)
  // A project that isn't a known member has no deterministic port slot.
  // Returning `base + 0` would alias it onto the FIRST member's sidecar
  // (port collision → two server.tsx processes fighting over one port), so
  // fail loudly instead. Callers only reach here via getWorkspacePreviewManager,
  // which already gates on isAttachedProjectId, so this should never fire.
  if (idx < 0) {
    throw new Error(
      `[agent-runtime] workspaceProjectApiPort: ${projectId} is not an attached workspace project`,
    )
  }
  return base + idx
}

/**
 * Lazily build (and cache) the PreviewManager for one attached project.
 * Returns null when not in workspace mode or when `projectId` is not one of
 * the runtime's attached projects (callers map that to 404 — never serve an
 * arbitrary subfolder).
 */
function getWorkspacePreviewManager(projectId: string): PreviewManager | null {
  if (!IS_WORKSPACE_RUNTIME) return null
  if (!isAttachedProjectId(projectId, WORKSPACE_RUNTIME_PROJECT_IDS)) return null
  let pm = workspacePreviewManagers.get(projectId)
  if (!pm) {
    const previewUrls = parseWorkspacePreviewUrls()
    pm = new PreviewManager({
      workspaceDir: join(WORKSPACE_DIR, projectId),
      runtimePort: PORT,
      publicUrl: previewUrls[projectId],
      apiPort: workspaceProjectApiPort(projectId),
      basePath: buildWorkspacePreviewPath(projectId),
      projectId,
      onConsoleLogReset: clearRuntimeConsoleLogBuffer,
      onLogLine: recordConsoleLogLine,
    })
    workspacePreviewManagers.set(projectId, pm)
  }
  return pm
}

// ---------------------------------------------------------------------------
// Canvas File Watcher (canvas v2 mode — lazy init)
// ---------------------------------------------------------------------------

let _canvasFileWatcher: any = null
function getCanvasFileWatcher(): any {
  if (!_canvasFileWatcher) {
    const { CanvasFileWatcher } = require('./canvas-file-watcher')
    _canvasFileWatcher = CanvasFileWatcher.getInstance(WORKSPACE_DIR)
  }
  return _canvasFileWatcher
}

app.get('/preview/status', (c) => {
  const pm = getPreviewManager()
  return c.json(pm.getStatus())
})

app.post('/preview/restart', async (c) => {
  const pm = getPreviewManager()
  const result = await pm.restart()
  return c.json(result)
})

app.post('/preview/start', async (c) => {
  const pm = getPreviewManager()
  const result = await pm.start()
  return c.json(result)
})

app.post('/preview/stop', (c) => {
  const pm = getPreviewManager()
  pm.stop()
  return c.json({ ok: true })
})

// Host-side workspace hydration (metal cold-start only).
//
// On bare metal the guest holds NO S3 credentials (a compromised guest must
// never reach the shared workspace bucket). Instead the trusted metal-agent
// fetches this project's durable source backup (`{projectId}/project-src.tar.gz`)
// host-side and streams the gzipped tar to this control endpoint on a cold
// miss (fresh warm-VM assign with no snapshot to resume). We extract it over
// the template that the warm pool booted with and rebuild so the served
// preview reflects the real app instead of the "Project Ready" placeholder.
//
// Auth: this lives under the `/pool` prefix, so once the VM is assigned it
// requires the runtime token — the agent authenticates with the same
// RUNTIME_AUTH_SECRET it injected via `/pool/assign`. The archive is applied
// only when it actually contains project source (guards against clobbering a
// live workspace with an empty/partial upload).
app.post('/pool/hydrate', async (c) => {
  const body = await c.req.arrayBuffer()
  if (!body || body.byteLength === 0) {
    return c.json({ error: 'empty archive' }, 400)
  }
  const tmp = join('/tmp', `pool-hydrate-${Date.now()}.tar.gz`)
  try {
    writeFileSync(tmp, Buffer.from(body))
    await extractTarFastNonBlocking(tmp, WORKSPACE_DIR)
    // Rebuild so the served dist reflects the hydrated source. Fire-and-forget:
    // readiness is reported through the normal preview/gateway status.
    getPreviewManager()
      .restart()
      .catch((e: any) => console.error('[pool/hydrate] rebuild failed:', e?.message ?? e))
    console.log(`[pool/hydrate] hydrated workspace from durable backup (${body.byteLength} bytes)`)
    return c.json({ ok: true, bytes: body.byteLength })
  } catch (err: any) {
    console.error('[pool/hydrate] failed:', err?.message ?? err)
    return c.json({ error: err?.message ?? 'hydrate failed' }, 500)
  } finally {
    try {
      unlinkSync(tmp)
    } catch {}
  }
})

// Metal write-side backup (host-driven). On stop/suspend the metal-agent calls
// this to pull the project's LATEST source, then uploads it to the durable S3
// backup ITSELF — the metal guest deliberately holds no S3 credentials. This is
// the symmetric counterpart of `/pool/hydrate`: it keeps `project-src.tar.gz`
// fresh so the project can cold-hydrate on a DIFFERENT metal machine even when
// that host has no local snapshot. Returns 204 when there's nothing to back up.
//
// Auth: under the `/pool` prefix, so it requires the runtime token — the agent
// presents the same RUNTIME_AUTH_SECRET it injected via `/pool/assign`.
app.post('/pool/export', async (c) => {
  const tmp = join('/tmp', `pool-export-${Date.now()}.tar.gz`)
  try {
    const sync =
      s3SyncInstance ??
      createS3SyncForProject(WORKSPACE_DIR, process.env.PROJECT_ID || '', {
        watchEnabled: false,
        syncInterval: 0,
        suppressProjectArchive: true,
      })
    if (!sync) return c.json({ error: 's3 sync unavailable' }, 500)
    const packed = await sync.packProjectArchive(tmp)
    if (!packed) return c.body(null, 204) // empty/new workspace — nothing to back up
    const bytes = readFileSync(tmp)
    console.log(`[pool/export] packed workspace source for durable backup (${bytes.length} bytes)`)
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { 'Content-Type': 'application/gzip' },
    })
  } catch (err: any) {
    console.error('[pool/export] failed:', err?.message ?? err)
    return c.json({ error: err?.message ?? 'export failed' }, 500)
  } finally {
    try {
      unlinkSync(tmp)
    } catch {}
  }
})

// Alias for `/preview/restart`. The code-agent prompt and older SDK/template
// scripts call `/preview/rebuild`; without this they hit the SPA catch-all
// and 404. Keep it a thin alias so existing callers just work.
app.post('/preview/rebuild', async (c) => {
  const pm = getPreviewManager()
  const result = await pm.restart()
  return c.json(result)
})

// Watcher pause/resume — used by `shogo push` to run prisma generate + db
// push without racing the schema watcher's own restart (avoids EADDRINUSE).
app.post('/preview/watch/pause', (c) => {
  const pm = getPreviewManager()
  pm.pauseWatchers()
  return c.json({ ok: true, paused: true })
})

app.post('/preview/watch/resume', (c) => {
  const pm = getPreviewManager()
  pm.resumeWatchers()
  return c.json({ ok: true, paused: false })
})

/**
 * Metro / Expo device-preview metadata.
 *
 * The runtime never proxies raw Metro traffic. In **local mode** the
 * runtime spawns `expo start --tunnel` and Expo's own tunnel server hands
 * the phone a public `exp://...exp.direct/...` URL — Studio just renders
 * that as a QR. In **cloud mode** we don't run Metro at all; this
 * endpoint returns `deviceMode: 'cloud-todo'` so Studio can render an
 * "on-device preview not yet available in cloud" hint.
 *
 * Returned shape (see PreviewManager.getDevicePreview):
 *   - devServer:   'metro' | 'vite' | 'none'
 *   - deviceMode:  'cloud-todo' | 'local-tunnel' | 'not-applicable'
 *   - metroUrl:    `exp://...` URL the phone scans (local-tunnel only)
 *   - publicUrl:   alias of metroUrl, kept for older Studio clients
 *   - message:     human-readable status / nudge
 *   - docs:        optional doc URL for the cloud-todo case
 */
// ──────────────────────────────────────────────────────────────────────
// External preview URL detection (folder-linked / external projects)
//
// We sniff PTY stdout for the standard `Local: http://localhost:PORT`
// banners emitted by Vite, Next, Vue, Rails, Django, etc. The actual
// detection lives in `detected-urls.ts` and is fed from
// `PtySessionManager.create()` — these routes just surface the state
// to the desktop UI so the external-preview tab can offer a one-click
// "Open this URL" affordance.
// ──────────────────────────────────────────────────────────────────────

app.get('/preview/detected-urls', (c) => {
  const { listAllDetections, getMostRecentDetection } = require('./detected-urls') as typeof import('./detected-urls')
  return c.json({
    detections: listAllDetections(),
    mostRecent: getMostRecentDetection(),
  })
})

app.get('/preview/detected-urls/stream', (c) => {
  const { listAllDetections, getMostRecentDetection, onDetectedUrl } =
    require('./detected-urls') as typeof import('./detected-urls')

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {}
      }
      send('snapshot', {
        detections: listAllDetections(),
        mostRecent: getMostRecentDetection(),
      })
      const unsubscribe = onDetectedUrl((detection) => {
        send('detected', detection)
      })
      c.req.raw.signal.addEventListener('abort', () => {
        unsubscribe()
        try { controller.close() } catch {}
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  })
})

app.get('/preview/metro', (c) => {
  const pm = getPreviewManager()
  return c.json(pm.getDevicePreview())
})

// ---------------------------------------------------------------------------
// Template Copy (app mode — extract pre-built archive into project/)
// ---------------------------------------------------------------------------

import { execSync } from 'child_process'

const TEMPLATES_DIR = resolve(MONOREPO_ROOT, 'packages/sdk/templates')
const EXAMPLES_DIR = resolve(MONOREPO_ROOT, 'packages/sdk/examples')

app.post('/templates/copy', async (c) => {
  try {
    const body = await c.req.json() as { template: string; name: string; theme?: string }
    if (!body.template || !body.name) {
      return c.json({ ok: false, error: 'Missing required fields: template, name' }, 400)
    }

    const projectDir = join(WORKSPACE_DIR, 'project')
    mkdirSync(projectDir, { recursive: true })

    for (const d of ['src', 'prisma', '.tanstack']) {
      const p = join(projectDir, d)
      if (existsSync(p)) rmSync(p, { recursive: true, force: true })
    }

    const archivePath = join(TEMPLATES_DIR, `${body.template}.tar.gz`)
    const examplesPath = join(EXAMPLES_DIR, body.template)

    if (existsSync(archivePath)) {
      execSync(`tar -xzf "${archivePath}" --strip-components=1 -C "${projectDir}"`, {
        stdio: 'pipe',
        timeout: 120_000,
      })
      console.log(`[templates/copy] Extracted "${body.template}" from archive to ${projectDir}`)
    } else if (existsSync(examplesPath)) {
      cpSync(examplesPath, projectDir, {
        recursive: true,
        filter: (src) => !src.includes('node_modules') && !src.includes('.git') && !src.includes('template.json'),
      })
      console.log(`[templates/copy] Copied "${body.template}" from examples to ${projectDir}`)
    } else {
      return c.json({ ok: false, error: `Template "${body.template}" not found in archives or examples` }, 404)
    }

    // Persist app template name so the agent knows what was created
    writeFileSync(join(WORKSPACE_DIR, '.app-template'), body.template, 'utf-8')

    const pkgPath = join(projectDir, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      pkg.name = body.name
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
    }

    const envPath = join(projectDir, '.env')
    const envLines = existsSync(envPath) ? readFileSync(envPath, 'utf-8').split('\n') : []
    const filtered = envLines.filter(l => !l.trim().startsWith('DATABASE_URL'))
    const devDbPath = join(projectDir, 'prisma', 'dev.db')
    writeFileSync(envPath, [...filtered, `DATABASE_URL="file:${devDbPath}"`, ''].join('\n'), 'utf-8')

    console.log(`[templates/copy] Prisma schema left as-is (Prisma 7.x adapter mode)`)

    // Rewrite db.tsx to use @prisma/adapter-libsql for SQLite
    // (templates ship with PrismaPg adapter but run on SQLite in the runtime)
    const dbTsxPath = join(projectDir, 'src', 'lib', 'db.tsx')
    if (existsSync(dbTsxPath)) {
      const SQLITE_DB_TSX = `import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from '../generated/prisma/client'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined }

const adapter = new PrismaLibSql({ url: process.env.DATABASE_URL ?? 'file:./prisma/dev.db' })

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
`
      writeFileSync(dbTsxPath, SQLITE_DB_TSX, 'utf-8')
      console.log(`[templates/copy] Rewrote db.tsx for SQLite with libsql adapter`)
    }

    const pm = getPreviewManager()
    const result = await pm.restart()
    console.log(`[templates/copy] Preview restart result:`, JSON.stringify(result))

    return c.json({ ok: true, message: `Template "${body.template}" extracted and preview restarted` })
  } catch (error: any) {
    console.error(`[templates/copy] Error:`, error)
    return c.json({ ok: false, error: error.message || 'Failed to copy template' }, 500)
  }
})

// ---------------------------------------------------------------------------
// Webhook Ingress Endpoints
// ---------------------------------------------------------------------------

const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN

function verifyWebhookAuth(c: any): boolean {
  if (!WEBHOOK_TOKEN) {
    console.warn('[agent-runtime] WEBHOOK_TOKEN not set — rejecting webhook request (fail-closed)')
    return false
  }
  const auth = c.req.header('authorization') || ''
  const token = c.req.header('x-webhook-token') || ''
  return auth === `Bearer ${WEBHOOK_TOKEN}` || token === WEBHOOK_TOKEN
}

/**
 * POST /internal/refresh-trust
 *
 * Fired by the API after writing a new `trustLevel` to Postgres (see
 * `apps/api/src/routes/local-projects.ts` POST /:id/trust). Tells the
 * runtime "go re-read trust from the DB now" instead of waiting for
 * the next chat turn's per-turn refresh. Without this, a user who
 * clicks "Trust folder" mid-stream would still hit `restricted_mode_*`
 * on the in-flight tool calls.
 *
 * Auth: shared WEBHOOK_TOKEN — the same secret the API ↔ runtime
 * webhook channel already uses (`/agent/hooks/*`).
 */
app.post('/internal/refresh-trust', async (c) => {
  if (!verifyWebhookAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  await refreshTrust()
  return c.json({ ok: true })
})

app.post('/agent/hooks/wake', async (c) => {
  if (!verifyWebhookAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const body = await c.req.json()
  const text = body.text as string
  const mode = (body.mode as string) || 'now'

  if (!text || typeof text !== 'string') {
    return c.json({ error: 'text (string) is required' }, 400)
  }

  if (mode === 'next-heartbeat') {
    agentGateway.queuePendingEvent(text)
    return c.json({ ok: true, mode: 'next-heartbeat', queued: true })
  }

  try {
    const result = await agentGateway.triggerHeartbeat()
    return c.json({ ok: true, mode: 'now', result: result.substring(0, 500) })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

app.post('/agent/hooks/agent', async (c) => {
  if (!verifyWebhookAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const body = await c.req.json()
  const message = body.message as string
  const deliver = body.deliver !== false
  const channel = body.channel as string | undefined
  const to = body.to as string | undefined

  if (!message || typeof message !== 'string') {
    return c.json({ error: 'message (string) is required' }, 400)
  }

  // Run asynchronously — return 202 immediately
  const runAsync = async () => {
    try {
      const response = await agentGateway!.processWebhookMessage(message)
      if (deliver && channel && to) {
        const status = agentGateway!.getStatus()
        const connected = status.channels.find((ch: any) => ch.type === channel && ch.connected)
        if (connected) {
          // Deliver through the gateway's test message path for now
          console.log(`[agent-runtime] Webhook: delivering to ${channel}:${to}`)
        }
      }
      console.log('[agent-runtime] Webhook agent turn complete:', response.substring(0, 200))
    } catch (error: any) {
      console.error('[agent-runtime] Webhook agent error:', error.message)
    }
  }

  runAsync()
  return c.json({ status: 'accepted' }, 202)
})

// Prompt override — used by DSPy optimization to inject candidate prompts at runtime
app.post('/agent/prompt-override', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }
  const overrides = await c.req.json() as Record<string, string>
  agentGateway.setPromptOverrides(overrides)
  return c.json({ ok: true, keys: Object.keys(overrides) })
})

app.delete('/agent/prompt-override', (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }
  agentGateway.setPromptOverrides({})
  return c.json({ ok: true, cleared: true })
})

// Session reset — used by eval runner to clear conversation history between tests
app.post('/agent/session/reset', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }
  const body = await c.req.json().catch(() => ({})) as { evalLabel?: string }
  const sm = agentGateway.getSessionManager()
  sm.clearHistory('chat')
  agentGateway.reloadConfig()
  agentGateway.setActiveMode('canvas')
  agentGateway.setEvalLabel(body.evalLabel ?? null)
  agentGateway.reconnectIndex()
  await agentGateway.getMCPClientManager().stopAll()
  return c.json({ ok: true })
})

// Tool mocks — used by eval runner to install deterministic tool responses
app.post('/agent/tool-mocks', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }
  const raw = await c.req.json()
  const { compileInstallBody } = await import('./evals/tool-mocks-runtime')
  const compiled = compileInstallBody(raw)
  agentGateway.setToolMocks(compiled.fns, compiled.syntheticDefs, compiled.hiddenTools)
  return c.json({ ok: true, mockedTools: Object.keys(compiled.fns), defaults: compiled.defaults })
})

app.delete('/agent/tool-mocks', (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }
  agentGateway.clearToolMocks()
  return c.json({ ok: true })
})

app.post('/agent/workspace/seed', async (c) => {
  const body = await c.req.json<{ files: Record<string, string> }>()
  if (!body?.files || typeof body.files !== 'object') {
    return c.json({ error: 'Expected { files: { [path]: content } }' }, 400)
  }
  let written = 0
  for (const [relPath, content] of Object.entries(body.files)) {
    const absPath = join(WORKSPACE_DIR, relPath)
    mkdirSync(dirname(absPath), { recursive: true })
    writeFileSync(absPath, content, 'utf-8')
    written++
  }
  return c.json({ ok: true, written })
})

// Destructive: wipe project source files and re-seed a fresh tech stack
// starter. Triggered by the Capabilities panel after the user explicitly
// confirms switching stacks (e.g. react-app → expo-three).
//
// Preserves agent identity (`.shogo/`), persistent memory, git history, and
// canvas state — see `WIPE_PRESERVE_TOP_LEVEL` in workspace-defaults.ts.
//
// Sequence: stop preview → wipe non-allowlisted files → seedTechStack →
// re-seed Vite runtime template if the new stack is Vite-based → restart
// preview so the new starter is built and served immediately.
app.post('/agent/workspace/reset-stack', async (c) => {
  let body: { stackId?: string } = {}
  try {
    body = await c.req.json<{ stackId?: string }>()
  } catch {
    return c.json({ error: 'Expected JSON body { stackId }' }, 400)
  }
  const stackId = body.stackId?.trim()
  if (!stackId) return c.json({ error: 'stackId is required' }, 400)

  // Verify the stack exists *before* we wipe anything — a typo on the client
  // shouldn't take the workspace down.
  if (!getTechStackPath(stackId)) {
    return c.json({ error: `Unknown tech stack: ${stackId}` }, 404)
  }

  console.log(`[reset-stack] Resetting workspace to "${stackId}"`)

  try {
    getPreviewManager().stop()
  } catch (err: any) {
    console.warn(`[reset-stack] Preview stop failed (continuing): ${err?.message ?? err}`)
  }

  const removed = wipeProjectFiles(WORKSPACE_DIR)

  const seeded = seedTechStack(WORKSPACE_DIR, stackId)
  if (!seeded) {
    return c.json({ error: `Failed to seed tech stack ${stackId}` }, 500)
  }

  // Vite-based stacks share the bundled runtime-template (vite + react +
  // tailwind + shadcn/ui). Mirrors the boot-time logic in `ensureWorkspaceFiles`.
  const viteStacks = new Set(['react-app', 'threejs-game', 'phaser-game'])
  if (viteStacks.has(stackId)) {
    seedRuntimeTemplate(WORKSPACE_DIR)
  }

  // Kick off a preview restart but don't block the HTTP response on it —
  // `bun install` for a fresh stack can take 30s+ and the client only needs
  // to know the wipe + seed is done so it can refresh the iframe.
  void getPreviewManager().restart().catch((err: any) => {
    console.error(`[reset-stack] Preview restart failed: ${err?.message ?? err}`)
  })

  console.log(`[reset-stack] Reset complete (stack=${stackId}, wiped=${removed} entries)`)
  return c.json({ ok: true, stackId, wiped: removed })
})

// Heartbeat trigger (called by external HeartbeatScheduler).
// ACKs immediately and runs the heartbeat asynchronously so the scheduler
// doesn't block. Reports completion back to the API when done.
app.post('/agent/heartbeat/trigger', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  // Fire-and-forget: run heartbeat asynchronously
  const projectId = state.currentProjectId!
  agentGateway.triggerHeartbeat().then(async () => {
    try {
      await reportHeartbeatComplete(projectId)
    } catch (err: any) {
      console.error('[Heartbeat] Failed to report completion:', err.message)
    }
  }).catch((err: any) => {
    console.error('[Heartbeat] Heartbeat tick failed:', err.message)
  })

  return c.json({ ok: true, async: true })
})

// Permission approval response (local mode security)
app.post('/agent/permission-response', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const engine = agentGateway.getPermissionEngine()
  if (!engine) {
    return c.json({ error: 'Permission engine not active' }, 404)
  }

  try {
    const body = await c.req.json() as {
      id: string
      decision: 'allow_once' | 'always_allow' | 'deny'
      pattern?: string
    }

    if (!body.id || !body.decision) {
      return c.json({ error: 'Missing id or decision' }, 400)
    }

    engine.handleApprovalResponse(body)
    return c.json({ ok: true })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// Workspace file read/write endpoints
app.get('/agent/files/:filename', async (c) => {
  const filename = c.req.param('filename')
  const allowedFiles = ['AGENTS.md', 'HEARTBEAT.md', 'MEMORY.md', 'TOOLS.md', 'STACK.md', 'config.json']

  if (!allowedFiles.includes(filename)) {
    return c.json({ error: `File not allowed: ${filename}` }, 400)
  }

  try {
    const filepath = join(WORKSPACE_DIR, filename)
    const content = existsSync(filepath) ? readFileSync(filepath, 'utf-8') : ''
    return c.json({ filename, content })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

app.put('/agent/files/:filename', async (c) => {
  const filename = c.req.param('filename')
  const allowedFiles = ['AGENTS.md', 'HEARTBEAT.md', 'MEMORY.md', 'TOOLS.md', 'STACK.md', 'config.json']

  if (!allowedFiles.includes(filename)) {
    return c.json({ error: `File not allowed: ${filename}` }, 400)
  }

  try {
    const { content } = await c.req.json()
    const filepath = join(WORKSPACE_DIR, filename)
    writeFileSync(filepath, content, 'utf-8')
    return c.json({ ok: true, filename })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// ---------------------------------------------------------------------------
// Workspace File Management Endpoints (files/ directory)
// ---------------------------------------------------------------------------

import { IndexEngine, createDefaultConfig } from './index-engine'

let indexEngineSingleton: IndexEngine | null = null
function getIndexEngine(): IndexEngine {
  if (!indexEngineSingleton) {
    indexEngineSingleton = new IndexEngine(createDefaultConfig(WORKSPACE_DIR))
  }
  return indexEngineSingleton
}

const FILES_DIR = join(WORKSPACE_DIR, 'files')

function resolveFilesPath(subPath: string): string | null {
  const resolved = resolve(FILES_DIR, subPath)
  if (!resolved.startsWith(resolve(FILES_DIR))) return null
  return resolved
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/markdown': '.md',
  'application/json': '.json',
  'application/xml': '.xml',
  'text/html': '.html',
  'text/css': '.css',
  'application/javascript': '.js',
  'application/typescript': '.ts',
}

function mimeToExtension(mimeType: string): string {
  return MIME_EXTENSIONS[mimeType] || `.${mimeType.split('/').pop() || 'bin'}`
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// File-tree exclusion policy (VS Code defaults) + the walker itself live in
// `./fs-tree-walker` so both this HTTP route and the Electron desktop IPC
// fast-path (`apps/desktop/src/fs-ipc.ts`) share one implementation. See the
// file-level doc-comment in `fs-tree-walker.ts` for the three-bucket policy
// and the rationale for keeping product-UX excludes client-side.

// Bundle all workspace files for project export (called by the API server in K8s mode).
// `dist/` and `build/` are intentionally NOT excluded here: shipping the built app output
// lets imports start the preview immediately without waiting for install + vite build.
// See preview-manager.ts — presence of `project/dist/index.html` marks the preview ready.
const BUNDLE_EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.cache', '.next', '.turbo', '.expo',
])
const BUNDLE_MAX_FILE_SIZE = 10 * 1024 * 1024

// Per-machine state that must NOT round-trip through a bundle. Mirrors
// `EXCLUDED_RELATIVE_PATHS` in apps/api/src/routes/project-export-import.ts;
// keep these two lists in sync.
//
//   .shogo/install-marker — sha256(package.json) at last successful
//     `bun install` on the EXPORTING machine. Restoring it on a fresh
//     pod tricks `ensureWorkspaceDeps` and PreviewManager into thinking
//     deps are installed against the imported package.json — even
//     though the on-disk node_modules is whatever the warm pod was
//     pre-seeded with. Surfaced as the 2026-05-12 imported-Expo
//     "kind of works but never rebuilds" report.
const BUNDLE_EXCLUDED_RELATIVE_PATHS = new Set<string>([
  '.shogo/install-marker',
])

function collectBundleFiles(dir: string, baseDir: string): Record<string, string> {
  const files: Record<string, string> = {}
  if (!existsSync(dir)) return files

  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (BUNDLE_EXCLUDED_DIRS.has(entry.name)) continue
    if (entry.name.startsWith('.install-ok')) continue
    // macOS detritus: `._*` AppleDouble sidecars crash Metro's Babel parser
    // when an imported workspace contains them, so they must never round-trip.
    if (isMacOSJunkName(entry.name)) continue

    const fullPath = join(dir, entry.name)
    const relPath = require('path').relative(baseDir, fullPath).replace(/\\/g, '/')

    if (entry.isDirectory()) {
      Object.assign(files, collectBundleFiles(fullPath, baseDir))
    } else if (entry.isFile()) {
      if (BUNDLE_EXCLUDED_RELATIVE_PATHS.has(relPath)) continue
      try {
        const stat = statSync(fullPath)
        if (stat.size > BUNDLE_MAX_FILE_SIZE) continue
        const buf = readFileSync(fullPath)
        files[relPath] = Buffer.from(buf).toString('base64')
      } catch {
        // skip unreadable files
      }
    }
  }
  return files
}

app.get('/agent/workspace/bundle', (c) => {
  const files = collectBundleFiles(WORKSPACE_DIR, WORKSPACE_DIR)
  return c.json({ files })
})

function resolveWorkspacePath(subPath: string): string | null {
  const resolved = resolve(WORKSPACE_DIR, subPath)
  if (!resolved.startsWith(resolve(WORKSPACE_DIR))) return null
  return resolved
}

// Recursive file tree for the file browser UI.
//
// Without `?path=`, walks from the workspace root. With `?path=<rel>`, walks
// just that subtree — used by the IDE to lazy-load `node_modules/`, `dist/`,
// and friends only when the user expands them. The same three exclusion sets
// apply at every depth, so a `node_modules/foo/node_modules` nested dep still
// comes back as a `lazy: true` entry rather than recursing.
app.get('/agent/workspace/tree', async (c) => {
  const subPath = c.req.query('path') ?? ''
  const rootResolved = resolve(WORKSPACE_DIR)
  let startDir = WORKSPACE_DIR
  if (subPath) {
    const resolved = resolveWorkspacePath(subPath)
    if (!resolved) return c.json({ error: 'Path outside workspace' }, 400)
    if (!existsSync(resolved)) return c.json({ error: 'Path not found' }, 404)
    if (!statSync(resolved).isDirectory()) {
      return c.json({ error: 'Path is not a directory' }, 400)
    }
    startDir = resolved
  }
  // `eagerDepth: 1` keeps first-paint cheap on big repos — the walker
  // returns the requested dir's children plus one level of descent, with
  // anything deeper marked `lazy: true`. The IDE fetches deeper subtrees
  // on demand by hitting this same route with `?path=…`, which is exactly
  // how lazy expansion already works for `node_modules` etc. See
  // `apps/mobile/components/project/panels/ide/workspace/desktopFs.ts`
  // and `sdkFs.ts` for the IDE-side handling.
  // `signal: c.req.raw.signal` wires Hono's per-request abort straight
  // into the walker. If the IDE navigates away mid-walk (close folder,
  // panel-resize re-render, ⌘W during cold open) the underlying Fetch
  // Request's signal fires, the walker's `withinBudget` flips on its
  // next iteration, and we stop reading directories. Pre-2026-05-25 the
  // walk ran to completion regardless and the client discarded the
  // result, which on a 95k repo wasted ~3s of fs handles + event-loop
  // budget per superseded request.
  const tree = await walkFilesTree(startDir, rootResolved, {
    hiddenDirs: WORKSPACE_TREE_HIDDEN_DIRS,
    lazyDirs: WORKSPACE_TREE_LAZY_DIRS,
    hiddenFiles: WORKSPACE_TREE_HIDDEN_FILES,
    eagerDepth: 1,
    signal: c.req.raw.signal,
  })
  return c.json({ tree })
})

// `isBinaryFilePath` / `BINARY_FILE_EXTENSIONS` are the canonical "should
// this file be wire-encoded as base64?" predicate, imported above from
// `@shogo/shared-runtime` (which re-exports `@shogo-ai/core/file-types`).
// One source of truth across agent-runtime, IDE Workbench, live-edit
// sync, and the local FS layer.

// Read a file from the workspace. Text files come back as `content`
// (utf-8 string); binary files come back as `contentBase64` (base64-
// encoded raw bytes) — see `isBinaryFilePath` (canonical extension list
// in `@shogo-ai/core/file-types`). Callers must branch on the `encoding`
// field; the SDK's `readFile()` does this for you and throws if asked to
// text-read a binary file.
app.get('/agent/workspace/files/*', (c) => {
  const subPath = c.req.path.replace('/agent/workspace/files/', '')
  if (!subPath) return c.json({ error: 'Path required' }, 400)

  const resolved = resolveWorkspacePath(subPath)
  if (!resolved) return c.json({ error: 'Path outside workspace' }, 400)

  let target = resolved
  if (!existsSync(resolved)) {
    const fallback = resolveFilesPath(subPath)
    if (!fallback || !existsSync(fallback)) {
      return c.json({ error: 'File not found' }, 404)
    }
    target = fallback
  }

  if (isBinaryFilePath(target)) {
    const buf = readFileSync(target)
    return c.json({
      path: subPath,
      contentBase64: buf.toString('base64'),
      encoding: 'base64',
      bytes: buf.length,
    })
  }

  const content = readFileSync(target, 'utf-8')
  return c.json({ path: subPath, content, encoding: 'utf-8', bytes: content.length })
})

// Write/create a file in the workspace. Accepts either:
//   { content: "<utf-8 string>" }                — text files
//   { contentBase64: "<base64-encoded bytes>" } — binary files
//
// To prevent the read-as-utf-8 / write-as-utf-8 corruption round-trip
// that previously bloated `.mp4` / `.zip` / etc. by ~2×, this endpoint
// refuses to accept utf-8 `content` for any path that `isBinaryFilePath`
// flags (see `@shogo-ai/core/file-types` for the canonical extension
// list) — callers MUST send `contentBase64` for those. The SDK's
// `writeFile()` covers this seamlessly for SDK users; raw HTTP callers
// get a 400 with an explicit error.
app.put('/agent/workspace/files/*', async (c) => {
  const subPath = c.req.path.replace('/agent/workspace/files/', '')
  if (!subPath) return c.json({ error: 'Path required' }, 400)

  const resolved = resolveWorkspacePath(subPath)
  if (!resolved) return c.json({ error: 'Path outside workspace' }, 400)

  const body = (await c.req.json()) as { content?: unknown; contentBase64?: unknown }
  const dir = dirname(resolved)
  mkdirSync(dir, { recursive: true })

  if (typeof body.contentBase64 === 'string') {
    let buf: Buffer
    try {
      buf = Buffer.from(body.contentBase64, 'base64')
    } catch {
      return c.json({ error: 'Invalid base64 in contentBase64' }, 400)
    }
    writeFileSync(resolved, buf)
    return c.json({
      ok: true,
      path: subPath,
      bytes: buf.length,
      encoding: 'base64',
    })
  }

  if (typeof body.content !== 'string') {
    return c.json(
      { error: 'Missing content (utf-8 string) or contentBase64' },
      400,
    )
  }

  if (isBinaryFilePath(resolved)) {
    return c.json(
      {
        error:
          'Refusing to write a binary file path with utf-8 string content — use contentBase64 to avoid corruption',
        path: subPath,
      },
      400,
    )
  }

  writeFileSync(resolved, body.content, 'utf-8')
  return c.json({
    ok: true,
    path: subPath,
    bytes: body.content.length,
    encoding: 'utf-8',
  })
})

// Delete a file from the workspace
app.delete('/agent/workspace/files/*', (c) => {
  const subPath = c.req.path.replace('/agent/workspace/files/', '')
  if (!subPath) return c.json({ error: 'Path required' }, 400)

  const resolved = resolveWorkspacePath(subPath)
  if (!resolved) return c.json({ error: 'Path outside workspace' }, 400)
  if (!existsSync(resolved)) return c.json({ error: 'File not found' }, 404)

  unlinkSync(resolved)
  return c.json({ ok: true, deleted: subPath })
})

// Create a directory
app.post('/agent/workspace/mkdir', async (c) => {
  const { path: dirPath } = await c.req.json() as { path: string }
  if (!dirPath) return c.json({ error: 'Path required' }, 400)

  const resolved = resolveFilesPath(dirPath)
  if (!resolved) return c.json({ error: 'Path outside files directory' }, 400)

  mkdirSync(resolved, { recursive: true })
  return c.json({ ok: true, path: dirPath })
})

// Upload files (multipart/form-data)
app.post('/agent/workspace/upload', async (c) => {
  try {
    const formData = await c.req.formData()
    const targetDir = (formData.get('directory') as string) || ''
    const uploaded: string[] = []

    for (const [key, value] of formData.entries()) {
      if (key === 'directory') continue
      if (typeof value === 'string') continue
      const file = value as unknown as { name: string; arrayBuffer(): Promise<ArrayBuffer> }

      const fileName = file.name
      const filePath = targetDir ? `${targetDir}/${fileName}` : fileName
      const resolved = resolveFilesPath(filePath)
      if (!resolved) continue

      const dir = dirname(resolved)
      mkdirSync(dir, { recursive: true })

      const buffer = await file.arrayBuffer()
      writeFileSync(resolved, Buffer.from(buffer))
      uploaded.push(filePath)
    }

    return c.json({ ok: true, uploaded, count: uploaded.length })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// Download a file
const DOWNLOAD_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
}

app.get('/agent/workspace/download/*', (c) => {
  const subPath = c.req.path.replace('/agent/workspace/download/', '')
  if (!subPath) return c.json({ error: 'Path required' }, 400)

  let resolved = resolveWorkspacePath(subPath)
  if (!resolved) return c.json({ error: 'Path outside workspace' }, 400)

  if (!existsSync(resolved)) {
    const fallback = resolveFilesPath(subPath)
    if (fallback && existsSync(fallback)) {
      resolved = fallback
    } else {
      return c.json({ error: 'File not found' }, 404)
    }
  }

  const content = readFileSync(resolved)
  const fileName = subPath.split('/').pop() || 'download'
  const ext = extname(fileName).toLowerCase()
  const contentType = DOWNLOAD_MIME_TYPES[ext] || 'application/octet-stream'
  const isInline = contentType.startsWith('image/') || contentType === 'application/pdf'

  return new Response(content, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `${isInline ? 'inline' : 'attachment'}; filename="${fileName}"`,
      'Content-Length': String(content.length),
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Allow-Origin': '*',
    },
  })
})

// Search files via RAG engine
app.post('/agent/workspace/search', async (c) => {
  try {
    const { query, limit = 10, path_filter } = await c.req.json() as {
      query: string; limit?: number; path_filter?: string
    }
    if (!query) return c.json({ error: 'Query required' }, 400)

    const engine = getIndexEngine()
    const results = await engine.search(query, { source: 'files', limit, pathFilter: path_filter })
    return c.json({
      query,
      results: results.map(r => ({
        path: r.path,
        chunk: r.chunk,
        score: Math.round(r.score * 1000) / 1000,
        lines: `${r.lineStart}-${r.lineEnd}`,
        matchType: r.matchType,
      })),
      count: results.length,
      stats: engine.getStats('files'),
    })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// Re-index files (manual trigger)
app.post('/agent/workspace/reindex', async (c) => {
  try {
    const engine = getIndexEngine()
    const stats = await engine.reindex('files')
    return c.json({ ok: true, ...stats })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// Tool catalog and search — powers the "Tools" tab in the web UI
import { MCP_CATALOG, MCP_CATEGORIES, isMcpServerAllowed, getPreinstalledPackages } from './mcp-catalog'
import { isComposioEnabled, findComposioToolkit, initComposioSession, registerToolkitProxyTools } from './composio'

app.get('/agent/mcp-catalog', (c) => {
  return c.json({ catalog: MCP_CATALOG, categories: MCP_CATEGORIES })
})

app.get('/agent/bundled-skills', (c) => {
  const { loadBundledSkills } = require('./skills')
  const bundled = loadBundledSkills(new Set())
  return c.json({
    skills: bundled.map((s: any) => ({
      name: s.name,
      version: s.version || '',
      description: s.description,
      trigger: s.trigger || '',
      tools: s.tools || [],
      content: s.content,
    })),
  })
})

app.post('/agent/bundled-skills/install', async (c) => {
  const { name } = await c.req.json() as { name: string }
  const { loadBundledSkills } = require('./skills')
  const bundled = loadBundledSkills(new Set())
  const skill = bundled.find((s: any) => s.name === name)

  if (!skill) {
    return c.json({ error: `Bundled skill "${name}" not found` }, 404)
  }

  const destDir = join(WORKSPACE_DIR, '.shogo', 'skills', name)
  mkdirSync(destDir, { recursive: true })

  const srcDir = skill.skillDir
  const { readdirSync: rds, readFileSync: rfs, cpSync: cps } = require('fs')
  for (const entry of rds(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name)
    const destPath = join(destDir, entry.name)
    if (entry.isDirectory()) {
      cps(srcPath, destPath, { recursive: true })
    } else {
      writeFileSync(destPath, rfs(srcPath))
    }
  }

  agentGateway?.reloadConfig()
  return c.json({ ok: true, installed: name })
})

app.get('/agent/skills/:name', (c) => {
  const name = c.req.param('name')
  if (!name || name.includes('/') || name.includes('..')) {
    return c.json({ error: 'Invalid skill name' }, 400)
  }

  const filePath = join(WORKSPACE_DIR, '.shogo', 'skills', name, 'SKILL.md')
  if (!existsSync(filePath)) {
    return c.json({ error: `Skill "${name}" not found` }, 404)
  }

  const raw = readFileSync(filePath, 'utf-8')
  return c.json({ name, content: raw })
})

app.delete('/agent/skills/:name', (c) => {
  const name = c.req.param('name')
  if (!name || name.includes('/') || name.includes('..')) {
    return c.json({ error: 'Invalid skill name' }, 400)
  }

  const skillDir = join(WORKSPACE_DIR, '.shogo', 'skills', name)
  if (!existsSync(skillDir)) {
    return c.json({ error: `Skill "${name}" not found` }, 404)
  }

  rmSync(skillDir, { recursive: true, force: true })
  agentGateway?.reloadConfig()
  return c.json({ ok: true, removed: name })
})

app.get('/agent/skills/:name/scripts', (c) => {
  const name = c.req.param('name')
  if (!name || name.includes('/') || name.includes('..')) {
    return c.json({ error: 'Invalid skill name' }, 400)
  }

  const scriptsDir = join(WORKSPACE_DIR, '.shogo', 'skills', name, 'scripts')
  if (!existsSync(scriptsDir)) {
    return c.json({ scripts: [] })
  }

  const { statSync: ss } = require('fs')
  const scripts = readdirSync(scriptsDir)
    .filter((f: string) => !f.startsWith('.'))
    .map((f: string) => {
      const ext = f.split('.').pop()?.toLowerCase() || ''
      const runtimeMap: Record<string, string> = { py: 'python3', js: 'node', ts: 'bun', mjs: 'node', sh: 'bash' }
      return { filename: f, runtime: runtimeMap[ext] || ext, size: ss(join(scriptsDir, f)).size }
    })

  return c.json({ skill: name, scripts })
})

app.get('/agent/skills/:name/scripts/:filename', (c) => {
  const name = c.req.param('name')
  const filename = c.req.param('filename')
  if (!name || !filename || name.includes('..') || filename.includes('..') || filename.includes('/')) {
    return c.json({ error: 'Invalid parameters' }, 400)
  }

  const filePath = join(WORKSPACE_DIR, '.shogo', 'skills', name, 'scripts', filename)
  if (!existsSync(filePath)) {
    return c.json({ error: `Script "${filename}" not found` }, 404)
  }

  const content = readFileSync(filePath, 'utf-8')
  return c.json({ skill: name, filename, content })
})

// ---------------------------------------------------------------------------
// External Skill Registry
// ---------------------------------------------------------------------------

app.get('/agent/skill-registry', (c) => {
  const { loadSkillRegistryManifest } = require('./skills')
  const manifest = loadSkillRegistryManifest()
  return c.json({ skills: manifest })
})

app.post('/agent/skill-registry/install', async (c) => {
  const { name, source, dirName } = await c.req.json() as {
    name: string
    source: string
    dirName: string
  }

  if (!source || !dirName) {
    return c.json({ error: 'source and dirName are required' }, 400)
  }
  if (dirName.includes('/') || dirName.includes('..') || source.includes('/') || source.includes('..')) {
    return c.json({ error: 'Invalid source or dirName' }, 400)
  }

  const { loadBundledClaudeCodeSkill } = require('./skills')
  const skill = loadBundledClaudeCodeSkill(source, dirName)
  if (!skill) {
    return c.json({ error: `Skill "${dirName}" not found in source "${source}"` }, 404)
  }

  const destDir = join(WORKSPACE_DIR, '.shogo', 'skills', skill.name)
  mkdirSync(destDir, { recursive: true })

  const srcDir = skill.skillDir
  const { readdirSync: rds, readFileSync: rfs, cpSync: cps } = require('fs')
  for (const entry of rds(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name)
    const destPath = join(destDir, entry.name)
    if (entry.isDirectory()) {
      cps(srcPath, destPath, { recursive: true })
    } else {
      writeFileSync(destPath, rfs(srcPath))
    }
  }

  agentGateway?.reloadConfig()
  return c.json({ ok: true, installed: skill.name, source })
})

// ---------------------------------------------------------------------------
// Quick Actions
// ---------------------------------------------------------------------------

app.get('/agent/quick-actions', (c) => {
  const filePath = join(WORKSPACE_DIR, '.shogo', 'quick-actions.json')
  if (!existsSync(filePath)) {
    return c.json({ actions: [] })
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    const actions = Array.isArray(raw?.actions)
      ? raw.actions.filter((a: any) => typeof a?.label === 'string' && typeof a?.prompt === 'string')
      : []
    return c.json({ actions })
  } catch {
    return c.json({ actions: [] })
  }
})

app.delete('/agent/quick-actions/:label', (c) => {
  const label = decodeURIComponent(c.req.param('label'))
  if (!label) {
    return c.json({ error: 'Label is required' }, 400)
  }

  const filePath = join(WORKSPACE_DIR, '.shogo', 'quick-actions.json')
  if (!existsSync(filePath)) {
    return c.json({ error: 'No quick actions file found' }, 404)
  }

  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    if (!Array.isArray(raw?.actions)) {
      return c.json({ error: 'Invalid quick actions file' }, 500)
    }
    const before = raw.actions.length
    raw.actions = raw.actions.filter((a: any) => a?.label !== label)
    if (raw.actions.length === before) {
      return c.json({ error: `Quick action "${label}" not found` }, 404)
    }
    writeFileSync(filePath, JSON.stringify(raw, null, 2) + '\n', 'utf-8')
    return c.json({ ok: true, removed: label })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// The legacy `/agent/templates` and `/agent/templates/:id` routes were
// removed in the templates → marketplace consolidation. The mobile app
// reads first-party agents from the API's `/api/marketplace` instead.

app.post('/agent/mcp-servers/toggle', async (c) => {
  const { serverId, enabled, env } = await c.req.json() as {
    serverId: string
    enabled: boolean
    env?: Record<string, string>
  }

  const entry = MCP_CATALOG.find((e) => e.id === serverId)
  if (!entry || !isMcpServerAllowed(serverId)) {
    const allowed = getPreinstalledPackages().map(e => e.id).join(', ')
    return c.json({ error: `MCP server "${serverId}" is not available. Only preinstalled servers are supported: ${allowed}` }, 400)
  }

  const configPath = join(WORKSPACE_DIR, 'config.json')
  let config: Record<string, any> = {}
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, 'utf-8'))
  }

  config.mcpServers = config.mcpServers || {}

  if (enabled) {
    const args = [entry.package, ...entry.defaultArgs]
    const mergedEnv: Record<string, string> = { ...env }

    if (entry.id === 'playwright' && process.env.SHOGO_LOCAL_MODE === 'true') {
      if (!args.includes('--extension')) {
        args.push('--extension')
      }
      const token = env?.PLAYWRIGHT_MCP_EXTENSION_TOKEN || process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN
      if (token) {
        mergedEnv.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token
      }
    }

    config.mcpServers[entry.id] = {
      command: 'npx',
      args,
      ...(Object.keys(mergedEnv).length > 0 ? { env: mergedEnv } : {}),
    }
  } else {
    delete config.mcpServers[entry.id]
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  return c.json({ ok: true, serverId, enabled, servers: config.mcpServers })
})

// ---------------------------------------------------------------------------
// Unified Tools API — powers the "Tools" tab
// ---------------------------------------------------------------------------

app.get('/agent/tools/status', (c) => {
  if (!agentGateway) {
    return c.json({ tools: [] })
  }
  const mcpMgr = agentGateway.getMcpClientManager()
  const serverInfo = mcpMgr.getServerInfo()

  const tools = serverInfo.map((s: any) => {
    const catalogEntry = MCP_CATALOG.find((e) => e.id === s.name)
    return {
      id: s.name,
      name: catalogEntry?.name || s.name,
      source: catalogEntry ? 'catalog' as const : 'custom' as const,
      status: 'running' as const,
      toolCount: s.toolCount,
      tools: s.toolNames,
    }
  })

  return c.json({ tools })
})

app.post('/agent/tools/execute', async (c) => {
  if (!agentGateway) {
    return c.json({ ok: false, error: 'Agent gateway not running' }, 503)
  }
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.tool !== 'string') {
    return c.json({ ok: false, error: 'Missing required field: tool (string)' }, 400)
  }
  const { tool, args } = body as { tool: string; args?: Record<string, any> }
  const mcpMgr = agentGateway.getMcpClientManager()
  const result = await mcpMgr.callTool(tool, args || {})
  return c.json(result, result.ok ? 200 : 404)
})

app.get('/agent/tools/schemas', (c) => {
  if (!agentGateway) {
    return c.json({ tools: [] })
  }
  const mcpMgr = agentGateway.getMcpClientManager()
  const allTools = mcpMgr.getTools()
  const schemas = allTools.map((t: any) => ({
    name: t.name,
    description: t.description || '',
    parameters: t.parameters ?? {},
  }))
  return c.json({ tools: schemas })
})

app.get('/agent/tools/search', async (c) => {
  const query = c.req.query('q') || ''
  if (!query.trim()) {
    return c.json({ results: [] })
  }

  const installedNames = new Set<string>()
  if (agentGateway) {
    for (const s of agentGateway.getMcpClientManager().getServerInfo()) {
      installedNames.add(s.name)
    }
  }

  const results: Array<Record<string, any>> = []
  const seenSlugs = new Set<string>()

  const queryLower = query.toLowerCase()
  const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2)
  const scored: Array<{ entry: typeof MCP_CATALOG[0]; score: number }> = []
  for (const entry of MCP_CATALOG) {
    const haystack = `${entry.id} ${entry.name} ${entry.description} ${entry.category} ${entry.providedTools.join(' ')}`.toLowerCase()
    const idName = `${entry.id} ${entry.name}`.toLowerCase()
    let score = 0
    if (haystack.includes(queryLower)) score += 10
    if (idName.includes(queryLower)) score += 20
    for (const w of queryWords) {
      if (idName.includes(w)) score += 5
      else if (haystack.includes(w)) score += 1
    }
    if (score > 0) scored.push({ entry, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const isLocal = process.env.SHOGO_LOCAL_MODE === 'true'
  for (const { entry } of scored.slice(0, 5)) {
    const entryNorm = entry.id.toLowerCase().replace(/[-_\s]/g, '')
    if (seenSlugs.has(entryNorm)) continue
    seenSlugs.add(entryNorm)
    results.push({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      source: 'catalog',
      installed: installedNames.has(entry.id),
      authType: Object.keys(entry.requiredEnv).length > 0 ? 'api_key' : 'none',
      requiredEnv: Object.keys(entry.requiredEnv).length > 0 ? entry.requiredEnv : undefined,
      optionalEnv: entry.optionalEnv && Object.keys(entry.optionalEnv).length > 0 ? entry.optionalEnv : undefined,
      icon: entry.icon,
      isLocalMode: isLocal,
    })
  }

  return c.json({ results })
})

app.post('/agent/tools/install', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const { id, env, extraArgs } = await c.req.json() as {
    id: string
    env?: Record<string, string>
    extraArgs?: string[]
  }

  const mcpMgr = agentGateway.getMcpClientManager()

  if (isComposioEnabled()) {
    const composioToolkit = await findComposioToolkit(id)
    if (composioToolkit) {
      try {
        const userId = c.req.header('X-User-Id') || process.env.USER_ID || 'default'
        const workspaceId = process.env.WORKSPACE_ID || 'default'
        const projectId = process.env.PROJECT_ID || 'default'
        const scopeEnv = process.env.COMPOSIO_USER_SCOPE
        const scope: 'workspace' | 'project' =
          scopeEnv === 'workspace' || scopeEnv === 'project' ? scopeEnv : 'workspace'
        await initComposioSession(userId, workspaceId, projectId, scope)
        const proxy = await registerToolkitProxyTools(mcpMgr, composioToolkit.slug)
        return c.json({
          ok: true,
          id: composioToolkit.slug.toLowerCase(),
          source: 'managed',
          toolCount: proxy.toolCount,
          tools: proxy.toolNames,
        })
      } catch (err: any) {
        return c.json({ error: `Failed to connect: ${err.message}` }, 500)
      }
    }
  }

  const catalogEntry = MCP_CATALOG.find((e) => e.id === id)
  if (!catalogEntry || !isMcpServerAllowed(id)) {
    const allowed = getPreinstalledPackages().map(e => e.id).join(', ')
    return c.json({ error: `MCP server "${id}" is not available. Only preinstalled servers are supported: ${allowed}` }, 400)
  }

  try {
    const args = [catalogEntry.package, ...catalogEntry.defaultArgs]
    const mergedEnv: Record<string, string> = { ...env }

    if (id === 'playwright' && process.env.SHOGO_LOCAL_MODE === 'true' && extraArgs?.includes('--extension')) {
      if (!args.includes('--extension')) {
        args.push('--extension')
      }
      const token = env?.PLAYWRIGHT_MCP_EXTENSION_TOKEN || process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN
      if (token) {
        mergedEnv.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token
      }
    }

    const serverCwd = id === 'playwright' ? FILES_DIR : undefined
    if (serverCwd) mkdirSync(serverCwd, { recursive: true })

    await mcpMgr.hotAddServer(id, {
      command: 'npx',
      args,
      env: Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined,
      cwd: serverCwd,
    })
    return c.json({ ok: true, id, source: 'catalog' })
  } catch (err: any) {
    return c.json({ error: `Failed to install: ${err.message}` }, 500)
  }
})

app.delete('/agent/tools/:id', async (c) => {
  if (!agentGateway) {
    return c.json({ error: 'Agent gateway not running' }, 503)
  }

  const id = c.req.param('id')
  const mcpMgr = agentGateway.getMcpClientManager()

  if (mcpMgr.hasProxyToolGroup(id)) {
    mcpMgr.removeProxyToolGroup(id)
    return c.json({ ok: true, removed: id })
  }

  if (!mcpMgr.isRunning(id)) {
    return c.json({ error: `Tool "${id}" is not running` }, 404)
  }

  try {
    await mcpMgr.hotRemoveServer(id)
    return c.json({ ok: true, removed: id })
  } catch (err: any) {
    return c.json({ error: `Failed to uninstall: ${err.message}` }, 500)
  }
})

// Agent export/import — bundle workspace into a shareable .shogo config
function collectExportDir(dir: string, prefix: string, out: Record<string, string>): void {
  if (!existsSync(dir)) return
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      collectExportDir(fullPath, relPath, out)
    } else if (entry.isFile()) {
      try {
        const stat = statSync(fullPath)
        if (stat.size > 5 * 1024 * 1024) continue
        out[relPath] = readFileSync(fullPath, 'utf-8')
      } catch { /* skip unreadable */ }
    }
  }
}

app.get('/agent/export', async (c) => {
  const exportFiles: Record<string, string> = {}
  const exportableFiles = [
    'AGENTS.md', 'HEARTBEAT.md', 'MEMORY.md', 'TOOLS.md', 'STACK.md', 'config.json',
  ]

  for (const filename of exportableFiles) {
    const filepath = join(WORKSPACE_DIR, filename)
    if (existsSync(filepath)) {
      exportFiles[filename] = readFileSync(filepath, 'utf-8')
    }
  }

  // Collect all .md files at workspace root (agent may create custom ones)
  if (existsSync(WORKSPACE_DIR)) {
    const rootEntries = readdirSync(WORKSPACE_DIR, { withFileTypes: true })
    for (const entry of rootEntries) {
      if (entry.isFile() && entry.name.endsWith('.md') && !exportFiles[entry.name]) {
        exportFiles[entry.name] = readFileSync(join(WORKSPACE_DIR, entry.name), 'utf-8')
      }
    }
  }

  collectExportDir(join(WORKSPACE_DIR, 'skills'), 'skills', exportFiles)
  collectExportDir(join(WORKSPACE_DIR, 'files'), 'files', exportFiles)
  collectExportDir(join(WORKSPACE_DIR, 'memory'), 'memory', exportFiles)
  collectExportDir(join(WORKSPACE_DIR, '.shogo', 'skills'), '.shogo/skills', exportFiles)
  collectExportDir(join(WORKSPACE_DIR, '.shogo', 'plans'), '.shogo/plans', exportFiles)

  const quickActionsPath = join(WORKSPACE_DIR, '.shogo', 'quick-actions.json')
  if (existsSync(quickActionsPath)) {
    exportFiles['.shogo/quick-actions.json'] = readFileSync(quickActionsPath, 'utf-8')
  }

  const bundle = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    projectId: process.env.PROJECT_ID || 'unknown',
    files: exportFiles,
  }

  return c.json(bundle)
})

app.post('/agent/import', async (c) => {
  const bundle = await c.req.json() as {
    version: string
    files: Record<string, string>
  }

  if (!bundle.files || typeof bundle.files !== 'object') {
    return c.json({ error: 'Invalid bundle: missing files' }, 400)
  }

  const written: string[] = []
  for (const [filename, content] of Object.entries(bundle.files)) {
    if (filename.includes('..') || filename.startsWith('/')) {
      continue
    }
    const filepath = join(WORKSPACE_DIR, filename)
    const dir = require('path').dirname(filepath)
    mkdirSync(dir, { recursive: true })
    writeFileSync(filepath, content, 'utf-8')
    written.push(filename)
  }

  return c.json({ ok: true, imported: written.length, files: written })
})

// Console log for forwarding — mirrored to .shogo/logs/console.log on disk (see runtime-log-paths.ts).
const logStreamListeners = new Set<(line: string) => void>()

app.post('/console-log/append', async (c) => {
  const { line, stream } = await c.req.json()
  if (line) recordConsoleLogLine(line, stream === 'stderr' ? 'stderr' : 'stdout')
  return c.json({ ok: true })
})

app.get('/console-log', (c) => {
  return c.json({ logs: getConsoleLogsBuffer() })
})

app.get('/agent/logs/stream', (c) => {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      const send = (text: string) => {
        try { controller.enqueue(encoder.encode(text + '\n')) } catch {}
      }

      for (const line of getConsoleLogsBuffer().slice(-100)) {
        send(line)
      }

      const listener = (line: string) => send(line)
      logStreamListeners.add(listener)

      c.req.raw.signal.addEventListener('abort', () => {
        logStreamListeners.delete(listener)
        try { controller.close() } catch {}
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
})

// ─── New typed runtime-log endpoints ───────────────────────────────────────
// These supersede the line-oriented `/console-log` + `/agent/logs/stream`
// pair for the Output tab. They emit `RuntimeLogEntry` JSON objects with
// `source` + `level` so the frontend can filter and surface unseen-error
// counts.
//
// The route bodies live in `runtime-logs-routes.ts` so they can be tested
// against a tiny Hono app without booting the full agent-gateway. The legacy
// endpoints are still wired (and forwarded to via the dispatcher) so older
// clients keep working.
app.route('/', runtimeLogsRoutes())


// =============================================================================
// API Server control (used by eval harness to force-sync before runtime checks).
//
// Legacy aliases: `/agent/skill-server/*` paths still work — both forward
// to the same handlers — so existing eval workers keep functioning during
// the rollout.
// =============================================================================

app.get('/agent/api-server/status', (c) => {
  if (!agentGateway) return c.json({ phase: 'unknown' })
  return c.json({ phase: agentGateway.getSkillServerPhase() })
})
app.get('/agent/skill-server/status', (c) => {
  if (!agentGateway) return c.json({ phase: 'unknown' })
  return c.json({ phase: agentGateway.getSkillServerPhase() })
})

app.post('/agent/api-server/sync', async (c) => {
  if (!agentGateway) return c.json({ ok: false, error: 'gateway not running' }, 503)
  try {
    const result = await agentGateway.syncSkillServer()
    return c.json(result)
  } catch (err: any) {
    return c.json({ ok: false, phase: 'crashed', error: err.message || String(err) }, 500)
  }
})
app.post('/agent/skill-server/sync', async (c) => {
  if (!agentGateway) return c.json({ ok: false, error: 'gateway not running' }, 503)
  try {
    const result = await agentGateway.syncSkillServer()
    return c.json(result)
  } catch (err: any) {
    return c.json({ ok: false, phase: 'crashed', error: err.message || String(err) }, 500)
  }
})

// =============================================================================
// Runtime checks (used by eval harness in any isolation mode — K8s pod
// or VM — where the workspace files and API server are colocated inside
// the worker. Local/Docker workers run the checks directly against the
// host's bind-mounted workspace dir instead.)
// =============================================================================

app.post('/agent/runtime-checks', async (c) => {
  const { runRuntimeChecks } = await import('./evals/runtime-checks')
  const body = await c.req.json<{ canvasExpectedPort?: number; evalId: string; verbose?: boolean; tenantProbe?: { route: string } }>()
  // Use the PreviewManager's configured port directly; `getSkillServerPort()`
  // also falls through to the same value via the shim, but reading it from
  // the manager keeps the source-of-truth obvious. Never falls back to the
  // retired skill server's 4100 — that port is unallocated post-merge.
  const skillServerPort = getPreviewManager().apiServerPort
    ?? agentGateway?.getSkillServerPort()
    ?? 3001
  try {
    const results = await runRuntimeChecks({
      workspaceDir: WORKSPACE_DIR,
      skillServerPort,
      canvasExpectedPort: body.canvasExpectedPort ?? skillServerPort,
      evalId: body.evalId,
      verbose: body.verbose,
      runtimePort: parseInt(process.env.PORT || '8080', 10),
      tenantProbe: body.tenantProbe,
    })
    return c.json({ ok: true, results })
  } catch (err: any) {
    return c.json({ ok: false, error: err.message || String(err) }, 500)
  }
})

// =============================================================================
// API Proxy — forward /api/* to the project's Hono `server.tsx`.
//
// PreviewManager owns the single API server (root `server.tsx`); the
// bound port is resolved per-instance from `API_SERVER_PORT` /
// `SKILL_SERVER_PORT` (legacy alias) / `3001` default — see
// `preview-manager.ts::resolveApiServerPort`. The legacy "skill server"
// on a separate port has been retired; see
// `migrations/skill-server-to-root.ts` for the one-shot migration of
// existing workspaces.
// =============================================================================

// Total time the proxy will wait for the project API server to come up
// before returning 503 to the SPA. Sized for "cold-start without a hot
// API server": the in-process health-check loop runs for up to
// HEALTH_CHECK_RETRIES * HEALTH_CHECK_INTERVAL_MS (~5s) on a fresh
// spawn, but most workspaces bind in well under 1s. 3s gives a healthy
// 2× margin for the common case without holding the browser hostage
// when `server.tsx` is genuinely broken — the SPA can render its
// "starting up" state from the 503 + phase payload instead.
const API_PROXY_STARTUP_WAIT_MS = 3000
const API_PROXY_POLL_INTERVAL_MS = 100

// Phases in which the proxy waits briefly for `apiServerPort` to
// transition from null → bound. Outside this set (`idle`, `healthy`,
// `crashed`, `stopped`) waiting wouldn't change the answer.
const API_PROXY_STARTUP_PHASES: ReadonlySet<string> = new Set([
  'starting', 'restarting', 'generating',
])

app.all('/api/*', async (c) => {
  const pm = getPreviewManager()

  // Short grace window for the spawn → bind gap. Without it, the SPA's
  // first `/api/*` fetch on a fresh project lands during cold-start (or
  // a custom-routes hot restart) and immediately gets a hard 5xx,
  // leaving the user staring at a blank preview until they manually
  // refresh. `apiServerPort` returning null + phase ∈ {starting,
  // restarting, generating} is exactly the "API is coming, just not
  // here yet" signal we need to soak briefly. Polling is cheap (every
  // 100 ms, total budget 3 s) and short-circuits the moment the port
  // becomes available.
  let port = pm.apiServerPort
  // Self-heal: if the sidecar crashed beyond its restart cap, an incoming API
  // request is the trigger to revive it — reset the crash budget and re-attempt
  // a single start — instead of returning 503 forever until a manual
  // /preview/restart. This flips the phase to `restarting`, so the grace-window
  // poll below can pick up the freshly bound port within this same request.
  if (port == null && pm.apiServerPhase === 'crashed') {
    pm.maybeRecoverApiServer()
  }
  if (port == null && API_PROXY_STARTUP_PHASES.has(pm.apiServerPhase)) {
    const deadline = Date.now() + API_PROXY_STARTUP_WAIT_MS
    while (port == null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, API_PROXY_POLL_INTERVAL_MS))
      if (!API_PROXY_STARTUP_PHASES.has(pm.apiServerPhase)) break
      port = pm.apiServerPort
    }
  }

  if (port == null) {
    // Surface the phase to the SPA so it can distinguish "API is still
    // booting, retry in a moment" (starting/restarting/generating) from
    // "API has crashed beyond recovery" (crashed) from "no API server
    // configured for this project" (idle/stopped). 503 is correct in
    // every non-bound case — the previous `c.notFound()` falsely
    // implied the route didn't exist when in fact we just couldn't
    // proxy yet.
    return c.json(
      { error: 'API server not ready', phase: pm.apiServerPhase },
      503,
    )
  }

  const url = new URL(c.req.url)
  const target = `http://127.0.0.1:${port}${url.pathname}${url.search}`

  try {
    const res = await fetch(target, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
      // @ts-ignore - duplex needed for streaming request bodies
      duplex: 'half',
    })
    return new Response(res.body, {
      status: res.status,
      headers: res.headers,
    })
  } catch (err: any) {
    console.error(`[api-proxy] Failed to proxy ${c.req.method} ${url.pathname}:`, err.message)
    return c.json({ error: 'API server not responding', phase: pm.apiServerPhase }, 502)
  }
})

// =============================================================================
// Workspace per-project preview routes — `/p/<projectId>/…`
//
// Registered ONLY in workspace-runtime mode. Multiplexes N attached
// projects over the single runtime port:
//   GET  /p/<id>/preview/status          control-plane status
//   POST /p/<id>/preview/{start,restart,stop}
//   *    /p/<id>/api/*                    → the project's server.tsx sidecar
//   GET  /p/<id>/*                        static dist/ serve (SPA fallback)
//
// These are registered before the root catch-all (`app.get('*')`) so they
// win for `/p/…` paths; in single-project mode they're never registered and
// `/p/…` is just an ordinary app route served from the root dist.
// =============================================================================

if (IS_WORKSPACE_RUNTIME) {
  const projectNotAttached = (c: any, projectId: string) =>
    c.json(
      { error: 'project_not_attached', message: `Project ${projectId} is not attached to this workspace runtime` },
      404,
    )

  app.get('/p/:projectId/preview/status', (c) => {
    const projectId = c.req.param('projectId')
    const pm = getWorkspacePreviewManager(projectId)
    if (!pm) return projectNotAttached(c, projectId)
    return c.json(pm.getStatus())
  })

  app.post('/p/:projectId/preview/start', async (c) => {
    const projectId = c.req.param('projectId')
    const pm = getWorkspacePreviewManager(projectId)
    if (!pm) return projectNotAttached(c, projectId)
    return c.json(await pm.start())
  })

  app.post('/p/:projectId/preview/restart', async (c) => {
    const projectId = c.req.param('projectId')
    const pm = getWorkspacePreviewManager(projectId)
    if (!pm) return projectNotAttached(c, projectId)
    return c.json(await pm.restart())
  })

  app.post('/p/:projectId/preview/stop', (c) => {
    const projectId = c.req.param('projectId')
    const pm = getWorkspacePreviewManager(projectId)
    if (!pm) return projectNotAttached(c, projectId)
    pm.stop()
    // Drop the cached instance so a subsequent start() rebuilds from a clean
    // PreviewManager (no leftover timers/child-slot state from this run).
    workspacePreviewManagers.delete(projectId)
    return c.json({ ok: true })
  })

  // Proxy `/p/<id>/api/*` to that project's server.tsx sidecar. Mirrors the
  // root `/api/*` proxy (startup grace window, 503/502 semantics) but strips
  // the `/p/<id>` prefix so the sidecar sees its own `/api/*` path.
  app.all('/p/:projectId/api/*', async (c) => {
    const projectId = c.req.param('projectId')
    const pm = getWorkspacePreviewManager(projectId)
    if (!pm) return projectNotAttached(c, projectId)

    let port = pm.apiServerPort
    // Self-heal a crashed-beyond-recovery sidecar on demand (see root `/api/*`).
    if (port == null && pm.apiServerPhase === 'crashed') {
      pm.maybeRecoverApiServer()
    }
    if (port == null && API_PROXY_STARTUP_PHASES.has(pm.apiServerPhase)) {
      const deadline = Date.now() + API_PROXY_STARTUP_WAIT_MS
      while (port == null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, API_PROXY_POLL_INTERVAL_MS))
        if (!API_PROXY_STARTUP_PHASES.has(pm.apiServerPhase)) break
        port = pm.apiServerPort
      }
    }
    if (port == null) {
      return c.json({ error: 'API server not ready', phase: pm.apiServerPhase }, 503)
    }

    const url = new URL(c.req.url)
    const parsed = parseWorkspacePreviewPath(url.pathname)
    const sidecarPath = parsed ? parsed.rest : '/'
    const target = `http://127.0.0.1:${port}${sidecarPath}${url.search}`
    try {
      const res = await fetch(target, {
        method: c.req.method,
        headers: c.req.raw.headers,
        body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
        // @ts-ignore - duplex needed for streaming request bodies
        duplex: 'half',
      })
      return new Response(res.body, { status: res.status, headers: res.headers })
    } catch (err: any) {
      console.error(`[ws-api-proxy] Failed to proxy ${c.req.method} ${url.pathname}:`, err.message)
      return c.json({ error: 'API server not responding', phase: pm.apiServerPhase }, 502)
    }
  })

  // Canonicalise the bare project root to the trailing-slash form so the
  // browser resolves relative URLs against `/p/<id>/` (and `/p/:projectId/*`
  // matches). Vite builds use absolute `--base` asset URLs regardless, but
  // the redirect keeps deep-link/back-button behaviour sane.
  app.get('/p/:projectId', (c) => {
    const projectId = c.req.param('projectId')
    if (!getWorkspacePreviewManager(projectId)) return projectNotAttached(c, projectId)
    return c.redirect(`/p/${projectId}/`)
  })

  // Static dist/ serve for a project, scoped to its subfolder + base prefix.
  app.get('/p/:projectId/*', (c) => {
    const urlPath = new URL(c.req.url).pathname
    const parsed = parseWorkspacePreviewPath(urlPath)
    if (!parsed) return c.notFound()
    const pm = getWorkspacePreviewManager(parsed.projectId)
    if (!pm) return projectNotAttached(c, parsed.projectId)
    const distDir = join(WORKSPACE_DIR, parsed.projectId, 'dist')
    const inFlight = BUILDING_PHASES.has(pm.phase)
    return serveDistResponse(distDir, parsed.rest, inFlight) ?? markedNotFound()
  })
}

// =============================================================================
// Shared MIME map for static file serving
// =============================================================================

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json', '.mjs': 'application/javascript',
}

// =============================================================================
// Canvas v2 Endpoints
// =============================================================================

app.get('/agent/canvas/stream', (c) => {
  const watcher = getCanvasFileWatcher()

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        } catch {}
      }

      // Replay current state
      send(JSON.stringify(watcher.getInitEvent()))

      // Subscribe to live updates
      const handler = (event: import('./canvas-file-watcher').CanvasEvent) => {
        send(JSON.stringify(event))
      }
      watcher.subscribe(handler)

      // Heartbeat
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        } catch {
          clearInterval(heartbeat)
          watcher.unsubscribe(handler)
        }
      }, 15_000)

      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(heartbeat)
        watcher.unsubscribe(handler)
        try { controller.close() } catch {}
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})

app.post('/agent/canvas/error', async (c) => {
  try {
    const body = await c.req.json() as {
      phase?: string
      error?: string
      route?: string
      recentActions?: Array<{ ts?: number; kind?: string; target?: string; route?: string }>
    }
    if (!body.error) return c.json({ error: 'Missing error field' }, 400)

    // Sanitize recentActions — the bridge serializes its own ring buffer
    // but we don't fully trust the shape since this endpoint is reachable
    // from the iframe. Drop anything that isn't a plain `{ ts, kind, ... }`.
    const recentActions = Array.isArray(body.recentActions)
      ? body.recentActions
          .filter((a): a is { ts: number; kind: string; target?: string; route?: string } =>
            !!a && typeof a.ts === 'number' && typeof a.kind === 'string',
          )
          .map((a) => ({
            ts: a.ts,
            kind: a.kind,
            target: typeof a.target === 'string' ? a.target : undefined,
            route: typeof a.route === 'string' ? a.route : undefined,
          }))
      : undefined

    const route = typeof body.route === 'string' ? body.route : undefined

    pushCanvasRuntimeError({
      phase: body.phase || 'unknown',
      error: body.error,
      timestamp: Date.now(),
      route,
      recentActions,
    })

    // SLO signal: a runtime/compile error reached the rendered canvas (the
    // numerator for "Debug: runtime error sessions per 100 canvas projects").
    // See canvas-slo.ts; paired with `canvas_typecheck_blocked` from the
    // post-build type-check gate, which counts the escapes we prevented.
    recordCanvasRuntimeErrorEscaped({
      phase: body.phase || 'unknown',
      error: body.error,
      route,
    })

    // Mirror into the typed runtime-log dispatcher so the Output tab
    // surfaces canvas errors alongside build/console output and the
    // unseen-error counter ticks correctly. We append a compact suffix
    // for page + last action so a glance at the Output tab still shows
    // useful repro context without expanding into the chat seed.
    const lastAction = recentActions && recentActions.length > 0
      ? recentActions[recentActions.length - 1]
      : null
    const suffixParts: string[] = []
    if (route) suffixParts.push(`page=${route}`)
    if (lastAction) suffixParts.push(`lastAction=${lastAction.kind}${lastAction.target ? ' ' + lastAction.target : ''}`)
    const suffix = suffixParts.length > 0 ? ` (${suffixParts.join(', ')})` : ''
    recordCanvasErrorEntry(`[${body.phase || 'unknown'}] ${body.error}${suffix}`)

    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'Invalid request body' }, 400)
  }
})

export { getCanvasRuntimeErrors, clearCanvasRuntimeErrors } from './canvas-runtime-errors'

// =============================================================================
// Canvas iframe bridge — served live, injected into every workspace HTML
// response. See packages/agent-runtime/static/canvas-bridge.js for the
// contract (update toast, theme sync, capability detection, error reporting,
// canvas-ready handshake). Updates here propagate to every running project on
// next page load — no template re-seed, no per-project rebuild.
// =============================================================================

// Loader helpers extracted to `./canvas-bridge.ts` so they're unit-testable
// without booting the full server (config, AI proxy, etc.). See that module
// for the full contract and the bug-history comment.
import {
  CANVAS_BRIDGE_PATH,
  CANVAS_BRIDGE_SCRIPT_TAG,
  CANVAS_BRIDGE_URL,
  loadCanvasBridgeSource,
} from './canvas-bridge'

const CANVAS_BRIDGE_SOURCE = loadCanvasBridgeSource()

app.get(CANVAS_BRIDGE_URL, () => {
  return new Response(CANVAS_BRIDGE_SOURCE, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  })
})

/**
 * Insert the bridge `<script>` tag into a workspace HTML response. The bridge
 * is the iframe-side counterpart of the agent runtime: it owns the update
 * toast, the theme bridge, capability detection, and error forwarding. By
 * injecting at request time we avoid baking those concerns into the user's
 * `src/main.tsx`, which means runtime changes to the bridge propagate to
 * every existing project on the next page load.
 *
 * Idempotent: skips if the script tag is already present (e.g. some future
 * template ships it directly).
 */
function injectCanvasBridge(html: string): string {
  if (html.indexOf(CANVAS_BRIDGE_URL) !== -1) return html
  const lower = html.toLowerCase()
  const bodyClose = lower.lastIndexOf('</body>')
  if (bodyClose !== -1) {
    return html.slice(0, bodyClose) + CANVAS_BRIDGE_SCRIPT_TAG + html.slice(bodyClose)
  }
  const htmlClose = lower.lastIndexOf('</html>')
  if (htmlClose !== -1) {
    return html.slice(0, htmlClose) + CANVAS_BRIDGE_SCRIPT_TAG + html.slice(htmlClose)
  }
  return html + CANVAS_BRIDGE_SCRIPT_TAG
}

// =============================================================================
// Diagnostics routes (Problems tab) — mounted BEFORE the SPA fallback below.
//
// PR #458 lesson: any handler that lives at a non-/agent path must (a) be
// registered before the `app.get('*')` static fallback at the bottom of this
// file, otherwise a GET will fall through and return index.html with status
// 200, and (b) be added to that fallback's skip-list so unknown sub-paths
// 404 cleanly instead of also returning index.html. We honor both here.
// =============================================================================
app.route('/', runtimeDiagnosticsRoutes({
  workspaceDir: WORKSPACE_DIR,
  getCurrentProjectId: () => state.currentProjectId,
}))

// =============================================================================
// LSP routes (Monaco IDE) — mounted alongside diagnostics.
//
// The browser-side Monaco editor delegates hover, completion, go-to-def,
// references, document-symbol, signature-help, and rename to the
// typescript-language-server already running inside this pod. This eliminates
// the 1000-file Monaco bulk preload that used to be required for cross-file
// IntelliSense.
//
// Auth: covered by the existing `/agent` authPrefix in createRuntimeApp.
// SPA fallback skip: also covered by the existing `/agent` startsWith check.
// =============================================================================
app.route('/', runtimeLspRoutes({
  workspaceDir: WORKSPACE_DIR,
  getLspManager: () => agentGateway?.getLspManager?.() ?? null,
}))

// =============================================================================
// Static File Serving — workspace Vite build output (dist/) at root
// =============================================================================

function getDistDir(): string {
  return join(WORKSPACE_DIR, 'dist')
}

// Recursively collect every file under `dist/` as `{ path, content (base64) }`.
// Consumed by apps/api/src/routes/publish.ts -> downloadDistFiles() to upload
// the build output to the published-apps S3 bucket.
//
// Lives under `/agent/*`, NOT `/api/*`. The `/api/*` namespace is owned by
// the user app's sidecar Hono server (see code-agent-prompt.ts) and the
// runtime mounts `app.all('/api/*', ...)` higher up to proxy every `/api/*`
// request to it. The original placement at `/api/dist-files` (commit
// 2f9b326d) was registered after that proxy and shadowed from day one —
// every publish hit either the proxy's `if (!port) return c.notFound()`
// branch (404) or got the user app's SPA fallback (200 + index.html, which
// the publisher then failed to JSON-parse). `/agent/*` is the
// runtime-owned namespace, is auth-gated by `authPrefixes` so callers must
// send `x-runtime-token`, and is in the SPA catch-all skip-list — so this
// endpoint is no longer reachable as a userland route.
const PUBLISH_DIST_MAX_FILE_SIZE = 50 * 1024 * 1024

function collectPublishDistFiles(dir: string, baseDir: string): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (isMacOSJunkName(entry.name)) continue
    const fullPath = join(dir, entry.name)
    const relPath = fullPath.slice(baseDir.length + 1).replace(/\\/g, '/')
    if (entry.isDirectory()) {
      out.push(...collectPublishDistFiles(fullPath, baseDir))
    } else if (entry.isFile()) {
      try {
        const stat = statSync(fullPath)
        if (stat.size > PUBLISH_DIST_MAX_FILE_SIZE) continue
        out.push({
          path: relPath,
          content: readFileSync(fullPath).toString('base64'),
        })
      } catch {
        // skip unreadable files
      }
    }
  }
  return out
}

app.get('/agent/dist-files', (c) => {
  const distDir = getDistDir()
  if (!existsSync(distDir)) {
    return c.json(
      { error: 'dist_not_found', message: 'No dist/ directory — run a build first' },
      404,
    )
  }
  const files = collectPublishDistFiles(distDir, distDir)
  return c.json(files)
})

/**
 * Return the project's writable runtime state (the SQLite DB + any upload
 * dirs) as a gzipped tar, base64-encoded. Called by the publish flow
 * (apps/api/src/routes/publish.ts) to SEED the published-data bucket on first
 * publish so a server-backed published app boots with the builder's data
 * (e.g. a guest list) instead of an empty DB.
 *
 * The archive layout is rooted at the workspace dir (entries like
 * `prisma/dev.db`), matching what `PublishedDataSync.restore()` extracts.
 * Lives under the runtime-owned `/agent/*` namespace (auth-gated by
 * `x-runtime-token`), same as `/agent/dist-files`.
 */
const PUBLISHED_DATA_WRITABLE_PATHS = [
  'prisma/dev.db',
  'prisma/dev.db-wal',
  'prisma/dev.db-shm',
  'uploads',
  'public/uploads',
  'storage',
]
app.get('/agent/published-data-archive', async (c) => {
  const present = PUBLISHED_DATA_WRITABLE_PATHS.filter((p) =>
    existsSync(join(WORKSPACE_DIR, p)),
  )
  if (present.length === 0) {
    return c.json(
      { error: 'no_writable_state', message: 'No prisma/dev.db or upload dirs to archive' },
      404,
    )
  }
  const tar = await import('tar')
  const fsp = await import('fs/promises')
  const os = await import('os')
  const tmpDir = await fsp.mkdtemp(join(os.tmpdir(), 'shogo-pubdata-seed-'))
  const archivePath = join(tmpDir, 'data.tar.gz')
  try {
    await tar.create(
      { gzip: true, file: archivePath, cwd: WORKSPACE_DIR, portable: true },
      present,
    )
    const buf = await fsp.readFile(archivePath)
    return c.json({ archive: buf.toString('base64'), paths: present })
  } catch (err: any) {
    return c.json({ error: 'archive_failed', message: err?.message ?? String(err) }, 500)
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
})

/**
 * Disarm this pod's published-data uploader (SHOGO_PUBLISHED_MODE only).
 * Called by the publish flow (apps/api/src/routes/publish.ts) right before it
 * overwrites the published-data archive with the builder's dev database: a
 * running published pod otherwise flushes its stale DB on its 30s interval /
 * on shutdown and would clobber the fresh push. After suspending, the API
 * rolls a new revision that re-hydrates from the pushed archive.
 *
 * Returns `{ suspended: false }` (still 200) when there's no uploader to
 * disarm (e.g. this app has no writable state) so the caller can proceed.
 * Under the runtime-owned `/agent/*` namespace, so it's `x-runtime-token`
 * gated like the other publish endpoints.
 */
app.post('/agent/published-data/suspend', (c) => {
  if (!IS_PUBLISHED_MODE) {
    return c.json({ error: 'not_published_mode', message: 'Only server-backed published pods can be suspended' }, 400)
  }
  if (publishedDataSyncInstance) {
    publishedDataSyncInstance.suspend()
    return c.json({ ok: true, suspended: true })
  }
  return c.json({ ok: true, suspended: false })
})

/**
 * Whitespace-insensitive fingerprint of `prisma/schema.prisma`, used by the
 * publish flow to detect dev<->published schema drift before pushing the dev
 * database onto the live app (pushing a newer-schema DB onto older published
 * code breaks the app). Returns `{ hash: null }` when the project has no
 * schema (a purely-static app). Runtime-owned `/agent/*` route.
 */
app.get('/agent/schema-fingerprint', (c) => {
  const schemaPath = join(WORKSPACE_DIR, 'prisma', 'schema.prisma')
  if (!existsSync(schemaPath)) return c.json({ hash: null })
  try {
    const { createHash } = require('crypto') as typeof import('crypto')
    const normalized = readFileSync(schemaPath, 'utf-8').replace(/\s+/g, ' ').trim()
    return c.json({ hash: createHash('sha256').update(normalized).digest('hex') })
  } catch (err: any) {
    return c.json({ error: 'fingerprint_failed', message: err?.message ?? String(err) }, 500)
  }
})

/**
 * Report whether this project needs a SERVER-BACKED publish — i.e. whether its
 * backend (`server.tsx`) does real work that a static export can't reproduce.
 * Consumed by the publish flow (apps/api/src/routes/publish.ts) to decide
 * between a static publish (Object Storage only) and a server-backed publish
 * (a running `server.tsx` pod fronting `/api/*`).
 *
 * Heuristic — an app is server-backed when EITHER:
 *   - `prisma/schema.prisma` declares at least one `model` (it has a DB the
 *     app reads/writes at runtime), OR
 *   - `custom-routes.ts` registers any route (`app.get/post/put/...`).
 *
 * `server.tsx` alone is NOT a signal: the template always ships one, so a
 * purely-static app (no models, no custom routes) stays on the static path.
 */
app.get('/agent/server-info', (c) => {
  const readIfExists = (rel: string): string | null => {
    try {
      const p = join(WORKSPACE_DIR, rel)
      return existsSync(p) ? readFileSync(p, 'utf-8') : null
    } catch {
      return null
    }
  }
  const result = evaluateServerBacked({
    schemaSource: readIfExists(join('prisma', 'schema.prisma')),
    customRoutesSource: readIfExists('custom-routes.ts'),
    hasServerFile: existsSync(join(WORKSPACE_DIR, 'server.tsx')),
  })
  return c.json(result)
})

/**
 * Force an immediate, AWAITED git sync of the workspace and return the
 * resulting HEAD sha. Called by the publish flow (apps/api/src/routes/
 * publish.ts) so the published source is committed + persisted to the
 * durable repo before the API records the publish.
 *
 * In the pod-owned `git_only` model the pod owns the repo, so this also
 * handles publish-as-tag: when a `tag` is supplied, after the flush we
 * create the annotated tag locally and re-persist `.git` (now carrying the
 * tag) to object storage. The API then records publishedCommitSha/Tag and
 * picks the tag up on its next read-hydrate. Also flushes the S3 large-file
 * offload first so the durable repo stays source-only. No-op (flushed=false)
 * when git sync isn't active for this pod (e.g. legacy `s3` mode).
 */
app.post('/agent/git-flush', async (c) => {
  if (!gitSyncInstance) {
    return c.json({ ok: true, flushed: false, reason: 'git-sync-not-active' })
  }
  // Legacy single-tag fields (`tag`/`tagMessage`) are still accepted; the
  // publish flow now sends `tags[]` (timestamped history + stable
  // `published/<subdomain>` pointer) and `deleteTags[]` (old pointer cleanup
  // on subdomain change / unpublish).
  let tag: string | undefined
  let tagMessage: string | undefined
  let tags: Array<{ name: string; message?: string; force?: boolean }> = []
  let deleteTags: string[] = []
  try {
    const body = await c.req.json().catch(() => ({}))
    tag = typeof body?.tag === 'string' ? body.tag : undefined
    tagMessage = typeof body?.tagMessage === 'string' ? body.tagMessage : undefined
    if (Array.isArray(body?.tags)) {
      tags = body.tags
        .filter((t: any) => t && typeof t.name === 'string')
        .map((t: any) => ({
          name: t.name as string,
          message: typeof t.message === 'string' ? t.message : undefined,
          force: t.force === true,
        }))
    }
    if (Array.isArray(body?.deleteTags)) {
      deleteTags = body.deleteTags.filter((t: any) => typeof t === 'string')
    }
  } catch {
    /* no body */
  }
  // Fold the legacy single tag into the unified list (force, matching prior behavior).
  if (tag) tags.push({ name: tag, message: tagMessage, force: true })

  try {
    // Legacy size-based offload (skipped under LFS — flush() handles LFS via
    // beforeStage track + afterCommit push).
    const lfCfg = largeFileSyncConfigFromEnv(WORKSPACE_DIR)
    if (lfCfg && !isLfsActive()) await syncLargeFiles(lfCfg)
    await gitSyncInstance.flush()

    let didTagOp = false
    for (const name of deleteTags) {
      try {
        await deleteTagLocal(WORKSPACE_DIR, name)
        didTagOp = true
      } catch (e: any) {
        console.warn(`[agent-runtime] git-flush: failed to delete tag ${name}:`, e?.message ?? e)
      }
    }
    let taggedSha: string | null = null
    for (const t of tags) {
      taggedSha = await createTagLocal(WORKSPACE_DIR, t.name, { message: t.message, force: t.force })
      didTagOp = true
    }
    if (didTagOp) {
      // Re-persist so the durable repo carries the tag changes (LFS objects are
      // already in OCI from the flush; re-push is a cheap no-op via dedup).
      await persistDurableRepo()
    }

    const sha = taggedSha ?? (await getHeadSha(WORKSPACE_DIR))
    return c.json({ ok: true, flushed: true, sha, tag: tag ?? null, tags: tags.map((t) => t.name) })
  } catch (err: any) {
    console.error('[agent-runtime] /agent/git-flush failed:', err?.message ?? err)
    return c.json({ ok: false, error: err?.message ?? 'git-flush failed' }, 500)
  }
})

/**
 * Phases during which a build is plausibly in flight and `dist/` may
 * legitimately be missing. When a navigation request would otherwise
 * 404 we render a small "Building..." placeholder instead so the user
 * sees a self-refreshing message rather than a hard error during the
 * first-ever build of a fresh workspace. (The atomic-swap commit logic
 * in `build-output-commit.ts` keeps `dist/` populated through every
 * subsequent rebuild, so this only fires before the first successful
 * build has landed.)
 */
const BUILDING_PHASES = new Set([
  'installing',
  'generating-prisma',
  'pushing-db',
  'building',
  'starting-api',
])

function isBuildLikelyInFlight(): boolean {
  // Avoid accidentally constructing a PreviewManager just to peek at
  // its phase — the fallback is only meaningful once one already exists
  // (i.e. a preview start has been requested somewhere).
  if (!previewManager) return false
  const phase = previewManager.phase
  return BUILDING_PHASES.has(phase)
}

// Marker header stamped on every response the agent-runtime itself
// produces for a preview document. The Cloudflare preview-router Worker
// uses its presence to distinguish an *infra* error (Kourier "no healthy
// upstream" 404, activator/pod 503 — no marker) from the *app's own*
// response (404 page, building placeholder — marked). Infra errors get
// swapped for the "waking up" interstitial; marked responses pass through
// untouched so a genuine app 404 never gets masked or reload-looped.
const RUNTIME_MARKER_HEADER = 'x-shogo-runtime'
const RUNTIME_MARKER_VALUE = '1'

function renderBuildingPlaceholder(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="2" />
<title>Building preview…</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #555; background: #fafafa;
  }
  .card { text-align: center; }
  .spinner {
    width: 28px; height: 28px; margin: 0 auto 12px;
    border: 3px solid #e0e0e0; border-top-color: #5b8def;
    border-radius: 50%; animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .hint { font-size: 13px; color: #888; margin-top: 6px; }
</style>
</head>
<body>
  <div class="card">
    <div class="spinner" aria-hidden="true"></div>
    <div>Building preview…</div>
    <div class="hint">This page will refresh automatically.</div>
  </div>
</body>
</html>`
  return new Response(html, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Retry-After': '2',
      [RUNTIME_MARKER_HEADER]: RUNTIME_MARKER_VALUE,
    },
  })
}

/**
 * Serve a request out of a `dist/` directory with SPA fallback.
 *
 * Shared by the root static handler (single-project: serves
 * `<WORKSPACE_DIR>/dist`) and the workspace per-project handler
 * (serves `<WORKSPACE_DIR>/<projectId>/dist`). Returns `null` when there
 * is genuinely nothing to serve (no matching file, no `index.html`, no
 * build in flight) so the caller can fall through to `c.notFound()`.
 *
 * `requestPath` is the path *relative to the dist root* — for the root
 * handler that's the full URL path; for the per-project handler it's the
 * remainder after `/p/<projectId>`.
 */
function serveDistResponse(
  distDir: string,
  requestPath: string,
  buildInFlight: boolean,
): Response | null {
  const safePath = requestPath.replace(/\.\./g, '').replace(/\/+/g, '/')
  const filePath = join(distDir, safePath === '/' ? 'index.html' : safePath)

  if (!filePath.startsWith(resolve(distDir))) {
    return null
  }

  if (existsSync(filePath) && statSync(filePath).isFile()) {
    const ext = extname(filePath).toLowerCase()
    const mime = STATIC_MIME[ext] || 'application/octet-stream'
    if (ext === '.html') {
      const html = injectCanvasBridge(readFileSync(filePath, 'utf-8'))
      return new Response(html, {
        headers: {
          'Content-Type': mime,
          'Cache-Control': 'no-cache',
          [RUNTIME_MARKER_HEADER]: RUNTIME_MARKER_VALUE,
        },
      })
    }
    return new Response(readFileSync(filePath), {
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=31536000, immutable',
        [RUNTIME_MARKER_HEADER]: RUNTIME_MARKER_VALUE,
      },
    })
  }

  // SPA fallback
  const indexPath = join(distDir, 'index.html')
  if (existsSync(indexPath)) {
    const html = injectCanvasBridge(readFileSync(indexPath, 'utf-8'))
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-cache',
        [RUNTIME_MARKER_HEADER]: RUNTIME_MARKER_VALUE,
      },
    })
  }

  // No dist yet. If a build is in flight, render a self-refreshing
  // "Building..." placeholder so the user doesn't stare at a raw 404
  // during the first build of a fresh workspace. After the first
  // successful build the atomic-swap pipeline keeps `dist/` populated,
  // so this only matters pre-first-build (or after a fresh wipe).
  if (buildInFlight) {
    return renderBuildingPlaceholder()
  }

  return null
}

// A 404 the agent-runtime itself produced. Carries the runtime marker so
// the preview-router Worker treats it as an app response (pass through),
// not an infra "no upstream" 404 (which it would swap for the interstitial).
function markedNotFound(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      [RUNTIME_MARKER_HEADER]: RUNTIME_MARKER_VALUE,
    },
  })
}

app.get('*', (c) => {
  const urlPath = new URL(c.req.url).pathname

  if (urlPath.startsWith('/agent') || urlPath.startsWith('/pool') ||
      urlPath.startsWith('/health') || urlPath.startsWith('/ready') ||
      urlPath.startsWith('/preview') || urlPath.startsWith('/console-log') ||
      urlPath.startsWith('/api') || urlPath.startsWith('/templates') ||
      urlPath.startsWith('/diagnostics')) {
    return markedNotFound()
  }

  return serveDistResponse(getDistDir(), urlPath, isBuildLikelyInFlight()) ?? markedNotFound()
})

// =============================================================================
// Initialization
// =============================================================================

/**
 * Essential initialization: workspace files, S3 sync, config.
 * Returns quickly so /pool/assign can respond fast.
 */
async function initializeEssentials(): Promise<void> {
  logTiming('Initializing essentials...')

  // When the workspace is 9p-mounted, keep .shogo/ on the local overlay disk
  // so SQLite uses a real filesystem with proper locking. For warm pool VMs this
  // is handled in onAssign; for cold-start VMs (e.g. evals) we do it here.
  if (process.env.VM_WORKSPACE_MOUNTED === 'true') {
    const projectId = process.env.PROJECT_ID || 'default'
    const localShogoDir = `/tmp/shogo-local/${projectId}/.shogo`
    mkdirSync(localShogoDir, { recursive: true })
    const workspaceShogoDir = join(WORKSPACE_DIR, '.shogo')
    try {
      const st = lstatSync(workspaceShogoDir)
      if (!st.isSymbolicLink()) {
        rmSync(workspaceShogoDir, { recursive: true, force: true })
        symlinkSync(localShogoDir, workspaceShogoDir)
      }
    } catch {
      try { symlinkSync(localShogoDir, workspaceShogoDir) } catch {}
    }
    logTiming('.shogo symlinked to local overlay (9p mount)')
  }

  // Bootstrap workspace files
  ensureWorkspaceFiles()
  logTiming('Workspace files ready')

  // Seed tech stack if specified (covers warm pool assignment path where
  // TECH_STACK_ID is injected after module-level code has already run).
  // seedTechStack is idempotent — only writes files that don't already exist.
  //
  // External (VS Code-style) projects: do NOT run any tech-stack seed.
  // `seedTechStack` copies `starter/` (whole directory tree: package.json,
  // tsconfig.json, src/, etc.) into the user's repo root. Even though it
  // skips existing files, it still pollutes the repo with files the user
  // never asked for — exactly the failure mode we're avoiding.
  const tsId = process.env.TECH_STACK_ID
  if (tsId && WORKING_MODE !== 'external') {
    seedTechStack(WORKSPACE_DIR, tsId)
    logTiming(`Tech stack seeded: ${tsId}`)
  }

  // Initialize S3 sync BEFORE loading canvas state so that downloaded files
  // (including .canvas-state.json and api-runtimes/*.db) are available on disk.
  //
  // SHOGO_CLOUD_SYNC=1 tells us a parent worker process (shogo-worker) is
  // already syncing this WORKSPACE_DIR back to Shogo Cloud. This single env
  // var disables TWO independent code paths:
  //   1. The runtime-internal S3Sync below (would feedback-loop with the
  //      worker's CloudFileTransport / git watcher).
  //   2. Any runtime-side ProjectCheckpoint insertion. In git-sync mode
  //      the cloud's smart-HTTP post-receive hook (apps/api/src/routes/
  //      git-http.ts → runPostReceiveHook) is now the SINGLE source of
  //      truth for ProjectCheckpoint rows — every push from the worker's
  //      watcher materializes exactly one row, and the desktop UI's
  //      checkpoint timeline picks it up from the same Postgres table.
  // See packages/shogo-worker/src/lib/runtime-manager.ts for the env-var
  // origin (set when AutoPullOptions.enabled is true).
  const skipInternalSync = process.env.SHOGO_CLOUD_SYNC === '1' || process.env.SHOGO_CLOUD_SYNC === 'true'
  if (skipInternalSync) {
    console.log('[agent-runtime] SHOGO_CLOUD_SYNC set; skipping runtime-internal S3Sync + checkpoint inserts (worker owns sync)')
    logTiming('S3 sync skipped: owned by worker')
  }

  // Per-project cloud sync mode:
  //   - 's3'          → today's behavior. Both S3 layers active. No git.
  //   - 'dual_shadow' → S3 authoritative + git push for verification.
  //   - 'git_only'    → git authoritative for Layer 2. S3 Layer 2 stays
  //                     SUPPRESSED but armed: it will be re-enabled at
  //                     runtime if git push fails repeatedly (see the
  //                     onDegrade wiring below), AND it always writes
  //                     a cold-start snapshot at evict via
  //                     `flushAndShutdown({ forceProjectArchive: true })`.
  //                     Layer 1 (deps cache) is unaffected.
  const cloudSyncMode = resolveCloudSyncMode()
  const wantS3Layer2 = cloudSyncMode === 's3' || cloudSyncMode === 'dual_shadow'
  const wantGitSync = cloudSyncMode === 'dual_shadow' || cloudSyncMode === 'git_only'
  if (cloudSyncMode !== 's3') {
    console.log(`[agent-runtime] cloudSyncMode=${cloudSyncMode} (wantS3Layer2=${wantS3Layer2}, wantGit=${wantGitSync})`)
  }

  if (!skipInternalSync && IS_WORKSPACE_RUNTIME && (process.env.S3_WORKSPACES_BUCKET || process.env.S3_BUCKET)) {
    // Workspace runtime: each attached project is stored under its own S3
    // prefix and lives in its own `<WORKSPACE_DIR>/<id>/` subfolder. A single
    // workspace-rooted `initializeS3Sync` (prefix = PROJECT_ID) would download
    // the anchor's archive over the merged root and never see the other
    // members, so hydrate each member into its own subfolder, then start a
    // periodic uploader + watcher per member (mirrors the single-project
    // uploader). All members are flushed on shutdown.
    try {
      const interval = parseInt(process.env.S3_SYNC_INTERVAL || '30000', 10)
      const watchEnabled = process.env.S3_WATCH_ENABLED !== 'false'
      const { hydrated, skipped, failed, syncs } = await hydrateWorkspaceMembers(
        WORKSPACE_DIR,
        WORKSPACE_RUNTIME_PROJECT_IDS,
        {
          createSync: (localDir, projectId): MemberSync | null =>
            createS3SyncForProject(localDir, projectId, {
              syncInterval: interval,
              watchEnabled,
              suppressProjectArchive: !wantS3Layer2,
            }),
        },
      )
      workspaceMemberSyncs = syncs as Map<string, import('@shogo/shared-runtime').S3Sync>
      for (const sync of workspaceMemberSyncs.values()) {
        sync.startPeriodicSync()
        sync.startWatcher()
      }
      logTiming(
        `Workspace S3 hydration: ${hydrated.length} hydrated, ${skipped.length} skipped, ${failed.length} failed`,
      )
    } catch (error: any) {
      console.error('[agent-runtime] Workspace S3 hydration failed:', error.message)
    }
  } else if (!skipInternalSync && (process.env.S3_WORKSPACES_BUCKET || process.env.S3_BUCKET)) {
    try {
      const result = await initializeS3Sync(WORKSPACE_DIR, {
        suppressProjectArchive: !wantS3Layer2,
      })
      if (result) {
        s3SyncInstance = result.sync
        // If node_modules were seeded from the template AND the user's
        // package.json actually depends on Vite, the template's
        // node_modules is the user's deps — mark pre-seeded so the first
        // periodic sync doesn't try to tar.gz 37K+ files and OOM the pod.
        //
        // The previous heuristic only checked `existsSync(.bin/vite)`,
        // but the warm-pool template ALWAYS has that bin regardless of
        // whether the user uses Vite. For non-Vite workspaces (Expo, RN,
        // etc.) ensureWorkspaceDeps() below will actually reinstall the
        // correct deps, and we need the post-install hook to upload them
        // with a per-project pointer. See the 2026-05-14 staging
        // disk-pressure incident write-up.
        if (
          existsSync(join(WORKSPACE_DIR, 'node_modules', '.bin', 'vite'))
          && workspaceUsesVite(WORKSPACE_DIR)
        ) {
          await s3SyncInstance.markDepsPreSeeded()
        }
        logTiming('S3 sync initialized')
      }
    } catch (error: any) {
      console.error('[agent-runtime] S3 sync init failed:', error.message)
    }
  }

  // Instantiate GitWorkspaceSync in dual_shadow / git_only mode. The
  // onDegrade callback ensures S3 stays armed as a fallback: if 3
  // consecutive git pushes fail we re-enable S3 Layer 2 for the rest
  // of the session. On recovery we re-suppress (only in git_only mode;
  // dual_shadow always keeps S3 Layer 2 active).
  //
  // EXTERNAL projects are excluded: the workspace is the user's own repo
  // and they own their git workflow. With cloudSyncMode defaulting to
  // git_only (incl. on desktop), an unguarded path would `git add -A &&
  // git commit` into their working tree every turn and `seedRepoIfAbsent`
  // a `.git` into folders we don't own. See shouldRunGitWorkspaceSync.
  if (shouldRunGitWorkspaceSync({ workingMode: WORKING_MODE, workerOwnsSync: skipInternalSync, wantGitSync })) {
    // Cold-start git lifecycle. The pod owns the repo: before the per-turn
    // committer can run, the working tree must be a git repo with the durable
    // history present.
    //
    //   git_only (pod-owned)  → restore `.git` from object storage (the pod's
    //     own durable copy). If no durable object exists yet, seed a fresh
    //     repo from the S3-restored tree (legacy s3-mode migration) and
    //     persist it. No API origin involved.
    //   dual_shadow           → ensureWorkspaceRepo fetches/seeds against the
    //     API origin (the legacy push model is still the durability path).
    //
    // Then restore the S3-offloaded large/binary assets so the pod sees a
    // complete tree.
    const cloudApiUrl = process.env.SHOGO_API_URL
    const runtimeAuthSecret = process.env.RUNTIME_AUTH_SECRET
    const projectId = process.env.PROJECT_ID
    if (cloudApiUrl && runtimeAuthSecret && projectId) {
      try {
        if (cloudSyncMode === 'git_only') {
          const repoCfg = repoStoreConfigFromEnv()
          let restored = false
          if (repoCfg) {
            const res = await restoreRepoFromStore(WORKSPACE_DIR, repoCfg)
            restored = res.restored
          }
          if (!restored) {
            // No durable repo yet (brand-new or legacy s3 project): seed from
            // the on-disk tree and persist so the next cold start hydrates it.
            const seededSha = await seedRepoIfAbsent(WORKSPACE_DIR)
            if (seededSha && repoCfg) {
              await persistRepoToStore(WORKSPACE_DIR, repoCfg)
              // Record the baseline seed commit so it shows in the checkpoints
              // timeline (not just the git graph).
              const meta = await gatherCommitMeta(WORKSPACE_DIR, seededSha)
              if (meta) {
                await postCheckpointRecord(projectId, {
                  commitSha: meta.sha,
                  commitMessage: meta.message,
                  branch: meta.branch,
                  filesChanged: meta.filesChanged,
                  additions: meta.additions,
                  deletions: meta.deletions,
                  isAutomatic: true,
                })
              }
            }
            logTiming(`Git repo bootstrap (git_only, restored=false, seeded=${Boolean(seededSha)})`)
          } else {
            logTiming('Git repo bootstrap (git_only, restored=true)')
          }
        } else {
          const result = await ensureWorkspaceRepo({
            workspaceDir: WORKSPACE_DIR,
            cloudApiUrl,
            runtimeAuthSecret,
            projectId,
          })
          logTiming(
            `Git repo bootstrap (preexisting=${result.preexisting}, cloned=${result.cloned}, seeded=${result.seeded})`,
          )
        }
      } catch (error: any) {
        console.error('[agent-runtime] git repo bootstrap failed (falling back to S3 durability):', error.message)
      }
      const lfCfg = largeFileSyncConfigFromEnv(WORKSPACE_DIR)
      if (lfCfg) {
        try {
          await restoreLargeFiles(lfCfg)
          logTiming('Large-file assets restored')
        } catch (error: any) {
          console.error('[agent-runtime] restoreLargeFiles failed:', error.message)
        }
      }
      // Git LFS (git_only): configure the repo's LFS filter +
      // .gitattributes, run the one-time migration off the legacy assets/
      // offload (no-op once done), then materialize object bytes for the
      // current checkout (smudge is skipped on checkout, so we fetch
      // explicitly). All best-effort — a failure leaves pointer files and is
      // recovered on the next pull.
      if (isLfsActive()) {
        try {
          await ensureLfsRepoSetup(WORKSPACE_DIR)
          await migrateOffloadedAssetsToLfs(WORKSPACE_DIR)
          const lfsCfg = lfsRemoteConfigFromEnv(WORKSPACE_DIR)
          if (lfsCfg) await lfsPull(lfsCfg)
          logTiming('Git LFS setup + pull')
        } catch (error: any) {
          console.error('[agent-runtime] Git LFS setup failed:', error?.message ?? error)
        }
      }
    } else {
      console.warn('[agent-runtime] git mode requested but SHOGO_API_URL/RUNTIME_AUTH_SECRET/PROJECT_ID incomplete; skipping repo bootstrap')
    }
    try {
      gitSyncInstance = createGitSyncFromEnv(WORKSPACE_DIR, {
        // git_only is pod-owned: commit locally + persist `.git` + record
        // the checkpoint row via afterCommit, instead of pushing to an API
        // origin. dual_shadow keeps the push model.
        localOnly: cloudSyncMode === 'git_only',
        afterCommit: cloudSyncMode === 'git_only' ? persistAndRecordCheckpoint : undefined,
        // Git LFS: before each `git add -A`, track newly-introduced large
        // files so the clean filter writes pointers instead of raw bytes.
        beforeStage: isLfsActive()
          ? async () => { await autoTrackLargeFiles(WORKSPACE_DIR) }
          : undefined,
        onDegrade: (reason) => {
          console.warn(
            `[agent-runtime] cloud-sync degraded (mode=${cloudSyncMode}): ${reason}`,
          )
          // In dual_shadow S3 Layer 2 is already on, so this is a no-op.
          // In git_only it flips Layer 2 back on as the durability fallback.
          s3SyncInstance?.setSuppressProjectArchive(false)
        },
        onRecovered: () => {
          console.log(`[agent-runtime] cloud-sync recovered (mode=${cloudSyncMode})`)
          // Only re-suppress in git_only mode; dual_shadow always wants both writers.
          if (cloudSyncMode === 'git_only') {
            s3SyncInstance?.setSuppressProjectArchive(true)
          }
        },
      })
      if (gitSyncInstance) {
        logTiming('Git sync initialized')
      } else {
        console.warn('[agent-runtime] Git sync requested but env incomplete (SHOGO_API_URL/RUNTIME_AUTH_SECRET/PROJECT_ID); falling back to S3 only')
      }
    } catch (error: any) {
      console.error('[agent-runtime] Git sync init failed:', error.message)
    }
  }

  // Ensure workspace has node_modules. This no longer blocks boot: the install
  // runs in the background (`startWorkspaceDepsInstall`) so the gateway can
  // start and accept the first chat message while deps install. Deps-dependent
  // work (the LSP) awaits `workspaceDepsReadyPromise`. If S3 sync is restoring
  // deps in the background, `startGateway` owns the restore-then-install
  // sequence (also in the background).
  //
  // External (VS Code-style) projects: never run `bun install` on the
  // user's repo. `ensureWorkspaceDeps` also calls `migrateLegacyShogoSdkPin`
  // which *rewrites* the user's `package.json` if it sees an old
  // `@shogo-ai/sdk` pin or `bunx shogo …` script — categorically not
  // something Shogo should be doing inside someone else's repo. The user
  // owns their package manager workflow in external mode.
  if (WORKING_MODE === 'external') {
    logTiming('External project: skipped workspace deps install')
  } else if (s3SyncInstance && !s3SyncInstance.areDepsReady()) {
    logTiming('Deps restoring in background — startGateway will finish the install')
  } else {
    startWorkspaceDepsInstall()
    logTiming('Workspace deps install started (background)')
  }

  // Run any pending tech-stack setup script. External projects can't
  // arrive here with a `.tech-stack` marker (we never seeded one), but
  // even if a user manually dropped one in, `setup.sh` is destructive
  // by definition (the contract is "set this stack up"), so we don't
  // execute it against an external repo.
  if (WORKING_MODE !== 'external') {
    const techStackMarkerPath = join(WORKSPACE_DIR, '.tech-stack')
    if (existsSync(techStackMarkerPath)) {
      const stackId = readFileSync(techStackMarkerPath, 'utf-8').trim()
      try {
        await runTechStackSetup(WORKSPACE_DIR, stackId)
        logTiming(`Tech stack setup complete: ${stackId}`)
      } catch (err: any) {
        console.error(`[agent-runtime] Tech stack setup failed for ${stackId}:`, err.message)
      }
    }
  }

  logTiming('Essentials complete')

  // Auto-start preview server if an app project was restored from S3 or
  // freshly seeded from a tech-stack starter. We accept either a
  // `<workspace>/project/package.json` (legacy Vite layout) or a workspace-
  // root `package.json` (Expo / React Native stacks place it there). The
  // PreviewManager itself owns the cwd disambiguation via `resolveBundlerCwd`.
  //
  // External projects: PreviewManager is gated by `RUNTIME_ENABLED` (set
  // by the host RuntimeManager from `Project.runtimeEnabled`). We only
  // honour the auto-start when the user has opted in via that flag.
  // Without this guard, opening any external project with a top-level
  // `package.json` would spawn Vite/Metro in the user's repo without
  // their consent.
  const legacyProjectDir = join(WORKSPACE_DIR, 'project')
  const hasLegacyPkg = existsSync(join(legacyProjectDir, 'package.json'))
  const hasRootPkg = existsSync(join(WORKSPACE_DIR, 'package.json'))
  const externalAutoPreviewBlocked =
    WORKING_MODE === 'external' && process.env.RUNTIME_ENABLED !== 'true'
  if (IS_WORKSPACE_RUNTIME) {
    // Workspace-runtime layout: every attached project lives under its own
    // `<workspace>/<projectId>` subtree and is served under `/p/<projectId>/`.
    // The global PreviewManager would resolve `bundlerCwd = <ws>/project`
    // (which doesn't exist) and bail, so nothing ever builds the per-project
    // dist. Auto-start ONLY the anchor project's preview (the project the
    // user opened — its canvas is what `/sandbox/url` points at). Attached
    // projects are for cross-folder editing via chat, not live preview, so
    // we don't pile up an extra vite-watch + API sidecar per attachment;
    // their previews start on demand via `POST /p/<id>/preview/start`. This
    // builds `<ws>/<anchor>/dist` (with `--base /p/<anchor>/`) for the
    // `/p/:projectId/*` static route. `start()` is idempotent.
    const anchorId =
      process.env.WORKSPACE_ANCHOR_PROJECT_ID || WORKSPACE_RUNTIME_PROJECT_IDS[0]
    const wpm = anchorId ? getWorkspacePreviewManager(anchorId) : null
    if (wpm && wpm.phase === 'idle') {
      logTiming(`Workspace runtime: auto-starting preview for anchor ${anchorId}`)
      setTimeout(() => {
        wpm.start().catch((err: any) =>
          console.error(
            `[agent-runtime] Auto-start workspace preview failed for ${anchorId}:`,
            err.message,
          ),
        )
      }, 0)
    }
  } else if ((hasLegacyPkg || hasRootPkg) && !externalAutoPreviewBlocked) {
    const pm = getPreviewManager()
    const status = pm.getStatus()
    if (!status.running) {
      const where = hasLegacyPkg ? 'project/' : 'workspace root'
      logTiming(`Detected app project (${where}) — auto-starting preview`)
      // Defer preview start by one event-loop tick so the runtime can
      // return from `initialize()` and let Bun.serve start handling
      // /health requests before we begin the heavier preview-manager
      // background setup (vite watch, project API server). Without this
      // yield, on Windows the preview-manager's sync work (npm bin
      // resolution, server.tsx drift check, etc.) piles onto the same
      // microtask as `initialize().then(...)` and starves /health.
      setTimeout(() => {
        pm.start().catch((err: any) => {
          console.error('[agent-runtime] Auto-start preview failed:', err.message)
        })
      }, 0)
    }
  } else if (externalAutoPreviewBlocked && (hasLegacyPkg || hasRootPkg)) {
    logTiming('External project with runtimeEnabled=false — skipping auto-preview-start')
  }
}

/**
 * Start the agent gateway (heavy: loads skills, MCP servers, sessions, BOOT.md).
 * Called after essentials are done — can run in background for warm pool assigns.
 */
let gatewayStarting = false
async function startGateway(): Promise<void> {
  if (gatewayStarting) {
    console.warn('[agent-runtime] startGateway() called while already starting — skipping')
    return
  }

  // Pool-mode invariant: the gateway starts the TypeScript + Pyright LSPs
  // (~450 MB combined RSS), prisma generate, and the canvas vite build
  // watcher. None of these should fire before /pool/assign, otherwise
  // every warm pool VM would sit at ~3 GB RSS even when idle. The plan
  // (vm-pool-oom-fix) tracks this property as part of the host-memory
  // budget for desktop VMs.
  if (state.isPoolMode && !state.poolAssigned) {
    console.warn(
      '[agent-runtime] startGateway() called in pool mode before /pool/assign — refusing. ' +
      'This would prematurely start the TS/Py LSPs and prisma engine, blowing the ' +
      'idle pool VM memory budget. The caller likely forgot to await onAssign().',
    )
    return
  }

  gatewayStarting = true
  logTiming('Starting agent gateway...')

  gatewayReadyPromise = new Promise<void>((resolve) => { gatewayReadyResolve = resolve })

  // Previously we awaited the S3 deps restore + `ensureWorkspaceDeps` here
  // before constructing the gateway, which meant the first `/agent/chat`
  // request 503'd for the entire cold install. The gateway itself does not
  // hard-require workspace node_modules — the LSP binary resolves from
  // agent-runtime's own deps, and the canvas build is gated on
  // `PreviewManager.depsReady` — so kick the restore+install in the background
  // and start the gateway immediately. The LSP start awaits
  // `workspaceDepsReadyPromise` (wired via `setWorkspaceDepsReady` below).
  if (s3SyncInstance && !s3SyncInstance.areDepsReady()) {
    startWorkspaceDepsInstall({ afterS3Restore: true })
  }

  const { AgentGateway } = await import('./gateway')
  agentGateway = new AgentGateway(WORKSPACE_DIR, state.currentProjectId!)
  // Gate the gateway's deps-dependent work (the LSP) on the background install
  // kicked off above / in essentials, instead of blocking the whole start.
  agentGateway.setWorkspaceDepsReady(() => workspaceDepsReadyPromise)
  // Wire the runtime's API-server-owning PreviewManager into the gateway
  // so prompt builders and tools can query/sync the project's backend.
  agentGateway.attachApiServer(getPreviewManager())
  agentGateway.setLogCallback((line: string) => {
    appendRuntimeConsoleLogLine(line)
    for (const listener of logStreamListeners) {
      try { listener(line) } catch {}
    }
  })

  if (s3SyncInstance || gitSyncInstance) {
    agentGateway.getMCPClientManager().setOnConfigPersisted(() => {
      // Fire both writers when either is present. In git_only mode
      // s3SyncInstance.triggerSync no-ops on Layer 2 (suppressed) but
      // still gates Layer 1 deps. In dual_shadow both write.
      s3SyncInstance?.triggerSync(true)
      if (gitSyncInstance) {
        triggerLargeFileSync()
        gitSyncInstance.triggerSync(true)
      }
    })
  }

  // BETA: per-chat git worktrees. Wire the durable-repo persist hook so that
  // worktree-branch commits/merges land in the persisted `.git` (all refs),
  // then recreate any in-flight chat worktrees that a cold start pruned.
  agentGateway.setRepoPersistHook(async () => {
    if (!repoStoreConfigFromEnv()) return
    const res = await persistDurableRepo()
    if (!res.ok) throw new Error(`durable repo persist failed: ${res.reason}`)
  })

  await agentGateway.start()

  if (agentGateway.isWorktreesEnabled()) {
    void agentGateway.recreateActiveWorktrees().catch((err: any) =>
      console.warn('[agent-runtime] recreateActiveWorktrees threw:', err?.message ?? err),
    )
  }

  gatewayReadyResolve?.()
  gatewayReadyResolve = null
  gatewayReadyPromise = null
  logTiming('Agent gateway started')
}

/**
 * Full initialization: essentials + gateway.
 * Used for non-pool-mode startup (cold start path).
 */
async function initialize(): Promise<void> {
  await initializeEssentials()
  await startGateway()
}

/**
 * Best-effort checkout of the stable `published/<subdomain>` pointer tag so a
 * published pod serves exactly what was published, not whatever HEAD the
 * durable repo currently points at (which a later in-IDE edit could move).
 * Detached-HEAD is fine — published pods never commit. Falls back silently to
 * the restored HEAD when the tag is missing (e.g. legacy repos).
 */
async function checkoutPublishedTag(subdomain: string): Promise<void> {
  if (!subdomain) return
  const { execFile } = await import('child_process')
  await new Promise<void>((resolve) => {
    execFile(
      'git',
      ['-C', WORKSPACE_DIR, 'checkout', '--quiet', `published/${subdomain}`],
      (err) => {
        if (err) {
          console.warn(`[agent-runtime] published-mode: could not checkout published/${subdomain} (using HEAD): ${err.message}`)
        } else {
          logTiming(`Published source pinned to tag published/${subdomain}`)
        }
        resolve()
      },
    )
  })
}

/**
 * Server-backed published initialization (SHOGO_PUBLISHED_MODE). Hydrates the
 * source read-only, overlays the durable writable state, runs `server.tsx`
 * via the PreviewManager (so `/api/*` is live), then arms the published-data
 * uploader. The agent gateway is deliberately NOT started.
 */
async function initializePublished(): Promise<void> {
  logTiming(`Published mode: initializing for subdomain=${PUBLISHED_SUBDOMAIN}`)

  // 1. Seed template files (idempotent) so a brand-new emptyDir has the base
  //    layout; git/S3 hydration below overlays the real published app.
  ensureWorkspaceFiles()

  // 2. Hydrate source read-only. Prefer the durable git repo (carries the
  //    published tag + the builder's seed DB); fall back to the S3 project
  //    archive. We deliberately do NOT start any source uploader/watcher —
  //    published source is immutable for the life of the pod.
  let hydrated = false
  const repoCfg = repoStoreConfigFromEnv()
  if (repoCfg) {
    try {
      const res = await restoreRepoFromStore(WORKSPACE_DIR, repoCfg)
      hydrated = res.restored
      if (hydrated) {
        await checkoutPublishedTag(PUBLISHED_SUBDOMAIN)
        logTiming('Published mode: source restored from git repo store')
      }
    } catch (err: any) {
      console.error('[agent-runtime] Published mode: git restore failed:', err?.message ?? err)
    }
  }
  if (!hydrated && (process.env.S3_WORKSPACES_BUCKET || process.env.S3_BUCKET)) {
    try {
      const sync = createS3SyncForProject(WORKSPACE_DIR, process.env.PROJECT_ID || '', {
        watchEnabled: false,
        syncInterval: 0,
        suppressProjectArchive: true,
      })
      if (sync) {
        const stats = await sync.downloadAll()
        hydrated = stats.errors.length === 0
        logTiming(`Published mode: source restored from S3 (downloaded=${stats.downloaded}, errors=${stats.errors.length})`)
      }
    } catch (err: any) {
      console.error('[agent-runtime] Published mode: S3 restore failed:', err?.message ?? err)
    }
  }
  if (!hydrated) {
    console.error('[agent-runtime] Published mode: NO source hydrated — the published app will not serve correctly')
  }

  // 3. Overlay durable writable state (end-user writes accumulated since the
  //    last cold start). Absent on first boot — the git seed DB is used then.
  publishedDataSyncInstance = createPublishedDataSyncFromEnv(WORKSPACE_DIR)
  if (publishedDataSyncInstance) {
    await publishedDataSyncInstance.restore()
  }

  // 4. Run the project's backend (deps install + prisma + build + server.tsx).
  //    The runtime's `/api/*` proxy + static `dist/` serve then front it.
  try {
    await getPreviewManager().start()
    logTiming('Published mode: preview/server pipeline started')
  } catch (err: any) {
    console.error('[agent-runtime] Published mode: preview start failed:', err?.message ?? err)
  }

  // 5. Arm the writable-state uploader (periodic + debounced DB watcher).
  if (publishedDataSyncInstance) {
    publishedDataSyncInstance.startAutoFlush()
  }
}

// =============================================================================
// In-Flight Request Tracking
// =============================================================================

let activeStreams = 0
let isShuttingDown = false

function trackStreamStart(): void { activeStreams++ }
function trackStreamEnd(): void { activeStreams = Math.max(0, activeStreams - 1) }

// =============================================================================
// Graceful Shutdown
// =============================================================================

const DRAIN_TIMEOUT_MS = 30_000

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log(`[agent-runtime] ${signal} received — draining ${activeStreams} active stream(s) (max ${DRAIN_TIMEOUT_MS / 1000}s)`)

  if (activeStreams > 0) {
    const drainStart = Date.now()
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (activeStreams <= 0 || Date.now() - drainStart > DRAIN_TIMEOUT_MS) {
          clearInterval(check)
          if (activeStreams > 0) {
            console.warn(`[agent-runtime] Drain timeout — ${activeStreams} stream(s) still active, proceeding with shutdown`)
          } else {
            console.log(`[agent-runtime] All streams drained in ${Date.now() - drainStart}ms`)
          }
          resolve()
        }
      }, 500)
    })
  }

  streamBufferStore.dispose()

  // Published mode: flush the writable-state archive (the SQLite DB + upload
  // dirs) before exit so end-user writes survive scale-to-zero / redeploys.
  if (publishedDataSyncInstance) {
    try {
      await publishedDataSyncInstance.flushAndShutdown(10_000)
    } catch (err: any) {
      console.error('[agent-runtime] Published data flush during shutdown failed:', err?.message ?? err)
    }
  }

  // Cloud sync shutdown order matters in `git_only` mode:
  //   1. GitWorkspaceSync.flushAndShutdown — last attempt at a clean push.
  //      If it succeeds we exit degraded state and can snapshot from HEAD.
  //      If it fails we stay degraded and must tar the live workspace.
  //   2. If we ended healthy AND in git_only mode, write the cold-start
  //      snapshot from `git archive HEAD` (no node_modules, no junk).
  //   3. Otherwise (s3, dual_shadow, or degraded git_only) run S3 flush
  //      with `forceProjectArchive: true` so a tarball always lands.
  try {
    const mode = resolveCloudSyncMode()
    if (gitSyncInstance) {
      // Final large-file offload before the last push so the durable repo
      // stays source-only and the offloaded asset set is current. Skipped
      // under LFS — flushAndShutdown's afterCommit runs the LFS object push.
      const lfCfg = largeFileSyncConfigFromEnv(WORKSPACE_DIR)
      if (lfCfg && !isLfsActive()) {
        try {
          await syncLargeFiles(lfCfg)
        } catch (err: any) {
          console.warn('[agent-runtime] large-file flush during shutdown threw:', err?.message ?? err)
        }
      }
      try {
        await gitSyncInstance.flushAndShutdown(5_000)
      } catch (err: any) {
        console.error(`[agent-runtime] Git flush error during shutdown:`, err?.message ?? err)
      }
    }

    if (s3SyncInstance) {
      const gitHealthy = gitSyncInstance != null && !gitSyncInstance.isDegraded
      if (mode === 'git_only' && gitHealthy) {
        // Healthy git_only path: HEAD is authoritative, so snapshot from
        // it. We still run flushAndShutdown() for the dep-cache (Layer 1)
        // pointer, since Layer 2 stays suppressed.
        try {
          await s3SyncInstance.snapshotProjectArchiveFromGit()
        } catch (snapErr: any) {
          console.warn(
            `[agent-runtime] snapshotFromGit failed; falling back to live-workspace tarball: ${snapErr?.message ?? snapErr}`,
          )
          await s3SyncInstance.flushAndShutdown({ timeoutMs: 10_000, forceProjectArchive: true })
        }
      } else {
        // s3 / dual_shadow / degraded git_only: always force the project
        // archive so the cold-start tarball reflects current disk state.
        const forceProjectArchive = mode === 'git_only'
        await s3SyncInstance.flushAndShutdown({ timeoutMs: 10_000, forceProjectArchive })
      }
    }
  } catch (err: any) {
    console.error(`[agent-runtime] Cloud sync flush error during shutdown:`, err.message)
  }

  // Flush every workspace member's S3 sync (cloud workspace runtime). Each
  // member owns its own prefix/subfolder, so the single-instance flush above
  // (which is null in workspace mode) doesn't cover them.
  if (workspaceMemberSyncs.size > 0) {
    console.log(`[agent-runtime] Flushing ${workspaceMemberSyncs.size} workspace member sync(s)`)
    await Promise.all(
      Array.from(workspaceMemberSyncs.entries()).map(async ([id, sync]) => {
        try {
          await sync.flushAndShutdown({ timeoutMs: 10_000, forceProjectArchive: true })
        } catch (err: any) {
          console.error(`[agent-runtime] Member sync flush failed for ${id}:`, err?.message ?? err)
        }
      }),
    )
  }

  try {
    if (agentGateway) {
      await agentGateway.stop()
    }
  } catch (err: any) {
    console.error(`[agent-runtime] Gateway stop error during shutdown:`, err.message)
  }

  // Stop every per-project workspace PreviewManager (vite watch + server.tsx
  // sidecar). The gateway only owns the global merged-root manager, so without
  // this the per-project vite/API children can outlive SIGTERM and linger as
  // orphans (the exact watcher pile-up that degrades after many open/closes).
  if (workspacePreviewManagers.size > 0) {
    console.log(
      `[agent-runtime] Stopping ${workspacePreviewManagers.size} workspace preview manager(s)`,
    )
    for (const pm of workspacePreviewManagers.values()) {
      try {
        pm.stop()
      } catch (err: any) {
        console.warn(`[agent-runtime] workspace preview stop during shutdown threw:`, err?.message ?? err)
      }
    }
    workspacePreviewManagers.clear()
  }

  console.log(`[agent-runtime] Graceful shutdown complete`)
  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// =============================================================================
// Start Server
// =============================================================================

if (state.isPoolMode && !state.poolAssigned) {
  logTiming('Pool mode: pre-seeding workspace with runtime template...')
  ensureWorkspaceFiles()
  ensureWorkspaceDeps(WORKSPACE_DIR).then(async () => {
    workspaceStatus.depsInstalled = true
    logTiming('Pool mode: workspace deps pre-seeded')

    // Pre-warm the preview pipeline (prisma generate + db push + codegen)
    // against the seeded template while the pod is still unassigned. This
    // moves the project-independent ~15-20s of setup off the user-perceived
    // assignment latency, so the first /pool/assign only pays the ~5s API
    // sidecar spawn and the canvas surfaces "Project Ready" in a few seconds
    // instead of sitting on "Starting API server…" for ~30s. Best-effort:
    // the assign path re-runs anything still missing via start()'s guards.
    if (!IS_WORKSPACE_RUNTIME) {
      try {
        await getPreviewManager().prewarm()
        logTiming('Pool mode: preview pipeline pre-warmed')
      } catch (err: any) {
        console.error('[agent-runtime] Pool preview pre-warm failed:', err?.message ?? err)
      }
    }
  }).catch(err => {
    console.error('[agent-runtime] Pool pre-seed deps failed:', err.message)
  })

  // Pre-warm the skill-server's node_modules in parallel with the workspace
  // deps copy. This moves the ~270 MB / ~9 s sync cpSync that the gateway
  // would otherwise do on first /pool/assign into the warm-pod boot phase,
  // shaving it off the user-perceived assignment latency. Runs in a
  // microtask so it doesn't block the bind on :8080 any longer than it
  // already takes — the cpSync is still synchronous, but it's now executed
  // while the pod is unclaimed, not while a user is waiting.
  queueMicrotask(() => {
    try {
      const copied = SkillServerManager.prewarmDeps(WORKSPACE_DIR)
      if (copied) logTiming('Pool mode: skill-server deps pre-warmed')
    } catch (err: any) {
      console.error('[agent-runtime] Pool skill-server pre-warm failed:', err?.message ?? err)
    }
  })
} else if (IS_PUBLISHED_MODE) {
  // Server-backed published app: run the project's server.tsx in production
  // without the agent gateway. No pool, no editing — serve-only.
  initializePublished()
    .then(() => {
      logTiming(`Published server listening on port ${PORT}`)
    })
    .catch((error) => {
      console.error('[agent-runtime] Published initialization failed:', error)
    })
} else {
  // Runs for both normal (non-pool) startup AND self-assigned cold-start pods.
  // Self-assigned pods have poolAssigned=true and need full init to restore
  // their workspace from S3 and start the gateway.
  initialize()
    .then(() => {
      logTiming(`Starting server on port ${PORT}`)
    })
    .catch((error) => {
      console.error('[agent-runtime] Initialization failed:', error)
    })
}

// Match a path like `/terminal/sessions/<id>/ws`; the id segment is opaque
// (no slashes) and is whatever PtySessionManager.create() assigned.
const WS_PATH_RE = /^\/terminal\/sessions\/([^/]+)\/ws$/

export default {
  port: PORT,
  fetch: async (req: Request, server: any) => {
    const url = new URL(req.url)
    // Hot-path bypass for /health: respond directly without going through
    // Hono's router. On Windows we observed a ~7s freeze during Bun's
    // first-request JIT compilation of the route tree, which made
    // RuntimeManager's /health probe time out repeatedly even though
    // Bun.serve() had already bound the port. This early return skips
    // that path for the smallest possible response.
    if (url.pathname === '/health' && req.method === 'GET') {
      // The slow path (createRuntimeApp's /health in shared-runtime) reports
      // `poolMode: IS_POOL_MODE && !state.poolAssigned`. The fast path needs
      // to match that contract or the warm-pool tests + RuntimeManager
      // probes can't distinguish an unassigned pool pod from an assigned
      // project pod. Both checks are sync reads of in-process state, so
      // they're safe in the hot path.
      const poolMode = state.isPoolMode && !state.poolAssigned
      // Mirror just enough of the slow-path `gateway` shape that the eval
      // worker readiness checks (vm-worker / docker-worker / k8s-worker)
      // can detect a started gateway. We deliberately do NOT call
      // agentGateway.getStatus() here — that walks the memory dir and
      // would re-introduce the Windows JIT freeze this fast path exists
      // to avoid. A plain field read is safe.
      const gatewayRunning = agentGateway?.running === true
      return new Response(
        JSON.stringify({ status: 'ok', projectId: process.env.PROJECT_ID, runtimeType: 'unified', poolMode, uptime: 0, fast: true, gateway: { running: gatewayRunning } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const upgrade = req.headers.get('upgrade')?.toLowerCase()
    const wsMatch = upgrade === 'websocket' ? WS_PATH_RE.exec(url.pathname) : null
    if (wsMatch) {
      const sessionId = wsMatch[1]
      const since = Number(url.searchParams.get('since')) || 0
      // Quick existence check pre-upgrade so a missing session returns a
      // proper 404 rather than a confusing accept-then-immediate-close.
      // We don't `attach()` here — that happens in the WS open handler.
      if (!ptyManager.get(sessionId)) {
        return new Response('Unknown session', { status: 404 })
      }
      const data: WsData = { manager: ptyManager, sessionId, since }
      const upgraded = server.upgrade(req, { data })
      if (upgraded) return undefined
      return new Response('WebSocket upgrade failed', { status: 500 })
    }
    return app.fetch(req)
  },
  websocket: {
    open: ptyWs.open,
    message: ptyWs.message,
    close: ptyWs.close,
  },
  idleTimeout: 0,
  // Durable-backup hydration (`POST /pool/hydrate`) streams a full project
  // tarball — source + uploaded assets + built `dist/` — into the guest. Bun's
  // default 128 MB request-body cap rejected large restored workspaces with a
  // 413, leaving those projects unable to load. Raise the cap so realistic
  // asset-heavy workspaces hydrate; 1 GiB stays well under the guest's 4 GB RAM.
  maxRequestBodySize: 1024 * 1024 * 1024,
}
