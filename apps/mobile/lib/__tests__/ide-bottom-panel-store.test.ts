// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for the lifted IDE bottom-panel store. happy-dom is registered
 * in the test preload so `localStorage` is available.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  BOTTOM_PANEL_TABS,
  ideBottomPanelStore,
} from '../ide-bottom-panel-store'

beforeEach(() => {
  // Tests share happy-dom's localStorage — wipe to keep them isolated.
  localStorage.clear()
  ideBottomPanelStore.__resetForTest()
})

afterEach(() => {
  localStorage.clear()
  ideBottomPanelStore.__resetForTest()
})

describe('initial state', () => {
  test('open defaults to false when no value is persisted', () => {
    expect(ideBottomPanelStore.getState().open).toBe(false)
  })

  test('size defaults to the canonical 260px', () => {
    expect(ideBottomPanelStore.getState().size).toBe(260)
  })

  test('activeTab defaults to "Terminal"', () => {
    expect(ideBottomPanelStore.getState().activeTab).toBe('Terminal')
  })

  test('persisted open=true is read back', () => {
    localStorage.setItem('shogo.ide.bottomPanelOpen', 'true')
    ideBottomPanelStore.__resetForTest()
    expect(ideBottomPanelStore.getState().open).toBe(true)
  })

  test('persisted size is clamped on read', () => {
    localStorage.setItem('shogo.ide.bottomPanelSize', '9999')
    ideBottomPanelStore.__resetForTest()
    expect(ideBottomPanelStore.getState().size).toBe(600)

    localStorage.setItem('shogo.ide.bottomPanelSize', '10')
    ideBottomPanelStore.__resetForTest()
    expect(ideBottomPanelStore.getState().size).toBe(120)
  })

  test('an unknown persisted activeTab falls back to "Terminal"', () => {
    localStorage.setItem('shogo.ide.bottomPanelTab', 'NotARealTab')
    ideBottomPanelStore.__resetForTest()
    expect(ideBottomPanelStore.getState().activeTab).toBe('Terminal')
  })
})

