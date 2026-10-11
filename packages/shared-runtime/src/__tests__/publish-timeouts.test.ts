// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_PUBLISH_BUILD_TIMEOUT_MS,
  DEFAULT_PUBLISH_CONFIGURE_TIMEOUT_METAL_MS,
  DEFAULT_PUBLISH_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_PUBLISH_UPLOAD_TIMEOUT_MS,
  PUBLISH_REQUEST_SLACK_MS,
  publishRequestTimeoutMs,
  publishStepTimeouts,
} from '../publish-timeouts'

describe('publish timeouts', () => {
  test('defaults cover two builds, download, upload, metal configure, and slack', () => {
    expect(publishRequestTimeoutMs({})).toBe(
      DEFAULT_PUBLISH_BUILD_TIMEOUT_MS * 2
        + DEFAULT_PUBLISH_DOWNLOAD_TIMEOUT_MS
        + DEFAULT_PUBLISH_UPLOAD_TIMEOUT_MS
        + DEFAULT_PUBLISH_CONFIGURE_TIMEOUT_METAL_MS
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
        + PUBLISH_REQUEST_SLACK_MS,
    )
  })
})
