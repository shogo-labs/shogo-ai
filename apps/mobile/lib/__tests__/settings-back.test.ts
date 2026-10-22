// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  APP_HOME_HREF,
  SETTINGS_WIDE_FALLBACK_HREF,
  leaveSettings,
} from '../settings-back'

function mockRouter(canGoBack = true) {
  const calls: string[] = []
  return {
    calls,
    router: {
      canGoBack: () => canGoBack,
      back: () => {
        calls.push('back')
      },
      replace: (href: string) => {
        calls.push(`replace:${href}`)
      },
    },
  }
}

describe('leaveSettings', () => {
  test('native phone always replaces onto Home', () => {
    const { calls, router } = mockRouter(true)
    leaveSettings(router, true)
    expect(calls).toEqual([`replace:${APP_HOME_HREF}`])
  })

  test('native phone ignores an empty history stack', () => {
    const { calls, router } = mockRouter(false)
    leaveSettings(router, true)
    expect(calls).toEqual([`replace:${APP_HOME_HREF}`])
  })

  test('wide layout uses history when it exists', () => {
    const { calls, router } = mockRouter(true)
    leaveSettings(router, false)
    expect(calls).toEqual(['back'])
  })

  test('wide layout falls back to projects with no history', () => {
    const { calls, router } = mockRouter(false)
    leaveSettings(router, false)
    expect(calls).toEqual([`replace:${SETTINGS_WIDE_FALLBACK_HREF}`])
  })
})
