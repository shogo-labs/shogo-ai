// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SplitsHost — Phase 9 glue between the pure `SplitsLayout` tree and the
 * concrete world of terminal surfaces.
 *
 * `SplitsLayout` knows nothing about PTYs or xterm; it just renders a
 * tree of leaves. `SplitsHost` owns:
 *
 *   • the tree state (split, close, resize) — backed by the pure
 *     reducers in splits-layout.ts so all of them stay 1-line wrappers
 *     and the existing 196-LOC test suite stays the source of truth.
 *
 *   • the **focus model** — which leaf is active, ⌘1/⌘2 jump by index,
 *     ⌘⌥→ / ⌘⌥← move by spatial direction within the tree.
 *
 *   • the **keyboard shortcuts** — ⌘\ horizontal split, ⌘⇧\ vertical
 *     split. (Or Ctrl on Linux/Win.)
 *
 *   • the **lifecycle callbacks** — when a split happens, the host
 *     asks the embedder for a new leaf id (which is when the embedder
 *     spawns the new PTY). When a leaf closes, the host fires
 *     `onClose(id)` so the embedder can `kill()` the PTY. Resize fires
 *     `onResize` so the embedder can call `fitAddon.fit()`.
 *
 *   • a controlled OR uncontrolled tree (pass `tree` + `onTreeChange`
 *     for parent-managed state; omit both for self-managed). This
 *     mirrors the React `<input>` controlled/uncontrolled split.
 *
 * Hard constraints carried from the plan:
 *
 *   1. Closing a leaf must never leave its sibling without a parent
 *      (no orphan PTY). `closeLeaf` already handles this; we just have
 *      to fire `onClose` for the *closed* id, not its parent.
 *
 *   2. Drag-resize must call `onResize()` after the ratio change so
 *      both halves can `fitAddon.fit()`. We debounce via `requestAnimationFrame`
 *      so 60 fps dragging doesn't drown the surface in fits.
 */
import * as React from 'react'
import {
  SplitsLayout,
  splitLeaf,
  closeLeaf,
  updateRatio,
  walkLeaves,
  findLeaf,
  countLeaves,
  type TreeNode,
  type LeafNode,
  type SplitDirection,
} from './splits-layout'

export interface SplitsHostProps {
  /** Render the actual terminal surface for `id`. */
  renderLeaf(id: string, isActive: boolean): React.ReactNode

  /**
   * Caller-supplied id minter. Called every time a split happens. The
   * returned id is what the new leaf will be keyed by. Embedder is
   * expected to spawn the PTY for this id before returning.
   */
  spawnLeafId(): string

  /** Called when a leaf is removed from the tree. Embedder kills the PTY. */
  onClose?(id: string): void

  /** Called after every tree mutation (split, close, resize). */
  onResize?(): void

  /** Initial leaf id — only used in uncontrolled mode. */
  initialLeafId?: string

  /** Controlled mode: parent owns the tree. */
  tree?: TreeNode
  onTreeChange?(tree: TreeNode): void

  /** Initial active leaf — only used in uncontrolled mode. */
  initialActiveId?: string

  /** Controlled focus. */
  activeId?: string
  onActiveChange?(id: string): void

  /** Detect ⌘ vs Ctrl at runtime. Defaults to `navigator.platform`. */
  isMac?: boolean

  className?: string
}

/**
 * Public API for callers that need to drive splits from outside React
 * (e.g. an app menu's "Split right" item). `useSplitsController` returns
 * the same handlers SplitsHost binds internally, so menu actions and
 * keyboard shortcuts share one code path.
 */
export interface SplitsController {
  splitActive(direction: SplitDirection): void
  closeActive(): void
  focusByIndex(i: number): void
  focusDirection(dir: 'left' | 'right' | 'up' | 'down'): void
  getActiveId(): string
  getTree(): TreeNode
}

