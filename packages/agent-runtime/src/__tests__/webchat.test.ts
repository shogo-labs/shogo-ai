import { describe, expect, test } from 'bun:test'
import { WebChatAdapter } from '../channels/webchat'

describe('WebChatAdapter', () => {
  test('uses a stable gateway channel id for a visitor', async () => {
    const adapter = new WebChatAdapter()
    await adapter.connect({ widgetSecret: 'secret' })
    const messages: any[] = []
    adapter.onMessage(async (message) => {
      messages.push(message)
    })

    await adapter.processIncoming({ message: 'first', sessionId: 'visitor-1' })
    await adapter.processIncoming({ message: 'second', sessionId: 'visitor-1' })

    expect(messages.map((message) => message.channelId)).toEqual([
      'webchat:visitor-1',
      'webchat:visitor-1',
    ])
    expect(messages[0].metadata.sessionId).toBe('visitor-1')
  })

  test('issues sliding 24-hour session tokens', async () => {
    const adapter = new WebChatAdapter()
    await adapter.connect({ widgetSecret: 'secret' })
    const session = adapter.getOrCreateSession('visitor-1')
    const token = adapter.issueSessionAuthToken(session.id)
    expect(token.expiresInSeconds).toBe(24 * 60 * 60)
    expect(adapter.validateSessionAuthToken(token.token, session.id)).toBe(true)
  })

  test('restores persisted session tokens after adapter restart', async () => {
    const sessionId = `persisted-${Date.now()}`
    const first = new WebChatAdapter()
    await first.connect({ widgetSecret: 'secret' })
    first.getOrCreateSession(sessionId)
    const token = first.issueSessionAuthToken(sessionId)
    await first.disconnect()

    const restarted = new WebChatAdapter()
    await restarted.connect({ widgetSecret: 'secret' })
    expect(restarted.validateSessionAuthToken(token.token, sessionId)).toBe(true)
    await restarted.disconnect()
  })

  test('stores visitor identity and enforces anonymous turn guardrails', async () => {
    const adapter = new WebChatAdapter()
    await adapter.connect({
      widgetSecret: 'secret',
      maxTurnsPerDay: '1',
      maxMessageLength: '12',
      allowWorkspaceWrites: 'false',
    })

    const sessionId = `visitor-2-${Date.now()}`
    adapter.updateSession(sessionId, {
      visitorId: 'stable-visitor',
      visitor: { name: 'Ada', metadata: { plan: 'pro' } },
    })
    expect(adapter.getOrCreateSession(sessionId).visitor?.name).toBe('Ada')
    adapter.onMessage(() => {})
    expect(adapter.canAcceptTurn(sessionId)).toEqual({ ok: true })
    await adapter.processIncoming({ message: 'hello', sessionId })
    expect(adapter.canAcceptTurn(sessionId)).toEqual({
      ok: false,
      message: 'This chat session has reached its daily message limit.',
    })
    expect(adapter.getConfig().maxMessageLength).toBe(100)
    expect(adapter.getConfig().allowWorkspaceWrites).toBe(false)
  })

  test('only trusts the publishable verification marker with a runtime token', async () => {
    const adapter = new WebChatAdapter()
    await adapter.connect({ widgetSecret: 'secret' })
    expect(adapter.isPublishableRequestAuthorized('1', 'runtime-token')).toBe(true)
    expect(adapter.isPublishableRequestAuthorized('1', null)).toBe(false)
    expect(adapter.isRequestAuthorized(null, '1', 'runtime-token')).toBe(true)
    expect(adapter.isRequestAuthorized(null, '1', null)).toBe(false)
    expect(adapter.isRequestAuthorized('secret', null, null)).toBe(true)
  })

  test('emits typing events to the visitor SSE stream', async () => {
    const adapter = new WebChatAdapter()
    await adapter.connect({ widgetSecret: 'secret' })
    const events: Array<{ event: string; data: string }> = []
    adapter.registerSSEClient('visitor-typing', (event, data) => events.push({ event, data }))
    await adapter.sendTyping('webchat:visitor-typing')
    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe('typing')
  })
})
