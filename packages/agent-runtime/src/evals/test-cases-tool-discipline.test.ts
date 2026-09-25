// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `classifyEditFailureCause` — the pure classifier that
 * buckets a failed `edit_file` tool call into one of the three highest-
 * volume production failure signatures (stale/hallucinated `old_string`,
 * an ambiguous non-unique match, or a read-before-edit violation) instead
 * of a single opaque "errored" bit. See test-cases-tool-discipline.ts's
 * module doc for the production counts this maps to.
 *
 * The exact strings below are copied from gateway-tools.ts's `edit_file`
 * error returns so this test breaks (loudly) if the tool's wording ever
 * drifts out of sync with the classifier's matching logic.
 */

import { describe, expect, test } from 'bun:test'
import type { ToolCallRecord } from './types'
import { classifyEditFailureCause } from './test-cases-tool-discipline'

function editCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    name: 'edit_file',
    input: { path: 'src/lib/numbers.ts' },
    output: null,
    error: false,
    ...overrides,
  }
}

describe('classifyEditFailureCause', () => {
  test('returns null for a call that did not error', () => {
    const t = editCall({ error: false, output: { ok: true } })
    expect(classifyEditFailureCause(t)).toBeNull()
  })

  test('classifies "old_string not found" as stale_old_string', () => {
    const t = editCall({
      error: true,
      output: {
        error: 'old_string not found in src/lib/numbers.ts',
        hint: 'No similar content found. Try reading the file first to get the exact text.',
      },
    })
    expect(classifyEditFailureCause(t)).toBe('stale_old_string')
  })

  test('classifies "old_string found N times" as duplicate_match', () => {
    const t = editCall({
      error: true,
      output: {
        error: 'old_string found 3 times in src/lib/numbers.ts. Provide more context to make it unique, or set replace_all: true.',
      },
    })
    expect(classifyEditFailureCause(t)).toBe('duplicate_match')
  })

  test('classifies "File has not been read yet" as read_before_edit', () => {
    const t = editCall({
      error: true,
      output: { error: 'File has not been read yet. Read it first with read_file before editing.' },
    })
    expect(classifyEditFailureCause(t)).toBe('read_before_edit')
  })

  test('classifies the stale-mtime "modified since last read" case as read_before_edit too', () => {
    // Grouped with the "has not been read" signature — the module doc's own
    // failure-count breakdown ("359 'File has not been read yet' + 52
    // stale-read errors") already treats these as the same underlying
    // read-before-edit failure class.
    const t = editCall({
      error: true,
      output: {
        error: 'File has been modified since last read (by user, linter, or another process). Read it again before editing.',
      },
    })
    expect(classifyEditFailureCause(t)).toBe('read_before_edit')
  })

  test('classifies an unrelated edit_file error as other', () => {
    const t = editCall({
      error: true,
      output: { error: 'old_string and new_string must differ' },
    })
    expect(classifyEditFailureCause(t)).toBe('other')
  })

  test('is case-insensitive and works whether output is a string or an object', () => {
    const asString = editCall({ error: true, output: 'OLD_STRING NOT FOUND in Foo.tsx' })
    expect(classifyEditFailureCause(asString)).toBe('stale_old_string')

    const asObject = editCall({
      error: true,
      output: { error: 'Old_String Found 2 Times in foo.tsx. Provide more context.' },
    })
    expect(classifyEditFailureCause(asObject)).toBe('duplicate_match')
  })

  test('classifies purely off error/output shape (callers pre-filter to edit_file calls)', () => {
    const notAnEdit: ToolCallRecord = {
      name: 'read_file',
      input: {},
      output: { error: 'old_string not found in x.ts' },
      error: true,
    }
    expect(classifyEditFailureCause(notAnEdit)).toBe('stale_old_string')
  })
})
