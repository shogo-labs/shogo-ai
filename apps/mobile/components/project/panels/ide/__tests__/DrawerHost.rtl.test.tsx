// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Smoke tests for the lifted IDE drawer host. Verifies:
 *
 *  - Gates: `platformIsWeb`, `canvasAreaHidden`, `isChatFullscreen`
 *    correctly suppress the drawer.
 *  - Children are always rendered (the previewTab switch must keep
 *    working even when the drawer is hidden).
 *  - Drawer state survives previewTab changes — i.e. swapping the
 *    `children` prop does not unmount the BottomPanel or reset its
 *    sessions.
 *  - Open/closed states render the right elements (peek handle vs
 *    resize separator + panel).
 *
 * Per the plan, full `ProjectLayout` mounting is out of scope (too many
 * providers). This test exercises `DrawerHost` directly with the same
 * gate signature the layout file uses.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import {
  installAgentFetchMock,
  recordedAgentFetch,
  restoreAgentFetch,
} from '../../../../../test/helpers/mockAgentFetch'
import { ideBottomPanelStore } from '../../../../../lib/ide-bottom-panel-store'
import {
  __resetRuntimeLogStoreForTest,
  pushEntries,
  type RuntimeLogEntry,
} from '../../../../../lib/runtime-logs/runtime-log-store'
import { __resetRuntimeLogStreamForTest } from '../../../../../lib/runtime-logs/useRuntimeLogStream'

import { DrawerHost, shouldShowDrawer } from '../DrawerHost'

function jsonOk<T>(body: T): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

let fetcher: ReturnType<typeof recordedAgentFetch>

beforeEach(() => {
  localStorage.clear()
  ideBottomPanelStore.__resetForTest()
  __resetRuntimeLogStoreForTest()
  __resetRuntimeLogStreamForTest()
  fetcher = recordedAgentFetch()
  fetcher.setRoute('/terminal/commands', () => jsonOk({ commands: {} }))
  fetcher.setRoute('/problems', () =>
    jsonOk({ diagnostics: [], status: 'ok', cursor: null }),
  )
  fetcher.setRoute('/diagnostics', () =>
    jsonOk({ diagnostics: [], status: 'ok', cursor: null }),
  )
  fetcher.setCatchAll(() => jsonOk({}))
  installAgentFetchMock(fetcher.handler)
})

afterEach(() => {
  restoreAgentFetch()
  ideBottomPanelStore.__resetForTest()
  __resetRuntimeLogStoreForTest()
  __resetRuntimeLogStreamForTest()
  localStorage.clear()
})

describe('shouldShowDrawer', () => {
  test('returns true only when web AND canvas visible AND not chat-fullscreen', () => {
    expect(
      shouldShowDrawer({
        platformIsWeb: true,
        canvasAreaHidden: false,
        isChatFullscreen: false,
      }),
    ).toBe(true)
  })

  test('returns false on native', () => {
    expect(
      shouldShowDrawer({
        platformIsWeb: false,
        canvasAreaHidden: false,
        isChatFullscreen: false,
      }),
    ).toBe(false)
  })

  test('returns false when canvasAreaHidden', () => {
    expect(
      shouldShowDrawer({
        platformIsWeb: true,
        canvasAreaHidden: true,
        isChatFullscreen: false,
      }),
    ).toBe(false)
  })

  test('returns false when chat is fullscreen', () => {
    expect(
      shouldShowDrawer({
        platformIsWeb: true,
        canvasAreaHidden: false,
        isChatFullscreen: true,
      }),
    ).toBe(false)
  })
})

