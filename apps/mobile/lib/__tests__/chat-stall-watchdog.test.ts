// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  emptyResponseErrorAfterFinish,
  STALL_TIMEOUT_USER_MESSAGE,
  EMPTY_AGENT_RESPONSE_MESSAGE,
} from '../chat-stall-watchdog'

describe('emptyResponseErrorAfterFinish', () => {
  test('user Stop clears the banner', () => {
    expect(
      emptyResponseErrorAfterFinish({
        isAbort: true,
        userInitiatedStop: true,
        stallWatchdogTripped: false,
        hasContent: false,
      }),
    ).toBeNull()
  })

  test('stall-watchdog abort surfaces a timeout with retry, even when isAbort is set', () => {
    expect(
      emptyResponseErrorAfterFinish({
        isAbort: true,
        userInitiatedStop: false,
        stallWatchdogTripped: true,
        hasContent: false,
      }),
    ).toBe(STALL_TIMEOUT_USER_MESSAGE)
  })

  test('user Stop wins over a concurrent stall trip', () => {
    expect(
      emptyResponseErrorAfterFinish({
        isAbort: true,
        userInitiatedStop: true,
        stallWatchdogTripped: true,
        hasContent: false,
      }),
    ).toBeNull()
  })

  test('other aborts (unmount) still clear rather than scare the user', () => {
    expect(
      emptyResponseErrorAfterFinish({
        isAbort: true,
        userInitiatedStop: false,
        stallWatchdogTripped: false,
        hasContent: false,
      }),
    ).toBeNull()
  })

  test('finished with no content → empty-response banner', () => {
    expect(
      emptyResponseErrorAfterFinish({
        isAbort: false,
        userInitiatedStop: false,
        stallWatchdogTripped: false,
        hasContent: false,
      }),
    ).toBe(EMPTY_AGENT_RESPONSE_MESSAGE)
  })

  test('finished with content → no banner', () => {
    expect(
      emptyResponseErrorAfterFinish({
        isAbort: false,
        userInitiatedStop: false,
        stallWatchdogTripped: false,
        hasContent: true,
      }),
    ).toBeNull()
  })
})
