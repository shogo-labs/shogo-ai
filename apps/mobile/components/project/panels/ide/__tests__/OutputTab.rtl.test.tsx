// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * RTL tests for the IDE Output tab. Asserts user-visible behavior:
 * filter pills, search filtering, level/error counts, auto-scroll,
 * clear, and export.
 *
 * The component reads from the runtime-log store via
 * `useRuntimeLogStream`, so most tests drive entries through a
 * MockEventSource rather than poking the store directly. Where store
 * shape matters (e.g. asserting clear() resets the buffer) we use the
 * store API directly — that's the contract we want to lock in.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { MockEventSource } from '../../../../../test/helpers/mockEventSource'
import {
  __resetRuntimeLogStoreForTest,
  pushEntries,
  type RuntimeLogEntry,
} from '../../../../../lib/runtime-logs/runtime-log-store'
import { __resetRuntimeLogStreamForTest } from '../../../../../lib/runtime-logs/useRuntimeLogStream'

import { OutputTab } from '../OutputTab'

const PROJECT = 'proj-output'

let originalCreateObjectURL: typeof URL.createObjectURL | undefined
let originalRevokeObjectURL: typeof URL.revokeObjectURL | undefined
let createObjectURLCalls: Blob[] = []
let revokeObjectURLCalls: string[] = []

beforeEach(() => {
  __resetRuntimeLogStoreForTest()
  __resetRuntimeLogStreamForTest()
  MockEventSource.last = null
  MockEventSource.all = []

  // Stub Blob URL plumbing so the export test doesn't have to navigate.
  createObjectURLCalls = []
  revokeObjectURLCalls = []
  originalCreateObjectURL = URL.createObjectURL
  originalRevokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = ((blob: Blob) => {
    createObjectURLCalls.push(blob)
    return 'blob:mock-url'
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = ((url: string) => {
    revokeObjectURLCalls.push(url)
  }) as typeof URL.revokeObjectURL
})

afterEach(() => {
  __resetRuntimeLogStoreForTest()
  __resetRuntimeLogStreamForTest()
  if (originalCreateObjectURL) URL.createObjectURL = originalCreateObjectURL
  if (originalRevokeObjectURL) URL.revokeObjectURL = originalRevokeObjectURL
})

function entry(overrides: Partial<RuntimeLogEntry> = {}): RuntimeLogEntry {
  return {
    seq: overrides.seq ?? 1,
    ts: overrides.ts ?? Date.now(),
    source: overrides.source ?? 'console',
    level: overrides.level ?? 'info',
    text: overrides.text ?? 'hello world',
  }
}

function renderTab(opts: {
  projectId?: string | null
  agentUrl?: string | null
  visible?: boolean
  messages?: any[]
} = {}) {
  const factory = (url: string) =>
    new MockEventSource(url) as unknown as EventSource
  return render(
    <OutputTab
      projectId={opts.projectId ?? PROJECT}
      agentUrl={opts.agentUrl ?? 'http://agent.test'}
      visible={opts.visible ?? true}
      messages={opts.messages}
      __eventSourceFactory={factory}
    />,
  )
}

describe('OutputTab — empty state', () => {
  test('shows a friendly message when no agent is connected', () => {
    render(
      <OutputTab
        projectId={PROJECT}
        agentUrl={null}
        visible
        __eventSourceFactory={(u) =>
          new MockEventSource(u) as unknown as EventSource
        }
      />,
    )
    expect(
      screen.getByText(/no runtime logs yet\. start the agent/i),
    ).toBeInTheDocument()
  })

  test('shows a different empty state when connected but no entries yet', () => {
    renderTab()
    expect(
      screen.getByText(/no runtime logs yet/i),
    ).toBeInTheDocument()
  })
})

describe('OutputTab — rendering & filter pills', () => {
  test('renders entries from the store with source label and level badge', async () => {
    renderTab()
    await act(async () => {
      pushEntries(PROJECT, [
        entry({ seq: 1, source: 'build', level: 'error', text: 'tsc: type error' }),
        entry({ seq: 2, source: 'console', text: 'hello console' }),
      ])
    })
    const region = screen.getByRole('region', { name: /output entries/i })
    expect(within(region).getByText(/tsc: type error/)).toBeInTheDocument()
    expect(within(region).getByText(/hello console/)).toBeInTheDocument()
    // The error level badge is the lowercase token "error"; the source
    // label is the bracketed `[build]`.
    expect(within(region).getByText('error')).toBeInTheDocument()
    expect(within(region).getByText('[build]')).toBeInTheDocument()
    expect(within(region).getByText('[console]')).toBeInTheDocument()
  })

  test('clicking the Build pill filters out non-build entries', async () => {
    const user = userEvent.setup()
    renderTab()
    await act(async () => {
      pushEntries(PROJECT, [
        entry({ seq: 1, source: 'build', text: 'webpack done' }),
        entry({ seq: 2, source: 'console', text: 'log A' }),
        entry({ seq: 3, source: 'canvas-error', text: 'render fail' }),
      ])
    })
    expect(screen.getByText('log A')).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: /filter by build/i }))

    const region = screen.getByRole('region', { name: /output entries/i })
    expect(within(region).getByText(/webpack done/)).toBeInTheDocument()
    expect(within(region).queryByText('log A')).not.toBeInTheDocument()
    expect(within(region).queryByText('render fail')).not.toBeInTheDocument()
  })

  test('the active filter pill exposes aria-checked=true', async () => {
    const user = userEvent.setup()
    renderTab()
    expect(
      screen.getByRole('radio', { name: /filter by all/i }),
    ).toHaveAttribute('aria-checked', 'true')

    await user.click(screen.getByRole('radio', { name: /filter by exec/i }))

    expect(
      screen.getByRole('radio', { name: /filter by exec/i }),
    ).toHaveAttribute('aria-checked', 'true')
    expect(
      screen.getByRole('radio', { name: /filter by all/i }),
    ).toHaveAttribute('aria-checked', 'false')
  })
})

