// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Publish step budgets shared by the API (which runs the steps) and the
 * agent runtime (which waits on POST /publish). One module so an override
 * of `PUBLISH_BUILD_TIMEOUT_MS` (and the sibling vars) changes both sides
 * when it is set in both processes.
 */

export const DEFAULT_PUBLISH_BUILD_TIMEOUT_MS = 180_000
export const DEFAULT_PUBLISH_DOWNLOAD_TIMEOUT_MS = 60_000
export const DEFAULT_PUBLISH_UPLOAD_TIMEOUT_MS = 60_000
export const DEFAULT_PUBLISH_CONFIGURE_TIMEOUT_MS = 60_000
export const DEFAULT_PUBLISH_CONFIGURE_TIMEOUT_METAL_MS = 150_000
export const DEFAULT_PUBLISH_GIT_FLUSH_TIMEOUT_MS = 60_000
/** Slack so the caller's abort fires after the API has returned its own timeout. */
export const PUBLISH_REQUEST_SLACK_MS = 30_000

function positiveMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export interface PublishStepTimeouts {
  buildMs: number
  downloadMs: number
  uploadMs: number
  configureMs: number
  configureMetalMs: number
  gitFlushMs: number
}

export function publishStepTimeouts(env: NodeJS.ProcessEnv = process.env): PublishStepTimeouts {
  return {
    buildMs: positiveMs(env.PUBLISH_BUILD_TIMEOUT_MS, DEFAULT_PUBLISH_BUILD_TIMEOUT_MS),
    downloadMs: positiveMs(env.PUBLISH_DOWNLOAD_TIMEOUT_MS, DEFAULT_PUBLISH_DOWNLOAD_TIMEOUT_MS),
    uploadMs: positiveMs(env.PUBLISH_UPLOAD_TIMEOUT_MS, DEFAULT_PUBLISH_UPLOAD_TIMEOUT_MS),
    configureMs: positiveMs(env.PUBLISH_CONFIGURE_TIMEOUT_MS, DEFAULT_PUBLISH_CONFIGURE_TIMEOUT_MS),
    configureMetalMs: positiveMs(env.PUBLISH_CONFIGURE_TIMEOUT_METAL_MS, DEFAULT_PUBLISH_CONFIGURE_TIMEOUT_METAL_MS),
    gitFlushMs: positiveMs(env.PUBLISH_GIT_FLUSH_TIMEOUT_MS, DEFAULT_PUBLISH_GIT_FLUSH_TIMEOUT_MS),
  }
}

/**
 * How long a caller should wait for POST /publish: two build attempts
 * (the retry joins the runtime's in-flight build), a download, an upload,
 * and the longer metal configure, plus slack.
 *
 * `PUBLISH_REQUEST_TIMEOUT_MS` wins when set. Otherwise the same step env
 * vars the API reads are summed, so an override set on both processes
 * stays in sync.
 */
export function publishRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = positiveMs(env.PUBLISH_REQUEST_TIMEOUT_MS, 0)
  if (env.PUBLISH_REQUEST_TIMEOUT_MS && explicit > 0) return explicit
  const steps = publishStepTimeouts(env)
  return steps.buildMs * 2 + steps.downloadMs + steps.uploadMs + steps.configureMetalMs + PUBLISH_REQUEST_SLACK_MS
}
