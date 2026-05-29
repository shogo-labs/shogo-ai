// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import {
  findPath,
  insertLeafAtEdge,
  leaf,
  leafIds,
  movePane,
  nodeAt,
  removeLeaf,
  resize,
  split,
  splitLeaf,
  type SplitNode,
} from '../split-tree'

function approxEqual(actual: ReadonlyArray<number>, expected: number[], tolerance = 0.01) {
  expect(actual.length).toBe(expected.length)
  actual.forEach((a, i) => {
    expect(Math.abs(a - expected[i])).toBeLessThan(tolerance)
  })
}

describe('leaf + split constructors', () => {
  test('leaf carries the sessionId', () => {
    expect(leaf('s1')).toEqual({ kind: 'leaf', sessionId: 's1' })
  })

  test('split with no sizes evenly distributes', () => {
    const n = split('row', [leaf('a'), leaf('b'), leaf('c')])
    approxEqual(n.sizes, [33.33, 33.33, 33.33])
  })

  test('split with explicit sizes is preserved', () => {
    const n = split('row', [leaf('a'), leaf('b')], [70, 30])
    expect(n.sizes).toEqual([70, 30])
  })

  test('split with <2 children throws', () => {
    expect(() => split('row', [leaf('a')])).toThrow()
  })

  test('split with mismatched sizes throws', () => {
    expect(() => split('row', [leaf('a'), leaf('b')], [50])).toThrow()
  })
})

