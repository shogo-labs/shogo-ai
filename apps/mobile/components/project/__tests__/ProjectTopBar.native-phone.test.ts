// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  NATIVE_HEADER_PAD_BOTTOM,
  nativePhoneTitleInset } from "../../../lib/project-topbar-layout"

describe('ProjectTopBar native phone header', () => {
  test("centers the project title using the wider chrome inset", () => {
    expect(nativePhoneTitleInset(48, 92)).toBe(92)
    expect(nativePhoneTitleInset(92, 48)).toBe(92)
  })

  test("keeps equal chrome insets unchanged", () => {
    expect(nativePhoneTitleInset(60, 60)).toBe(60)
  })

  test('keeps header icons off the hairline under the bar', () => {
    expect(NATIVE_HEADER_PAD_BOTTOM).toBe(12)
  })
})
