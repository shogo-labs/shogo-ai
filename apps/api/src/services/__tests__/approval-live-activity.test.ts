// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, test } from 'bun:test'
import { approvalPushFor } from '../approval-push'
import { _setLiveActivityPusherForTests, liveActivityApprovalAnswered, liveActivityApprovalOpened } from '../approval-live-activity'
import type { LiveActivityPushInput } from '../live-activity-push'

afterEach(() => _setLiveActivityPusherForTests(null))

function capture() {
  const calls: Array<{ userId: string; input: LiveActivityPushInput }> = []
  _setLiveActivityPusherForTests(async (userId, input) => (calls.push({ userId, input }), 1))
  return calls
}

const approval = approvalPushFor({
  id: 'm1',
  authorAgentRef: { name: 'Atlas' },
  blocks: { type: 'approval_request', approval: { requestId: 'r1', projectId: 'p1', summary: 'Run npm install', status: 'pending' } },
})!

describe('approval live activity', () => {
  test('an open card starts or flips the activity to "needs you", with an alert', async () => {
    const calls = capture()
    await liveActivityApprovalOpened('u1', approval)
    expect(calls).toHaveLength(1)
    expect(calls[0].userId).toBe('u1')
    expect(calls[0].input).toMatchObject({
      event: 'update',
      startIfNone: true,
      alert: { title: 'Atlas needs approval', body: 'Run npm install' },
      props: { agentId: 'p1', agentName: 'Atlas', state: 'needs_you', detail: 'Run npm install' },
    })
  })

  test('the workspace agent uses the ws key', async () => {
    const calls = capture()
    await liveActivityApprovalOpened('u1', { ...approval, data: { ...approval.data, projectId: null } })
    expect(calls[0].input.props.agentId).toBe('ws')
  })

  test('an answer puts it back to working and never starts a new one', async () => {
    const calls = capture()
    await liveActivityApprovalAnswered('u1', { projectId: 'p1', agentName: 'Atlas', decision: 'approve' })
    await liveActivityApprovalAnswered('u1', { projectId: 'p1', agentName: 'Atlas', decision: 'deny' })
    expect(calls.map((c) => c.input.props.detail)).toEqual(['Approved, continuing', 'Denied'])
    expect(calls.every((c) => c.input.props.state === 'running' && !c.input.startIfNone)).toBe(true)
  })

  test('a failing push does not reach the caller', async () => {
    _setLiveActivityPusherForTests(async () => { throw new Error('boom') })
    await liveActivityApprovalOpened('u1', approval)
    await liveActivityApprovalAnswered('u1', { projectId: 'p1', agentName: 'Atlas', decision: 'approve' })
  })
})
