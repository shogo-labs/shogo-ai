// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { ACTIVITY_SUMMARY_MAX, cleanActivitySummary } from '../services/conversation-activity-summary'

describe('cleanActivitySummary', () => {
  test('strips wrapping quotes and markdown', () => {
    expect(cleanActivitySummary('"**Found** three overdue invoices."')).toBe('Found three overdue invoices.')
    expect(cleanActivitySummary('`done`')).toBe('done')
    expect(cleanActivitySummary('# Title\n\nA result')).toBe('Title A result')
  })

  test('clips to 140 characters', () => {
    const cleaned = cleanActivitySummary('x'.repeat(200))
    expect(cleaned.length).toBe(ACTIVITY_SUMMARY_MAX)
    expect(cleaned.endsWith('…')).toBe(true)
  })
})
