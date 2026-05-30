// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Minimal Quick-Pick components for "Recent Command" (Ctrl+Alt+R) and
 * "Recent Directory" (⌘G). Both are thin React wrappers over the
 * history sources in `../history/history-sources`.
 *
 * The components ship just enough markup for apps/desktop to plug in
 * a cmdk-styled variant on top. Behaviour is identical regardless of
 * styling: typed query → debounced filter → ↑/↓ navigation → Enter
 * accepts → Escape closes.
 *
 * Like every other React surface in this package, we provide a pure
 * controller hook (`useRecentPicker`) that owns the state machine.
 * Unit tests exercise the hook's reducer behaviour via direct calls;
 * the rendered component is a thin shell on top.
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import {
  CommandHistorySource,
  DirectoryHistorySource,
  type CommandHistoryEntry,
  type DirectoryHistoryEntry,
} from '../history/history-sources'

// ─── shared controller (used by both pickers) ───────────────────────

export interface PickerState<E> {
  isOpen: boolean
  query: string
  /** Filtered, ranked entries — recomputed on query change. */
  entries: E[]
  /** Highlighted entry index, or -1 when entries is empty. */
  highlight: number
}

export type PickerAction<E> =
  | { kind: 'open'; entries: E[] }
  | { kind: 'close' }
  | { kind: 'set-query'; query: string; entries: E[] }
  | { kind: 'move'; delta: number }

export function pickerReducer<E>(state: PickerState<E>, action: PickerAction<E>): PickerState<E> {
  switch (action.kind) {
    case 'open':
      return { isOpen: true, query: '', entries: action.entries, highlight: action.entries.length > 0 ? 0 : -1 }
    case 'close':
      return { ...state, isOpen: false, query: '', entries: [], highlight: -1 }
    case 'set-query': {
      const high = action.entries.length === 0 ? -1 : 0
      return { ...state, query: action.query, entries: action.entries, highlight: high }
    }
    case 'move': {
      const n = state.entries.length
      if (n === 0) return state
      // Wrap around — VS Code does this too.
      const next = ((state.highlight + action.delta) % n + n) % n
      return { ...state, highlight: next }
    }
  }
}

const initial = <E,>(): PickerState<E> => ({ isOpen: false, query: '', entries: [], highlight: -1 })

// ─── hooks ──────────────────────────────────────────────────────────

export interface UseCommandPickerOptions {
  source: CommandHistorySource
  onAccept(entry: CommandHistoryEntry): void
  /** If true, kick refreshDisk() on open. Default true. */
  loadDiskOnOpen?: boolean
}

export interface CommandPickerHandle {
  state: PickerState<CommandHistoryEntry>
  open(): void
  close(): void
  setQuery(q: string): void
  moveUp(): void
  moveDown(): void
  acceptHighlighted(): boolean
  acceptAt(index: number): boolean
}

export function useCommandPicker(opts: UseCommandPickerOptions): CommandPickerHandle {
  const [state, dispatch] = React.useReducer(
    pickerReducer as React.Reducer<PickerState<CommandHistoryEntry>, PickerAction<CommandHistoryEntry>>,
    null,
    initial<CommandHistoryEntry>,
  )
  const sourceRef = React.useRef(opts.source)
  sourceRef.current = opts.source
  const onAccept = opts.onAccept

  const open = React.useCallback(() => {
    if (opts.loadDiskOnOpen !== false) {
      // Fire-and-forget — the picker shows tracker entries immediately
      // and absorbs disk entries on the next setQuery / re-open.
      void sourceRef.current.refreshDisk()
    }
    dispatch({ kind: 'open', entries: sourceRef.current.list() })
  }, [opts.loadDiskOnOpen])

  const close = React.useCallback(() => dispatch({ kind: 'close' }), [])

  const setQuery = React.useCallback((q: string) => {
    dispatch({ kind: 'set-query', query: q, entries: sourceRef.current.filter(q) })
  }, [])

  const moveUp = React.useCallback(() => dispatch({ kind: 'move', delta: -1 }), [])
  const moveDown = React.useCallback(() => dispatch({ kind: 'move', delta: 1 }), [])

  const acceptAt = React.useCallback((index: number): boolean => {
    if (index < 0 || index >= state.entries.length) return false
    const e = state.entries[index]
    if (!e) return false
    onAccept(e)
    dispatch({ kind: 'close' })
    return true
  }, [state.entries, onAccept])

  const acceptHighlighted = React.useCallback(() => acceptAt(state.highlight), [acceptAt, state.highlight])

  return { state, open, close, setQuery, moveUp, moveDown, acceptHighlighted, acceptAt }
}

