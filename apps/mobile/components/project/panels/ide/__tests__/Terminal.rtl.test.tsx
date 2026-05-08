// SPDX-License-Identifier: AGPL-3.0-or-later
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
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'

import {
  installAgentFetchMock,
  recordedAgentFetch,
  restoreAgentFetch,
} from '../../../../../test/helpers/mockAgentFetch'
import { __resetSessionIdSeqForTest } from '../terminal/session-reducer'

// ─── Mock createPtyClient: no real WebSocket; record calls + expose state.
// We mock the *factory* (pty-factory) rather than the underlying PtyClient
// module so the dedicated `pty-client.test.ts` keeps seeing the real
// implementation when both files run in the same Bun process.
interface FakePtyClient {
  url: string
  state: 'idle' | 'connecting' | 'open' | 'closed' | 'disposed'
  connect: () => void
  send: (text: string | Uint8Array) => void
  resize: (cols: number, rows: number) => void
  signal: (sig: 'INT' | 'TERM' | 'KILL') => void
  dispose: () => void
  onState: (cb: (s: string) => void) => () => void
  onData: (cb: (b: Uint8Array) => void) => () => void
  onExit: (cb: (info: unknown) => void) => () => void
  onError: (cb: (e: Error) => void) => () => void
  onTruncated: (cb: () => void) => () => void
  __fireOpen: () => void
}

const fakeClients: FakePtyClient[] = []
const sendCalls: Array<{ url: string; text: string }> = []
const signalCalls: Array<{ url: string; sig: string }> = []

function createFakeClient(url: string): FakePtyClient {
  const stateListeners = new Set<(s: string) => void>()
  const errorListeners = new Set<(e: Error) => void>()
  const client: FakePtyClient = {
    url,
    state: 'idle',
    connect() {
      this.state = 'connecting'
      stateListeners.forEach((cb) => cb('connecting'))
    },
    send(text) {
      const s = typeof text === 'string' ? text : new TextDecoder().decode(text)
      sendCalls.push({ url, text: s })
    },
    resize() {},
    signal(sig) {
      signalCalls.push({ url, sig })
    },
    dispose() {
      this.state = 'disposed'
      stateListeners.forEach((cb) => cb('disposed'))
    },
    onState(cb) {
      stateListeners.add(cb)
      return () => stateListeners.delete(cb)
    },
    onData() { return () => {} },
    onExit() { return () => {} },
    onError(cb) {
      errorListeners.add(cb)
      return () => errorListeners.delete(cb)
    },
    onTruncated() { return () => {} },
    __fireOpen() {
      this.state = 'open'
      stateListeners.forEach((cb) => cb('open'))
    },
  }
  fakeClients.push(client)
  return client
}

mock.module(
  require.resolve('../terminal/pty-factory'),
  () => ({
    createPtyClient: (url: string) => createFakeClient(url),
  }),
)

// ─── Mock XtermView: render a placeholder div + expose the imperative
// ── handle so the parent's clear/focus wiring still binds.
const xtermClearCalls: number[] = []
const xtermFocusCalls: number[] = []

mock.module(
  require.resolve('../terminal/XtermView'),
  () => ({
    XtermView: React.forwardRef(function FakeXtermView(
      _props: { client: unknown; hidden?: boolean; autoFocus?: boolean },
      ref: React.Ref<{ clear: () => void; focus: () => void; refit: () => void }>,
    ) {
      React.useImperativeHandle(ref, () => ({
        clear: () => xtermClearCalls.push(Date.now()),
        focus: () => xtermFocusCalls.push(Date.now()),
        refit: () => {},
      }))
      return React.createElement('div', {
        'data-testid': 'xterm-view',
        role: 'group',
        'aria-label': 'Terminal viewport',
      })
    }),
  }),
)

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

beforeEach(() => {
  __resetSessionIdSeqForTest()
  fakeClients.length = 0
  sendCalls.length = 0
  signalCalls.length = 0
  xtermClearCalls.length = 0
  xtermFocusCalls.length = 0
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
    expect(fakeClients.length).toBeGreaterThanOrEqual(count)
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
    act(() => fakeClients[0].__fireOpen())

    await user.click(screen.getByRole('button', { name: /terminal actions/i }))
    const menu = await screen.findByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: /reset database/i }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/destructive command/i)).toBeInTheDocument()
    expect(sendCalls).toHaveLength(0)

    await user.click(within(dialog).getByRole('button', { name: /cancel/i }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(sendCalls).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: /terminal actions/i }))
    const reopened = await screen.findByRole('menu')
    await user.click(within(reopened).getByRole('menuitem', { name: /reset database/i }))
    const dialog2 = await screen.findByRole('dialog')
    await user.click(within(dialog2).getByRole('button', { name: /run anyway/i }))

    await waitFor(() => {
      expect(sendCalls).toHaveLength(1)
    })
    expect(sendCalls[0].text).toBe('bun run db:reset\r')
  })

  test('non-dangerous presets type the command into the active shell', async () => {
    const user = userEvent.setup()
    render(<Terminal projectId="p1" visible />)
    await waitForSessionsCreated(1)
    act(() => fakeClients[0].__fireOpen())

    await user.click(screen.getByRole('button', { name: /terminal actions/i }))
    const menu = await screen.findByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: /bun install/i }))

    await waitFor(() => {
      expect(sendCalls).toHaveLength(1)
    })
    expect(sendCalls[0].text).toBe('bun install\r')
  })
})

describe('Terminal — toolbar', () => {
  test('Stop button SIGINTs the active PTY when the shell is open', async () => {
    const user = userEvent.setup()
    render(<Terminal projectId="p1" visible />)
    await waitForSessionsCreated(1)
    // Flip to "ready" so the Stop button renders.
    act(() => fakeClients[0].__fireOpen())

    const stopBtn = await screen.findByRole('button', { name: /stop running command/i })
    await user.click(stopBtn)

    expect(signalCalls).toHaveLength(1)
    expect(signalCalls[0].sig).toBe('INT')
  })

  test('Clear button blanks the xterm buffer for the active session', async () => {
    const user = userEvent.setup()
    render(<Terminal projectId="p1" visible />)
    await waitForSessionsCreated(1)
    act(() => fakeClients[0].__fireOpen())

    const clearBtn = await screen.findByRole('button', { name: /clear output/i })
    expect(clearBtn).not.toBeDisabled()
    await user.click(clearBtn)

    expect(xtermClearCalls.length).toBeGreaterThanOrEqual(1)
  })
})

// Defer the SUT import until after `mock.module` registrations are
// installed; otherwise Bun resolves the real module first.
import { Terminal } from '../Terminal'
