// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What a Knative Revision says about itself (SHO-536 §C).
 *
 * `configurePublishedService` used to record every publish as `ready` as soon as
 * the ksvc was created. Deployment `cmwp5w12…` of a published app claimed
 * `ready` while revisions 00006/00007 had exited with ExitCode137 and none of
 * its DomainMappings resolved — the Deployment tab showed a healthy deploy of an
 * app that served nothing. This is the one place that turns a Revision object
 * into ready / still pending / failed with a reason a person can act on, so the
 * decision is testable without a cluster.
 */

export type PublishedRevisionState =
  | { state: 'ready' }
  | { state: 'pending'; reason: string }
  | { state: 'failed'; reason: string }

/**
 * `Ready=False` reasons that never resolve on their own.
 *
 * Everything else — `Deploying`, `ContainerCreating`, a Revision that has not
 * been observed yet — is a rollout in progress, which is what a Revision looks
 * like for its first seconds of life.
 */
const TERMINAL_REVISION_REASONS = new Set([
  'RevisionFailed',
  'ProgressDeadlineExceeded',
  'ContainerMissing',
  'InvalidRevision',
])


/**
 * Ready / pending / failed for one Revision, from its `status`.
 *
 * A container that exited non-zero is reported as failed even before the Ready
 * condition settles: ExitCode137 (OOMKilled) is the failure that was silently
 * recorded as a healthy deployment, and it never turns into a Ready=False on
 * its own in the window a publish waits.
 */
export function publishedRevisionState(revision: unknown): PublishedRevisionState {
  const row = revision as
    | {
        metadata?: { name?: string }
        status?: {
          conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>
          containerStatuses?: unknown
        }
      }
    | null
    | undefined
  const name = typeof row?.metadata?.name === 'string' ? row.metadata.name : 'the new revision'
  if (!row) return { state: 'pending', reason: 'the published service reported no revision yet' }

  const exit = describeContainerExit(row.status?.containerStatuses)
  if (exit) return { state: 'failed', reason: `${name} ${exit}` }

  const ready = (row.status?.conditions ?? []).find((c) => c?.type === 'Ready')
  if (!ready) return { state: 'pending', reason: `${name} has no Ready condition yet` }

  const detail = [ready.reason, ready.message].filter(Boolean).join(': ')
  if (ready.status === 'True') return { state: 'ready' }
  // Ready=False is normal while a Revision is deploying — Knative reports it
  // with `reason: Deploying` until the pod answers. Reading that as a failure
  // failed a publish that came up 12 seconds later and printed "not Ready
  // within 120s" without ever having waited. Only a terminal reason fails here;
  // a container that died is caught above by its exit status.
  if (ready.status === 'False' && TERMINAL_REVISION_REASONS.has(ready.reason ?? '')) {
    return { state: 'failed', reason: `${name} is not Ready — ${detail || 'no reason given'}` }
  }
  return { state: 'pending', reason: `${name} is still starting — ${detail || 'Ready is False'}` }
}

/**
 * `exited with ExitCode137 (OOMKilled)` for a container that died, else null.
 *
 * Reads `state.terminated` and `lastState.terminated`: a crash-looping container
 * spends most of its time restarting, and the exit that matters is the last one.
 */
function describeContainerExit(statuses: unknown): string | null {
  for (const entry of Array.isArray(statuses) ? statuses : []) {
    const terminated = (entry as any)?.state?.terminated ?? (entry as any)?.lastState?.terminated
    if (!terminated) continue
    const code = Number(terminated.exitCode)
    if (!Number.isFinite(code) || code === 0) continue
    return `exited with ExitCode${code}${terminated.reason ? ` (${terminated.reason})` : ''}`
  }
  return null
}
