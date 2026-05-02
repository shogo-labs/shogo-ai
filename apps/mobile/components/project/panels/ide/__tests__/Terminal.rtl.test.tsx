// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Component tests for the IDE Terminal. We exercise the multi-session
 * tab strip, the in-shell prompt's keyboard handling (clear / exit /
 * Ctrl-keys), preset confirmation, and stop / abort behavior.
 *
 * Networked endpoints are mocked via `installAgentFetchMock` instead of
 * MSW so this stays a single-process test against pure DOM.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import {
  installAgentFetchMock,
  recordedAgentFetch,
  restoreAgentFetch,
} from '../../../../../test/helpers/mockAgentFetch'
import {
  pendingStreamingResponse,
  streamingResponse,
} from '../../../../../test/helpers/streamingResponse'
import { __resetSessionIdSeqForTest } from '../terminal/session-reducer'

import { Terminal } from '../Terminal'

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
        },
      ],
      database: [
        {
          id: 'prisma-reset',
          label: 'Reset database',
          description: 'Drops all data',
          category: 'database',
          dangerous: true,
        },
      ],
    },
  })
}

let fetcher: ReturnType<typeof recordedAgentFetch>

beforeEach(() => {
  __resetSessionIdSeqForTest()
  fetcher = recordedAgentFetch()
  fetcher.setRoute('/terminal/commands', () => presetCommandsResponse())
  installAgentFetchMock(fetcher.handler)
})

afterEach(() => {
  restoreAgentFetch()
})