/**
 * Walks the tree in spatial order — left-to-right within horizontal
 * splits, top-to-bottom within vertical splits — and returns the leaf
 * id at the given index. Used by ⌘1 / ⌘2 / ⌘3… shortcuts.
 *
 * Exported so the embedder can render numbered badges on each leaf if
 * desired.
 */
export function leafIdAtIndex(tree: TreeNode, i: number): string | null {
  const leaves = walkLeaves(tree)
  return leaves[i] ?? null
}

/**
 * Find the leaf "next to" `id` in the requested cardinal direction.
 *
 * Algorithm: walk up the tree until we find a SplitNode whose direction
 * matches the requested axis AND whose subtree the move would step
 * across. Then pick the first leaf of the other half.
 *
 * Returns `null` if no leaf exists in that direction (we're at the
 * edge of the workspace).
 */
export function leafInDirection(
  tree: TreeNode,
  fromId: string,
  dir: 'left' | 'right' | 'up' | 'down',
): string | null {
  const path = findLeaf(tree, fromId)
  if (!path) return null
  // Match direction to axis + side.
  const axis: SplitDirection = (dir === 'left' || dir === 'right') ? 'h' : 'v'
  const moveAwayFromA = (dir === 'right' || dir === 'down')
  // Walk from leaf back up. For each split node, the leaf is in either
  // its `a` or `b` subtree depending on `path[i]`.
  let node: TreeNode = tree
  const ancestors: { node: TreeNode; childKey: 'a' | 'b' }[] = []
  for (const step of path) {
    if (node.kind !== 'split') return null
    ancestors.push({ node, childKey: step })
    node = step === 'a' ? node.a : node.b
  }
  // Walk back up the ancestors finding the closest split that matches
  // the direction AND has the leaf on the side we're moving away from.
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const { node: anc, childKey } = ancestors[i]
    if (anc.kind !== 'split') continue
    if (anc.dir !== axis) continue
    // Going right/down means leaf was in `a`; going left/up means in `b`.
    if (moveAwayFromA && childKey === 'a') {
      return firstLeafIdInSubtree(anc.b)
    }
    if (!moveAwayFromA && childKey === 'b') {
      return firstLeafIdInSubtree(anc.a)
    }
  }
  return null
}

function firstLeafIdInSubtree(n: TreeNode): string {
  return n.kind === 'leaf' ? n.id : firstLeafIdInSubtree(n.a)
}

