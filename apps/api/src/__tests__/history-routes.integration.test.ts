import { describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

mock.module('../services/workspace.service', () => ({
  hasWorkspaceAccess: async (workspaceId: string, userId: string) =>
    workspaceId === 'workspace-1' && userId === 'user-1',
}))
mock.module('../lib/history-search', () => ({
  searchWorkspaceHistory: async () => ({
    results: [{
      kind: 'chat',
      id: 'chat-1',
      title: 'SQLite decision',
      snippet: 'Use SQLite',
      score: 1,
      createdAt: '2026-09-15T10:00:00.000Z',
      lastActivityAt: '2026-09-15T10:01:00.000Z',
    }],
    count: 1,
  }),
}))

const { historyRoutes } = await import('../routes/history')

function appFor(userId: string | null) {
  const app = new Hono()
  app.route('/api', historyRoutes({ resolveUserId: async () => userId }))
  return app
}

describe('workspace history HTTP route', () => {
  test('requires auth and workspace membership', async () => {
    expect((await appFor(null).request('/api/workspaces/workspace-1/history/search?q=sqlite')).status).toBe(401)
    expect((await appFor('user-2').request('/api/workspaces/workspace-1/history/search?q=sqlite')).status).toBe(403)
  })

  test('returns grouped history results for an authorized workspace', async () => {
    const response = await appFor('user-1').request('/api/workspaces/workspace-1/history/search?q=sqlite&kind=chat')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      workspaceId: 'workspace-1',
      kind: 'chat',
      count: 1,
    })
  })
})
