// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Component tests for the IDE bottom panel: tab switching, panel close,
 * and tabpanel visibility. Asserts ARIA semantics (tablist + tab +
 * tabpanel) rather than Tailwind class strings.
 *
 * Tab/active state is now driven by `ideBottomPanelStore`. We reset the
 * store between tests so leftover state from one case doesn't bleed into
 * the next, and also so persisted `localStorage` values don't surprise us.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import {
  installAgentFetchMock,
  recordedAgentFetch,
  restoreAgentFetch,
} from '../../../../../test/helpers/mockAgentFetch'
import {
  ideBottomPanelStore,
} from '../../../../../lib/ide-bottom-panel-store'
import { __resetRuntimeLogStoreForTest } from '../../../../../lib/runtime-logs/runtime-log-store'
import { __resetRuntimeLogStreamForTest } from '../../../../../lib/runtime-logs/useRuntimeLogStream'

import { BottomPanel } from '../BottomPanel'

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
  // Both Terminal (commands) and Problems poll on mount. Stub them both
  // so the panel can render without log-noise about unrouted calls.
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

describe('BottomPanel — tab switching', () => {
  test('renders a tablist with Terminal active by default', () => {
    render(
      <BottomPanel projectId="p1" newSessionNonce={0} onClose={() => {}} />,
    )
    const tablist = screen.getByRole('tablist', { name: /bottom panel tabs/i })
    expect(within(tablist).getByRole('tab', { name: /^terminal$/i })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(within(tablist).getByRole('tab', { name: /^problems$/i })).toHaveAttribute(
      'aria-selected',
      'false',
    )
    expect(within(tablist).getByRole('tab', { name: /^output$/i })).toHaveAttribute(
      'aria-selected',
      'false',
    )
  })

  test('clicking Problems updates aria-selected and shows the matching tabpanel', async () => {
    const user = userEvent.setup()
    render(
      <BottomPanel projectId="p1" newSessionNonce={0} onClose={() => {}} />,
    )

    await user.click(screen.getByRole('tab', { name: /^problems$/i }))

    expect(screen.getByRole('tab', { name: /^problems$/i })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByRole('tab', { name: /^terminal$/i })).toHaveAttribute(
      'aria-selected',
      'false',
    )
  })

  test('inactive tabpanels are hidden via the `hidden` attribute (not class names)', async () => {
    const user = userEvent.setup()
    render(
      <BottomPanel projectId="p1" newSessionNonce={0} onClose={() => {}} />,
    )

    // Use IDs since happy-dom's accessible-name resolution for hidden
    // tabpanels has been flaky in earlier versions.
    const terminalPanel = document.getElementById('bottompanel-tabpanel-Terminal')!
    const problemsPanel = document.getElementById('bottompanel-tabpanel-Problems')!
    const outputPanel = document.getElementById('bottompanel-tabpanel-Output')!
    expect(terminalPanel).toHaveAttribute('role', 'tabpanel')
    expect(problemsPanel).toHaveAttribute('role', 'tabpanel')
    expect(outputPanel).toHaveAttribute('role', 'tabpanel')
    // jest-dom's `toBeVisible()` walks ancestors and honors `hidden` +
    // `display:none`. The visible panel must be visible; the hidden
    // panels must not be.
    expect(terminalPanel).toBeVisible()
    expect(problemsPanel).not.toBeVisible()
    expect(outputPanel).not.toBeVisible()

    await user.click(screen.getByRole('tab', { name: /^problems$/i }))
    expect(terminalPanel).not.toBeVisible()
    expect(problemsPanel).toBeVisible()

    await user.click(screen.getByRole('tab', { name: /^output$/i }))
    expect(outputPanel).toBeVisible()
    expect(problemsPanel).not.toBeVisible()
  })

  test('the active tab persists into the lifted store', async () => {
    const user = userEvent.setup()
    render(
      <BottomPanel projectId="p1" newSessionNonce={0} onClose={() => {}} />,
    )
    await user.click(screen.getByRole('tab', { name: /^output$/i }))
    expect(ideBottomPanelStore.getState().activeTab).toBe('Output')
  })
})

describe('BottomPanel — close', () => {
  test('clicking the X button calls onClose', async () => {
    const user = userEvent.setup()
    const onClose = mock(() => {})
    render(
      <BottomPanel projectId="p1" newSessionNonce={0} onClose={onClose} />,
    )

    await user.click(screen.getByRole('button', { name: /close panel/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('clicking the chevron Hide button also calls onClose', async () => {
    const user = userEvent.setup()
    const onClose = mock(() => {})
    render(
      <BottomPanel projectId="p1" newSessionNonce={0} onClose={onClose} />,
    )

    await user.click(screen.getByRole('button', { name: /hide panel/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('BottomPanel — Output red-dot badge', () => {
  test('no badge when there are no unseen errors for this project', () => {
    render(
      <BottomPanel projectId="p1" newSessionNonce={0} onClose={() => {}} />,
    )
    expect(screen.queryByTestId('tab-badge-Output')).not.toBeInTheDocument()
    // Accessible name should not include error-count text.
    expect(
      screen.getByRole('tab', { name: /^output$/i }),
    ).toBeInTheDocument()
  })

  test('reportError shows the badge with an accessible "N unseen errors" name', () => {
    // Simulate the runtime-log → bottom-panel store bridge firing twice.
    ideBottomPanelStore.reportError('p1')
    ideBottomPanelStore.reportError('p1')

    render(
      <BottomPanel projectId="p1" newSessionNonce={0} onClose={() => {}} />,
    )
    expect(screen.getByTestId('tab-badge-Output')).toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: /output \(2 unseen errors\)/i }),
    ).toBeInTheDocument()
  })

  test('errors for a different project do not show a badge here', () => {
    ideBottomPanelStore.reportError('p-other')
    render(
      <BottomPanel projectId="p1" newSessionNonce={0} onClose={() => {}} />,
    )
    expect(screen.queryByTestId('tab-badge-Output')).not.toBeInTheDocument()
  })

  test('opening the Output tab clears the badge via markAllSeen', async () => {
    const user = userEvent.setup()
    ideBottomPanelStore.reportError('p1')
    // reportError auto-flips activeTab to Output on first error — switch
    // the user *back* to Terminal to simulate them dismissing the
    // auto-open before clicking the tab themselves.
    ideBottomPanelStore.setActiveTab('Terminal')

    render(
      <BottomPanel projectId="p1" newSessionNonce={0} onClose={() => {}} />,
    )
    expect(screen.getByTestId('tab-badge-Output')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /output \(1 unseen error\)/i }))

    expect(screen.queryByTestId('tab-badge-Output')).not.toBeInTheDocument()
    expect(ideBottomPanelStore.getState().unseenErrorsByProject.p1).toBeUndefined()
  })

  test('badge uses singular "error" form when count is exactly one', () => {
    ideBottomPanelStore.reportError('p1')
    render(
      <BottomPanel projectId="p1" newSessionNonce={0} onClose={() => {}} />,
    )
    expect(
      screen.getByRole('tab', { name: /output \(1 unseen error\)/i }),
    ).toBeInTheDocument()
  })
})

describe('BottomPanel — auto-open on first error', () => {
  test('the lifted store auto-flips activeTab to Output when an error is reported', () => {
    ideBottomPanelStore.setActiveTab('Terminal')
    ideBottomPanelStore.setOpen(false)

    ideBottomPanelStore.reportError('p1')

    expect(ideBottomPanelStore.getState().activeTab).toBe('Output')
    expect(ideBottomPanelStore.getState().open).toBe(true)
  })

  test('a second error in the same project session does not re-flip activeTab', () => {
    ideBottomPanelStore.reportError('p1')
    ideBottomPanelStore.setActiveTab('Terminal')

    ideBottomPanelStore.reportError('p1')

    // The user manually switched away — the second error must NOT
    // hijack their selection. (Once-per-project-session rule.)
    expect(ideBottomPanelStore.getState().activeTab).toBe('Terminal')
    expect(ideBottomPanelStore.getState().unseenErrorsByProject.p1).toBe(2)
  })
})
