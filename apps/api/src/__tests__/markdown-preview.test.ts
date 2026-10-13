// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { flattenMarkdownBlocks, inlineMarkdownSegments, markdownToPlainText } from '../services/conversation-mentions'

describe('conversation markdown previews', () => {
  test('flattens blocks and keeps inline markers', () => {
    expect(flattenMarkdownBlocks('## Done\n\n**shipped** the fix\n- see `main`\n\n```ts\nconst x = 1\n```')).toBe(
      'Done **shipped** the fix see `main` const x = 1',
    )
    expect(flattenMarkdownBlocks('> quoted\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n![shot](https://example.com/a.png)')).toBe(
      'quoted a b 1 2 shot',
    )
    expect(flattenMarkdownBlocks('```\nconst x = 1')).toBe('const x = 1')
  })

  test('parses inline formatting and drops an unclosed marker', () => {
    expect(inlineMarkdownSegments('**bold** and *italic* and ~~gone~~ and `code` and [docs](https://example.com)')).toEqual([
      { text: 'bold', bold: true },
      { text: ' and ' },
      { text: 'italic', italic: true },
      { text: ' and ' },
      { text: 'gone', strike: true },
      { text: ' and ' },
      { text: 'code', code: true },
      { text: ' and docs' },
    ])
    expect(inlineMarkdownSegments('***both*** snake_case **wor')).toEqual([
      { text: 'both', bold: true, italic: true },
      { text: ' snake_case wor' },
    ])
  })

  test('plain text strips every marker, including mentions left as labels', () => {
    expect(markdownToPlainText('## Hi\n\n**Ada** see [docs](https://example.com)')).toBe('Hi Ada see docs')
    expect(markdownToPlainText('@Ada **shipped**')).toBe('@Ada shipped')
  })
})