describe('OutputTab — search filtering', () => {
  test('typing in the search box filters entries by text content', async () => {
    const user = userEvent.setup()
    renderTab()
    await act(async () => {
      pushEntries(PROJECT, [
        entry({ seq: 1, text: 'compile failed: TS2345' }),
        entry({ seq: 2, text: 'starting dev server' }),
        entry({ seq: 3, text: 'build complete' }),
      ])
    })

    const searchBox = screen.getByRole('searchbox', { name: /search output/i })
    await user.type(searchBox, 'build')

    const region = screen.getByRole('region', { name: /output entries/i })
    expect(within(region).getByText(/build complete/)).toBeInTheDocument()
    expect(within(region).queryByText(/starting dev server/)).not.toBeInTheDocument()
    expect(within(region).queryByText(/compile failed/)).not.toBeInTheDocument()
  })

  test('search is case-insensitive', async () => {
    const user = userEvent.setup()
    renderTab()
    await act(async () => {
      pushEntries(PROJECT, [entry({ seq: 1, text: 'Hello FROM Vite' })])
    })
    await user.type(
      screen.getByRole('searchbox', { name: /search output/i }),
      'vite',
    )
    expect(screen.getByText(/Hello FROM Vite/)).toBeInTheDocument()
  })

  test('shows a no-match message when search yields zero entries', async () => {
    const user = userEvent.setup()
    renderTab()
    await act(async () => {
      pushEntries(PROJECT, [entry({ seq: 1, text: 'foo' })])
    })
    await user.type(
      screen.getByRole('searchbox', { name: /search output/i }),
      'no-such-thing',
    )
    expect(
      screen.getByText(/no entries match the current filters/i),
    ).toBeInTheDocument()
  })
})

describe('OutputTab — counts & badges', () => {
  test('status row reflects filtered entry count and error count', async () => {
    renderTab()
    await act(async () => {
      pushEntries(PROJECT, [
        entry({ seq: 1, level: 'error', text: 'boom' }),
        entry({ seq: 2, level: 'error', text: 'crash' }),
        entry({ seq: 3, level: 'info', text: 'ok' }),
      ])
    })

    const status = screen.getByRole('status')
    expect(within(status).getByText(/3 entries/)).toBeInTheDocument()
    expect(within(status).getByText(/2 errors/)).toBeInTheDocument()
  })

  test('error count uses singular form when there is exactly one', async () => {
    renderTab()
    await act(async () => {
      pushEntries(PROJECT, [
        entry({ seq: 1, level: 'error', text: 'boom' }),
        entry({ seq: 2, text: 'noise' }),
      ])
    })
    expect(screen.getByRole('status')).toHaveTextContent(/1 error\b/)
    expect(screen.getByRole('status')).toHaveTextContent(/2 entries/)
  })
})

describe('OutputTab — clear', () => {
  test('Clear button empties the buffer for this project', async () => {
    const user = userEvent.setup()
    renderTab()
    await act(async () => {
      pushEntries(PROJECT, [
        entry({ seq: 1, text: 'A' }),
        entry({ seq: 2, text: 'B' }),
      ])
    })
    expect(screen.getByText('A')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /clear output/i }))

    expect(screen.queryByText('A')).not.toBeInTheDocument()
    expect(screen.getByText(/no runtime logs yet/i)).toBeInTheDocument()
  })
})

