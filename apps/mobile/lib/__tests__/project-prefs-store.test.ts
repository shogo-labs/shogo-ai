// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_PROJECT_FILTER,
  effectiveSidebarProjectFilter,
} from '../project-prefs-store'

describe('effectiveSidebarProjectFilter', () => {
  const stored = { sort: 'name' as const, scope: 'mine' as const }

  test('web keeps the stored sort and scope', () => {
    expect(effectiveSidebarProjectFilter(stored, 'web')).toEqual(stored)
  })

  test('native phone ignores stored filter prefs', () => {
    expect(effectiveSidebarProjectFilter(stored, 'ios')).toEqual(DEFAULT_PROJECT_FILTER)
    expect(effectiveSidebarProjectFilter(stored, 'android')).toEqual(DEFAULT_PROJECT_FILTER)
  })
})
