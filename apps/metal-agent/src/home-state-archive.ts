// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Host-side fetch + GUARDED write of a project's encrypted home-directory
 * archive (`{projectId}/home-state.enc`): the guest's `~/.ssh`, `~/.oci`,
 * `~/.kube`, `~/.config`, ... (see packages/agent-runtime/src/home-state.ts).
 *
 * The bytes are opaque here. The guest encrypts them with a per-project key
 * before they leave the VM, so this module only moves ciphertext, and the
 * write guard is the same one `project-data-archive.ts` uses: a workspace may
 * replace only the exact archive it hydrated from, or create one where none
 * exists. A VM whose home hydrate failed is booting on an empty home, and the
 * guard is what stops that empty home from being exported over the real one.
 *
 * No daily restore points: this is credentials and tool config, small and
 * rewritten rarely, and the bucket's noncurrent-version retention already
 * covers an accidental overwrite.
 */

import { describeObject, type ArchiveRef } from './archive-ref'
import type { MetalConfig } from './config'
import { dataS3Target, planDataWrite, type DataLineage, type DataWriteOutcome } from './project-data-archive'
import { conditionalPutObject } from './s3-conditional'
import { workspaceS3 } from './workspace-archive'

/**
 * Hard ceiling on an encrypted home archive. Matches the guest's packed limit
 * (16 MiB) plus header room; anything larger could not be handed back anyway.
 */
export const HOME_STATE_MAX_BYTES = 16 * 1024 * 1024 + 1024

const CONTENT_TYPE = 'application/octet-stream'

/** Durable key for a project's encrypted home-directory archive. */
export function homeStateKey(projectId: string): string {
  return `${projectId}/home-state.enc`
}

/** Quarantine key for a home export we refused to write. Shares the `conflict/` TTL rule. */
export function homeStateQuarantineKey(projectId: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `conflict/${projectId}/${Date.now()}-${rand}-home.enc`
}

/** Describe the archive without downloading it. Null when absent; transport errors propagate. */
export async function describeHomeStateArchive(
  projectId: string,
  cfg: MetalConfig,
  expiresInSec: number,
): Promise<ArchiveRef | null> {
  const s3 = workspaceS3(cfg)
  if (!s3) return null
  return describeObject(s3.client, homeStateKey(projectId), expiresInSec)
}

async function quarantine(projectId: string, bytes: Uint8Array, cfg: MetalConfig): Promise<string | null> {
  const s3 = workspaceS3(cfg)
  if (!s3) return null
  const key = homeStateQuarantineKey(projectId)
  await s3.client.write(key, bytes, { type: CONTENT_TYPE })
  return key
}

/**
 * Write a project's encrypted home archive under the lineage guard. Same
 * outcomes and `preserveOnRefusal` semantics as `uploadProjectDataGuarded`.
 */
export async function uploadHomeStateGuarded(
  projectId: string,
  bytes: Uint8Array,
  opts: { lineage: DataLineage; preserveOnRefusal?: boolean },
  cfg: MetalConfig,
): Promise<DataWriteOutcome> {
  if (bytes.byteLength > HOME_STATE_MAX_BYTES) {
    return { status: 'too-large', bytes: bytes.byteLength, limit: HOME_STATE_MAX_BYTES }
  }

  const plan = planDataWrite(opts.lineage)
  if (plan.action === 'refuse') {
    const qkey = opts.preserveOnRefusal ? await quarantine(projectId, bytes, cfg) : null
    return { status: 'refused', reason: plan.reason, quarantineKey: qkey }
  }

  const target = dataS3Target(cfg)
  if (!target) return { status: 'skipped' }

  const result = await conditionalPutObject({
    target,
    key: homeStateKey(projectId),
    body: bytes,
    contentType: CONTENT_TYPE,
    precondition: plan.action === 'compare-and-swap' ? { ifMatch: plan.ifMatch } : { ifNoneMatch: '*' },
  })

  if (result.status === 'ok') {
    return plan.action === 'create-only'
      ? { status: 'created', etag: result.etag }
      : { status: 'written', etag: result.etag }
  }

  const qkey = opts.preserveOnRefusal ? await quarantine(projectId, bytes, cfg) : null
  return {
    status: 'conflict',
    quarantineKey: qkey,
    reason: plan.action === 'create-only' ? 'raced-create' : 'lineage',
  }
}