export interface UseDirectoryPickerOptions {
  source: DirectoryHistorySource
  onAccept(entry: DirectoryHistoryEntry): void
}

export interface DirectoryPickerHandle {
  state: PickerState<DirectoryHistoryEntry>
  open(): void
  close(): void
  setQuery(q: string): void
  moveUp(): void
  moveDown(): void
  acceptHighlighted(): boolean
  acceptAt(index: number): boolean
}

export function useDirectoryPicker(opts: UseDirectoryPickerOptions): DirectoryPickerHandle {
  const [state, dispatch] = React.useReducer(
    pickerReducer as React.Reducer<PickerState<DirectoryHistoryEntry>, PickerAction<DirectoryHistoryEntry>>,
    null,
    initial<DirectoryHistoryEntry>,
  )
  const sourceRef = React.useRef(opts.source)
  sourceRef.current = opts.source
  const onAccept = opts.onAccept

  const open = React.useCallback(() =>
    dispatch({ kind: 'open', entries: sourceRef.current.list() }), [])

  const close = React.useCallback(() => dispatch({ kind: 'close' }), [])

  const setQuery = React.useCallback((q: string) => {
    dispatch({ kind: 'set-query', query: q, entries: sourceRef.current.filter(q) })
  }, [])

  const moveUp = React.useCallback(() => dispatch({ kind: 'move', delta: -1 }), [])
  const moveDown = React.useCallback(() => dispatch({ kind: 'move', delta: 1 }), [])

  const acceptAt = React.useCallback((index: number): boolean => {
    if (index < 0 || index >= state.entries.length) return false
    const e = state.entries[index]
    if (!e) return false
    onAccept(e)
    dispatch({ kind: 'close' })
    return true
  }, [state.entries, onAccept])

  const acceptHighlighted = React.useCallback(() => acceptAt(state.highlight), [acceptAt, state.highlight])

  return { state, open, close, setQuery, moveUp, moveDown, acceptHighlighted, acceptAt }
}

// ─── default components (minimal markup) ────────────────────────────

export interface RecentCommandPickerProps {
  handle: CommandPickerHandle
  className?: string
}

export function RecentCommandPicker(props: RecentCommandPickerProps): React.ReactElement | null {
  const h = props.handle
  if (!h.state.isOpen) return null
  const rows = h.state.entries.map((e, i) =>
    React.createElement(PickerRow, {
      key: e.id,
      active: i === h.state.highlight,
      onClick: () => h.acceptAt(i),
      testId: `shogo-picker-row-${i}`,
      children: [
        React.createElement('span', { key: 'cmd', style: { fontFamily: 'monospace' } }, e.command),
        e.cwd
          ? React.createElement('span', { key: 'cwd', style: { float: 'right', opacity: 0.6, fontSize: 11 } }, e.cwd)
          : null,
      ],
    }),
  )
  return React.createElement(PickerShell, {
    className: props.className,
    testId: 'shogo-recent-command-picker',
    query: h.state.query,
    onQuery: h.setQuery,
    onClose: h.close,
    onUp: h.moveUp,
    onDown: h.moveDown,
    onAccept: h.acceptHighlighted,
    children: rows,
  })
}

export interface RecentDirectoryPickerProps {
  handle: DirectoryPickerHandle
  className?: string
}

