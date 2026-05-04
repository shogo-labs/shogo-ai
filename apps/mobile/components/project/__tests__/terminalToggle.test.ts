// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Locks the contract for the Terminal top-tab → IDE bottom drawer toggle.
 * Covers every branch in `decideTerminalToggleAction`, plus the regressions
 * from PR #477 review (HIGH: hidden-drawer "close" footgun; MEDIUM: sub-tab
 * preference loss; LOW: hard-coded `'dynamic-app'` restore).
 */
import { describe, expect, test } from 'bun:test'
import {
  decideTerminalToggleAction,
  type TerminalToggleInput,
} from '../terminalToggle'

const base: TerminalToggleInput = {
  storeOpen: false,
  storeActiveSubTab: 'Terminal',
  isWeb: true,
  canvasAreaHidden: false,
  isNarrow: false,
  activeTab: 'dynamic-app',
  lastSubTab: null,
  lastNonFullscreenPreview: 'dynamic-app',
}

describe('decideTerminalToggleAction — close path', () => {
  test('drawer open + visible → close, remembers current sub-tab', () => {
    const a = decideTerminalToggleAction({
      ...base,
      storeOpen: true,
      storeActiveSubTab: 'Output',
    })
    expect(a).toEqual({ kind: 'close', rememberSubTab: 'Output' })
  })

  test('drawer open + Problems sub-tab → close, remembers Problems', () => {
    const a = decideTerminalToggleAction({
      ...base,
      storeOpen: true,
      storeActiveSubTab: 'Problems',
    })
    expect(a).toEqual({ kind: 'close', rememberSubTab: 'Problems' })
  })
})

describe('decideTerminalToggleAction — HIGH-severity reveal path (drawer open but hidden)', () => {
  test('open in store but hidden by canvasAreaHidden (narrow chat-only) → reveal, no sub-tab churn', () => {
    const a = decideTerminalToggleAction({
      ...base,
      storeOpen: true,
      storeActiveSubTab: 'Output',
      canvasAreaHidden: true,
      isNarrow: true,
    })
    expect(a).toEqual({ kind: 'open', narrowTo: 'canvas' })
    // setSubTab intentionally absent — preserves user's Output selection.
    expect((a as any).setSubTab).toBeUndefined()
  })

  test('open in store but in chat-fullscreen on wide → reveal via lastNonFullscreenPreview', () => {
    const a = decideTerminalToggleAction({
      ...base,
      storeOpen: true,
      canvasAreaHidden: true,
      activeTab: 'chat-fullscreen',
      lastNonFullscreenPreview: 'app-preview',
    })
    expect(a).toEqual({ kind: 'open', previewTo: 'app-preview' })
  })

  test('does NOT call narrowTo when not narrow', () => {
    const a = decideTerminalToggleAction({
      ...base,
      storeOpen: true,
      canvasAreaHidden: true,
      isNarrow: false,
    })
    expect((a as any).narrowTo).toBeUndefined()
  })
})

describe('decideTerminalToggleAction — cold-start open path', () => {
  test('drawer closed, no remembered sub-tab → open Terminal sub-tab', () => {
    const a = decideTerminalToggleAction({ ...base })
    expect(a).toEqual({ kind: 'open', setSubTab: 'Terminal' })
  })

  test('drawer closed, narrow layout → open + swap narrow to canvas', () => {
    const a = decideTerminalToggleAction({ ...base, isNarrow: true })
    expect(a).toEqual({ kind: 'open', narrowTo: 'canvas', setSubTab: 'Terminal' })
  })

  test('drawer closed, wide + chat-fullscreen → open + restore lastNonFullscreenPreview', () => {
    const a = decideTerminalToggleAction({
      ...base,
      activeTab: 'chat-fullscreen',
      lastNonFullscreenPreview: 'app-preview',
    })
    expect(a).toEqual({
      kind: 'open',
      previewTo: 'app-preview',
      setSubTab: 'Terminal',
    })
  })

  test('drawer closed, wide + chat-fullscreen with no last preview → still falls back to dynamic-app via the ref default', () => {
    const a = decideTerminalToggleAction({
      ...base,
      activeTab: 'chat-fullscreen',
      lastNonFullscreenPreview: 'dynamic-app',
    })
    expect(a).toEqual({
      kind: 'open',
      previewTo: 'dynamic-app',
      setSubTab: 'Terminal',
    })
  })

  test('drawer closed, NOT in chat-fullscreen → does NOT call previewTo', () => {
    const a = decideTerminalToggleAction({
      ...base,
      activeTab: 'dynamic-app',
      lastNonFullscreenPreview: 'app-preview',
    })
    expect((a as any).previewTo).toBeUndefined()
  })
})

describe('decideTerminalToggleAction — MEDIUM: sub-tab preference restoration', () => {
  test('reopen after toggle-close on Output → restores Output, not Terminal', () => {
    const a = decideTerminalToggleAction({ ...base, lastSubTab: 'Output' })
    expect(a).toEqual({ kind: 'open', setSubTab: 'Output' })
  })

  test('reopen after toggle-close on Problems → restores Problems', () => {
    const a = decideTerminalToggleAction({ ...base, lastSubTab: 'Problems' })
    expect(a).toEqual({ kind: 'open', setSubTab: 'Problems' })
  })

  test('reopen with corrupted lastSubTab (defensive) → falls back to Terminal', () => {
    const a = decideTerminalToggleAction({
      ...base,
      lastSubTab: 'NotARealTab' as any,
    })
    expect(a).toEqual({ kind: 'open', setSubTab: 'Terminal' })
  })
})

describe('decideTerminalToggleAction — non-web platforms', () => {
  test('non-web treats canvasAreaHidden as effectively hidden (drawer not visible) → reveal path', () => {
    // The component never reaches this helper on native because the tab is
    // filtered from AGENT_TABS, but the helper itself must stay correct.
    const a = decideTerminalToggleAction({
      ...base,
      isWeb: false,
      storeOpen: true,
    })
    // storeOpen + !drawerVisible → reveal, not close.
    expect(a.kind).toBe('open')
  })
})

describe('decideTerminalToggleAction — interaction matrix', () => {
  test('close path NEVER fires when storeOpen but layout has hidden the drawer (HIGH-fix invariant)', () => {
    const cases: Array<Partial<TerminalToggleInput>> = [
      { canvasAreaHidden: true },
      { isWeb: false },
      { canvasAreaHidden: true, isNarrow: true },
      { canvasAreaHidden: true, activeTab: 'chat-fullscreen' },
    ]
    for (const c of cases) {
      const a = decideTerminalToggleAction({ ...base, storeOpen: true, ...c })
      expect(a.kind).toBe('open')
    }
  })

  test('open path NEVER force-overwrites sub-tab when revealing a store-open-but-hidden drawer (MEDIUM-fix invariant)', () => {
    const a = decideTerminalToggleAction({
      ...base,
      storeOpen: true,
      storeActiveSubTab: 'Output',
      canvasAreaHidden: true,
      isNarrow: true,
    })
    if (a.kind !== 'open') throw new Error('expected open')
    expect(a.setSubTab).toBeUndefined()
  })
})
