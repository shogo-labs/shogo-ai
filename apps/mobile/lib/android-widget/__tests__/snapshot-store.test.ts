// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'

mock.module('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {} } }))

import { buildGlanceSnapshot } from '../../agent-glance'
import { parseStoredGlance } from '../snapshot-store'

describe('parseStoredGlance', () => {
  test('reads back what was saved', () => {
    const snapshot = buildGlanceSnapshot({ rows: [], now: 7 })
    expect(parseStoredGlance(JSON.stringify(snapshot))).toEqual(snapshot)
  })

  test('ignores anything that is not a snapshot', () => {
    expect(parseStoredGlance(null)).toBeNull()
    expect(parseStoredGlance('')).toBeNull()
    expect(parseStoredGlance('{not json')).toBeNull()
    expect(parseStoredGlance('null')).toBeNull()
    expect(parseStoredGlance(JSON.stringify({ version: 2, agents: [], generatedAt: 1 }))).toBeNull()
    expect(parseStoredGlance(JSON.stringify({ version: 1, agents: 'x', generatedAt: 1 }))).toBeNull()
    expect(parseStoredGlance(JSON.stringify({ version: 1, agents: [] }))).toBeNull()
  })
})
