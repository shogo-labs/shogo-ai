// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 *   bun test apps/api/src/lib/__tests__/heartbeat-home-region-filter.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { heartbeatHomeRegionFilter } from '../heartbeat-scheduler'

const EMPTY = { text: '', values: [] as unknown[] }
const P = {
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join('?').replace(/\s+/g, ' ').trim(),
    values,
  }),
  empty: EMPTY,
} as any

describe('heartbeatHomeRegionFilter', () => {
  test('single-region / local mode applies no partition', () => {
    expect(heartbeatHomeRegionFilter(P, null)).toBe(EMPTY)
  })

  test('a non-primary region only claims workspaces homed there', () => {
    expect(heartbeatHomeRegionFilter(P, { homeRegion: 'eu-frankfurt-1' })).toEqual({
      text: 'AND w."homeRegion" = ?',
      values: ['eu-frankfurt-1'],
    })
  })

  test('the primary region also claims legacy null-homeRegion workspaces', () => {
    expect(
      heartbeatHomeRegionFilter(P, {
        OR: [{ homeRegion: 'us-ashburn-1' }, { homeRegion: null }],
      }),
    ).toEqual({
      text: 'AND (w."homeRegion" = ? OR w."homeRegion" IS NULL)',
      values: ['us-ashburn-1'],
    })
  })
})
