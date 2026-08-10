// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Component tests for the IDE Terminal under the new PTY architecture.
 *
 * The shell + xterm.js + WebSocket layers all live in unit / e2e tests
 * for `pty-protocol`, `pty-session`, `pty-ws-handler`, `pty-client`, and
 * `pty-ws-e2e`. Here we exercise only the React layer:
 *
 *   - Session lifecycle (open, add, kill, positional relabelling, and
 *     closing the last one dismissing the panel).
 *   - Stop/Clear wiring to the active session's PtyClient and XtermView
 *     handle.
 *
 * These drive `onControlsChange` rather than clicking chrome. `remove tab
 * strip, add instance panel` (740815da6) moved the terminal's toolbar into
 * BottomPanel's header, so the props Terminal hands its parent — not a strip
 * it no longer renders — are its real surface. The one piece of UI Terminal
 * still owns is the "Terminal instances" panel, which VS Code only shows once
 * a second terminal exists; that is asserted directly.
 *
 * NOT covered here: the preset-command menu. `runCommand` is reachable only
 * from the deleted strip, so presets are currently unreachable from the UI —
 * tests were removed rather than left asserting dead code.
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
import type { TerminalToolbarControls } from '../Terminal'

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
    // Phase 2: createPtyClient is now async (Promise<PtyClientLike>) so it
    // can lazy-import the desktop transport. Accepts a bare URL string or
    // `{ url, sessionId, forceWs }`.
    createPtyClient: async (args: string | { url?: string; sessionId?: string }) => {
      const url = typeof args === 'string' ? args : (args.url ?? '')
      return createFakeClient(url)
    },
    chooseTransport: () => 'ws' as const,
    // Terminal.tsx imports these two as well; the mock has to cover the
    // module's whole surface or the import fails at module-eval time.
    isDesktopRuntime: () => false,
    createPtyClientSession: async () => {
      throw new Error('createPtyClientSession: desktop runtime is required')
    },
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

/**
 * The visible "Terminal instances" panel.
 *
 * Terminal renders one panel per group and hides the inactive groups' copies,
 * so a held reference goes stale the moment the active group changes. Re-query
 * after anything that switches groups; the role query skips the hidden copies.
 */
async function visibleInstancePanel(): Promise<HTMLElement> {
  return screen.findByRole('complementary', { name: 'Terminal instances' })
}

/**
 * The rows of the "Terminal instances" panel. A row is the element carrying
 * both `role="button"` and a `title`; the split/kill affordances inside it are
 * plain buttons without one. Rows are identified structurally rather than by
 * name because the label follows the resolved shell ("Terminal" before the
 * profile is known, "zsh" after), which is not what these cases are about.
 */
function instanceRows(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>('[role="button"][title]'))
}

// Terminal publishes its toolbar to the parent instead of rendering one, so
// tests reach the behaviour the same way BottomPanel does. `controls()` waits
// for the first publish rather than reading a possibly-null ref.
function renderTerminal(
  props: Partial<React.ComponentProps<typeof Terminal>> = {},
) {
  let latest: TerminalToolbarControls | null = null
  const utils = render(
    <Terminal
      projectId="p1"
      visible
      onControlsChange={(c) => {
        latest = c
      }}
      {...props}
    />,
  )
  const controls = async (): Promise<TerminalToolbarControls> => {
    await waitFor(() => {
      expect(latest).not.toBeNull()
    })
    return latest as unknown as TerminalToolbarControls
  }
  return { ...utils, controls }
}

