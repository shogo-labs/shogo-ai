// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Find-in-terminal — wraps `@xterm/addon-search` behind a narrow
 * interface and ships a minimal popover component. apps/desktop's
 * design system can render its own popover and just consume the
 * controller; we provide a default for ergonomics.
 *
 * Surface split:
 *
 *   - `SearchController` — non-React class. Owns the addon, current
 *     query, and the case/regex/whole-word toggles. `findNext` /
 *     `findPrev` / `setQuery` / `setOptions` / `clear`. Easy to test.
 *
 *   - `useSearch(controller)` — React hook returning `{ query,
 *     options, hits, setQuery, setOptions, next, prev, close, isOpen,
 *     open }`. Owns the popover open-state and the "active hit"
 *     counter via the addon's `onDidChangeResults` callback.
 *
 *   - `<SearchPopover />` — thin styled wrapper around the hook.
 *     apps/desktop replaces it with a shadcn variant.
 */

import * as React from 'react'

// ─── narrow xterm addon-search interface ────────────────────────────

export interface SearchOptions {
  caseSensitive?: boolean
  regex?: boolean
  wholeWord?: boolean
  /** When true, the next findNext() starts from the current cursor. */
  incremental?: boolean
}

/** Subset of `@xterm/addon-search`'s SearchAddon we need. */
export interface SearchAddonLike {
  findNext(term: string, options?: SearchOptions): boolean
  findPrevious(term: string, options?: SearchOptions): boolean
  clearDecorations?(): void
  dispose?(): void
  /**
   * Subscribes to result-changes; cb is called with the total match
   * count and the index of the currently-highlighted match (or -1).
   * Returns a dispose-style handle.
   */
  onDidChangeResults?(cb: (e: { resultIndex: number; resultCount: number }) => void): { dispose(): void } | (() => void)
}

export interface SearchHits {
  total: number
  /** 1-based index of the currently focused hit (0 when no focus). */
  current: number
}

// ─── controller ────────────────────────────────────────────────────

export interface SearchControllerOptions {
  addon: SearchAddonLike
  /** Listener for result updates (drives the hook's re-render). */
  onResults?(hits: SearchHits): void
}

export class SearchController {
  private readonly addon: SearchAddonLike
  private query = ''
  private options: SearchOptions = {}
  private listener?: (hits: SearchHits) => void
  private unsubscribeResults: (() => void) | null = null
  private lastHits: SearchHits = { total: 0, current: 0 }
  private disposed = false

  constructor(opts: SearchControllerOptions) {
    this.addon = opts.addon
    this.listener = opts.onResults
    if (this.addon.onDidChangeResults) {
      const handle = this.addon.onDidChangeResults((e) => {
        this.lastHits = { total: e.resultCount, current: e.resultIndex < 0 ? 0 : e.resultIndex + 1 }
        this.listener?.(this.lastHits)
      })
      this.unsubscribeResults = typeof handle === 'function' ? handle : () => handle.dispose()
    }
  }

  /** Replace the listener (used by hook re-renders). */
  setListener(cb?: (hits: SearchHits) => void): void {
    this.listener = cb
    if (cb) cb(this.lastHits)
  }

  getQuery(): string { return this.query }
  getOptions(): SearchOptions { return { ...this.options } }
  getHits(): SearchHits { return this.lastHits }

  setQuery(q: string): void {
    if (this.disposed) return
    this.query = q
    if (q.length === 0) {
      this.addon.clearDecorations?.()
      this.lastHits = { total: 0, current: 0 }
      this.listener?.(this.lastHits)
      return
    }
    // Re-issue a search so highlights match the new query.
    this.addon.findNext(this.query, { ...this.options, incremental: true })
  }

  setOptions(opts: SearchOptions): void {
    if (this.disposed) return
    this.options = { ...opts }
    if (this.query) this.addon.findNext(this.query, { ...this.options, incremental: true })
  }

  /** Returns true if a match was found. */
  findNext(): boolean {
    if (this.disposed || !this.query) return false
    return this.addon.findNext(this.query, { ...this.options })
  }

  /** Returns true if a match was found. */
  findPrev(): boolean {
    if (this.disposed || !this.query) return false
    return this.addon.findPrevious(this.query, { ...this.options })
  }

