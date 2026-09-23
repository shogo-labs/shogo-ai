import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import {
  createWorkspaceRoutes,
  setPrisma,
  setWorkspaceHooks,
} from '../../generated/workspace.routes'
import { localWorkspaceHooks } from '../../generated/local-routes'

describe('local workspace access hooks', () => {
  test('scopes workspace discovery to the authenticated user membership', async () => {
    let observedWhere: unknown
    const prisma = {
      workspace: {
        findMany: async ({ where }: { where: unknown }) => {
          observedWhere = where
          return [{ id: 'ws-team', kind: 'team' }]
        },
        count: async ({ where }: { where: unknown }) => {
          observedWhere = where
          return 1
        },
      },
    }

    setPrisma(prisma as any)
    setWorkspaceHooks(localWorkspaceHooks)

    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('auth', { userId: 'user-1' })
      await next()
    })
    app.route('/api/workspaces', createWorkspaceRoutes())

    const response = await app.request('/api/workspaces')

    expect(response.status).toBe(200)
    expect(observedWhere).toEqual({
      members: { some: { userId: 'user-1' } },
    })
    expect(await response.json()).toMatchObject({
      items: [{ id: 'ws-team', kind: 'team' }],
    })
  })

  test('rejects reading a workspace without a local membership', async () => {
    setPrisma({
      workspace: {},
      member: {
        findFirst: async () => null,
      },
    } as any)
    setWorkspaceHooks(localWorkspaceHooks)

    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('auth', { userId: 'user-1' })
      await next()
    })
    app.route('/api/workspaces', createWorkspaceRoutes())

    const response = await app.request('/api/workspaces/foreign')

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'forbidden' },
    })
  })
})