describe('DrawerHost — gates', () => {
  test('renders only children when platformIsWeb is false', () => {
    render(
      <DrawerHost
        projectId="p1"
        platformIsWeb={false}
        canvasAreaHidden={false}
        isChatFullscreen={false}
      >
        <div data-testid="content">main content</div>
      </DrawerHost>,
    )
    expect(screen.getByTestId('content')).toBeInTheDocument()
    expect(screen.queryByTestId('drawer-host-peek')).not.toBeInTheDocument()
    expect(screen.queryByTestId('drawer-host-panel')).not.toBeInTheDocument()
  })

  test('renders only children when canvasAreaHidden is true', () => {
    render(
      <DrawerHost
        projectId="p1"
        platformIsWeb
        canvasAreaHidden
        isChatFullscreen={false}
      >
        <div data-testid="content">main content</div>
      </DrawerHost>,
    )
    expect(screen.getByTestId('content')).toBeInTheDocument()
    expect(screen.queryByTestId('drawer-host-peek')).not.toBeInTheDocument()
  })

  test('renders only children when isChatFullscreen is true', () => {
    render(
      <DrawerHost
        projectId="p1"
        platformIsWeb
        canvasAreaHidden={false}
        isChatFullscreen
      >
        <div data-testid="content">main content</div>
      </DrawerHost>,
    )
    expect(screen.getByTestId('content')).toBeInTheDocument()
    expect(screen.queryByTestId('drawer-host-peek')).not.toBeInTheDocument()
  })
})

describe('DrawerHost — open/closed', () => {
  test('shows peek handle when store.open is false', () => {
    render(
      <DrawerHost
        projectId="p1"
        platformIsWeb
        canvasAreaHidden={false}
        isChatFullscreen={false}
      >
        <div data-testid="content">main content</div>
      </DrawerHost>,
    )
    expect(screen.getByTestId('content')).toBeInTheDocument()
    expect(screen.getByTestId('drawer-host-peek')).toBeInTheDocument()
    expect(screen.queryByTestId('drawer-host-panel')).not.toBeInTheDocument()
  })

  test('shows BottomPanel + resize handle when store.open is true', () => {
    ideBottomPanelStore.setOpen(true)
    render(
      <DrawerHost
        projectId="p1"
        platformIsWeb
        canvasAreaHidden={false}
        isChatFullscreen={false}
      >
        <div data-testid="content">main content</div>
      </DrawerHost>,
    )
    expect(screen.getByTestId('drawer-host-panel')).toBeInTheDocument()
    expect(
      screen.getByRole('separator', { name: /resize panel/i }),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('drawer-host-peek')).not.toBeInTheDocument()
    // The BottomPanel's tablist is a strong indicator the panel mounted.
    expect(
      screen.getByRole('tablist', { name: /bottom panel tabs/i }),
    ).toBeInTheDocument()
  })

  test('peek handle opens the drawer on click (no drag movement)', async () => {
    const user = userEvent.setup()
    render(
      <DrawerHost
        projectId="p1"
        platformIsWeb
        canvasAreaHidden={false}
        isChatFullscreen={false}
      >
        <div data-testid="content">main content</div>
      </DrawerHost>,
    )
    // userEvent's click sequence is mousedown/mouseup at the same point —
    // exactly the "tiny click without drag" path we want.
    await user.click(screen.getByTestId('drawer-host-peek'))
    expect(ideBottomPanelStore.getState().open).toBe(true)
  })
})

