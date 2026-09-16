import { Hono } from 'hono'
import { hasWorkspaceAccess } from '../services/workspace.service'
import { searchWorkspaceHistory } from '../lib/history-search'

export function historyRoutes(config: { resolveUserId: (c: any) => Promise<string | null> }): Hono {
  const app = new Hono()
  app.get('/workspaces/:workspaceId/history/search', async (c) => {
    const userId = await config.resolveUserId(c)
    if (!userId) return c.json({ error: 'Authentication required' }, 401)
    const workspaceId = c.req.param('workspaceId')
    if (!(await hasWorkspaceAccess(workspaceId, userId))) return c.json({ error: 'Workspace access denied' }, 403)
    const rawKind = c.req.query('kind')
    const kind = rawKind === 'chat' || rawKind === 'plan' ? rawKind : 'all'
    return c.json({
      workspaceId,
      kind,
      ...(await searchWorkspaceHistory({
        workspaceId,
        userId,
        query: c.req.query('q') || c.req.query('query') || '',
        kind,
        limit: Number(c.req.query('limit') || 8),
        excludeSessionId: c.req.query('exclude') || undefined,
      })),
    })
  })
  return app
}
