// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Published-commit git tags.
 *
 * A publish writes two tags into the project's durable repo (pod-owned): an
 * immutable `publish/<subdomain>/<unix-ts>` history entry, and the stable
 * `published/<subdomain>` pointer the commit graph resolves "what's live" from.
 * The pod owns the repo, so both are created by `/agent/git-flush` and the API
 * only records the resulting HEAD.
 *
 * Lives here (not in `routes/publish.ts`) because the project-delete teardown
 * also has to drop the pointer — and a hook must not import a route module.
 */

import { publishStepTimeouts } from '@shogo/shared-runtime/publish-timeouts'
import { deriveProjectRuntimeToken } from '../lib/project-runtime-token'

/**
 * Force the runtime pod to flush its git sync so the published source is
 * committed + pushed into the durable repo. Best-effort — a pod in legacy `s3`
 * mode (or with git sync inactive) returns `flushed:false` and we fall back to
 * whatever HEAD the durable repo already holds. Never throws; the publish must
 * still proceed.
 */
export async function flushGitSync(
  projectId: string,
  opts: {
    tags?: Array<{ name: string; message?: string; force?: boolean }>
    deleteTags?: string[]
  } = {},
): Promise<{ sha: string | null } | null> {
  const { gitFlushMs } = publishStepTimeouts()
  try {
    const { getProjectPodUrl } = await import('../lib/knative-project-manager')
    const podUrl = await getProjectPodUrl(projectId)
    const response = await fetch(`${podUrl}/agent/git-flush`, {
      method: 'POST',
      headers: {
        'x-runtime-token': await deriveProjectRuntimeToken(projectId),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tags: opts.tags, deleteTags: opts.deleteTags }),
      signal: AbortSignal.timeout(gitFlushMs),
    })
    if (!response.ok) {
      console.warn(`[Publish] git-flush returned ${response.status} for ${projectId} (continuing)`)
      return null
    }
    const result = (await response.json().catch(() => ({}))) as { sha?: string }
    console.log(`[Publish] git-flush for ${projectId}:`, result)
    return { sha: result.sha ?? null }
  } catch (err: any) {
    console.warn(`[Publish] git-flush failed for ${projectId} (continuing):`, err?.message ?? err)
    return null
  }
}

/**
 * Best-effort removal of the stable `published/<subdomain>` pointer tag (the
 * immutable `publish/<subdomain>/<ts>` history tags are intentionally kept).
 * Used on unpublish/delete so the graph stops marking any commit as live.
 */
export async function deletePublishPointer(projectId: string, subdomain: string): Promise<void> {
  await flushGitSync(projectId, { deleteTags: [`published/${subdomain}`] })
}