export function RecentDirectoryPicker(props: RecentDirectoryPickerProps): React.ReactElement | null {
  const h = props.handle
  if (!h.state.isOpen) return null
  const rows = h.state.entries.map((e, i) =>
    React.createElement(PickerRow, {
      key: e.id,
      active: i === h.state.highlight,
      onClick: () => h.acceptAt(i),
      testId: `shogo-picker-row-${i}`,
      children: React.createElement('span', { style: { fontFamily: 'monospace' } }, e.path),
    }),
  )
  return React.createElement(PickerShell, {
    className: props.className,
    testId: 'shogo-recent-directory-picker',
    query: h.state.query,
    onQuery: h.setQuery,
    onClose: h.close,
    onUp: h.moveUp,
    onDown: h.moveDown,
    onAccept: h.acceptHighlighted,
    children: rows,
  })
}

// ─── shared markup ──────────────────────────────────────────────────

interface PickerShellProps {
  className?: string
  testId: string
  query: string
  onQuery(q: string): void
  onClose(): void
  onUp(): void
  onDown(): void
  onAccept(): boolean
  children: React.ReactNode
}

function PickerShell(props: PickerShellProps): React.ReactElement {
  const onKey = (ev: React.KeyboardEvent<HTMLInputElement>): void => {
    if (ev.key === 'Escape') { ev.preventDefault(); props.onClose() }
    else if (ev.key === 'Enter') { ev.preventDefault(); props.onAccept() }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); props.onUp() }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); props.onDown() }
  }
  const shell = React.createElement(
    'div',
    {
      role: 'dialog',
      'aria-modal': 'true',
      'data-testid': props.testId,
      className: props.className,
      style: {
        position: 'fixed',
        top: 60, left: '50%', transform: 'translateX(-50%)',
        width: 'min(480px, calc(100vw - 32px))', maxHeight: 'min(360px, calc(100vh - 96px))',
        zIndex: 2147483647,
        background: 'rgba(20,20,24,0.95)',
        border: '1px solid #444',
        borderRadius: 6,
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        display: 'flex', flexDirection: 'column',
        font: '13px / 1.4 system-ui',
        color: '#eee',
      },
    },
    React.createElement(
      'div',
      { style: { position: 'relative', borderBottom: '1px solid #333' } },
      React.createElement('input', {
        'data-testid': `${props.testId}-input`,
        autoFocus: true,
        placeholder: 'Type to filter…',
        value: props.query,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => props.onQuery(e.target.value),
        onKeyDown: onKey,
        style: {
          width: '100%',
          boxSizing: 'border-box',
          background: 'transparent', color: '#eee', border: 'none',
          padding: '8px 34px 8px 10px', outline: 'none', font: 'inherit',
        },
      }),
      React.createElement('button', {
        type: 'button',
        'aria-label': 'Close recent command picker',
        onClick: props.onClose,
        style: {
          position: 'absolute',
          top: '50%',
          right: 6,
          transform: 'translateY(-50%)',
          width: 24,
          height: 24,
          border: 'none',
          borderRadius: 4,
          background: 'transparent',
          color: '#aaa',
          cursor: 'pointer',
          font: '18px / 22px system-ui',
        },
      }, '×'),
    ),
    React.createElement(
      'div',
      { style: { overflowY: 'auto', flex: 1 } },
      props.children,
    ),
  )
  if (typeof document === 'undefined') return shell
  return createPortal(shell, document.body)
}

interface PickerRowProps {
  active: boolean
  onClick(): void
  testId: string
  children: React.ReactNode
}

function PickerRow(props: PickerRowProps): React.ReactElement {
  return React.createElement(
    'div',
    {
      'data-testid': props.testId,
      'data-active': props.active ? 'true' : 'false',
      onClick: props.onClick,
      style: {
        padding: '4px 10px',
        cursor: 'pointer',
        background: props.active ? 'rgba(80,140,220,0.25)' : 'transparent',
      },
    },
    props.children,
  )
}
