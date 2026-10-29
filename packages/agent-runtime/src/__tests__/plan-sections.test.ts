// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { missingCodePlanSections } from '../plan-sections'

describe('missingCodePlanSections', () => {
  test('a code plan without the root-cause sections reports both', () => {
    expect(missingCodePlanSections('## Problem\nx\n## Changes\n- `src/http/client.ts`: read the setting')).toEqual(['Root cause', 'Options considered'])
  })
  test('headings at any level and in any case count', () => {
    expect(missingCodePlanSections('### root cause\nsrc/a.ts:3\n# Options Considered\n1. a')).toEqual([])
    expect(missingCodePlanSections('## Root cause\nsrc/a.py:3')).toEqual(['Options considered'])
  })
  test('plans that name no source file are not code plans', () => {
    expect(missingCodePlanSections('## Itinerary\nDay 1: Lisbon')).toEqual([])
  })
})
