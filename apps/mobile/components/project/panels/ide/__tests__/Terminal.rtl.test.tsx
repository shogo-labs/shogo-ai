// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Component tests for the IDE Terminal under the new PTY architecture.
 *
 * The shell + xterm.js + WebSocket layers all live in unit / e2e tests
 * for `pty-protocol`, `pty-session`, `pty-ws-handler`, `pty-client`, and
 * `pty-ws-e2e`. Here we exercise only the React layer:
 *
 *   - Tab strip behavior (multi-session, positional labels, close-last
 *     dismisses the panel, ⌘⇧` nonce opens a new tab).
 *   - Preset menu (loaded via `/terminal/commands`, dangerous-confirm
 *     dialog, sending the command into the active PTY's send()).
 *   - Toolbar Stop/Clear wiring to the active session's PtyClient and
 *     XtermView handle.
 *
 * We mock `PtyClient` so REST POST → WS open → PTY data isn't actually
 * exercised, and we mock `XtermView` to a tiny div so happy-dom doesn't
 * try to load xterm.js (which needs Canvas/WebGL).
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  fakePtyClients,
  ptySendCalls,
  ptySignalCalls,
  resetTerminalPtyMocks,
  xtermClearCalls,
} from '../../../../../test/helpers/mockTerminalPty'
import {
  installAgentFetchMock,
  recordedAgentFetch,
  restoreAgentFetch,
} from '../../../../../test/helpers/mockAgentFetch'
import { __resetSessionIdSeqForTest } from '../terminal/session-reducer'

// ─── HTTP fixtures ──────────────────────────────────────────────────
function jsonOk<T>(body: T): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function presetCommandsResponse(): Response {
  return jsonOk({
    commands: {
      package: [
        {
          id: 'bun-install',
          label: 'bun install',
          description: 'Install workspace dependencies',
          category: 'package',
          dangerous: false,
          command: 'bun install',
        },
      ],
      database: [
        {
          id: 'prisma-reset',
          label: 'Reset database',
          description: 'Drops all data',
          category: 'database',
          dangerous: true,
          command: 'bun run db:reset',
        },
      ],
    },
  })
}

let createCounter = 0
function createSessionResponse(): Response {
  createCounter += 1
  return jsonOk({
    id: `srv-${createCounter}`,
    cwd: '/work',
    cols: 80,
    rows: 24,
    createdAt: Date.now(),
  })
}

let fetcher: ReturnType<typeof recordedAgentFetch>
type TerminalComponent = typeof import('../Terminal').Terminal
let Terminal: TerminalComponent

beforeAll(async () => {
  ;({ Terminal } = await import('../Terminal'))
})

beforeEach(() => {
  __resetSessionIdSeqForTest()
  resetTerminalPtyMocks()
  createCounter = 0
  fetcher = recordedAgentFetch()
  fetcher.setRoute('/terminal/commands', () => presetCommandsResponse())
  fetcher.setRoute('/terminal/sessions', () => createSessionResponse())
  // Catch-all for DELETE /terminal/sessions/:id (id-suffixed URLs).
  fetcher.setRoute(/\/terminal\/sessions\/[^/?]+$/, () => jsonOk({ ok: true }))
  installAgentFetchMock(fetcher.handler)
})

afterEach(() => {
  restoreAgentFetch()
})

// Helper: Terminal.tsx fires off the create-session POST inside an
// effect. Wait for the request to land + the resolved JSON body to
// hydrate the corresponding fake client.
async function waitForSessionsCreated(count: number): Promise<void> {
  await waitFor(() => {
    const created = fetcher.calls.filter(
      (c) =>
        c.url.endsWith('/terminal/sessions') && (c.init?.method ?? 'GET') === 'POST',
    )
    expect(created.length).toBeGreaterThanOrEqual(count)
  })
  await waitFor(() => {
    expect(fakePtyClients.length).toBeGreaterThanOrEqual(count)
  })
}

describe('Terminal — multi-session tabs', () => {
  test('renders one session tab labeled "Terminal 1" and provisions a PTY', async () => {
    render(<Terminal projectId="p1" visible />)
    expect(
      screen.getByRole('tab', { name: 'Terminal 1' }),
    ).toHaveAttribute('aria-selected', 'true')
    await waitForSessionsCreated(1)
  })

  test('"New Terminal" appends a session and provisions a second PTY', async () => {
    const user = userEvent.setup()
    render(<Terminal projectId="p1" visible />)
    await waitForSessionsCreated(1)

    await user.click(screen.getByRole('button', { name: /new terminal/i }))

    const tab2 = await screen.findByRole('tab', { name: 'Terminal 2' })
    expect(tab2).toHaveAttribute('aria-selected', 'true')
    await waitForSessionsCreated(2)
  })

  test('closing the middle session leaves "Terminal 1, 2" without gaps', async () => {
    const user = userEvent.setup()
    render(<Terminal projectId="p1" visible />)
    await waitForSessionsCreated(1)

    await user.click(screen.getByRole('button', { name: /new terminal/i }))
    await user.click(screen.getByRole('button', { name: /new terminal/i }))
    expect(await screen.findByRole('tab', { name: 'Terminal 3' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /close terminal 2/i }))

    await waitFor(() => {
      expect(screen.getAllByRole('tab')).toHaveLength(2)
    })
    expect(screen.getByRole('tab', { name: 'Terminal 1' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Terminal 2' })).toBeInTheDocument()
  })

  test('closing the last session calls onRequestClose', async () => {
    const user = userEvent.setup()
    const onRequestClose = mock(() => {})
    render(<Terminal projectId="p1" visible onRequestClose={onRequestClose} />)
    await waitForSessionsCreated(1)

    await user.click(screen.getByRole('button', { name: /close terminal 1/i }))
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  test('bumping newSessionNonce creates a new session', async () => {
    const { rerender } = render(
      <Terminal projectId="p1" visible newSessionNonce={0} />,
    )
    await waitForSessionsCreated(1)
    rerender(<Terminal projectId="p1" visible newSessionNonce={1} />)
    expect(await screen.findByRole('tab', { name: 'Terminal 2' })).toBeInTheDocument()
    await waitForSessionsCreated(2)
  })
})

describe('Terminal — preset menu', () => {
  test('confirms dangerous presets before sending them to the active shell', async () => {
    const user = userEvent.setup()
    render(<Terminal projectId="p1" visible />)
    await waitForSessionsCreated(1)
    act(() => fakePtyClients[0].__fireOpen())

    await user.click(screen.getByRole('button', { name: /terminal actions/i }))
    const menu = await screen.findByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: /reset database/i }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/destructive command/i)).toBeInTheDocument()
    expect(ptySendCalls).toHaveLength(0)

    await user.click(within(dialog).getByRole('button', { name: /cancel/i }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(ptySendCalls).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: /terminal actions/i }))
    const reopened = await screen.findByRole('menu')
    await user.click(within(reopened).getByRole('menuitem', { name: /reset database/i }))
    const dialog2 = await screen.findByRole('dialog')
    await user.click(within(dialog2).getByRole('button', { name: /run anyway/i }))

    await waitFor(() => {
      expect(ptySendCalls).toHaveLength(1)
    })
    expect(ptySendCalls[0].text).toBe('bun run db:reset\r')
  })

  test('non-dangerous presets type the command into the active shell', async () => {
    const user = userEvent.setup()
    render(<Terminal projectId="p1" visible />)
    await waitForSessionsCreated(1)
    act(() => fakePtyClients[0].__fireOpen())

    await user.click(screen.getByRole('button', { name: /terminal actions/i }))
    const menu = await screen.findByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: /bun install/i }))

    await waitFor(() => {
      expect(ptySendCalls).toHaveLength(1)
    })
    expect(ptySendCalls[0].text).toBe('bun install\r')
  })
})

describe('Terminal — toolbar', () => {
  test('Stop button SIGINTs the active PTY when the shell is open', async () => {
    const user = userEvent.setup()
    render(<Terminal projectId="p1" visible />)
    await waitForSessionsCreated(1)
    // Flip to "ready" so the Stop button renders.
    act(() => fakePtyClients[0].__fireOpen())

    const stopBtn = await screen.findByRole('button', { name: /stop running command/i })
    await user.click(stopBtn)

    expect(ptySignalCalls).toHaveLength(1)
    expect(ptySignalCalls[0].sig).toBe('INT')
  })

  test('Clear button blanks the xterm buffer for the active session', async () => {
    const user = userEvent.setup()
    render(<Terminal projectId="p1" visible />)
    await waitForSessionsCreated(1)
    act(() => fakePtyClients[0].__fireOpen())

    const clearBtn = await screen.findByRole('button', { name: /clear output/i })
    expect(clearBtn).not.toBeDisabled()
    await user.click(clearBtn)

    expect(xtermClearCalls.length).toBeGreaterThanOrEqual(1)
  })
})

