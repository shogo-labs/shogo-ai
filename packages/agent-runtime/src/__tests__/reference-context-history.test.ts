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
})
