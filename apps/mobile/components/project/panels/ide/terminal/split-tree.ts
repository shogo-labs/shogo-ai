// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Per-group split layout — pure tree data structure + reducers.
 *
 * A group (tab) used to be modelled as a flat array of sessions rendered in a
 * horizontal flex row. That made vertical splits impossible and mixed
 * (grid) layouts implausible. This module replaces that model with a
 * recursive tree:
 *
 *   - A *leaf* references exactly one `Session.id`.
 *   - A *split* has a direction (`'row'` = side-by-side, `'column'` =
 *     stacked) and N ≥ 2 children. `sizes` are percentages summing to 100
 *     and parallel to `children`.
 *
 * The same direction never nests directly: `splitLeaf` flattens
 * sibling-into-sibling whenever the parent split shares the new
 * direction (matches VS Code's "Split Right" behaviour). Different
 * directions nest, producing mixed grids.
 *
 * All operations are immutable and return a new tree (or null if the
 * tree becomes empty). The reducers are pure — no React, no DOM. The
 * UI lives in Terminal.tsx and renders this tree recursively.
 */

export interface LeafNode {
  readonly kind: 'leaf'
  /** Stable client-side session id (Session.id from session-reducer.ts). */
  readonly sessionId: string
}

export interface SplitInternalNode {
  readonly kind: 'split'
  readonly direction: 'row' | 'column'
  readonly children: ReadonlyArray<SplitNode>
  /** Percentages parallel to `children`. Always sums to ~100 (rounded). */
  readonly sizes: ReadonlyArray<number>
}

export type SplitNode = LeafNode | SplitInternalNode

export function leaf(sessionId: string): LeafNode {
  return { kind: 'leaf', sessionId }
}

export function split(
  direction: 'row' | 'column',
  children: SplitNode[],
  sizes?: number[],
): SplitInternalNode {
  if (children.length < 2) {
    throw new Error(`split() requires >=2 children, got ${children.length}`)
  }
  const resolvedSizes = sizes ?? evenSizes(children.length)
  if (resolvedSizes.length !== children.length) {
    throw new Error(
      `split() sizes.length (${resolvedSizes.length}) must equal children.length (${children.length})`,
    )
  }
  return { kind: 'split', direction, children, sizes: resolvedSizes }
}

function evenSizes(n: number): number[] {
  const each = 100 / n
  return Array.from({ length: n }, () => each)
}

/**
 * Find the path of child indices that reach `sessionId`, or `null` if the
 * leaf isn't in this tree. Path on a single-leaf root is `[]`.
 */
export function findPath(root: SplitNode, sessionId: string): number[] | null {
  if (root.kind === 'leaf') {
    return root.sessionId === sessionId ? [] : null
  }
  for (let i = 0; i < root.children.length; i++) {
    const sub = findPath(root.children[i], sessionId)
    if (sub) return [i, ...sub]
  }
  return null
}

/** Flat array of every leaf's sessionId, in left-to-right tree order. */
export function leafIds(root: SplitNode): string[] {
  if (root.kind === 'leaf') return [root.sessionId]
  const out: string[] = []
  for (const child of root.children) out.push(...leafIds(child))
  return out
}

/**
 * Split the leaf with id `anchorSessionId`. The new leaf is inserted
 * immediately after the anchor in its parent's child list (or as the
 * second of two children when the anchor is the root).
 *
 *   - If the anchor's parent split already runs in `direction`, the new
 *     leaf is added as a sibling (flat append) so we keep mixed grids
 *     parseable.
 *   - Otherwise the anchor leaf is replaced with a 2-child split node
 *     whose children are `[anchor, newLeaf]`.
 *
 * On insertion into an existing flat split, sizes are renormalised: the
 * new leaf takes an even share and everyone else's percentage is scaled
 * down proportionally. On a fresh 2-child split, sizes are 50/50.
 *
 * Throws if `anchorSessionId` isn't in the tree.
 */
export function splitLeaf(
  root: SplitNode,
  anchorSessionId: string,
  newSessionId: string,
  direction: 'row' | 'column',
): SplitNode {
  const path = findPath(root, anchorSessionId)
  if (!path) {
    throw new Error(`splitLeaf: anchor "${anchorSessionId}" not found in tree`)
  }
  if (path.length === 0) {
    return split(direction, [root, leaf(newSessionId)])
  }
  return splitAtPath(root, path, newSessionId, direction)
}

function splitAtPath(
  node: SplitNode,
  path: number[],
  newSessionId: string,
  direction: 'row' | 'column',
): SplitNode {
  if (node.kind === 'leaf') {
    throw new Error('splitAtPath: walked past last index but landed on leaf')
  }
  const [head, ...rest] = path
  if (rest.length === 0) {
    const anchor = node.children[head]
    if (anchor.kind !== 'leaf') {
      throw new Error('splitAtPath: terminal step must land on a leaf')
    }
    if (node.direction === direction) {
      const newChildren = node.children.slice()
      newChildren.splice(head + 1, 0, leaf(newSessionId))
      const newSizes = insertSize(node.sizes, head + 1)
      return { ...node, children: newChildren, sizes: newSizes }
    }
    const replaced = split(direction, [anchor, leaf(newSessionId)])
    const newChildren = node.children.slice()
    newChildren[head] = replaced
    return { ...node, children: newChildren }
  }
  const recursed = splitAtPath(node.children[head], rest, newSessionId, direction)
  const newChildren = node.children.slice()
  newChildren[head] = recursed
  return { ...node, children: newChildren }
}

/**
 * Insert an even share at `index` and proportionally scale the existing
 * sizes so the total stays 100. Example: [50,50] + insertSize at 1 →
 * a third for the new sibling, two thirds split evenly between the
 * existing siblings = [33.33, 33.33, 33.33].
 */
function insertSize(sizes: ReadonlyArray<number>, index: number): number[] {
  const newN = sizes.length + 1
  const each = 100 / newN
  const next: number[] = []
  const otherTotal = 100 - each
  const oldTotal = sizes.reduce((a, b) => a + b, 0) || 100
  for (let i = 0; i <= sizes.length; i++) {
    if (i < index) next.push((sizes[i] / oldTotal) * otherTotal)
    else if (i === index) next.push(each)
    else next.push((sizes[i - 1] / oldTotal) * otherTotal)
  }
  return next
}

/**
 * Remove the leaf with id `sessionId`. Returns:
 *
 *   - `null` if the tree is now empty (caller should drop the group).
 *   - A leaf if the tree collapsed to a single survivor.
 *   - A split node otherwise. Single-child split nodes are collapsed
 *     into their child (a split must have ≥2 children to be useful).
 *
 * Sizes of surviving siblings are renormalised so their percentages sum
 * back to 100.
 *
 * No-ops (returns the same root by reference) if `sessionId` is absent.
 */
export function removeLeaf(root: SplitNode, sessionId: string): SplitNode | null {
  if (root.kind === 'leaf') {
    return root.sessionId === sessionId ? null : root
  }
  const path = findPath(root, sessionId)
  if (!path) return root
  return removeAtPath(root, path)
}

function removeAtPath(node: SplitInternalNode, path: number[]): SplitNode | null {
  const [head, ...rest] = path
  if (rest.length === 0) {
    const newChildren = node.children.slice()
    newChildren.splice(head, 1)
    if (newChildren.length === 0) return null
    if (newChildren.length === 1) return newChildren[0]
    const newSizes = normalise(removeAt(node.sizes, head))
    return { ...node, children: newChildren, sizes: newSizes }
  }
  const child = node.children[head]
  if (child.kind === 'leaf') {
    throw new Error('removeAtPath: walked past last index but landed on leaf')
  }
  const recursed = removeAtPath(child, rest)
  const newChildren = node.children.slice()
  if (recursed === null) {
    newChildren.splice(head, 1)
    if (newChildren.length === 0) return null
    if (newChildren.length === 1) return newChildren[0]
    const newSizes = normalise(removeAt(node.sizes, head))
    return { ...node, children: newChildren, sizes: newSizes }
  }
  // If the recursed child collapsed into a same-direction split, flatten
  // it into our children so we never nest equal-direction splits.
  if (recursed.kind === 'split' && recursed.direction === node.direction) {
    newChildren.splice(head, 1, ...recursed.children)
    const newSizes = flattenSizes(node.sizes, head, recursed.sizes)
    return { ...node, children: newChildren, sizes: newSizes }
  }
  newChildren[head] = recursed
  return { ...node, children: newChildren }
}

function removeAt(sizes: ReadonlyArray<number>, index: number): number[] {
  const next = sizes.slice()
  next.splice(index, 1)
  return next
}

function normalise(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0)
  if (total <= 0) return evenSizes(sizes.length)
  return sizes.map((s) => (s / total) * 100)
}

