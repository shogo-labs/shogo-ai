// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import {
  MIN_RATIO,
  clampRatio,
  closeLeaf,
  countLeaves,
  findLeaf,
  splitLeaf,
  updateRatio,
  walkLeaves,
  type TreeNode,
} from '../splits-layout'

const leaf = (id: string): TreeNode => ({ kind: 'leaf', id })

// ─── clampRatio ────────────────────────────────────────────────────────

describe('clampRatio', () => {
  it('clamps to [MIN_RATIO, 1-MIN_RATIO]', () => {
    expect(clampRatio(0)).toBe(MIN_RATIO)
    expect(clampRatio(1)).toBe(1 - MIN_RATIO)
    expect(clampRatio(0.5)).toBe(0.5)
    expect(clampRatio(-1)).toBe(MIN_RATIO)
    expect(clampRatio(2)).toBe(1 - MIN_RATIO)
  })
  it('returns 0.5 for non-finite input', () => {
    expect(clampRatio(Number.NaN)).toBe(0.5)
    expect(clampRatio(Infinity)).toBe(0.5)
    expect(clampRatio(-Infinity)).toBe(0.5)
  })
})

// ─── walkLeaves + findLeaf + countLeaves ──────────────────────────────

describe('walkLeaves', () => {
  it('yields leaf ids in left-to-right order', () => {
    const tree: TreeNode = {
      kind: 'split', dir: 'h', ratio: 0.5,
      a: { kind: 'split', dir: 'v', ratio: 0.5, a: leaf('a'), b: leaf('b') },
      b: leaf('c'),
    }
    expect(walkLeaves(tree)).toEqual(['a', 'b', 'c'])
  })
  it('returns single-id list for a leaf', () => {
    expect(walkLeaves(leaf('only'))).toEqual(['only'])
  })
})

describe('findLeaf / countLeaves', () => {
  const tree: TreeNode = {
    kind: 'split', dir: 'h', ratio: 0.4,
    a: leaf('a'),
    b: { kind: 'split', dir: 'v', ratio: 0.6, a: leaf('b'), b: leaf('c') },
  }
  it('locates each leaf by path', () => {
    expect(findLeaf(tree, 'a')).toEqual(['a'])
    expect(findLeaf(tree, 'b')).toEqual(['b', 'a'])
    expect(findLeaf(tree, 'c')).toEqual(['b', 'b'])
    expect(findLeaf(tree, 'missing')).toBeNull()
  })
  it('counts leaves correctly', () => {
    expect(countLeaves(tree)).toBe(3)
    expect(countLeaves(leaf('x'))).toBe(1)
  })
})

// ─── splitLeaf ────────────────────────────────────────────────────────

describe('splitLeaf', () => {
  it('replaces a leaf with a split (new leaf placed after by default)', () => {
    const t = splitLeaf(leaf('a'), 'a', 'b', 'h')
    expect(t.kind).toBe('split')
    if (t.kind !== 'split') throw new Error('unreachable')
    expect(t.dir).toBe('h')
    expect((t.a as { id: string }).id).toBe('a')
    expect((t.b as { id: string }).id).toBe('b')
  })

  it('honours placement=before', () => {
    const t = splitLeaf(leaf('a'), 'a', 'b', 'v', 'before')
    if (t.kind !== 'split') throw new Error('unreachable')
    expect((t.a as { id: string }).id).toBe('b')
    expect((t.b as { id: string }).id).toBe('a')
  })

  it('descends into subtrees and only splits the matching leaf', () => {
    const tree: TreeNode = {
      kind: 'split', dir: 'h', ratio: 0.5,
      a: leaf('a'),
      b: leaf('b'),
    }
    const t = splitLeaf(tree, 'b', 'c', 'v')
    if (t.kind !== 'split') throw new Error('unreachable')
    expect((t.a as { id: string }).id).toBe('a')
    expect(t.b.kind).toBe('split')
    if (t.b.kind !== 'split') throw new Error('unreachable')
    expect(t.b.dir).toBe('v')
    expect(walkLeaves(t)).toEqual(['a', 'b', 'c'])
  })

  it('returns the tree unchanged when the id does not exist', () => {
    const tree: TreeNode = { kind: 'split', dir: 'h', ratio: 0.5, a: leaf('a'), b: leaf('b') }
    const t = splitLeaf(tree, 'missing', 'c', 'h')
    expect(walkLeaves(t)).toEqual(['a', 'b'])
  })
})

