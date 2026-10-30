// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The cloud half of a move's files.
 *
 * On Kubernetes the API pod holds no project files at all: a project's code
 * lives in its runtime pod and, durably, in S3 under the project's prefix. A
 * move that walks `WORKSPACES_DIR` on the API pod therefore finds nothing —
 * that is the bug this module exists to fix (SHO-252: a real cloud → desktop
 * move carried 1,956 rows and **zero** files, and still reported `done`).
 *
 * So every file question is asked of the store the runtime actually reads:
 *
 *   read     the runtime pod's bundle (projects) and merged workspace root
 *            (workspace-level files) — the same sources export uses;
 *   write    S3 under the project's prefix, exactly as project import seeds a
 *            freshly imported project (`createS3SyncForProject`).
 *
 * Non-Kubernetes callers never reach this module: `serve.ts` and `receive.ts`
 * only branch here when {@link moveUsesCloudStorage} is true, so desktop ↔
 * desktop and local mode keep their filesystem behaviour byte for byte.
 */

import { AgentClient } from '@shogo-ai/sdk/agent'
import { createS3SyncForProject } from '@shogo/shared-runtime'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { importCloudModule } from '../../lib/cloud-import'
import { deriveProjectRuntimeToken } from '../../lib/project-runtime-token'
import {
  collectWorkspacePodFiles,
  fetchRuntimeWorkspaceBundle,
  isExcludedRelPath,
  isKubernetes,
  workspacesDir,
} from '../workspace-export/files'
import { moveDirFor, walkMoveFiles } from './files'
import { isMoveIgnored, moveIgnoreRules } from './ignores'
import {
  WORKSPACE_ROOT_ID,
  WorkspaceMoveError,
  type MoveFileEntry,
  type MoveFileManifest,
} from './types'

/**
 * Whether a move must read and write through pod + S3 rather than a local
 * directory. The single switch `serve.ts` / `receive.ts` branch on.
 */
export function moveUsesCloudStorage(): boolean {
  return isKubernetes()
}

function assertSafeRelPath(relPath: string): string {
  const safe = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!safe || safe.split('/').includes('..')) {
    throw new Error(`unsafe path: ${relPath.slice(0, 120)}`)
  }
  return safe
}

async function projectPodClient(projectId: string): Promise<AgentClient> {
  // `importCloudModule` keeps the Knative/warm-pool graph out of the desktop
  // bundle, which mounts these same routes.
  const { getProjectPodUrl } =
    await importCloudModule<typeof import('../../lib/knative-project-manager')>(
      './knative-project-manager',
    )
  return new AgentClient({
    baseUrl: await getProjectPodUrl(projectId),
    headers: { 'x-runtime-token': await deriveProjectRuntimeToken(projectId) },
    workspaceScope: 'project',
  })
}

async function workspacePodClient(workspaceId: string, projectIds: string[]): Promise<AgentClient> {
  const [{ getWorkspacePodUrl }, { deriveWorkspaceRuntimeToken }] = await Promise.all([
    importCloudModule<typeof import('../../lib/knative-workspace-manager')>(
      './knative-workspace-manager',
    ),
    import('../../lib/workspace-runtime-token'),
  ])
  return new AgentClient({
    baseUrl: await getWorkspacePodUrl(workspaceId, [...projectIds]),
    headers: { 'x-runtime-token': deriveWorkspaceRuntimeToken(workspaceId) },
  })
}

/**
 * Turn a pod bundle into the manifest a move diffs against.
 *
 * Two shapes reach here, both straight from a runtime: `/agent/workspace/bundle`
 * answers with base64 strings, while `collectWorkspacePodFiles` decodes them on
 * the way in.
 *
 * The pod already drops `node_modules`/`.git`/caches, but not a project's own
 * `.shogoignore` or the move's default rules (`out/`, `.tmp/`, `dist/`), so
 * they are applied here — otherwise a cloud source would carry build output the
 * same project would not carry from a desktop.
 */
