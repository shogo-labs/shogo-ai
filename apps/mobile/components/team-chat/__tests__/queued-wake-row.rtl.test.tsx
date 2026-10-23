// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * A team-chat message queued behind a reply the agent is still writing is a
 * durable `AgentWake`, and this row is its view in the timeline. Long-press free:
 * Send now starts it immediately, ✕ takes it off the queue for good, and once it
 * is no longer pending the row says what happened to it instead of offering
 * buttons that can only be refused (SHO-167).
 */

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const sent: string[] = []
const removed: string[] = []
let sendFailure: Error | null = null
let removeFailure: Error | null = null

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web' },
    Pressable: ({ accessibilityLabel, accessibilityRole, children, onPress, disabled, testID }: any) => (
      <button
        aria-label={accessibilityLabel}
        data-testid={testID}
        disabled={disabled}
        onClick={() => onPress?.({ stopPropagation() {} })}
        role={accessibilityRole ?? 'button'}
        type="button"
      >
        {children}
      </button>
    ),
  }),
)
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))
mock.module('../../../lib/team-chat-api', () => ({
  teamChatApi: () => ({
    sendWakeNow: async (id: string) => {
      if (sendFailure) throw sendFailure
      sent.push(id)
    },
    removeWake: async (id: string) => {
      if (removeFailure) throw removeFailure
      removed.push(id)
    },
  }),
}))

const { QueuedWakeRow } = await import('../QueuedWakeRow')

function note(wake: Record<string, unknown> = {}): any {
  return {
    id: 'n1',
    conversationId: 'c1',
    workspaceId: 'ws',
    seq: 7,
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    alsoSentToChannel: false,
    authorType: 'system',
    author: null,
    authorUserId: null,
    authorAgent: null,
    text: 'Queued for Billing Bot — it runs when the current reply ends.',
    blocks: {
      wakeQueued: {
        wakeId: 'w1',
        agentRef: 'project:proj-1',
        agentName: 'Billing Bot',
        triggerMessageId: 'm2',
        runningMessageId: 'm3',
        ...wake,
      },
    },
    clientMsgId: null,
    agentSessionId: null,
    agentStatus: null,
    reactions: [],
    attachments: [],
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-09-29T10:00:00.000Z',
  }
}

function renderRow(wake: Record<string, unknown> = {}) {
  const message = note(wake)
  return render(<QueuedWakeRow message={message} wake={message.blocks.wakeQueued} />)
}

const sendNowButton = () => screen.getByRole('button', { name: 'Send queued message now' })
const removeButton = () => screen.getByRole('button', { name: 'Remove queued message' })

afterEach(() => {
  cleanup()
  sent.length = 0
  removed.length = 0
  sendFailure = null
  removeFailure = null
})

describe('a queued team-chat message', () => {
  test('a pending wake names the agent and offers both actions', () => {
    renderRow()
    expect(screen.getByText('Queued for Billing Bot')).toBeInTheDocument()
    expect(sendNowButton()).toBeInTheDocument()
    expect(removeButton()).toBeInTheDocument()
  })

  test('Send now starts that wake on the server and stops offering it', async () => {
    renderRow()
    fireEvent.click(sendNowButton())

    await waitFor(() => expect(sent).toEqual(['w1']))
    // The buttons are gone the moment it is on its way, so a second press
    // cannot 409 against a wake that is already running.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Send queued message now' })).toBeNull())
    expect(screen.queryByRole('button', { name: 'Remove queued message' })).toBeNull()
    expect(screen.getByText('Sending…')).toBeInTheDocument()
  })

  test('✕ removes the wake and the row says so', async () => {
    renderRow()
    fireEvent.click(removeButton())

    await waitFor(() => expect(removed).toEqual(['w1']))
    expect(sent).toEqual([])
    await waitFor(() => expect(screen.getByText('Removed')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Remove queued message' })).toBeNull()
  })

  test('a refused click shows the server’s reason and keeps the buttons', async () => {
    sendFailure = Object.assign(new Error('Request failed with status code 409'), {
      response: { data: { error: { message: 'That message is no longer waiting.' } } },
    })
    renderRow()
    fireEvent.click(sendNowButton())

    await waitFor(() => expect(screen.getByText('That message is no longer waiting.')).toBeInTheDocument())
    expect(screen.getByText('Queued for Billing Bot')).toBeInTheDocument()
    expect(sendNowButton()).toBeInTheDocument()
  })

  test('a wake that is running or done says who started it, with nothing to press', () => {
    const { rerender } = renderRow({ status: 'running', sentNowBy: { id: 'u-ana', name: 'Ana Lopez' } })
    expect(screen.getByText('Sent now by Ana Lopez · running')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send queued message now' })).toBeNull()

    const done = note({ status: 'done', sentNowBy: { id: 'u-ana', name: 'Ana Lopez' } })
    rerender(<QueuedWakeRow message={done} wake={done.blocks.wakeQueued} />)
    expect(screen.getByText('Sent now by Ana Lopez')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send queued message now' })).toBeNull()
  })

  test('a wake whose run failed says Failed, never Done, and shows why', () => {
    renderRow({ status: 'failed', error: 'runtime exploded' })

    expect(screen.getByText('Failed to run')).toBeInTheDocument()
    expect(screen.getByText('runtime exploded')).toBeInTheDocument()
    expect(screen.queryByText('Done')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send queued message now' })).toBeNull()
  })

  test('a running wake nobody started by hand just reads Running', () => {
    renderRow({ status: 'running' })
    expect(screen.getByText('Running')).toBeInTheDocument()
  })
})
