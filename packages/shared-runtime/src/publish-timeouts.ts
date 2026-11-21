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
/**
 * The per-commit image build a server-backed Knative publish runs *inside* the
 * configure step. Its own budget, so the configure timeout can cover it.
 */
export const DEFAULT_PUBLISH_IMAGE_BUILD_TIMEOUT_MS = 900_000
export const DEFAULT_PUBLISH_GIT_FLUSH_TIMEOUT_MS = 60_000
/** Slack so the caller's abort fires after the API has returned its own timeout. */
export const PUBLISH_REQUEST_SLACK_MS = 30_000

/**
 * Largest publish build context the API will hand to a build, in bytes.
 *
 * The BuildKit Job's `src` volume is a 2 Gi `emptyDir`, so an artifact above
 * that is an eviction with no explanation. Well under it, because the context
 * must unpack *and* the build needs room for its own work. Media no longer
 * counts toward this (SHO-485 keeps LFS objects and `dist/` files ≥ 5 MiB out
 * of the artifact), so a project that trips it has something else wrong.
 */
export const DEFAULT_PUBLISH_ARTIFACT_MAX_BYTES = 1536 * 1024 * 1024

/**
 * How long the API waits for the runtime to hash the context, replace large
 * media with pointers and upload the tar to object storage.
 *
 * Not the 180 s app-build budget: on a media-heavy project the runtime reads
 * every offloadable byte once (to content-address it), and a fixed 3-minute
 * abort used to fire mid-upload, which reads as `artifact_missing` forever.
 */
export const DEFAULT_PUBLISH_ARTIFACT_UPLOAD_TIMEOUT_MS = 20 * 60_000

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
  imageBuildMs: number
  gitFlushMs: number
}

export function publishStepTimeouts(env: NodeJS.ProcessEnv = process.env): PublishStepTimeouts {
  return {
    buildMs: positiveMs(env.PUBLISH_BUILD_TIMEOUT_MS, DEFAULT_PUBLISH_BUILD_TIMEOUT_MS),
    downloadMs: positiveMs(env.PUBLISH_DOWNLOAD_TIMEOUT_MS, DEFAULT_PUBLISH_DOWNLOAD_TIMEOUT_MS),
    uploadMs: positiveMs(env.PUBLISH_UPLOAD_TIMEOUT_MS, DEFAULT_PUBLISH_UPLOAD_TIMEOUT_MS),
    configureMs: positiveMs(env.PUBLISH_CONFIGURE_TIMEOUT_MS, DEFAULT_PUBLISH_CONFIGURE_TIMEOUT_MS),
    configureMetalMs: positiveMs(env.PUBLISH_CONFIGURE_TIMEOUT_METAL_MS, DEFAULT_PUBLISH_CONFIGURE_TIMEOUT_METAL_MS),
    imageBuildMs: positiveMs(env.PUBLISH_IMAGE_BUILD_TIMEOUT_MS, DEFAULT_PUBLISH_IMAGE_BUILD_TIMEOUT_MS),
    gitFlushMs: positiveMs(env.PUBLISH_GIT_FLUSH_TIMEOUT_MS, DEFAULT_PUBLISH_GIT_FLUSH_TIMEOUT_MS),
  }
}

/** {@link DEFAULT_PUBLISH_ARTIFACT_MAX_BYTES}, overridable per region. */
export function publishArtifactMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return positiveMs(env.PUBLISH_ARTIFACT_MAX_BYTES, DEFAULT_PUBLISH_ARTIFACT_MAX_BYTES)
}

/** {@link DEFAULT_PUBLISH_ARTIFACT_UPLOAD_TIMEOUT_MS}, overridable per region. */
export function publishArtifactUploadTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveMs(env.PUBLISH_ARTIFACT_UPLOAD_TIMEOUT_MS, DEFAULT_PUBLISH_ARTIFACT_UPLOAD_TIMEOUT_MS)
}

/**
 * How long a caller should wait for POST /publish: two build attempts
 * (the retry joins the runtime's in-flight build), a download, an upload,
 * the longer metal configure, the per-commit image build that runs inside
 * the configure step, plus slack.
 *
 * `PUBLISH_REQUEST_TIMEOUT_MS` wins when set. Otherwise the same step env
 * vars the API reads are summed, so an override set on both processes
 * stays in sync.
 */
export function publishRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = positiveMs(env.PUBLISH_REQUEST_TIMEOUT_MS, 0)
  if (env.PUBLISH_REQUEST_TIMEOUT_MS && explicit > 0) return explicit
  const steps = publishStepTimeouts(env)
  return (
    steps.buildMs * 2
    + steps.downloadMs
    + steps.uploadMs
    + steps.configureMetalMs
    + steps.imageBuildMs
    + PUBLISH_REQUEST_SLACK_MS
  )
}
