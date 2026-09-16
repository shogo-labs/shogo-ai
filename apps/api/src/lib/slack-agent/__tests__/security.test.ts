import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import {
  createSlackOAuthState,
  verifySlackOAuthState,
  verifySlackSignature,
} from '../security'

describe('Slack request security', () => {
  const secret = 'slack-signing-secret'
  const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev123' })

  test('accepts a valid Slack signature', () => {
    const timestamp = '1700000000'
    const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`
    expect(verifySlackSignature({
      rawBody: body,
      timestamp,
      signature,
      signingSecret: secret,
      nowMs: Number(timestamp) * 1000,
    })).toBe(true)
  })

  test('rejects a modified body and stale request', () => {
    const timestamp = '1700000000'
    const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`
    expect(verifySlackSignature({
      rawBody: `${body} `,
      timestamp,
      signature,
      signingSecret: secret,
      nowMs: Number(timestamp) * 1000,
    })).toBe(false)
    expect(verifySlackSignature({
      rawBody: body,
      timestamp,
      signature,
      signingSecret: secret,
      nowMs: (Number(timestamp) + 301) * 1000,
    })).toBe(false)
  })
})

describe('Slack OAuth state', () => {
  test('round trips and rejects tampering/expiry', () => {
    const state = createSlackOAuthState({
      mode: 'install',
      workspaceId: 'workspace-1',
      userId: 'user-1',
    }, 'state-secret', 1000)
    expect(verifySlackOAuthState(state, 'state-secret', 1001)).toMatchObject({
      mode: 'install',
      workspaceId: 'workspace-1',
      userId: 'user-1',
    })
    expect(verifySlackOAuthState(`${state}x`, 'state-secret', 1001)).toBeNull()
    expect(verifySlackOAuthState(state, 'state-secret', 601001)).toBeNull()
  })
})