describe('OutputTab — export', () => {
  test('Export button is disabled when there are no entries', () => {
    renderTab()
    expect(
      screen.getByRole('button', { name: /export output/i }),
    ).toBeDisabled()
  })

  test('Export button creates a Blob with one line per visible entry', async () => {
    const user = userEvent.setup()

    // Avoid jsdom/happy-dom navigation when the anchor's `click()` fires.
    const clickStub = mock(function (this: HTMLAnchorElement) {
      // Don't navigate.
    })
    const originalClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = clickStub as any

    try {
      renderTab()
      await act(async () => {
        pushEntries(PROJECT, [
          entry({ seq: 1, source: 'build', level: 'error', text: 'tsc fail' }),
          entry({ seq: 2, source: 'console', text: 'just a log' }),
        ])
      })

      await user.click(
        screen.getByRole('button', { name: /export output/i }),
      )

      expect(createObjectURLCalls).toHaveLength(1)
      expect(clickStub).toHaveBeenCalledTimes(1)
      expect(revokeObjectURLCalls).toHaveLength(1)

      // Read the Blob payload back to assert the lines round-tripped.
      const text = await createObjectURLCalls[0]!.text()
      const lines = text.split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatch(/\[build]/)
      expect(lines[0]).toMatch(/\[ERROR]/)
      expect(lines[0]).toMatch(/tsc fail/)
      expect(lines[1]).toMatch(/\[console]/)
      expect(lines[1]).not.toMatch(/\[ERROR]/)
      expect(lines[1]).toMatch(/just a log/)
    } finally {
      HTMLAnchorElement.prototype.click = originalClick
    }
  })

  test('Export honors the active source filter', async () => {
    const user = userEvent.setup()
    const clickStub = mock(function () {})
    const originalClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = clickStub as any

    try {
      renderTab()
      await act(async () => {
        pushEntries(PROJECT, [
          entry({ seq: 1, source: 'build', text: 'b1' }),
          entry({ seq: 2, source: 'console', text: 'c1' }),
        ])
      })
      await user.click(screen.getByRole('radio', { name: /filter by build/i }))
      await user.click(screen.getByRole('button', { name: /export output/i }))

      const text = await createObjectURLCalls[0]!.text()
      expect(text).toContain('b1')
      expect(text).not.toContain('c1')
    } finally {
      HTMLAnchorElement.prototype.click = originalClick
    }
  })
})

describe('OutputTab — auto-scroll', () => {
  test('auto-scrolls to the bottom when new entries land', async () => {
    renderTab()
    const region = screen.getByRole('region', { name: /output entries/i })
    Object.defineProperty(region, 'scrollHeight', {
      configurable: true,
      get: () => 1000,
    })
    region.scrollTop = 0

    await act(async () => {
      pushEntries(PROJECT, [entry({ seq: 1, text: 'first' })])
    })

    expect(region.scrollTop).toBe(1000)
  })

  test('toggling auto-scroll off pins scroll position on next entry', async () => {
    const user = userEvent.setup()
    renderTab()

    const region = screen.getByRole('region', { name: /output entries/i })
    Object.defineProperty(region, 'scrollHeight', {
      configurable: true,
      get: () => 1000,
    })

    await user.click(screen.getByRole('checkbox', { name: /auto-scroll/i }))
    region.scrollTop = 100

    await act(async () => {
      pushEntries(PROJECT, [entry({ seq: 1, text: 'first' })])
    })

    expect(region.scrollTop).toBe(100)
  })
})

describe('OutputTab — markAllSeen on visible', () => {
  test('opening the tab clears the unseen-error counter', async () => {
    // Pre-populate buffer with errors before mounting (so unseenErrors > 0).
    pushEntries(PROJECT, [
      entry({ seq: 1, level: 'error', text: 'boom' }),
      entry({ seq: 2, level: 'error', text: 'crash' }),
    ])

    // Mount with `visible=false` first — markAllSeen should not fire.
    const { rerender } = render(
      <OutputTab
        projectId={PROJECT}
        agentUrl="http://agent.test"
        visible={false}
        __eventSourceFactory={(u) =>
          new MockEventSource(u) as unknown as EventSource
        }
      />,
    )

    // Now flip to visible — markAllSeen should fire.
    await act(async () => {
      rerender(
        <OutputTab
          projectId={PROJECT}
          agentUrl="http://agent.test"
          visible
          __eventSourceFactory={(u) =>
            new MockEventSource(u) as unknown as EventSource
          }
        />,
      )
    })

    // The "N new" badge (unseen errors) should be gone.
    expect(screen.queryByTestId('unseen-error-count')).not.toBeInTheDocument()
  })
})