describe('DrawerHost — runtime-log → bottom-panel error bridge', () => {
  function entry(overrides: Partial<RuntimeLogEntry> = {}): RuntimeLogEntry {
    return {
      seq: overrides.seq ?? 1,
      ts: overrides.ts ?? Date.now(),
      source: overrides.source ?? 'console',
      level: overrides.level ?? 'info',
      text: overrides.text ?? 'line',
    }
  }

  test('an error entry pushed to the runtime-log store auto-opens the drawer to Output', async () => {
    // Drawer starts closed and on the Terminal tab.
    expect(ideBottomPanelStore.getState().open).toBe(false)
    expect(ideBottomPanelStore.getState().activeTab).toBe('Terminal')

    render(
      <DrawerHost
        projectId="p1"
        platformIsWeb
        canvasAreaHidden={false}
        isChatFullscreen={false}
      >
        <div data-testid="content">main</div>
      </DrawerHost>,
    )

    await act(async () => {
      pushEntries('p1', [entry({ seq: 1, level: 'error', text: 'boom' })])
    })

    const s = ideBottomPanelStore.getState()
    expect(s.open).toBe(true)
    expect(s.activeTab).toBe('Output')
    expect(s.unseenErrorsByProject.p1).toBe(1)
  })

  test('non-error entries do not bump the counter or auto-open', async () => {
    render(
      <DrawerHost
        projectId="p1"
        platformIsWeb
        canvasAreaHidden={false}
        isChatFullscreen={false}
      >
        <div data-testid="content">main</div>
      </DrawerHost>,
    )

    await act(async () => {
      pushEntries('p1', [
        entry({ seq: 1, level: 'info', text: 'just info' }),
        entry({ seq: 2, level: 'warn', text: 'just warn' }),
      ])
    })

    const s = ideBottomPanelStore.getState()
    expect(s.open).toBe(false)
    expect(s.unseenErrorsByProject.p1).toBeUndefined()
  })

  test('errors for a different project are ignored by this DrawerHost', async () => {
    render(
      <DrawerHost
        projectId="p1"
        platformIsWeb
        canvasAreaHidden={false}
        isChatFullscreen={false}
      >
        <div data-testid="content">main</div>
      </DrawerHost>,
    )

    await act(async () => {
      pushEntries('p2', [entry({ seq: 1, level: 'error', text: 'p2 boom' })])
    })

    const s = ideBottomPanelStore.getState()
    // p1's drawer mustn't auto-open on p2's errors.
    expect(s.open).toBe(false)
    expect(s.unseenErrorsByProject.p1).toBeUndefined()
  })

  test('does not re-report entries that were already in the buffer at mount time', async () => {
    // Entry already in the store before the DrawerHost mounts (e.g. SSE
    // backlog replay arrived while user was on a different tab).
    pushEntries('p1', [entry({ seq: 1, level: 'error', text: 'pre-mount' })])

    render(
      <DrawerHost
        projectId="p1"
        platformIsWeb
        canvasAreaHidden={false}
        isChatFullscreen={false}
      >
        <div data-testid="content">main</div>
      </DrawerHost>,
    )

    // The bridge should snapshot the cursor on mount, so the pre-mount
    // entry doesn't re-fire `reportError`.
    expect(ideBottomPanelStore.getState().unseenErrorsByProject.p1).toBeUndefined()

    await act(async () => {
      pushEntries('p1', [entry({ seq: 2, level: 'error', text: 'post-mount' })])
    })

    expect(ideBottomPanelStore.getState().unseenErrorsByProject.p1).toBe(1)
  })
})

describe('DrawerHost — preview-tab survival', () => {
  test('rerendering with different children does not unmount the drawer', () => {
    ideBottomPanelStore.setOpen(true)

    const { rerender } = render(
      <DrawerHost
        projectId="p1"
        platformIsWeb
        canvasAreaHidden={false}
        isChatFullscreen={false}
      >
        <div data-testid="canvas-tab">canvas content</div>
      </DrawerHost>,
    )

    const drawerBefore = screen.getByTestId('drawer-host-panel')
    expect(drawerBefore).toBeInTheDocument()

    // Simulate the user switching previewTab → IDE.
    rerender(
      <DrawerHost
        projectId="p1"
        platformIsWeb
        canvasAreaHidden={false}
        isChatFullscreen={false}
      >
        <div data-testid="ide-tab">ide content</div>
      </DrawerHost>,
    )

    const drawerAfter = screen.getByTestId('drawer-host-panel')
    expect(drawerAfter).toBeInTheDocument()
    // Identity check — same DOM node means React preserved the subtree.
    expect(drawerAfter).toBe(drawerBefore)
    expect(screen.queryByTestId('canvas-tab')).not.toBeInTheDocument()
    expect(screen.getByTestId('ide-tab')).toBeInTheDocument()
  })
})
