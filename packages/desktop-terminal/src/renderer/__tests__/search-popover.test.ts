// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests cover the non-React `SearchController`. The hook +
 * component are exercised when apps/desktop integrates; the
 * controller carries all the search logic.
 */

import { describe, it, expect } from 'bun:test'
import {
  SearchController,
  type SearchAddonLike,
  type SearchHits,
  type SearchOptions,
} from '../search-popover'

interface FakeAddon extends SearchAddonLike {
  calls: { fn: string; args: unknown[] }[]
  fireResults(resultIndex: number, resultCount: number): void
  dispose(): void
  setNext(value: boolean): void
  setPrev(value: boolean): void
}

function makeAddon(): FakeAddon {
  const calls: { fn: string; args: unknown[] }[] = []
  let listener: ((e: { resultIndex: number; resultCount: number }) => void) | null = null
  let nextResult = true
  let prevResult = true
  return {
    calls,
    findNext(term, opts) { calls.push({ fn: 'findNext', args: [term, opts] }); return nextResult },
    findPrevious(term, opts) { calls.push({ fn: 'findPrevious', args: [term, opts] }); return prevResult },
    clearDecorations() { calls.push({ fn: 'clearDecorations', args: [] }) },
    onDidChangeResults(cb) {
      listener = cb
      return { dispose() { listener = null } }
    },
    fireResults(resultIndex, resultCount) { listener?.({ resultIndex, resultCount }) },
    dispose() { /* */ },
    setNext(v) { nextResult = v },
    setPrev(v) { prevResult = v },
  }
}

// ─── query lifecycle ──────────────────────────────────────────────────

describe('SearchController — query lifecycle', () => {
  it('setQuery("") clears highlights and resets hits', () => {
    const addon = makeAddon()
    let hits: SearchHits = { total: -1, current: -1 }
    const ctl = new SearchController({ addon, onResults: (h) => { hits = h } })
    ctl.setQuery('foo')
    addon.fireResults(0, 5)
    expect(hits).toEqual({ total: 5, current: 1 })
    ctl.setQuery('')
    expect(addon.calls.find((c) => c.fn === 'clearDecorations')).toBeTruthy()
    expect(hits).toEqual({ total: 0, current: 0 })
  })

  it('setQuery issues an incremental findNext under the hood', () => {
    const addon = makeAddon()
    const ctl = new SearchController({ addon })
    ctl.setQuery('hello')
    const last = addon.calls.findLast((c) => c.fn === 'findNext')!
    expect(last.args[0]).toBe('hello')
    expect((last.args[1] as SearchOptions).incremental).toBe(true)
  })

  it('setOptions re-issues a search with the new options', () => {
    const addon = makeAddon()
    const ctl = new SearchController({ addon })
    ctl.setQuery('foo')
    ctl.setOptions({ regex: true, caseSensitive: true })
    const last = addon.calls.findLast((c) => c.fn === 'findNext')!
    expect((last.args[1] as SearchOptions).regex).toBe(true)
    expect((last.args[1] as SearchOptions).caseSensitive).toBe(true)
  })

  it('setOptions with no query does NOT issue a search', () => {
    const addon = makeAddon()
    const ctl = new SearchController({ addon })
    ctl.setOptions({ regex: true })
    expect(addon.calls.filter((c) => c.fn === 'findNext')).toHaveLength(0)
  })
})

// ─── navigation ───────────────────────────────────────────────────────

describe('SearchController — navigation', () => {
  it('findNext / findPrev forward the current query + options', () => {
    const addon = makeAddon()
    const ctl = new SearchController({ addon })
    ctl.setQuery('foo')
    ctl.setOptions({ wholeWord: true })
    addon.calls.length = 0
    expect(ctl.findNext()).toBe(true)
    expect(ctl.findPrev()).toBe(true)
    expect(addon.calls[0]).toMatchObject({ fn: 'findNext', args: ['foo', { wholeWord: true }] })
    expect(addon.calls[1]).toMatchObject({ fn: 'findPrevious', args: ['foo', { wholeWord: true }] })
  })

  it('findNext returns false when query is empty', () => {
    const addon = makeAddon()
    const ctl = new SearchController({ addon })
    expect(ctl.findNext()).toBe(false)
    expect(addon.calls).toHaveLength(0)
  })

  it('returns the addon\'s boolean verdict on misses', () => {
    const addon = makeAddon()
    addon.setNext(false)
    const ctl = new SearchController({ addon })
    ctl.setQuery('foo')
    expect(ctl.findNext()).toBe(false)
  })
})

// ─── results plumbing ─────────────────────────────────────────────────

describe('SearchController — results listener', () => {
  it('translates resultIndex -1 / 0+ into a 1-based current', () => {
    const addon = makeAddon()
    let hits: SearchHits = { total: 0, current: 0 }
    const ctl = new SearchController({ addon, onResults: (h) => { hits = h } })
    addon.fireResults(-1, 0)
    expect(hits).toEqual({ total: 0, current: 0 })
    addon.fireResults(0, 3)
    expect(hits).toEqual({ total: 3, current: 1 })
    addon.fireResults(2, 3)
    expect(hits).toEqual({ total: 3, current: 3 })
    void ctl
  })

  it('setListener replaces the listener and pushes lastHits immediately', () => {
    const addon = makeAddon()
    const ctl = new SearchController({ addon })
    addon.fireResults(1, 5)
    let hits: SearchHits | null = null
    ctl.setListener((h) => { hits = h })
    expect(hits).toEqual({ total: 5, current: 2 })
  })
})

// ─── lifecycle ───────────────────────────────────────────────────────

describe('SearchController — clear + dispose', () => {
  it('clear resets state and notifies the listener', () => {
    const addon = makeAddon()
    let hits: SearchHits | null = null
    const ctl = new SearchController({ addon, onResults: (h) => { hits = h } })
    ctl.setQuery('x')
    addon.fireResults(0, 1)
    ctl.clear()
    expect(ctl.getQuery()).toBe('')
    expect(hits).toEqual({ total: 0, current: 0 })
  })

  it('dispose unsubscribes the results listener', () => {
    const addon = makeAddon()
    let hits: SearchHits = { total: 0, current: 0 }
    const ctl = new SearchController({ addon, onResults: (h) => { hits = h } })
    addon.fireResults(0, 2) // listener fires
    ctl.dispose()
    const before = { ...hits }
    addon.fireResults(0, 7) // should be ignored
    expect(hits).toEqual(before)
  })

  it('post-dispose findNext is a no-op', () => {
    const addon = makeAddon()
    const ctl = new SearchController({ addon })
    ctl.setQuery('foo')
    ctl.dispose()
    addon.calls.length = 0
    expect(ctl.findNext()).toBe(false)
    expect(addon.calls).toHaveLength(0)
  })
})
