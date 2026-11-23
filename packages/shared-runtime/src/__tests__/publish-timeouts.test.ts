// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_PUBLISH_BUILD_TIMEOUT_MS,
  DEFAULT_PUBLISH_CONFIGURE_TIMEOUT_METAL_MS,
  DEFAULT_PUBLISH_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_PUBLISH_IMAGE_BUILD_TIMEOUT_MS,
  DEFAULT_PUBLISH_READINESS_TIMEOUT_MS,
  DEFAULT_PUBLISH_UPLOAD_TIMEOUT_MS,
  PUBLISH_REQUEST_SLACK_MS,
  DEFAULT_PUBLISH_ARTIFACT_MAX_BYTES,
  DEFAULT_PUBLISH_ARTIFACT_UPLOAD_TIMEOUT_MS,
  DEFAULT_PUBLISH_ARTIFACT_INLINE_MAX_BYTES,
  publishArtifactInlineMaxBytes,
  publishArtifactMaxBytes,
  publishArtifactUploadTimeoutMs,
  publishRequestTimeoutMs,
  publishStepTimeouts,
} from '../publish-timeouts'

describe('publish timeouts', () => {
  test('defaults cover two builds, download, upload, metal configure, image build, readiness, and slack', () => {
    expect(publishRequestTimeoutMs({})).toBe(
      DEFAULT_PUBLISH_BUILD_TIMEOUT_MS * 2
        + DEFAULT_PUBLISH_DOWNLOAD_TIMEOUT_MS
        + DEFAULT_PUBLISH_UPLOAD_TIMEOUT_MS
        + DEFAULT_PUBLISH_CONFIGURE_TIMEOUT_METAL_MS
        + DEFAULT_PUBLISH_IMAGE_BUILD_TIMEOUT_MS
        + DEFAULT_PUBLISH_READINESS_TIMEOUT_MS
        + PUBLISH_REQUEST_SLACK_MS,
    )
  })

  test('an explicit request timeout wins over the step sum', () => {
    expect(publishRequestTimeoutMs({ PUBLISH_REQUEST_TIMEOUT_MS: '90000' })).toBe(90_000)
  })

  test('step env overrides feed the request budget', () => {
    const env = { PUBLISH_BUILD_TIMEOUT_MS: '1000' }
    expect(publishStepTimeouts(env).buildMs).toBe(1000)
    expect(publishRequestTimeoutMs(env)).toBe(
      1000 * 2
        + DEFAULT_PUBLISH_DOWNLOAD_TIMEOUT_MS
        + DEFAULT_PUBLISH_UPLOAD_TIMEOUT_MS
        + DEFAULT_PUBLISH_CONFIGURE_TIMEOUT_METAL_MS
        + DEFAULT_PUBLISH_IMAGE_BUILD_TIMEOUT_MS
        + DEFAULT_PUBLISH_READINESS_TIMEOUT_MS
        + PUBLISH_REQUEST_SLACK_MS,
    )
  })

  test('the image build has its own budget, not the app build\'s', () => {
    // PUBLISH_BUILD_TIMEOUT_MS is the app build. Resizing it must not resize
    // the image build, which used to read the same variable.
    const env = { PUBLISH_BUILD_TIMEOUT_MS: '1000' }
    expect(publishStepTimeouts(env).imageBuildMs).toBe(DEFAULT_PUBLISH_IMAGE_BUILD_TIMEOUT_MS)
    expect(publishStepTimeouts({ PUBLISH_IMAGE_BUILD_TIMEOUT_MS: '5000' }).imageBuildMs).toBe(5000)
    expect(publishStepTimeouts({ PUBLISH_IMAGE_BUILD_TIMEOUT_MS: '5000' }).buildMs).toBe(
      DEFAULT_PUBLISH_BUILD_TIMEOUT_MS,
    )
  })
})

describe('publish artifact limits', () => {
  test('the build-context ceiling sits well under the 2 Gi Job volume', () => {
    expect(DEFAULT_PUBLISH_ARTIFACT_MAX_BYTES).toBeLessThan(2 * 1024 * 1024 * 1024)
    expect(publishArtifactMaxBytes({})).toBe(DEFAULT_PUBLISH_ARTIFACT_MAX_BYTES)
  })

  test('a region can raise or lower the ceiling', () => {
    expect(publishArtifactMaxBytes({ PUBLISH_ARTIFACT_MAX_BYTES: '1048576' })).toBe(1024 * 1024)
    // Nonsense is ignored, not treated as zero (which would refuse every publish).
    expect(publishArtifactMaxBytes({ PUBLISH_ARTIFACT_MAX_BYTES: 'lots' })).toBe(DEFAULT_PUBLISH_ARTIFACT_MAX_BYTES)
  })

  test('the inline ceiling is small enough that base64 of it is still a legal V8 string', () => {
    const chars = (bytes: number) => Math.ceil(bytes / 3) * 4
    // V8 refuses a string over 2^31-1 characters — which is what a tar at the
    // build-context ceiling produced before this cap (SHO-536).
    expect(chars(DEFAULT_PUBLISH_ARTIFACT_MAX_BYTES)).toBeGreaterThan(2 ** 31 - 1)
    expect(chars(DEFAULT_PUBLISH_ARTIFACT_INLINE_MAX_BYTES)).toBeLessThan(2 ** 31 - 1)
    expect(publishArtifactInlineMaxBytes({})).toBe(DEFAULT_PUBLISH_ARTIFACT_INLINE_MAX_BYTES)
    expect(publishArtifactInlineMaxBytes({ PUBLISH_ARTIFACT_INLINE_MAX_BYTES: '4096' })).toBe(4096)
    expect(publishArtifactInlineMaxBytes({ PUBLISH_ARTIFACT_INLINE_MAX_BYTES: 'lots' })).toBe(
      DEFAULT_PUBLISH_ARTIFACT_INLINE_MAX_BYTES,
    )
  })

  test('the artifact upload budget is minutes, not the 3-minute app build budget', () => {
    expect(publishArtifactUploadTimeoutMs({})).toBe(DEFAULT_PUBLISH_ARTIFACT_UPLOAD_TIMEOUT_MS)
    expect(publishArtifactUploadTimeoutMs({})).toBeGreaterThan(DEFAULT_PUBLISH_BUILD_TIMEOUT_MS)
    expect(publishArtifactUploadTimeoutMs({ PUBLISH_ARTIFACT_UPLOAD_TIMEOUT_MS: '60000' })).toBe(60_000)
  })
})
