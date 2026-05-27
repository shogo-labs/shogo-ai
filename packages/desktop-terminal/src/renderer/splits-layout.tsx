// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Binary-tree splits layout. Each leaf hosts a single Terminal
 * session; each internal node is a horizontal or vertical split with
 * a `ratio ∈ (0,1)` defining how much room the first child gets.
 *
 * This module owns:
 *
 *   1. **Pure tree algebra** — `splitLeaf`, `closeLeaf`, `updateRatio`,
 *      `findLeaf`, `walkLeaves`. Deeply unit-testable, no DOM.
 *
 *   2. **`<SplitsLayout>` React component** — renders the tree as
 *      nested flex containers and draggable dividers. Leaves are
 *      rendered via a caller-supplied `renderLeaf(id)` so we don't
 *      bind to xterm.js here.
 *
 *   3. **Focus + active-leaf tracking** — caller pushes the active id
 *      down and gets a `onActiveChange` callback when a click changes
 *      focus.
 *
 * Layout invariants:
 *   - tree is never empty (closing the last leaf is a no-op),
 *   - `ratio` is clamped to [MIN_RATIO, 1-MIN_RATIO] (default 0.1),
 *   - leaf ids are unique strings; the caller owns id allocation.
 */

import * as React from 'react'

// ─── tree types ─────────────────────────────────────────────────────

export type SplitDirection = 'h' | 'v'

export interface LeafNode {
  kind: 'leaf'
  id: string
}

export interface SplitNode {
  kind: 'split'
  /** 'h' = side-by-side (a | b), 'v' = stacked (a / b). */
  dir: SplitDirection
  ratio: number
  a: TreeNode
  b: TreeNode
}

export type TreeNode = LeafNode | SplitNode

export const MIN_RATIO = 0.1

// ─── algebra (pure functions) ───────────────────────────────────────

export function clampRatio(r: number): number {
  if (!Number.isFinite(r)) return 0.5
  return Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, r))
}

/** Walk the tree depth-first, yielding leaf ids in left-to-right order. */
export function walkLeaves(tree: TreeNode): string[] {
  const out: string[] = []
  const stack: TreeNode[] = [tree]
  while (stack.length) {
    const n = stack.pop()!
    if (n.kind === 'leaf') out.push(n.id)
    else { stack.push(n.b); stack.push(n.a) }
  }
  return out
}

/** Find the path (a/b indices) to a leaf, or null. */
export function findLeaf(tree: TreeNode, id: string): ('a' | 'b')[] | null {
  if (tree.kind === 'leaf') return tree.id === id ? [] : null
  const left = findLeaf(tree.a, id)
  if (left) return ['a', ...left]
  const right = findLeaf(tree.b, id)
  if (right) return ['b', ...right]
  return null
}

/**
 * Replace the leaf with `id` by a split where `id` becomes one child
 * and `newId` becomes the other. `placement` decides whether the new
 * leaf goes 'before' (left/top) or 'after' (right/bottom) the existing.
 */
export function splitLeaf(
  tree: TreeNode,
  id: string,
  newId: string,
  dir: SplitDirection,
  placement: 'before' | 'after' = 'after',
  ratio = 0.5,
): TreeNode {
  if (tree.kind === 'leaf') {
    if (tree.id !== id) return tree
    const a: LeafNode = placement === 'after' ? tree : { kind: 'leaf', id: newId }
    const b: LeafNode = placement === 'after' ? { kind: 'leaf', id: newId } : tree
    return { kind: 'split', dir, ratio: clampRatio(ratio), a, b }
  }
  return { ...tree, a: splitLeaf(tree.a, id, newId, dir, placement, ratio), b: splitLeaf(tree.b, id, newId, dir, placement, ratio) }
}

/**
 * Remove the leaf with `id`. If its parent split has another child,
 * that sibling replaces the parent. Closing the last leaf returns the
 * tree unchanged (caller decides whether to also unmount the panel).
 */
export function closeLeaf(tree: TreeNode, id: string): TreeNode {
  if (tree.kind === 'leaf') return tree
  if (tree.a.kind === 'leaf' && tree.a.id === id) return tree.b
  if (tree.b.kind === 'leaf' && tree.b.id === id) return tree.a
  const newA = closeLeaf(tree.a, id)
  const newB = closeLeaf(tree.b, id)
  if (newA === tree.a && newB === tree.b) return tree
  return { ...tree, a: newA, b: newB }
}

/**
 * Update the ratio of the nearest enclosing split that contains
 * `leafId`. We address dividers by "the leaf to the left/top of the
 * divider"; that's the natural way to identify dividers in the UI.
 * Returns the (possibly unchanged) tree.
 */