export function manifestEntriesFromBundle(
  files: Record<string, string | Uint8Array> | undefined,
): MoveFileEntry[] {
  const rules = moveIgnoreRules()
  const entries: MoveFileEntry[] = []
  for (const [rawPath, content] of Object.entries(files ?? {})) {
    const path = rawPath.replace(/\\/g, '/')
    if (!path || isMoveIgnored(path, false, rules) || isExcludedRelPath(path)) continue
    const bytes =
      typeof content === 'string' ? Buffer.from(content, 'base64') : Buffer.from(content)
    entries.push({
      path,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return entries
}

/** A project's files as the runtime pod holds them. */
export async function cloudProjectFileManifest(projectId: string): Promise<MoveFileManifest> {
  const bundle = await fetchRuntimeWorkspaceBundle(projectId)
  return {
    projectId,
    entries: manifestEntriesFromBundle(bundle?.files),
    ignored: { files: 0, bytes: 0 },
  }
}

/**
 * The workspace's own root files (AGENTS.md, MEMORY.md, `.shogo/`, …) as the
 * merged workspace runtime holds them — the same source export reads.
 */
export async function cloudWorkspaceRootFileManifest(
  workspaceId: string,
  projectIds: readonly string[],
): Promise<MoveFileManifest> {
  const collected = await collectWorkspacePodFiles(workspaceId, [...projectIds])
  const { files } = collected
  return {
    projectId: WORKSPACE_ROOT_ID,
    entries: manifestEntriesFromBundle(files),
    ignored: { files: 0, bytes: 0 },
  }
}

/** One project file's bytes, straight from the runtime pod. */
export async function readCloudProjectFile(projectId: string, relPath: string): Promise<Uint8Array> {
  const safe = assertSafeRelPath(relPath)
  const client = await projectPodClient(projectId)
  return client.readFileBytes(safe)
}

/** One workspace-root file's bytes, from the merged workspace runtime. */
export async function readCloudWorkspaceRootFile(
  workspaceId: string,
  projectIds: readonly string[],
  relPath: string,
): Promise<Uint8Array> {
  const safe = assertSafeRelPath(relPath)
  const client = await workspacePodClient(workspaceId, [...projectIds])
  return client.readFileBytes(safe)
}

/**
 * Fail loudly when this instance cannot store files the runtime will read.
 *
 * An unconfigured bucket used to mean "write to the API pod's disk, report
 * `done`, lose the files" — the pod's disk is not what the runtime reads. A move
 * that cannot store its files must fail, not pretend (SHO-252 AC 2).
 */
export function assertTargetStorageConfigured(): void {
  if (!process.env.S3_WORKSPACES_BUCKET) {
    throw new WorkspaceMoveError(
      'This Shogo Cloud instance has no workspace storage bucket configured, so moved files could not be read back by the runtime. Nothing was stored — retry once storage is configured.',
      500,
      'workspace_move_cloud_storage_unconfigured',
    )
  }
}

/** The S3 handle for one target project, or a loud failure. */
function targetProjectStore(projectId: string, dir: string) {
  assertTargetStorageConfigured()
  // A move writes a project the target has just created, so there is no prior
  // archive read to anchor a conditional write — same opt-out as import.
  const sync = createS3SyncForProject(dir, projectId, { allowUnconditionalWrite: true })
  if (!sync) {
    throw new WorkspaceMoveError(
      'This Shogo Cloud instance could not open workspace storage, so moved files could not be stored. Nothing was stored.',
      500,
      'workspace_move_cloud_storage_unconfigured',
    )
  }
  return sync
}

/**
 * Pull what the store already holds for this project into the staging dir, so
 * the manifest that follows describes S3 rather than one pod's leftover disk.
 * A resumed move then sends only what is genuinely missing.
 */
export async function hydrateTargetProject(projectId: string, dir: string): Promise<void> {
  const sync = targetProjectStore(projectId, dir)
  const stats = await sync.downloadAll()
  const errors = (stats?.errors ?? []).filter(Boolean)
  if (errors.length) {
    throw new WorkspaceMoveError(
      `Could not read project ${projectId} from cloud storage: ${errors.join('; ')}`.slice(0, 500),
      502,
      'workspace_move_cloud_storage_read_failed',
    )
  }
}

/**
 * Store a project's received files under its S3 prefix — the same call project
 * import makes so a warm pod's `downloadAll()` finds the archive.
 */
export async function storeTargetProject(projectId: string, dir: string): Promise<void> {
  if (!existsSync(dir)) return
  const sync = targetProjectStore(projectId, dir)
  const stats = await sync.uploadAll(false)
  const errors = (stats?.errors ?? []).filter(Boolean)
  if (errors.length) {
    throw new WorkspaceMoveError(
      `Could not store project ${projectId} in cloud storage: ${errors.join('; ')}`.slice(0, 500),
      502,
      'workspace_move_cloud_storage_write_failed',
    )
  }
}

/** Where the API pod stages a project's received files before they go to S3. */
export function moveStagingDir(projectId: string, workspaceId: string, base = workspacesDir()): string {
  return moveDirFor({ projectId, workspaceId, base })
}

/**
 * The manifest of what a target staging dir holds, hashed the same way the
 * source hashes its files.
 */
export async function stagingManifest(
  projectId: string,
  workspaceId: string,
  base = workspacesDir(),
): Promise<MoveFileManifest> {
  const dir = moveStagingDir(projectId, workspaceId, base)
  const walk = await walkMoveFiles(dir, { rules: moveIgnoreRules(dir), hash: true })
  return { projectId, entries: walk.entries, ignored: walk.ignored }
}

/**
 * Why a workspace-root move at a cloud target is not durable yet.
 *
 * A workspace runtime pod mounts its `WORKSPACE_DIR` as an `emptyDir` and
 * hydrates only *project* members from S3 (`workspace-hydration.ts`), so there
 * is no cloud store for workspace-level files. The bytes still land on the
 * target and are readable there (a move is not lossy while it is running), but
 * a runtime restart re-seeds the root instead of restoring them. Said out loud
 * rather than discovered later.
 */
export const CLOUD_WORKSPACE_ROOT_NOTICE =
  'Workspace-level files (AGENTS.md, MEMORY.md, .shogo/, …) were written to the target workspace root, but Shogo Cloud has no durable store for workspace-level files yet: they are readable on the target now and will not survive a runtime restart. Project files are stored in cloud storage and are durable.'

export function isWorkspaceRootPath(projectId: string): boolean {
  return projectId === WORKSPACE_ROOT_ID || projectId.startsWith('.workspace-roots/')
}
