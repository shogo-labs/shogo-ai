// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import { splitLeaf, type TreeNode } from '../splits-layout'
import { leafIdAtIndex, leafInDirection } from '../splits-host'

// ─── leafIdAtIndex ──────────────────────────────────────────────────

describe('leafIdAtIndex', () => {
  it('returns the only leaf in a single-leaf tree at index 0', () => {
    const t: TreeNode = { kind: 'leaf', id: 'a' }
    expect(leafIdAtIndex(t, 0)).toBe('a')
    expect(leafIdAtIndex(t, 1)).toBe(null)
  })

  it('walks horizontal splits left-to-right', () => {
    const t: TreeNode = { kind: 'split', dir: 'h', ratio: 0.5,
      a: { kind: 'leaf', id: 'a' }, b: { kind: 'leaf', id: 'b' } }
    expect(leafIdAtIndex(t, 0)).toBe('a')
    expect(leafIdAtIndex(t, 1)).toBe('b')
  })

  it('walks vertical splits top-to-bottom', () => {
    const t: TreeNode = { kind: 'split', dir: 'v', ratio: 0.5,
      a: { kind: 'leaf', id: 'top' }, b: { kind: 'leaf', id: 'bottom' } }
    expect(leafIdAtIndex(t, 0)).toBe('top')
    expect(leafIdAtIndex(t, 1)).toBe('bottom')
  })

  it('handles nested splits — a|b|c via splitLeaf', () => {
    // Build a tree of three leaves: a on left, b|c stacked on right.
    let t: TreeNode = { kind: 'leaf', id: 'a' }
    // splitLeaf(tree, id, newId, dir) — default placement 'after'
    t = splitLeaf(t, 'a', 'b', 'h')              // a | b
    t = splitLeaf(t, 'b', 'c', 'v')              // a | (b / c)
    expect(leafIdAtIndex(t, 0)).toBe('a')
    expect(leafIdAtIndex(t, 1)).toBe('b')
    expect(leafIdAtIndex(t, 2)).toBe('c')
    expect(leafIdAtIndex(t, 3)).toBe(null)
  })
})

// ─── leafInDirection ────────────────────────────────────────────────

describe('leafInDirection', () => {
  // Tree: a | b (single horizontal split).
  const ab: TreeNode = { kind: 'split', dir: 'h', ratio: 0.5,
    a: { kind: 'leaf', id: 'a' }, b: { kind: 'leaf', id: 'b' } }

  it('finds the right neighbour across a horizontal split', () => {
    expect(leafInDirection(ab, 'a', 'right')).toBe('b')
  })

  it('finds the left neighbour across a horizontal split', () => {
    expect(leafInDirection(ab, 'b', 'left')).toBe('a')
  })

  it('returns null when moving in the wrong axis across a horizontal split', () => {
    expect(leafInDirection(ab, 'a', 'up')).toBe(null)
    expect(leafInDirection(ab, 'a', 'down')).toBe(null)
  })

  it('returns null at the workspace edge', () => {
    expect(leafInDirection(ab, 'a', 'left')).toBe(null)
    expect(leafInDirection(ab, 'b', 'right')).toBe(null)
  })

  // Tree: a / b (single vertical split).
  const ab_v: TreeNode = { kind: 'split', dir: 'v', ratio: 0.5,
    a: { kind: 'leaf', id: 'top' }, b: { kind: 'leaf', id: 'bot' } }

  it('finds neighbours across a vertical split', () => {
    expect(leafInDirection(ab_v, 'top', 'down')).toBe('bot')
    expect(leafInDirection(ab_v, 'bot', 'up')).toBe('top')
    expect(leafInDirection(ab_v, 'top', 'right')).toBe(null)
  })

  it('skips axis-mismatched ancestors and finds a matching one further up', () => {
    // Tree: (a | b) on top, c on bottom (vertical at root).
    // From `a`, going down should jump to `c` even though the immediate
    // parent of `a` is a horizontal split.
    const root: TreeNode = {
      kind: 'split', dir: 'v', ratio: 0.5,
      a: {
        kind: 'split', dir: 'h', ratio: 0.5,
        a: { kind: 'leaf', id: 'a' }, b: { kind: 'leaf', id: 'b' },
      },
      b: { kind: 'leaf', id: 'c' },
    }
    expect(leafInDirection(root, 'a', 'down')).toBe('c')
    expect(leafInDirection(root, 'b', 'down')).toBe('c')
    expect(leafInDirection(root, 'c', 'up')).toBe('a') // first leaf of `a` subtree
  })

  it('returns null for unknown leaf id', () => {
    expect(leafInDirection(ab, 'ghost', 'left')).toBe(null)
  })
})
