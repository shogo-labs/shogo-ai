import { describe, expect, test, mock } from 'bun:test'

const chat = {
  id: 'chat-1',
  name: 'Earlier decision',
  inferredName: '',
  createdAt: new Date('2026-09-15T10:00:00Z'),
  lastActiveAt: new Date('2026-09-15T10:01:00Z'),
  contextType: 'project',
  contextId: 'project-1',
  project: { id: 'project-1', name: 'App' },
  messages: [{ role: 'user', content: 'Use SQLite for history', createdAt: new Date('2026-09-15T10:00:00Z') }],
}
const plan = {
  id: 'plan-1',
  filename: 'history.plan.md',
  name: 'History Search',
  overview: 'Search plans',
  status: 'active',
  content: '# Search',
  projectId: 'project-1',
  createdAt: new Date('2026-09-15T10:00:00Z'),
  updatedAt: new Date('2026-09-15T10:01:00Z'),
  project: { id: 'project-1', name: 'App' },
}

mock.module('../lib/prisma', () => ({
  prisma: {
    member: { findFirst: async () => ({ id: 'member-1' }) },
    project: { findMany: async () => [{ id: 'project-1' }] },
    chatSession: {
      findMany: async () => [chat],
      findFirst: async () => chat,
    },
    plan: { findMany: async () => [plan], findFirst: async () => plan },
  },
}))

const { searchWorkspaceHistory, renderWorkspaceTranscript } = await import('../lib/history-search')
const { enrichChatReferences } = await import('../lib/chat-references')

describe('workspace history search', () => {
  test('searches chats and plans in one workspace', async () => {
    const result = await searchWorkspaceHistory({ workspaceId: 'workspace-1', userId: 'user-1', query: 'history' })
    expect(result.results.map((item) => item.kind)).toEqual(['chat', 'plan'])
  })

  test('renders a bounded transcript and enriches references', async () => {
    const transcript = await renderWorkspaceTranscript('chat-1', { workspaceId: 'workspace-1', userId: 'user-1' })
    expect(transcript?.messages[0].text).toContain('SQLite')
    const body = {
      references: [
        { type: 'chat', id: 'chat-1', label: '@chat:Earlier' },
        { type: 'plan', planId: 'plan-1', label: '@plan:History' },
      ],
    }
    expect(await enrichChatReferences(body, 'user-1', 'project-1', 'workspace-1')).toBe(true)
    expect(body.references[0].transcript).toContain('SQLite')
    expect(body.references[1].content).toContain('# Search')
  })
})