describe('Terminal — multi-session tabs', () => {
  test('renders one session tab labeled "Terminal 1" by default', async () => {
    render(<Terminal projectId="p1" visible />)
    expect(
      screen.getByRole('tab', { name: 'Terminal 1' }),
    ).toHaveAttribute('aria-selected', 'true')
  })

  test('"New Terminal" appends a session and selects it', async () => {
    const user = userEvent.setup()
    render(<Terminal projectId="p1" visible />)

    await user.click(screen.getByRole('button', { name: /new terminal/i }))

    const tab2 = await screen.findByRole('tab', { name: 'Terminal 2' })
    expect(tab2).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Terminal 1' })).toHaveAttribute(
      'aria-selected',
      'false',
    )
  })

  test('closing the middle session leaves "Terminal 1, 2" without gaps', async () => {
    const user = userEvent.setup()
    render(<Terminal projectId="p1" visible />)

    await user.click(screen.getByRole('button', { name: /new terminal/i }))
    await user.click(screen.getByRole('button', { name: /new terminal/i }))
    expect(await screen.findByRole('tab', { name: 'Terminal 3' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /close terminal 2/i }))

    await waitFor(() => {
      expect(screen.getAllByRole('tab')).toHaveLength(2)
    })
    expect(screen.getByRole('tab', { name: 'Terminal 1' })).toBeInTheDocument()
    // The third tab is now positionally relabeled to "Terminal 2".
    expect(screen.getByRole('tab', { name: 'Terminal 2' })).toBeInTheDocument()
  })

  test('closing the last session calls onRequestClose', async () => {
    const user = userEvent.setup()
    const onRequestClose = mock(() => {})
    render(<Terminal projectId="p1" visible onRequestClose={onRequestClose} />)

    await user.click(screen.getByRole('button', { name: /close terminal 1/i }))
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  test('bumping newSessionNonce creates a new session', async () => {
    const { rerender } = render(
      <Terminal projectId="p1" visible newSessionNonce={0} />,
    )
    rerender(<Terminal projectId="p1" visible newSessionNonce={1} />)
    expect(await screen.findByRole('tab', { name: 'Terminal 2' })).toBeInTheDocument()
  })
})

describe('Terminal — prompt built-ins', () => {
  test('typing "clear" clears the visible output without a network call', async () => {
    const user = userEvent.setup()
    render(<Terminal projectId="p1" visible />)

    const input = screen.getByRole('textbox', { name: /command/i })
    // First seed the buffer with an `exit` so we have something visible.
    // `exit` short-circuits client-side without firing a fetch, so we
    // don't have to queue a response.
    await user.type(input, 'exit{Enter}')
    expect(await screen.findByText(/\[session closed\]/)).toBeInTheDocument()

    const reborn = await screen.findByRole('textbox', { name: /command/i })
    await user.type(reborn, 'clear{Enter}')

    // After `clear`, the visible output is empty.
    expect(screen.queryByText(/\[session closed\]/)).not.toBeInTheDocument()
    // No /terminal/run call was made.
    expect(
      fetcher.calls.find((c) => c.url.includes('/terminal/run')),
    ).toBeUndefined()
  })

  test('typing "exit" appends [session closed] without a network call', async () => {
    const user = userEvent.setup()
    render(<Terminal projectId="p1" visible />)

    const input = screen.getByRole('textbox', { name: /command/i })
    await user.type(input, 'exit{Enter}')

    expect(await screen.findByText(/\[session closed\]/)).toBeInTheDocument()
    // No /terminal/run call was made.
    expect(
      fetcher.calls.find((c) => c.url.includes('/terminal/run')),
    ).toBeUndefined()
  })

  test('arrow up recalls the previous command', async () => {
    const user = userEvent.setup()
    render(<Terminal projectId="p1" visible />)

    const input = screen.getByRole('textbox', { name: /command/i })
    await user.type(input, 'exit{Enter}')
    // Prompt re-renders; refetch the (possibly different) input element.
    const reborn = await screen.findByRole('textbox', { name: /command/i })
    await user.click(reborn)
    await user.keyboard('{ArrowUp}')
    expect(reborn).toHaveValue('exit')
  })

  test('Ctrl+U empties the prompt', async () => {
    const user = userEvent.setup()
    render(<Terminal projectId="p1" visible />)

    const input = screen.getByRole('textbox', { name: /command/i })
    await user.type(input, 'partially-typed')
    await user.keyboard('{Control>}u{/Control}')
    expect(input).toHaveValue('')
  })
})

describe('Terminal — dangerous preset confirmation', () => {
  test('opens a destructive-command dialog and runs only after confirmation', async () => {
    const user = userEvent.setup()
    fetcher.queue('/terminal/exec', () => streamingResponse(['dropping...\n']))
    render(<Terminal projectId="p1" visible />)

    await user.click(screen.getByRole('button', { name: /terminal actions/i }))
    const menu = await screen.findByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: /reset database/i }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/destructive command/i)).toBeInTheDocument()

    // Cancel — no fetch, dialog closes.
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(
      fetcher.calls.find((c) => c.url.includes('/terminal/exec')),
    ).toBeUndefined()

    // Re-open and confirm.
    await user.click(screen.getByRole('button', { name: /terminal actions/i }))
    const reopened = await screen.findByRole('menu')
    await user.click(within(reopened).getByRole('menuitem', { name: /reset database/i }))
    const dialog2 = await screen.findByRole('dialog')
    await user.click(within(dialog2).getByRole('button', { name: /run anyway/i }))

    await waitFor(() => {
      expect(
        fetcher.calls.some((c) => c.url.includes('/terminal/exec')),
      ).toBe(true)
    })
  })
})

describe('Terminal — streaming + abort', () => {
  test('Stop button aborts a running command and shows [Cancelled]', async () => {
    const user = userEvent.setup()
    const stream = pendingStreamingResponse(['boot\n'])
    fetcher.queue('/terminal/exec', stream.response)

    render(<Terminal projectId="p1" visible />)

    // Open kebab → click bun install preset.
    await user.click(screen.getByRole('button', { name: /terminal actions/i }))
    const menu = await screen.findByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: /bun install/i }))

    expect(await screen.findByText(/boot/)).toBeInTheDocument()

    // Stop button should be visible while running.
    const stopBtn = await screen.findByRole('button', { name: /stop running command/i })
    await act(async () => {
      await user.click(stopBtn)
    })

    // Even though we close the stream after the click, the AbortError
    // path should land [Cancelled] in the output.
    stream.end()
    await waitFor(() => {
      expect(screen.getByText(/\[Cancelled\]/)).toBeInTheDocument()
    })
  })
})
