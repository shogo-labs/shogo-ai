// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { applyFormat } from '../doc-markdown'

const at = (start: number, end = start) => ({ start, end })

describe('applyFormat — h3', () => {
  test('prefixes the line with ###', () => {
    const r = applyFormat('Title', at(0), 'h3')
    expect(r.text).toBe('### Title')
  })
})

describe('applyFormat — divider', () => {
  test('inserts a rule below the current text', () => {
    const r = applyFormat('Intro', at(5), 'divider')
    expect(r.text).toBe('Intro\n\n---')
    expect(r.selection.start).toBe(r.text.length)
  })

  test('does not add a second blank line when one is already there', () => {
    const r = applyFormat('Intro\n\n', at(7), 'divider')
    expect(r.text).toBe('Intro\n\n---')
  })
})

describe('applyFormat — table', () => {
  test('inserts a table skeleton and selects the first header cell', () => {
    const r = applyFormat('', at(0), 'table')
    expect(r.text).toBe('| Column | Column |\n| --- | --- |\n| Text | Text |')
    // The placeholder is selected, so typing replaces it rather than
    // appending to it.
    expect(r.text.slice(r.selection.start, r.selection.end)).toBe('Column')
  })

  test('separates the table from the paragraph above it', () => {
    const r = applyFormat('Intro', at(5), 'table')
    expect(r.text.startsWith('Intro\n\n| Column |')).toBe(true)
  })

  test('the inserted block is a table the markdown parser keeps on its own lines', () => {
    const r = applyFormat('', at(0), 'table')
    const lines = r.text.split('\n')
    expect(lines[1]).toBe('| --- | --- |')
  })
})