describe('findPath / leafIds', () => {
  test('single-leaf root returns empty path', () => {
    expect(findPath(leaf('a'), 'a')).toEqual([])
    expect(findPath(leaf('a'), 'b')).toBeNull()
  })

  test('walks through a nested tree', () => {
    const tree = split('row', [
      leaf('a'),
      split('column', [leaf('b'), leaf('c')]),
    ])
    expect(findPath(tree, 'a')).toEqual([0])
    expect(findPath(tree, 'b')).toEqual([1, 0])
    expect(findPath(tree, 'c')).toEqual([1, 1])
    expect(findPath(tree, 'ghost')).toBeNull()
  })

  test('leafIds flattens in left-to-right order', () => {
    const tree = split('row', [
      split('column', [leaf('a'), leaf('b')]),
      leaf('c'),
      split('column', [leaf('d'), leaf('e')]),
    ])
    expect(leafIds(tree)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('splitLeaf', () => {
  test('splitting a single-leaf root creates a 2-child split with even sizes', () => {
    const next = splitLeaf(leaf('a'), 'a', 'b', 'row')
    expect(next).toEqual({
      kind: 'split',
      direction: 'row',
      children: [{ kind: 'leaf', sessionId: 'a' }, { kind: 'leaf', sessionId: 'b' }],
      sizes: [50, 50],
    })
  })

  test('same-direction split appends a flat sibling (no nesting)', () => {
    const tree = split('row', [leaf('a'), leaf('b')])
    const next = splitLeaf(tree, 'b', 'c', 'row')
    expect(next.kind).toBe('split')
    if (next.kind !== 'split') throw new Error('unreachable')
    expect(next.direction).toBe('row')
    expect(leafIds(next)).toEqual(['a', 'b', 'c'])
    expect(next.children.every((c) => c.kind === 'leaf')).toBe(true)
    approxEqual(next.sizes, [33.33, 33.33, 33.33])
  })

  test('different-direction split nests', () => {
    const tree = split('row', [leaf('a'), leaf('b')])
    const next = splitLeaf(tree, 'b', 'c', 'column')
    if (next.kind !== 'split') throw new Error('unreachable')
    expect(next.direction).toBe('row')
    expect(next.children[0]).toEqual(leaf('a'))
    expect(next.children[1].kind).toBe('split')
    if (next.children[1].kind !== 'split') throw new Error('unreachable')
    expect(next.children[1].direction).toBe('column')
    expect(leafIds(next.children[1])).toEqual(['b', 'c'])
  })

  test('produces a mixed grid: split right then split down', () => {
    let tree: SplitNode = leaf('a')
    tree = splitLeaf(tree, 'a', 'b', 'row')
    tree = splitLeaf(tree, 'b', 'c', 'column')
    expect(leafIds(tree)).toEqual(['a', 'b', 'c'])
    if (tree.kind !== 'split') throw new Error('unreachable')
    expect(tree.direction).toBe('row')
    expect(tree.children[1].kind).toBe('split')
  })

  test('unknown anchor throws', () => {
    expect(() => splitLeaf(leaf('a'), 'ghost', 'b', 'row')).toThrow(/anchor/)
  })

  test('inserts immediately after the anchor in a flat split', () => {
    const tree = split('row', [leaf('a'), leaf('b'), leaf('c')])
    const next = splitLeaf(tree, 'a', 'x', 'row')
    expect(leafIds(next)).toEqual(['a', 'x', 'b', 'c'])
  })
})

describe('removeLeaf', () => {
  test('removing the only leaf returns null', () => {
    expect(removeLeaf(leaf('a'), 'a')).toBeNull()
  })

  test('removing a leaf with one sibling collapses the split to the survivor', () => {
    const tree = split('row', [leaf('a'), leaf('b')])
    expect(removeLeaf(tree, 'b')).toEqual(leaf('a'))
  })

  test('removing one of >2 siblings keeps the split, renormalises sizes', () => {
    const tree = split('row', [leaf('a'), leaf('b'), leaf('c')], [50, 25, 25])
    const next = removeLeaf(tree, 'b')
    if (!next || next.kind !== 'split') throw new Error('unreachable')
    expect(leafIds(next)).toEqual(['a', 'c'])
    approxEqual(next.sizes, [66.67, 33.33])
  })

  test('collapses nested same-direction splits after removal', () => {
    // row[a, column[b, row[c, d]]]: removing b should keep b's sibling,
    // collapsing column to its only child row[c,d] — and since the
    // grandparent is also a row, flatten c,d into the top.
    const tree = split('row', [
      leaf('a'),
      split('column', [
        leaf('b'),
        split('row', [leaf('c'), leaf('d')]),
      ]),
    ])
    const next = removeLeaf(tree, 'b')
    expect(next).not.toBeNull()
    if (!next || next.kind !== 'split') throw new Error('unreachable')
    expect(next.direction).toBe('row')
    expect(leafIds(next)).toEqual(['a', 'c', 'd'])
    expect(next.children.every((c) => c.kind === 'leaf')).toBe(true)
  })

  test('missing leaf returns the same root by reference', () => {
    const tree = split('row', [leaf('a'), leaf('b')])
    expect(removeLeaf(tree, 'ghost')).toBe(tree)
  })
})

describe('resize', () => {
  test('updates sizes at root', () => {
    const tree = split('row', [leaf('a'), leaf('b')])
    const next = resize(tree, [], [70, 30])
    if (next.kind !== 'split') throw new Error('unreachable')
    approxEqual(next.sizes, [70, 30])
  })

  test('updates sizes at a nested path', () => {
    const tree = split('row', [
      leaf('a'),
      split('column', [leaf('b'), leaf('c')]),
    ])
    const next = resize(tree, [1], [80, 20])
    const inner = (next as any).children[1]
    approxEqual(inner.sizes, [80, 20])
  })

  test('throws on size length mismatch', () => {
    const tree = split('row', [leaf('a'), leaf('b')])
    expect(() => resize(tree, [], [100])).toThrow()
  })

  test('throws when path lands on a leaf', () => {
    const tree = split('row', [leaf('a'), leaf('b')])
    expect(() => resize(tree, [0], [100])).toThrow()
  })

  test('normalises sizes that do not sum to 100', () => {
    const tree = split('row', [leaf('a'), leaf('b')])
    const next = resize(tree, [], [1, 1])
    if (next.kind !== 'split') throw new Error('unreachable')
    approxEqual(next.sizes, [50, 50])
  })
})

describe('nodeAt', () => {
  test('empty path returns root', () => {
    const tree = split('row', [leaf('a'), leaf('b')])
    expect(nodeAt(tree, [])).toBe(tree)
  })

  test('walks to a leaf', () => {
    const tree = split('row', [leaf('a'), leaf('b')])
    expect(nodeAt(tree, [1])).toEqual(leaf('b'))
  })

  test('returns null for out-of-bounds', () => {
    const tree = split('row', [leaf('a'), leaf('b')])
    expect(nodeAt(tree, [5])).toBeNull()
  })
})

describe('movePane', () => {
  test('detaches and returns the leaf', () => {
    const tree = split('row', [leaf('a'), leaf('b')])
    const { tree: rest, node } = movePane(tree, 'b')
    expect(node).toEqual({ kind: 'leaf', sessionId: 'b' })
    expect(rest).toEqual(leaf('a'))
  })

  test('detaching the only leaf returns null tree', () => {
    const { tree: rest, node } = movePane(leaf('a'), 'a')
    expect(node).toEqual({ kind: 'leaf', sessionId: 'a' })
    expect(rest).toBeNull()
  })

  test('absent leaf returns root by reference, node null', () => {
    const tree = split('row', [leaf('a'), leaf('b')])
    const { tree: rest, node } = movePane(tree, 'ghost')
    expect(rest).toBe(tree)
    expect(node).toBeNull()
  })
})

describe('insertLeafAtEdge', () => {
  test('left edge inserts before with row direction', () => {
    const tree = leaf('a')
    const next = insertLeafAtEdge(tree, 'a', leaf('b'), 'left')
    if (next.kind !== 'split') throw new Error('unreachable')
    expect(next.direction).toBe('row')
    expect(leafIds(next)).toEqual(['b', 'a'])
  })

  test('right edge inserts after with row direction', () => {
    const next = insertLeafAtEdge(leaf('a'), 'a', leaf('b'), 'right')
    if (next.kind !== 'split') throw new Error('unreachable')
    expect(leafIds(next)).toEqual(['a', 'b'])
  })

  test('top edge inserts before with column direction', () => {
    const next = insertLeafAtEdge(leaf('a'), 'a', leaf('b'), 'top')
    if (next.kind !== 'split') throw new Error('unreachable')
    expect(next.direction).toBe('column')
    expect(leafIds(next)).toEqual(['b', 'a'])
  })

  test('bottom edge inserts after with column direction', () => {
    const next = insertLeafAtEdge(leaf('a'), 'a', leaf('b'), 'bottom')
    if (next.kind !== 'split') throw new Error('unreachable')
    expect(next.direction).toBe('column')
    expect(leafIds(next)).toEqual(['a', 'b'])
  })

  test('center replaces the target leaf with incoming', () => {
    const next = insertLeafAtEdge(leaf('a'), 'a', leaf('b'), 'center')
    expect(next).toEqual(leaf('b'))
  })

  test('same-direction parent flattens', () => {
    const tree = split('row', [leaf('a'), leaf('b')])
    const next = insertLeafAtEdge(tree, 'a', leaf('x'), 'right')
    if (next.kind !== 'split') throw new Error('unreachable')
    expect(next.children.every((c) => c.kind === 'leaf')).toBe(true)
    expect(leafIds(next)).toEqual(['a', 'x', 'b'])
  })

  test('different-direction parent nests', () => {
    const tree = split('row', [leaf('a'), leaf('b')])
    const next = insertLeafAtEdge(tree, 'a', leaf('x'), 'bottom')
    if (next.kind !== 'split') throw new Error('unreachable')
    expect(next.direction).toBe('row')
    expect(next.children[0].kind).toBe('split')
    if (next.children[0].kind !== 'split') throw new Error('unreachable')
    expect(next.children[0].direction).toBe('column')
    expect(leafIds(next.children[0])).toEqual(['a', 'x'])
  })

  test('throws when target is absent', () => {
    expect(() => insertLeafAtEdge(leaf('a'), 'ghost', leaf('b'), 'right')).toThrow(/target/)
  })
})

describe('integration: end-to-end mixed grid', () => {
  test('build a 2x2 grid, resize a pane, then close one leaf', () => {
    // Start: single pane 'a'
    let tree: SplitNode = leaf('a')
    // Split right: row[a, b]
    tree = splitLeaf(tree, 'a', 'b', 'row')
    expect(leafIds(tree)).toEqual(['a', 'b'])
    // Split a down: row[column[a, c], b]
    tree = splitLeaf(tree, 'a', 'c', 'column')
    expect(leafIds(tree)).toEqual(['a', 'c', 'b'])
    // Split b down: row[column[a, c], column[b, d]]
    tree = splitLeaf(tree, 'b', 'd', 'column')
    expect(leafIds(tree)).toEqual(['a', 'c', 'b', 'd'])
    if (tree.kind !== 'split') throw new Error('unreachable')
    expect(tree.children.length).toBe(2)
    expect(tree.children.every((c) => c.kind === 'split')).toBe(true)
    // Resize the left column: 80/20
    tree = resize(tree, [0], [80, 20])
    const leftColumn = (tree as any).children[0]
    approxEqual(leftColumn.sizes, [80, 20])
    // Close c → left collapses to leaf a, then root becomes row[a, column[b, d]]
    const afterRemoval = removeLeaf(tree, 'c')
    expect(afterRemoval).not.toBeNull()
    if (!afterRemoval || afterRemoval.kind !== 'split') throw new Error('unreachable')
    expect(afterRemoval.direction).toBe('row')
    expect(afterRemoval.children[0]).toEqual(leaf('a'))
    expect(afterRemoval.children[1].kind).toBe('split')
    expect(leafIds(afterRemoval)).toEqual(['a', 'b', 'd'])
  })
})