// ─── closeLeaf ────────────────────────────────────────────────────────

describe('closeLeaf', () => {
  it('removes a leaf and lifts its sibling into the parent slot', () => {
    const tree: TreeNode = { kind: 'split', dir: 'h', ratio: 0.5, a: leaf('a'), b: leaf('b') }
    const t = closeLeaf(tree, 'b')
    expect(t).toEqual(leaf('a'))
  })

  it('closes a nested leaf and collapses correctly', () => {
    const tree: TreeNode = {
      kind: 'split', dir: 'h', ratio: 0.5,
      a: leaf('a'),
      b: { kind: 'split', dir: 'v', ratio: 0.5, a: leaf('b'), b: leaf('c') },
    }
    const t = closeLeaf(tree, 'b')
    expect(walkLeaves(t)).toEqual(['a', 'c'])
  })

  it('is a no-op when the leaf does not exist', () => {
    const tree: TreeNode = { kind: 'split', dir: 'h', ratio: 0.5, a: leaf('a'), b: leaf('b') }
    expect(closeLeaf(tree, 'missing')).toBe(tree)
  })

  it('is a no-op on a single-leaf tree (last leaf protected)', () => {
    expect(closeLeaf(leaf('a'), 'a')).toEqual(leaf('a'))
  })
})

// ─── updateRatio ──────────────────────────────────────────────────────

describe('updateRatio', () => {
  it('updates the ratio of the enclosing split when leafId is left child', () => {
    const tree: TreeNode = { kind: 'split', dir: 'h', ratio: 0.5, a: leaf('a'), b: leaf('b') }
    const t = updateRatio(tree, 'a', 0.7)
    expect((t as { ratio: number }).ratio).toBe(0.7)
  })

  it('clamps out-of-range ratios', () => {
    const tree: TreeNode = { kind: 'split', dir: 'h', ratio: 0.5, a: leaf('a'), b: leaf('b') }
    expect((updateRatio(tree, 'a', 0) as { ratio: number }).ratio).toBe(MIN_RATIO)
    expect((updateRatio(tree, 'a', 2) as { ratio: number }).ratio).toBe(1 - MIN_RATIO)
  })

  it('descends into the correct subtree when leafId is nested', () => {
    const tree: TreeNode = {
      kind: 'split', dir: 'h', ratio: 0.5,
      a: leaf('outer-a'),
      b: { kind: 'split', dir: 'v', ratio: 0.5, a: leaf('inner-a'), b: leaf('inner-b') },
    }
    const t = updateRatio(tree, 'inner-a', 0.3)
    if (t.kind !== 'split' || t.b.kind !== 'split') throw new Error('unreachable')
    expect(t.ratio).toBe(0.5) // outer unchanged
    expect(t.b.ratio).toBe(0.3) // inner updated
  })

  it('is a no-op when the leaf is not the left child of any split', () => {
    // outer.b is leaf('b') — id 'b' isn't a left-child anywhere.
    const tree: TreeNode = { kind: 'split', dir: 'h', ratio: 0.5, a: leaf('a'), b: leaf('b') }
    const t = updateRatio(tree, 'b', 0.9)
    expect(t).toBe(tree)
  })
})

// ─── invariants ───────────────────────────────────────────────────────

describe('splits algebra — invariants', () => {
  it('split + close round-trips back to the original leaf', () => {
    const original = leaf('a')
    const split = splitLeaf(original, 'a', 'b', 'h')
    const closed = closeLeaf(split, 'b')
    expect(closed).toEqual(original)
  })

  it('many sequential operations preserve leaf-set integrity', () => {
    let t: TreeNode = leaf('a')
    t = splitLeaf(t, 'a', 'b', 'h')
    t = splitLeaf(t, 'b', 'c', 'v')
    t = splitLeaf(t, 'a', 'd', 'v')
    expect(new Set(walkLeaves(t))).toEqual(new Set(['a', 'b', 'c', 'd']))
    expect(countLeaves(t)).toBe(4)
    t = closeLeaf(t, 'd')
    t = closeLeaf(t, 'c')
    expect(new Set(walkLeaves(t))).toEqual(new Set(['a', 'b']))
  })
})
