// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  IDE_ALIGNMENT_TOGGLE_TEST_ID,
  ideAlignmentLabel,
  nextIdeAlignment,
} from '../../../lib/project-topbar-layout'

describe('ProjectTopBar IDE alignment toggle wiring', () => {
  test('uses the stable toggle identifier', () => {
    expect(IDE_ALIGNMENT_TOGGLE_TEST_ID).toBe('ide-sidebar-alignment-toggle')
  })

  test('builds the requested alignment label', () => {
    expect(ideAlignmentLabel('right')).toBe(
      'Switch IDE files and tabs to right alignment',
    )
  })

  test('flips between left and right alignment', () => {
    expect(nextIdeAlignment('left')).toBe('right')
    expect(nextIdeAlignment('right')).toBe('left')
  })
})
