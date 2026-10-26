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

const allProjects = [
  { id: 'project-1', name: 'App', hidden: false },
  { id: 'project-hidden', name: 'Hidden Builder Delegate', hidden: true },
]
const projectFindManyCalls: any[] = []
const chatFindManyCalls: any[] = []

mock.module('../lib/prisma', () => ({
  prisma: {
    member: {
      findFirst: async () => ({ id: 'member-1' }),
      findMany: async () => [{ role: 'member', workspaceId: 'workspace-1', projectId: null }],
    },
    user: { findUnique: async () => ({ role: 'user' }) },
    project: {
      findMany: async (args: any) => {
        projectFindManyCalls.push(args)
        const hiddenFilter = args?.where?.hidden
        return allProjects.filter((p) => (hiddenFilter === undefined ? true : p.hidden === hiddenFilter))
      },
    },
    chatSession: {
      findMany: async (args: any) => {
        chatFindManyCalls.push(args)
        return [chat]
      },
      findFirst: async () => chat,
    },
    chatMessage: {
      findMany: async () => [
        { role: 'user', content: 'Use SQLite for history', createdAt: new Date('2026-09-15T10:00:00Z') },
      ],
    },
    plan: { findMany: async () => [plan], findFirst: async () => plan },
    workspace: { findUnique: async () => ({ name: 'Acme', slug: 'acme', description: null }) },
  },
}))

const { searchWorkspaceHistory, renderWorkspaceTranscript } = await import('../lib/history-search')
const { enrichChatReferences, enrichWorkspaceReferences } = await import('../lib/chat-references')

describe('workspace history search', () => {
  test('searches chats and plans in one workspace', async () => {
    const result = await searchWorkspaceHistory({ workspaceId: 'workspace-1', userId: 'user-1', query: 'history' })
    expect(result.results.map((item) => item.kind)).toEqual(['chat', 'plan'])
  })

  test('limits workspace chats to the caller or chats with no owner', async () => {
    chatFindManyCalls.length = 0
    await searchWorkspaceHistory({ workspaceId: 'workspace-1', userId: 'user-1', query: 'history' })
    const workspaceChat = chatFindManyCalls[0]?.where?.OR?.find((clause: any) => clause.contextType === 'workspace')
    expect(workspaceChat).toMatchObject({
      workspaceId: 'workspace-1',
      OR: [{ createdByUserId: 'user-1' }, { createdByUserId: null }],
    })
  })

  test('excludes hidden projects when resolving the workspace project scope', async () => {
    projectFindManyCalls.length = 0
    await searchWorkspaceHistory({ workspaceId: 'workspace-1', userId: 'user-1', query: 'history' })
    expect(projectFindManyCalls[0]?.where).toMatchObject({ workspaceId: 'workspace-1', hidden: false })
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
    expect(await enrichChatReferences(body, 'user-1', 'workspace-1')).toBe(true)
    expect(body.references[0].transcript).toContain('SQLite')
    expect(body.references[1].content).toContain('# Search')
  })

  test('leaves chat references alone when there is no acting user', async () => {
    const body = { references: [{ type: 'chat', id: 'other-tenant-chat' }] }
    // No acting user → nothing can be validated, so enrichment refuses to touch
    // the references and the route forwards none of them as context.
    expect(await enrichChatReferences(body, undefined, 'workspace-1')).toBe(false)
    expect(body.references).toHaveLength(1)
  })

  test('workspace reference summaries never list hidden project names', async () => {
    const body = { references: [{ type: 'workspace', id: 'workspace-1', label: '@workspace:Acme' }] }
    expect(await enrichWorkspaceReferences(body, 'user-1')).toBe(true)
    expect(body.references[0].summary).toContain('App')
    expect(body.references[0].summary).not.toContain('Hidden Builder Delegate')
  })
})
