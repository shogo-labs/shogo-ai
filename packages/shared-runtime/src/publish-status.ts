// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Publish status vocabulary shared by the API (which runs a publish in the
 * background) and the agent runtime (which waits on it).
 *
 * A publish is no longer one HTTP request: `POST /publish` validates, records
 * `building` and returns 202, then the pipeline runs on its own and moves the
 * project's `publishStatus` through `building → uploading → configuring →
 * live | failed` (SHO-542). Both sides therefore need the same answers to
 * "is this status still in flight?", "how long before an in-flight status is
 * considered dead?", and "what does this failure code mean to a person?".
 */

import { publishRequestTimeoutMs } from './publish-timeouts'

export type PublishStatusValue = 'idle' | 'building' | 'uploading' | 'configuring' | 'live' | 'failed'

/** The statuses a running pipeline holds. Anything else is a settled publish. */
export const PUBLISH_IN_FLIGHT_STATUSES = ['building', 'uploading', 'configuring'] as const

export type PublishInFlightStatus = (typeof PUBLISH_IN_FLIGHT_STATUSES)[number]

export function isPublishInFlight(status: string | null | undefined): status is PublishInFlightStatus {
  return !!status && (PUBLISH_IN_FLIGHT_STATUSES as readonly string[]).includes(status)
}

/** A second publish was refused because one is already running. */
export const PUBLISH_IN_PROGRESS_CODE = 'publish_in_progress'
/**
 * An in-flight status outlived every step budget with no progress — the API pod
 * running it died (deploy, OOM, node drain). The publish is over, not running.
 */
export const PUBLISH_INTERRUPTED_CODE = 'publish_interrupted'

/**
 * How long an in-flight status is believed before it is treated as a dead
 * publish.
 *
 * It must outlast the whole pipeline, not one step: a server-backed Knative
 * publish legitimately spends 180 s building, 60 s downloading, 60 s uploading
 * and up to 150 s + 900 s configuring (image build included) — so a shorter
 * lease would let a second publish start on top of a live one. Derived from the
 * same step budgets the pipeline enforces, so an override of any step budget
 * moves both. Never below 10 minutes (the old fixed lease).
 */
export function publishInFlightTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(10 * 60_000, publishRequestTimeoutMs(env) + 30_000)
}

/** Default lease, for callers that have no env to pass. */
export const PUBLISH_IN_FLIGHT_TTL_MS = publishInFlightTtlMs()

/**
 * One-line, user-facing explanation of a publish failure code.
 *
 * The code is what `publishError` stores and what clients switch on; this is
 * the sentence to put in front of a person (or an agent) who only has the code.
 * Codes not listed fall back to a generic sentence — never to the bare code.
 */
export function publishFailureMessage(code: string | null | undefined): string {
  switch (code) {
    case 'build_failed':
    case 'build_timeout':
      return "The app's build failed, so nothing was deployed. The previous deploy (if any) is still serving."
    case 'download_failed':
    case 'download_timeout':
      return 'The build finished but its output could not be read back. Nothing was deployed; the previous deploy (if any) is still serving.'
    case 'no_files':
      return 'The build produced no files to publish — check that the app builds and outputs to dist/.'
    case 'upload_failed':
    case 'upload_timeout':
      return "Publishing failed while uploading the site to Shogo's storage. Nothing was deployed; the previous deploy (if any) is still serving."
    case 'configure_failed':
    case 'configure_timeout':
    case 'revision_not_ready':
      return "Publishing failed on Shogo's hosting side while setting up the published service — this is our infrastructure, not the app. The previous deploy (if any) is still serving."
    case 'database_unavailable':
      return "The published app's database was unavailable, so publishing stopped before deploying. Nothing was deployed."
    case 'schema_push_failed':
      return "The app's database schema could not be applied, so publishing stopped before deploying. Nothing was deployed."
    case 'seed_failed':
      return 'The published database could not be seeded from dev data, so publishing stopped before deploying. Nothing was deployed.'
    case 'destructive_schema_change':
      return 'This publish would destroy data in the published database (a dropped table or column, a narrowed type, or a new required column). Nothing was deployed.'
    case PUBLISH_IN_PROGRESS_CODE:
      return 'A publish is already running for this app. Wait for it to finish instead of starting another.'
    case PUBLISH_INTERRUPTED_CODE:
      return 'The publish stopped before it finished (the server restarted mid-publish). Nothing new is live — publish again.'
    case 'publish_failed':
    default:
      return 'Publishing failed. The previous deploy (if any) is still serving.'
  }
}
