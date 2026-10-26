// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { normalizeRichTextPaste } from '../rich-text-paste'

describe('normalizeRichTextPaste — pasted bullet glyphs', () => {
  test('a Docs bullet run becomes a markdown list instead of one line', () => {
    expect(normalizeRichTextPaste('•\tItem one\n•\tItem two')).toBe('- Item one\n- Item two')
    expect(normalizeRichTextPaste('• Item one\n• Item two')).toBe('- Item one\n- Item two')
  })

  test('keeps nesting, which rich text indents with a tab', () => {
    expect(normalizeRichTextPaste('•\tParent\n\t•\tChild one\n\t•\tChild two')).toBe(
      '- Parent\n    - Child one\n    - Child two',
    )
  })

  test('a bullet glyph inside a quoted reply keeps its quote', () => {
    expect(normalizeRichTextPaste('> • item one\n> • item two')).toBe('> - item one\n> - item two')
  })

  test('leaves a glyph that is not at the start of a line alone', () => {
    expect(normalizeRichTextPaste('compass · heading')).toBe('compass · heading')
  })
})

describe('normalizeRichTextPaste — rich-text list indentation', () => {
  test('a tab-indented numbered list stops being a code block', () => {
    expect(normalizeRichTextPaste('\t1. one\n\t2. two')).toBe('1. one\n2. two')
  })

  test('a four-space-indented numbered list stops being a code block', () => {
    expect(normalizeRichTextPaste('    1. one\n    2. two')).toBe('1. one\n2. two')
  })

  test('three spaces is already a list, and is left alone', () => {
    expect(normalizeRichTextPaste('   1. one\n   2. two')).toBe('   1. one\n   2. two')
  })

  test('trims only the copy indent, so a nested list keeps its shape', () => {
    expect(normalizeRichTextPaste('    - parent\n        - child')).toBe('- parent\n    - child')
  })

  test('leaves a list someone typed at column zero untouched', () => {
    const typed = '- one\n- two\n\n1. first\n2. second'
    expect(normalizeRichTextPaste(typed)).toBe(typed)
  })

  test('does not treat a rule or an emphasised line as a list item', () => {
    expect(normalizeRichTextPaste('---')).toBe('---')
    expect(normalizeRichTextPaste('*emphasis*')).toBe('*emphasis*')
  })
})

describe('normalizeRichTextPaste — spreadsheet rows', () => {
  test('a tab-separated block becomes a table', () => {
    expect(normalizeRichTextPaste('Name\tQty\tPrice\nWidget\t2\t9.99')).toBe(
      '| Name | Qty | Price |\n| --- | --- | --- |\n| Widget | 2 | 9.99 |',
    )
  })

  test('drops the trailing tabs a spreadsheet copy leaves on every row', () => {
    expect(normalizeRichTextPaste('a\tb\tc\t\n1\t2\t3\t')).toBe(
      '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |',
    )
  })

  test('a two-column copy still becomes a table', () => {
    expect(normalizeRichTextPaste('Key\tValue\nx\t1')).toBe(
      '| Key | Value |\n| --- | --- |\n| x | 1 |',
    )
  })

  test('escapes a pipe so a cell cannot break the row', () => {
    expect(normalizeRichTextPaste('a\tb|c\n1\t2')).toBe('| a | b\\|c |\n| --- | --- |\n| 1 | 2 |')
  })

  test('leaves a ragged block alone rather than guessing the columns', () => {
    const ragged = 'a\tb\tc\n1\t2'
    expect(normalizeRichTextPaste(ragged)).toBe(ragged)
  })

  test('a single tab-separated line is not enough to call it a table', () => {
    expect(normalizeRichTextPaste('a\tb')).toBe('a\tb')
  })

  test('a tab-indented list is not mistaken for a table', () => {
    expect(normalizeRichTextPaste('\t1. one\n\t2. two')).toBe('1. one\n2. two')
  })

  test('a numbered list whose items are tab separated is not a table', () => {
    expect(normalizeRichTextPaste('1.\tone\n2.\ttwo')).toBe('1.\tone\n2.\ttwo')
  })

  test('a dash list whose items are tab separated is not a table', () => {
    expect(normalizeRichTextPaste('-\tone\n-\ttwo')).toBe('-\tone\n-\ttwo')
  })

  test('a tab inside a list item is left alone', () => {
    expect(normalizeRichTextPaste('- one\ta\tb\n- two')).toBe('- one\ta\tb\n- two')
  })
})

describe('normalizeRichTextPaste — a typed plus sign', () => {
  test('a lone leading plus survives as a plus', () => {
    expect(normalizeRichTextPaste('+ @Adhihariharan AU')).toBe('\\+ @Adhihariharan AU')
  })

  test('a two-item plus list is still a list', () => {
    expect(normalizeRichTextPaste('+ a\n+ b')).toBe('+ a\n+ b')
  })

  test('a plus list separated by a blank line is still a list', () => {
    expect(normalizeRichTextPaste('+ a\n\n+ b')).toBe('+ a\n\n+ b')
  })

  test('a plus that is not a marker is untouched', () => {
    expect(normalizeRichTextPaste('a + b')).toBe('a + b')
    expect(normalizeRichTextPaste('+1 rating')).toBe('+1 rating')
  })
})

describe('normalizeRichTextPaste — code is never rewritten', () => {
  test('a fenced block keeps its tabs and glyphs', () => {
    const fenced = '```\n•\tnot a list\n```'
    expect(normalizeRichTextPaste(fenced)).toBe(fenced)
  })

  test('an inline span keeps its glyph', () => {
    expect(normalizeRichTextPaste('use `•\tas a marker` here')).toBe('use `•\tas a marker` here')
  })

  test('prose around a fence is still repaired', () => {
    expect(normalizeRichTextPaste('•\titem\n\n```\n\tkeep\tme\n```')).toBe(
      '- item\n\n```\n\tkeep\tme\n```',
    )
  })
})

describe('normalizeRichTextPaste — invariants', () => {
  const samples = [
    '',
    'plain sentence',
    '•\tItem one\n•\tItem two',
    '\t1. one\n\t2. two',
    'Name\tQty\nWidget\t2',
    '+ @someone',
    '+ a\n+ b',
    '```\n•\tx\n```',
    '- typed\n- list',
    '> quoted\n\n| a | b |\n| --- | --- |\n| 1 | 2 |',
  ]

  test('is idempotent, so re-normalizing a streaming buffer is safe', () => {
    for (const sample of samples) {
      const once = normalizeRichTextPaste(sample)
      expect(normalizeRichTextPaste(once)).toBe(once)
    }
  })

  test('normalizes CRLF the way it normalizes LF', () => {
    expect(normalizeRichTextPaste('•\tone\r\n•\ttwo')).toBe('- one\n- two')
  })
})