export function SplitsHost(props: SplitsHostProps): React.ReactElement {
  // Tree state — controlled or uncontrolled.
  const [innerTree, setInnerTree] = React.useState<TreeNode>(() => {
    if (props.tree) return props.tree
    const id = props.initialLeafId ?? 'root'
    return { kind: 'leaf', id } satisfies LeafNode
  })
  const tree = props.tree ?? innerTree
  const updateTree = React.useCallback((next: TreeNode) => {
    if (props.onTreeChange) props.onTreeChange(next)
    if (!props.tree) setInnerTree(next)
  }, [props])

  // Active leaf id — controlled or uncontrolled.
  const [innerActive, setInnerActive] = React.useState<string>(
    props.initialActiveId ?? props.initialLeafId ?? 'root',
  )
  const activeId = props.activeId ?? innerActive
  const setActive = React.useCallback((id: string) => {
    if (props.onActiveChange) props.onActiveChange(id)
    if (props.activeId == null) setInnerActive(id)
  }, [props])

  // After every tree mutation, schedule a single rAF to fire onResize
  // — this coalesces drag-resize calls so we don't fit() per pixel.
  const resizeRaf = React.useRef<number | null>(null)
  const scheduleResize = React.useCallback(() => {
    if (!props.onResize) return
    if (resizeRaf.current != null) return
    resizeRaf.current = requestAnimationFrame(() => {
      resizeRaf.current = null
      props.onResize?.()
    })
  }, [props])
  React.useEffect(() => () => {
    if (resizeRaf.current != null) cancelAnimationFrame(resizeRaf.current)
  }, [])

  const splitActive = React.useCallback((direction: SplitDirection) => {
    const newId = props.spawnLeafId()
    // splitLeaf signature: (tree, id, newId, dir, placement?, ratio?).
    // Default placement 'after' puts the new leaf on the right/bottom,
    // matching VS Code's "split right / split down" feel.
    const next = splitLeaf(tree, activeId, newId, direction)
    updateTree(next)
    setActive(newId) // VS Code focuses the new pane.
    scheduleResize()
  }, [tree, activeId, props, updateTree, setActive, scheduleResize])

  const closeActive = React.useCallback(() => {
    if (countLeaves(tree) <= 1) return // Don't close the last surface.
    const closingId = activeId
    const next = closeLeaf(tree, closingId)
    updateTree(next)
    // Refocus a sibling leaf. We pick the first remaining leaf in spatial
    // order, which gives a predictable UX (matches VS Code's "focus the
    // pane that absorbed the space" heuristic well enough).
    const remaining = walkLeaves(next)
    if (remaining.length > 0) setActive(remaining[0])
    props.onClose?.(closingId)
    scheduleResize()
  }, [tree, activeId, props, updateTree, setActive, scheduleResize])

  const focusByIndex = React.useCallback((i: number) => {
    const id = leafIdAtIndex(tree, i)
    if (id) setActive(id)
  }, [tree, setActive])

  const focusDirection = React.useCallback((dir: 'left' | 'right' | 'up' | 'down') => {
    const id = leafInDirection(tree, activeId, dir)
    if (id) setActive(id)
  }, [tree, activeId, setActive])

  // Drag-resize plumbing — wraps the layout's onRatioChange so we both
  // mutate the tree AND schedule fit() on the surfaces.
  const onRatioChange = React.useCallback((leftLeafId: string, ratio: number) => {
    updateTree(updateRatio(tree, leftLeafId, ratio))
    scheduleResize()
  }, [tree, updateTree, scheduleResize])

  // Keyboard shortcuts — capture-phase document listener so the
  // shortcuts work even when xterm has DOM focus (xterm swallows most
  // keys, but ⌘ + key still bubbles).
  const isMac = props.isMac ?? (typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform))
  React.useEffect(() => {
    const mod = (ev: KeyboardEvent) => isMac ? ev.metaKey : ev.ctrlKey
    const onKey = (ev: KeyboardEvent) => {
      if (!mod(ev)) return
      // ⌘\ horizontal split. ⌘⇧\ vertical split.
      if (ev.key === '\\') {
        ev.preventDefault()
        splitActive(ev.shiftKey ? 'v' : 'h')
        return
      }
      // ⌘W closes the active pane (when more than one).
      if (ev.key.toLowerCase() === 'w' && !ev.altKey) {
        if (countLeaves(tree) > 1) {
          ev.preventDefault()
          closeActive()
        }
        return
      }
      // ⌘1 … ⌘9 jump by index.
      if (/^[1-9]$/.test(ev.key) && !ev.altKey && !ev.shiftKey) {
        const idx = Number.parseInt(ev.key, 10) - 1
        if (idx < countLeaves(tree)) {
          ev.preventDefault()
          focusByIndex(idx)
        }
        return
      }
      // ⌘⌥arrow — directional focus.
      if (ev.altKey) {
        if (ev.key === 'ArrowLeft')  { ev.preventDefault(); focusDirection('left');  return }
        if (ev.key === 'ArrowRight') { ev.preventDefault(); focusDirection('right'); return }
        if (ev.key === 'ArrowUp')    { ev.preventDefault(); focusDirection('up');    return }
        if (ev.key === 'ArrowDown')  { ev.preventDefault(); focusDirection('down');  return }
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [isMac, splitActive, closeActive, focusByIndex, focusDirection, tree])

  return React.createElement(SplitsLayout, {
    tree,
    activeId,
    onActiveChange: setActive,
    onRatioChange,
    renderLeaf: props.renderLeaf,
    className: props.className,
  })
}