export function updateRatio(tree: TreeNode, leafId: string, ratio: number): TreeNode {
  if (tree.kind === 'leaf') return tree
  // If the leaf is directly tree.a, this is the divider to touch.
  if (tree.a.kind === 'leaf' && tree.a.id === leafId) {
    return { ...tree, ratio: clampRatio(ratio) }
  }
  // Otherwise recurse — the leaf may live in either subtree.
  const newA = updateRatio(tree.a, leafId, ratio)
  if (newA !== tree.a) return { ...tree, a: newA }
  const newB = updateRatio(tree.b, leafId, ratio)
  if (newB !== tree.b) return { ...tree, b: newB }
  return tree
}

/** Count leaves. Useful for sanity assertions in callers. */
export function countLeaves(tree: TreeNode): number {
  if (tree.kind === 'leaf') return 1
  return countLeaves(tree.a) + countLeaves(tree.b)
}

// ─── component ──────────────────────────────────────────────────────

export interface SplitsLayoutProps {
  tree: TreeNode
  /** Caller renders the actual terminal for a leaf id. */
  renderLeaf(id: string, isActive: boolean): React.ReactNode
  /** Currently focused leaf id; gets a highlighted divider/border. */
  activeId?: string
  /** Fired when the user clicks inside a leaf. */
  onActiveChange?(id: string): void
  /** Fired when the user drags a divider. New ratio in (0,1). */
  onRatioChange?(leftLeafId: string, ratio: number): void
  /** Optional class for the outer container. */
  className?: string
}

/**
 * Renders the tree using nested flex containers. Dividers are simple
 * 4 px draggable strips; styling is intentionally minimal — apps wrap
 * this with their design system.
 */
export function SplitsLayout(props: SplitsLayoutProps): React.ReactElement {
  return React.createElement(
    'div',
    {
      'data-testid': 'shogo-splits-root',
      className: props.className,
      style: { width: '100%', height: '100%', position: 'relative' },
    },
    renderNode(props.tree, props),
  )
}

function renderNode(node: TreeNode, props: SplitsLayoutProps): React.ReactElement {
  if (node.kind === 'leaf') {
    const isActive = node.id === props.activeId
    return React.createElement(
      'div',
      {
        'data-testid': `shogo-leaf-${node.id}`,
        'data-active': isActive ? 'true' : 'false',
        onMouseDown: () => props.onActiveChange?.(node.id),
        style: {
          width: '100%',
          height: '100%',
          position: 'relative',
          outline: isActive ? '1px solid #4a90e2' : '1px solid transparent',
        },
      },
      props.renderLeaf(node.id, isActive),
    )
  }
  const horizontal = node.dir === 'h'
  const aSize = `${(node.ratio * 100).toFixed(4)}%`
  const bSize = `${((1 - node.ratio) * 100).toFixed(4)}%`
  const leftLeafId = firstLeafId(node.a)
  return React.createElement(
    'div',
    {
      'data-testid': `shogo-split-${node.dir}`,
      style: {
        display: 'flex',
        flexDirection: horizontal ? 'row' : 'column',
        width: '100%',
        height: '100%',
        position: 'relative',
      },
    },
    React.createElement('div', { style: { flex: `0 0 ${aSize}`, minWidth: 0, minHeight: 0, position: 'relative' } }, renderNode(node.a, props)),
    React.createElement(SplitDivider, {
      direction: node.dir,
      leftLeafId,
      onRatioChange: props.onRatioChange,
    }),
    React.createElement('div', { style: { flex: `0 0 calc(${bSize} - 4px)`, minWidth: 0, minHeight: 0, position: 'relative' } }, renderNode(node.b, props)),
  )
}

function firstLeafId(n: TreeNode): string {
  return n.kind === 'leaf' ? n.id : firstLeafId(n.a)
}

interface SplitDividerProps {
  direction: SplitDirection
  leftLeafId: string
  onRatioChange?: (id: string, ratio: number) => void
}

function SplitDivider(props: SplitDividerProps): React.ReactElement {
  const dragRef = React.useRef<HTMLDivElement | null>(null)
  const onMouseDown = (ev: React.MouseEvent<HTMLDivElement>): void => {
    if (!props.onRatioChange) return
    const parent = (ev.currentTarget.parentElement as HTMLElement | null)
    if (!parent) return
    const rect = parent.getBoundingClientRect()
    ev.preventDefault()
    const move = (e: MouseEvent): void => {
      const ratio = props.direction === 'h'
        ? (e.clientX - rect.left) / rect.width
        : (e.clientY - rect.top) / rect.height
      props.onRatioChange!(props.leftLeafId, ratio)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return React.createElement('div', {
    ref: dragRef,
    'data-testid': `shogo-divider-${props.direction}`,
    onMouseDown,
    style: {
      flex: '0 0 4px',
      cursor: props.direction === 'h' ? 'ew-resize' : 'ns-resize',
      background: 'rgba(255,255,255,0.06)',
      userSelect: 'none',
    },
  })
}