function flattenSizes(
  parentSizes: ReadonlyArray<number>,
  index: number,
  childSizes: ReadonlyArray<number>,
): number[] {
  const parentShare = parentSizes[index]
  const childTotal = childSizes.reduce((a, b) => a + b, 0) || 100
  const expandedChild = childSizes.map((s) => (s / childTotal) * parentShare)
  const next: number[] = []
  for (let i = 0; i < parentSizes.length; i++) {
    if (i === index) next.push(...expandedChild)
    else next.push(parentSizes[i])
  }
  return next
}

/**
 * Replace the `sizes` array at the given path. The path points at a
 * split node — not a leaf. Throws if the path doesn't land on a split
 * or the new sizes don't match the existing child count.
 */
export function resize(
  root: SplitNode,
  path: number[],
  sizes: number[],
): SplitNode {
  if (path.length === 0) {
    if (root.kind !== 'split') {
      throw new Error('resize: root is a leaf')
    }
    if (sizes.length !== root.children.length) {
      throw new Error(
        `resize: sizes.length (${sizes.length}) must match children.length (${root.children.length})`,
      )
    }
    return { ...root, sizes: normalise(sizes.slice()) }
  }
  if (root.kind !== 'split') {
    throw new Error('resize: walked past last index but landed on leaf')
  }
  const [head, ...rest] = path
  const recursed = resize(root.children[head], rest, sizes)
  const newChildren = root.children.slice()
  newChildren[head] = recursed
  return { ...root, children: newChildren }
}

