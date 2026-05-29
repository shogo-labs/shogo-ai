// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Tests for the unified-diff hunk-header parser used to render gutter
// markers and to drive hunk revert. The parser is pure — it only looks
// at `@@ -<o>,<oc> +<n>,<nc> @@` headers and ignores everything else.

import { describe, expect, it } from 'bun:test'
import { parseUnified } from '../diffMarkers'

describe('parseUnified', () => {
  it('returns empty list when there are no hunks', () => {
    expect(parseUnified('')).toEqual([])
    expect(parseUnified('diff --git a/foo b/foo\nindex abc..def\n')).toEqual([])
  })

  it('parses a single modified-block hunk', () => {
    const stdout = [
      'diff --git a/f b/f',
      '--- a/f',
      '+++ b/f',
      '@@ -10,2 +12,3 @@',
      '-old1',
      '-old2',
      '+new1',
      '+new2',
      '+new3',
    ].join('\n')
    expect(parseUnified(stdout)).toEqual([
      { kind: 'modified', startLine: 12, endLine: 14, removed: 2, added: 3, oldStart: 10 },
    ])
  })

  it('treats a hunk with newCount=0 as removed and anchors at line 1 when newStart=0', () => {
    const stdout = '@@ -1,3 +0,0 @@\n-a\n-b\n-c\n'
    expect(parseUnified(stdout)).toEqual([
      { kind: 'removed', startLine: 1, endLine: 1, removed: 3, added: 0, oldStart: 1 },
    ])
  })

  it('treats a hunk with oldCount=0 as added (pure insertion)', () => {
    const stdout = '@@ -5,0 +6,4 @@\n+a\n+b\n+c\n+d\n'
    expect(parseUnified(stdout)).toEqual([
      { kind: 'added', startLine: 6, endLine: 9, removed: 0, added: 4, oldStart: 0 },
    ])
  })

  it('defaults missing counts to 1', () => {
    // `@@ -7 +9 @@` ↔ `@@ -7,1 +9,1 @@`
    expect(parseUnified('@@ -7 +9 @@\n-old\n+new\n')).toEqual([
      { kind: 'modified', startLine: 9, endLine: 9, removed: 1, added: 1, oldStart: 7 },
    ])
  })

  it('parses multiple hunks in a single diff and preserves their order', () => {
    const stdout = [
      '@@ -1,1 +1,2 @@',
      ' unchanged',
      '+added',
      '@@ -10,2 +11,0 @@',
      '-x',
      '-y',
      '@@ -20 +21,3 @@',
      '-z',
      '+a',
      '+b',
      '+c',
    ].join('\n')
    const out = parseUnified(stdout)
    expect(out).toHaveLength(3)
    expect(out[0].kind).toBe('modified')
    expect(out[0].oldStart).toBe(1)
    expect(out[1]).toEqual({ kind: 'removed', startLine: 11, endLine: 11, removed: 2, added: 0, oldStart: 10 })
    expect(out[2]).toEqual({ kind: 'modified', startLine: 21, endLine: 23, removed: 1, added: 3, oldStart: 20 })
  })

  it('ignores garbled hunk headers gracefully', () => {
    const stdout = '@@ ----- @@\n@@ -1 + @@\n@@ -1,1 +1,1 @@\n'
    expect(parseUnified(stdout)).toEqual([
      { kind: 'modified', startLine: 1, endLine: 1, removed: 1, added: 1, oldStart: 1 },
    ])
  })

  it('always exposes oldStart on every marker shape so the hunk-revert helper has the HEAD-side anchor', () => {
    const stdout = [
      '@@ -1,2 +1,0 @@', // removed
      '@@ -0,0 +5,3 @@', // added
      '@@ -10,2 +12,3 @@', // modified
    ].join('\n')
    const out = parseUnified(stdout)
    expect(out.map((m) => m.oldStart)).toEqual([1, 0, 10])
  })
})
