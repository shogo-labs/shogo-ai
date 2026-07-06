// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// The classifier feeds the `errorClass` label on the canvas runtime-health
// SLO events. Keep these buckets stable — SigNoz saved queries group by them.

import { describe, test, expect } from 'bun:test'
import { classifyCanvasError, type CanvasErrorClass } from '../canvas-slo'

describe('classifyCanvasError', () => {
  const cases: Array<[string, CanvasErrorClass]> = [
    ['Element type is invalid: expected a string ... but got: boolean.', 'invalid_element'],
    ['Maximum update depth exceeded.', 'render_loop'],
    ['Uncaught ReferenceError: Tabs is not defined', 'missing_reference'],
    ["Cannot find name 'BarChart3'.", 'missing_reference'],
    ['TypeError: x.map is not a function', 'not_a_function'],
    ["Cannot read properties of undefined (reading 'weeklyGoalMinutes')", 'undefined_access'],
    ['Hydration failed because the initial UI does not match', 'hydration'],
    ['some entirely unrelated error', 'other'],
    ['', 'other'],
  ]
  for (const [input, expected] of cases) {
    test(`classifies ${JSON.stringify(input)} as ${expected}`, () => {
      expect(classifyCanvasError(input)).toBe(expected)
    })
  }

  test('invalid_element wins over undefined_access when both could match', () => {
    // "Element type is invalid" also contains "reading"-adjacent phrasing in
    // some stacks; the specific React message must take precedence.
    expect(classifyCanvasError('Element type is invalid, check the render method')).toBe('invalid_element' as CanvasErrorClass)
  })
})