/**
 * Walk the tree and return the split node at `path`. `[]` returns the
 * root if it's a split, otherwise null. Useful for the UI's "double
 * click divider to reset" path.
 */
export function nodeAt(root: SplitNode, path: number[]): SplitNode | null {
  let cur: SplitNode = root
  for (const i of path) {
    if (cur.kind !== 'split') return null
    if (i < 0 || i >= cur.children.length) return null
    cur = cur.children[i]
  }
  return cur
}

/**
 * Detach the leaf with id `sessionId` from `root`. Returns
 *
 *   - `tree`: the source tree minus the leaf (or null if empty)
 *   - `node`: the removed leaf
 *
 * No-op (returns `{ tree: root, node: null }`) when the leaf is absent.
 * Used by Phase 4's drag-between-groups; kept here so source/destination
 * tree manipulations both live in the same module.
 */
export function movePane(
  root: SplitNode,
  sessionId: string,
): { tree: SplitNode | null; node: LeafNode | null } {
  const path = findPath(root, sessionId)
  if (!path) return { tree: root, node: null }
  const node: LeafNode = { kind: 'leaf', sessionId }
  const tree = removeLeaf(root, sessionId)
  return { tree, node }
}

/**
 * Insert `incoming` (a leaf or subtree) into `root` at the requested
 * edge of the target leaf. `'left'` and `'top'` insert *before*; `'right'`
 * and `'bottom'` insert *after*. `'center'` replaces the target (used
 * when dropping onto a placeholder).
 *
 * Direction follows the edge: left/right → 'row', top/bottom → 'column'.
 * Same-direction parents flatten (consistent with `splitLeaf`).
 *
 * Throws if `targetSessionId` isn't in the tree.
 */
export function insertLeafAtEdge(
  root: SplitNode,
  targetSessionId: string,
  incoming: SplitNode,
  edge: 'left' | 'right' | 'top' | 'bottom' | 'center',
): SplitNode {
  const path = findPath(root, targetSessionId)
  if (!path) {
    throw new Error(`insertLeafAtEdge: target "${targetSessionId}" not found`)
  }
  if (edge === 'center') {
    return replaceAtPath(root, path, incoming)
  }
  const direction: 'row' | 'column' = edge === 'left' || edge === 'right' ? 'row' : 'column'
  const before = edge === 'left' || edge === 'top'
  return insertAtPath(root, path, incoming, direction, before)
}

function replaceAtPath(node: SplitNode, path: number[], replacement: SplitNode): SplitNode {
  if (path.length === 0) return replacement
  if (node.kind === 'leaf') {
    throw new Error('replaceAtPath: walked past last index but landed on leaf')
  }
  const [head, ...rest] = path
  const recursed = replaceAtPath(node.children[head], rest, replacement)
  const newChildren = node.children.slice()
  newChildren[head] = recursed
  return { ...node, children: newChildren }
}

function insertAtPath(
  node: SplitNode,
  path: number[],
  incoming: SplitNode,
  direction: 'row' | 'column',
  before: boolean,
): SplitNode {
  if (path.length === 0) {
    const children = before ? [incoming, node] : [node, incoming]
    return split(direction, children)
  }
  if (node.kind === 'leaf') {
    throw new Error('insertAtPath: walked past last index but landed on leaf')
  }
  const [head, ...rest] = path
  if (rest.length === 0) {
    const anchor = node.children[head]
    if (node.direction === direction) {
      const insertAt = before ? head : head + 1
      const newChildren = node.children.slice()
      newChildren.splice(insertAt, 0, incoming)
      const newSizes = insertSize(node.sizes, insertAt)
      return { ...node, children: newChildren, sizes: newSizes }
    }
    const wrapped = split(direction, before ? [incoming, anchor] : [anchor, incoming])
    const newChildren = node.children.slice()
    newChildren[head] = wrapped
    return { ...node, children: newChildren }
  }
  const recursed = insertAtPath(node.children[head], rest, incoming, direction, before)
  const newChildren = node.children.slice()
  newChildren[head] = recursed
  return { ...node, children: newChildren }
}