describe('Terminal — sessions', () => {
  test('provisions a PTY and shows no instance panel for a single terminal', async () => {
    renderTerminal()
    await waitForSessionsCreated(1)

    // VS Code parity: the instance panel appears only once a second terminal
    // exists, so a lone terminal is all viewport and no chrome.
    expect(
      screen.queryByRole('complementary', { name: 'Terminal instances' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Terminal viewport' })).toBeInTheDocument()
  })

  test('onNew provisions a second PTY and lists both in the instance panel', async () => {
    const { controls } = renderTerminal()
    await waitForSessionsCreated(1)

    await act(async () => {
      (await controls()).onNew()
    })

    await waitForSessionsCreated(2)
    const panel = await visibleInstancePanel()
    expect(instanceRows(panel)).toHaveLength(2)
  })

  test('killing the middle terminal relabels the rest without gaps', async () => {
    const user = userEvent.setup()
    const { controls } = renderTerminal()
    await waitForSessionsCreated(1)

    await act(async () => {
      (await controls()).onNew()
    })
    await waitForSessionsCreated(2)
    await act(async () => {
      (await controls()).onNew()
    })
    await waitForSessionsCreated(3)

    expect(instanceRows(await visibleInstancePanel())).toHaveLength(3)

    const middleLabel = instanceRows(await visibleInstancePanel())[1].getAttribute(
      'title',
    )
    // Split/kill render only on the active row, so select it before killing —
    // the same two steps the UI requires of a user.
    await user.click(instanceRows(await visibleInstancePanel())[1])

    const middle = instanceRows(await visibleInstancePanel()).find(
      (r) => r.getAttribute('title') === middleLabel,
    )
    expect(middle).toBeDefined()
    await user.click(
      await within(middle as HTMLElement).findByRole('button', {
        name: 'Kill Terminal',
      }),
    )

    await waitFor(async () => {
      expect(instanceRows(await visibleInstancePanel())).toHaveLength(2)
    })

    // Labels are positional rather than identities, so the survivor slides up
    // and takes the freed name. "No gaps" therefore means no stale third-slot
    // suffix is left behind — not that the killed label disappears.
    const remaining = instanceRows(await visibleInstancePanel()).map((r) =>
      r.getAttribute('title'),
    )
    expect(remaining.some((label) => /\(3\)$/.test(label ?? ''))).toBe(false)
  })

  test('killing the only terminal asks the parent to close the panel', async () => {
    const onRequestClose = mock(() => {})
    const { controls } = renderTerminal({ onRequestClose })
    await waitForSessionsCreated(1)

    await act(async () => {
      (await controls()).onKillActive()
    })

    await waitFor(() => {
      expect(onRequestClose).toHaveBeenCalledTimes(1)
    })
  })

  test('bumping newSessionNonce opens another terminal', async () => {
    const { rerender } = renderTerminal({ newSessionNonce: 0 })
    await waitForSessionsCreated(1)

    rerender(<Terminal projectId="p1" visible newSessionNonce={1} />)

    await waitForSessionsCreated(2)
    const panel = await visibleInstancePanel()
    expect(instanceRows(panel)).toHaveLength(2)
  })
})

describe('Terminal — toolbar controls', () => {
  test('onStop SIGINTs the active PTY once the shell is open', async () => {
    const { controls } = renderTerminal()
    await waitForSessionsCreated(1)
    act(() => fakeClients[0].__fireOpen())

    await act(async () => {
      (await controls()).onStop()
    })

    expect(signalCalls).toHaveLength(1)
    expect(signalCalls[0].sig).toBe('INT')
  })

  test('onClear blanks the xterm buffer for the active session', async () => {
    const { controls } = renderTerminal()
    await waitForSessionsCreated(1)
    act(() => fakeClients[0].__fireOpen())

    await act(async () => {
      (await controls()).onClear()
    })

    expect(xtermClearCalls.length).toBeGreaterThanOrEqual(1)
  })
})

// Defer the SUT import until after the `mock.module` registrations above are
// installed; otherwise Bun resolves the real module first. This MUST be a
// dynamic import: a static `import` is hoisted to the top of the module and
// would bind the real `../Terminal` (and its real pty transport, which opens a
// live WebSocket) before any mock is registered.
const { Terminal } = await import('../Terminal')