  /** Clear query + highlights. */
  clear(): void {
    if (this.disposed) return
    this.query = ''
    this.addon.clearDecorations?.()
    this.lastHits = { total: 0, current: 0 }
    this.listener?.(this.lastHits)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.unsubscribeResults) {
      try { this.unsubscribeResults() } catch { /* */ }
      this.unsubscribeResults = null
    }
    this.listener = undefined
    this.addon.clearDecorations?.()
  }
}

// ─── React hook + component ────────────────────────────────────────

export interface UseSearchValue {
  isOpen: boolean
  open(): void
  close(): void
  query: string
  setQuery(q: string): void
  options: SearchOptions
  setOptions(o: SearchOptions): void
  hits: SearchHits
  next(): boolean
  prev(): boolean
}

/**
 * Hook that wires a SearchController into React local state. Caller
 * triggers `open()` from a key handler (⌘F).
 */
export function useSearch(controller: SearchController): UseSearchValue {
  const [isOpen, setOpen] = React.useState(false)
  const [query, setQueryState] = React.useState(controller.getQuery())
  const [options, setOptionsState] = React.useState<SearchOptions>(controller.getOptions())
  const [hits, setHits] = React.useState<SearchHits>(controller.getHits())

  React.useEffect(() => {
    controller.setListener(setHits)
    return () => controller.setListener(undefined)
  }, [controller])

  const setQuery = React.useCallback((q: string) => {
    setQueryState(q)
    controller.setQuery(q)
  }, [controller])

  const setOptions = React.useCallback((o: SearchOptions) => {
    setOptionsState(o)
    controller.setOptions(o)
  }, [controller])

  const next = React.useCallback(() => controller.findNext(), [controller])
  const prev = React.useCallback(() => controller.findPrev(), [controller])
  const open = React.useCallback(() => setOpen(true), [])
  const close = React.useCallback(() => {
    setOpen(false)
    controller.clear()
    setQueryState('')
  }, [controller])

  return { isOpen, open, close, query, setQuery, options, setOptions, hits, next, prev }
}

// ─── default popover (minimal) ─────────────────────────────────────

export interface SearchPopoverProps {
  controller: SearchController
  className?: string
}

export function SearchPopover(props: SearchPopoverProps): React.ReactElement | null {
  const s = useSearch(props.controller)
  if (!s.isOpen) return null

  const onKeyDown = (ev: React.KeyboardEvent<HTMLInputElement>): void => {
    if (ev.key === 'Enter') {
      ev.preventDefault()
      if (ev.shiftKey) s.prev()
      else s.next()
    } else if (ev.key === 'Escape') {
      ev.preventDefault()
      s.close()
    }
  }

  return React.createElement(
    'div',
    {
      role: 'search',
      'data-testid': 'shogo-search-popover',
      className: props.className,
      style: {
        position: 'absolute',
        top: 4, right: 4,
        zIndex: 10,
        font: '12px / 1.4 system-ui',
        background: 'rgba(20,20,24,0.92)',
        color: '#eee',
        padding: '4px 6px',
        borderRadius: 4,
        display: 'flex',
        gap: 4,
        alignItems: 'center',
      },
    },
    React.createElement('input', {
      'data-testid': 'shogo-search-input',
      'aria-label': 'Find in terminal',
      value: s.query,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => s.setQuery(e.target.value),
      onKeyDown,
      autoFocus: true,
      style: { background: 'transparent', color: '#eee', border: '1px solid #555', borderRadius: 3, padding: '2px 4px', width: 180 },
    }),
    React.createElement(
      'span',
      { 'data-testid': 'shogo-search-hits', style: { minWidth: 48, textAlign: 'right', opacity: 0.7 } },
      s.hits.total === 0 ? '0/0' : `${s.hits.current}/${s.hits.total}`,
    ),
    toggleButton('Aa', !!s.options.caseSensitive, () => s.setOptions({ ...s.options, caseSensitive: !s.options.caseSensitive })),
    toggleButton('.*', !!s.options.regex, () => s.setOptions({ ...s.options, regex: !s.options.regex })),
    toggleButton('ab', !!s.options.wholeWord, () => s.setOptions({ ...s.options, wholeWord: !s.options.wholeWord })),
  )
}

function toggleButton(label: string, on: boolean, onClick: () => void): React.ReactElement {
  return React.createElement('button', {
    onClick,
    'aria-pressed': on,
    style: {
      background: on ? '#3a6' : 'transparent',
      color: '#eee',
      border: '1px solid #555',
      borderRadius: 3,
      padding: '1px 5px',
      cursor: 'pointer',
      font: 'inherit',
    },
  }, label)
}
