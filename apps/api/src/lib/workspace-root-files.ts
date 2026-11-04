// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The durable copy of a Personal workspace's **root** (SHO-285 Update 2,
 * section F).
 *
 * A workspace root — `AGENTS.md`, `MEMORY.md`, `memory/`, `skills/` — used to
 * live only on whichever machine had it open, which is exactly the "multiple
 * personal workspaces everywhere" problem Russell asked to remove: the same
 * account's memory read differently on the Mac, the Windows box and the cloud.
 *
 * The cloud is canonical. Every file of the root is one object under
 * `workspace-root/<workspaceId>/` (see `buildWorkspaceRootKey`), and every
 * device — the cloud workspace pod and each paired desktop — pulls a manifest
 * and pushes its own writes through API-signed URLs. Desktops hold no
 * object-store credentials, so they never talk to S3 directly.
 *
 * Two rules keep this from losing data:
 *
 *   • **Nothing is deleted by a sync.** A file removed on one device stays in
 *     the store until someone removes it there deliberately; a delete that races
 *     an edit is the case where a naive sync eats a memory file.
 *   • **A conflict never overwrites.** When a file changed on both sides since
 *     the device last pulled, the cloud's copy stays and the device's version is
 *     uploaded beside it as `<name>.conflict-<device>-<ts>.<ext>`.
 */

import {
  buildWorkspaceRootKey,
  buildWorkspaceRootPrefix,
  getPresignedReadUrl,
  getPresignedWriteUrl,
  headS3Object,
  listAllObjectsInS3,
} from './s3'
import {
  conflictPathFor,
  isSharedRootPath,
  type WorkspaceRootFile,
  type WorkspaceRootManifest,
} from '@shogo/shared-runtime'

/**
 * The skip list and the conflict-name rule live in `@shogo/shared-runtime`,
 * because the runtimes that push and pull through these routes run that same
 * module. Two copies of the list would drift, and a path one side hides while
 * the other sends is uploaded forever. Re-exported here so the routes and tests
 * have one import for everything about a workspace root.
 */
export { isSharedRootPath, conflictPathFor }
export type WorkspaceRootEntry = WorkspaceRootFile
export type { WorkspaceRootManifest }

/**
 * Read the manifest for a workspace root.
 *
 * `since` keeps the cost down: only objects modified after it need a HEAD to
 * recover the writer's `sha256`/instance metadata, so a desktop polling every
 * minute pays for a listing and nothing else when nothing changed.
 */
export async function readWorkspaceRootManifest(
  workspaceId: string,
  opts: { since?: Date | null } = {},
): Promise<WorkspaceRootManifest> {
  const prefix = buildWorkspaceRootPrefix(workspaceId)
  const objects = await listAllObjectsInS3(prefix)
  const since = opts.since ?? null
  const files: WorkspaceRootEntry[] = []

  for (const object of objects) {
    const path = object.relativePath
    if (!path || path.endsWith('/')) continue
    if (!isSharedRootPath(path)) continue

    let sha256: string | null = null
    let updatedByInstanceId: string | null = null
    const changedSince = !since || !object.lastModified || object.lastModified > since
    if (changedSince) {
      const head = await headS3Object(object.key).catch(() => null)
      if (head) {
        sha256 = head.metadata.sha256 || null
        updatedByInstanceId = head.metadata.instance || null
      }
    }

    files.push({
      path,
      etag: object.etag ?? null,
      size: object.size,
      updatedAt: object.lastModified ? object.lastModified.toISOString() : null,
      sha256,
      updatedByInstanceId,
    })
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  return { workspaceId, files, empty: files.length === 0 }
}

export interface PresignRequest {
  path: string
  action: 'read' | 'write'
  sha256?: string
  instanceId?: string
  contentType?: string
}

export interface PresignedUrl {
  path: string
  action: 'read' | 'write'
  url: string
}

/**
 * Sign read/write URLs for workspace-root files.
 *
 * A write signs the writer's `sha256` and instance id into the object's
 * metadata, so a later manifest can say who wrote what without the API keeping
 * a second index that could drift from the objects themselves.
 */
export async function presignWorkspaceRoot(
  workspaceId: string,
  files: PresignRequest[],
): Promise<{ urls: PresignedUrl[]; skipped: string[] }> {
  const urls: PresignedUrl[] = []
  const skipped: string[] = []

  for (const file of files) {
    if (!isSharedRootPath(file.path)) {
      skipped.push(file.path)
      continue
    }
    const key = buildWorkspaceRootKey(workspaceId, file.path)
    if (file.action === 'write') {
      urls.push({
        path: file.path,
        action: 'write',
        url: await getPresignedWriteUrl(key, {
          contentType: file.contentType || 'application/octet-stream',
          metadata: {
            ...(file.sha256 ? { sha256: file.sha256 } : {}),
            ...(file.instanceId ? { instance: file.instanceId } : {}),
          },
        }),
      })
    } else {
      urls.push({ path: file.path, action: 'read', url: await getPresignedReadUrl(key) })
    }
  }

  return { urls, skipped }
}

/**
 * Conflict copies a device has not dealt with yet, for the agent's context.
 */
export function conflictCopiesOf(manifest: WorkspaceRootManifest): WorkspaceRootEntry[] {
  return manifest.files.filter((file) => file.path.includes('.conflict-'))
}
