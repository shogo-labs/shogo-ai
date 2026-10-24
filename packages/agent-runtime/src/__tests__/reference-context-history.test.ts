import { describe, expect, test, mock } from 'bun:test'

mock.module('@shogo/shared-runtime', () => ({ isBinaryFilePath: () => false }))
const { buildReferencedContext } = await import('../reference-context')

describe('history references', () => {
  test('prefers inlined transcript and plan content', () => {
    const context = buildReferencedContext([
      { type: 'chat', id: 'chat-1', name: 'Earlier chat', transcript: 'user: inline transcript' },
      { type: 'plan', planId: 'plan-1', name: 'Inline plan', content: '# Inline plan' },
    ], '/tmp', {
      history: {
        readChat: () => ({
          id: 'chat-1',
          title: 'wrong local title',
          messages: [],
          createdAt: 0,
          lastActivityAt: 0,
        }),
        readPlan: () => ({
          filename: 'plan-1.plan.md',
          name: 'wrong local plan',
          overview: '',
          status: 'pending',
          createdAt: '',
          content: '# Wrong local plan',
          updatedAt: 0,
        }),
      },
    })
    expect(context).toContain('inline transcript')
    expect(context).toContain('# Inline plan')
    expect(context).not.toContain('wrong local')
  })

  test('does not inline the current chat', () => {
    const context = buildReferencedContext([
      { type: 'chat', id: 'chat-1', name: 'Current' },
    ], '/tmp', { currentChatSessionId: 'chat-1' })
    expect(context).toContain('current chat omitted')
  })

  // SHO-191: the workspace chat tags a chat as context — the block names it and
  // says how to read it, and no transcript travels with the turn.
  test('a pointer reference names the chat and how to read it, with no transcript', () => {
    const context = buildReferencedContext([
      {
        type: 'chat',
        id: 'chat-b',
        name: 'Deploy notes',
        label: 'Deploy notes',
        projectName: 'Billing',
        workspaceId: 'ws-2',
        workspaceName: 'Other team',
        messageCount: 12,
        lastActivityAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        transcript: 'user: this must not appear',
        pointer: true,
      },
    ], '/tmp', {
      history: {
        readChat: () => ({
          id: 'chat-b',
          title: 'Deploy notes',
          messages: [{ role: 'user', text: 'nor this', seq: 1, createdAt: 0 }],
          createdAt: 0,
          lastActivityAt: 0,
        }),
        readPlan: () => null,
      },
    })

    expect(context).toContain(
      '[Referenced Chat: "Deploy notes" — id chat-b — Billing in Other team — 12 messages, last active 3h ago]',
    )
    expect(context).toContain(
      'read_history({ kind: "chat", id: "chat-b", scope: "workspace" })',
    )
    expect(context).toContain('Nothing was sent to that chat')
    expect(context).toContain('[End of Referenced Chat]')
    expect(context).not.toContain('must not appear')
    expect(context).not.toContain('nor this')
  })

  test('a pointer reference without a project is called a workspace chat', () => {
    const context = buildReferencedContext([
      { type: 'chat', id: 'chat-c', name: 'Planning', workspaceName: 'Acme', pointer: true },
    ], '/tmp')
    expect(context).toContain('workspace chat in Acme')
    // Unknown counts/activity are simply left out, not rendered as "undefined".
    expect(context).not.toContain('undefined')
    expect(context).not.toContain('NaN')
  })

  test('a chat reference without the pointer flag still inlines its transcript', () => {
    const context = buildReferencedContext([
      { type: 'chat', id: 'chat-1', name: 'Earlier chat', transcript: 'user: inline transcript' },
    ], '/tmp')
    expect(context).toContain('inline transcript')
    expect(context).not.toContain('read_history')
  })
})