describe('setOpen + toggleOpen', () => {
  test('setOpen persists to localStorage', () => {
    ideBottomPanelStore.setOpen(true)
    expect(localStorage.getItem('shogo.ide.bottomPanelOpen')).toBe('true')
    expect(ideBottomPanelStore.getState().open).toBe(true)
  })

  test('setOpen with the current value is a no-op (no listener fired)', () => {
    const listener = mock(() => {})
    ideBottomPanelStore.subscribe(listener)
    ideBottomPanelStore.setOpen(false)
    expect(listener).not.toHaveBeenCalled()
  })

  test('toggleOpen flips state and notifies subscribers', () => {
    const listener = mock(() => {})
    ideBottomPanelStore.subscribe(listener)
    ideBottomPanelStore.toggleOpen()
    expect(ideBottomPanelStore.getState().open).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    ideBottomPanelStore.toggleOpen()
    expect(ideBottomPanelStore.getState().open).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('setSize', () => {
  test('rounds and clamps the value to [120, 600]', () => {
    ideBottomPanelStore.setSize(50)
    expect(ideBottomPanelStore.getState().size).toBe(120)
    ideBottomPanelStore.setSize(900)
    expect(ideBottomPanelStore.getState().size).toBe(600)
    ideBottomPanelStore.setSize(300.6)
    expect(ideBottomPanelStore.getState().size).toBe(301)
  })

  test('persists to localStorage', () => {
    ideBottomPanelStore.setSize(420)
    expect(localStorage.getItem('shogo.ide.bottomPanelSize')).toBe('420')
  })

  test('non-finite input falls back to default', () => {
    ideBottomPanelStore.setSize(Number.NaN)
    expect(ideBottomPanelStore.getState().size).toBe(260)
  })
})

describe('setActiveTab', () => {
  test.each(BOTTOM_PANEL_TABS)('accepts %s and persists', (tab) => {
    // Switch away from the current tab first so the change is real
    // (no-op suppression skips persistence when value matches).
    const other: typeof tab = tab === 'Terminal' ? 'Output' : 'Terminal'
    ideBottomPanelStore.setActiveTab(other)
    ideBottomPanelStore.setActiveTab(tab)
    expect(ideBottomPanelStore.getState().activeTab).toBe(tab)
    expect(localStorage.getItem('shogo.ide.bottomPanelTab')).toBe(tab)
  })

  test('setting the current tab does not notify', () => {
    const listener = mock(() => {})
    ideBottomPanelStore.subscribe(listener)
    ideBottomPanelStore.setActiveTab('Terminal')
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('requestNewTerminal', () => {
  test('opens the drawer, focuses Terminal, and bumps the nonce', () => {
    const before = ideBottomPanelStore.getState().newTerminalNonce
    ideBottomPanelStore.setOpen(false)
    ideBottomPanelStore.setActiveTab('Output')

    ideBottomPanelStore.requestNewTerminal()

    const s = ideBottomPanelStore.getState()
    expect(s.open).toBe(true)
    expect(s.activeTab).toBe('Terminal')
    expect(s.newTerminalNonce).toBe(before + 1)
  })
})

describe('reportError + markAllSeen', () => {
  test('first error auto-opens the drawer and switches to Output (per project)', () => {
    ideBottomPanelStore.setActiveTab('Terminal')
    ideBottomPanelStore.setOpen(false)

    ideBottomPanelStore.reportError('p1')

    const s = ideBottomPanelStore.getState()
    expect(s.open).toBe(true)
    expect(s.activeTab).toBe('Output')
    expect(s.unseenErrorsByProject.p1).toBe(1)
  })

  test('subsequent errors only bump the counter (no re-open)', () => {
    ideBottomPanelStore.reportError('p1')
    ideBottomPanelStore.setOpen(false)
    ideBottomPanelStore.setActiveTab('Terminal')

    ideBottomPanelStore.reportError('p1')
    ideBottomPanelStore.reportError('p1')

    const s = ideBottomPanelStore.getState()
    // We didn't auto-reopen — user closed it back.
    expect(s.open).toBe(false)
    expect(s.activeTab).toBe('Terminal')
    expect(s.unseenErrorsByProject.p1).toBe(3)
  })

  test('errors from a different project re-trigger the auto-open', () => {
    ideBottomPanelStore.reportError('p1')
    ideBottomPanelStore.setOpen(false)
    ideBottomPanelStore.setActiveTab('Terminal')

    ideBottomPanelStore.reportError('p2')

    const s = ideBottomPanelStore.getState()
    expect(s.open).toBe(true)
    expect(s.activeTab).toBe('Output')
    expect(s.unseenErrorsByProject.p2).toBe(1)
    expect(s.unseenErrorsByProject.p1).toBe(1)
  })

  test('markAllSeen clears only the named project', () => {
    ideBottomPanelStore.reportError('p1')
    ideBottomPanelStore.reportError('p2')
    ideBottomPanelStore.markAllSeen('p1')
    const s = ideBottomPanelStore.getState()
    expect(s.unseenErrorsByProject.p1).toBeUndefined()
    expect(s.unseenErrorsByProject.p2).toBe(1)
  })

  test('markAllSeen for a project with no unseen errors is a no-op', () => {
    const listener = mock(() => {})
    ideBottomPanelStore.subscribe(listener)
    ideBottomPanelStore.markAllSeen('never-errored')
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('subscribe + unsubscribe', () => {
  test('listener fires for every state change', () => {
    const listener = mock(() => {})
    ideBottomPanelStore.subscribe(listener)
    ideBottomPanelStore.setOpen(true)
    ideBottomPanelStore.setSize(200)
    ideBottomPanelStore.setActiveTab('Output')
    expect(listener).toHaveBeenCalledTimes(3)
  })

  test('unsubscribe stops notifications', () => {
    const listener = mock(() => {})
    const unsubscribe = ideBottomPanelStore.subscribe(listener)
    unsubscribe()
    ideBottomPanelStore.setOpen(true)
    expect(listener).not.toHaveBeenCalled()
  })
})
