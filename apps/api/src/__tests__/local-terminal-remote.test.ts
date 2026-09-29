import { describe, expect, mock, test } from 'bun:test'

const prismaMock = {
  project: {
    findUnique: mock(async ({ where }: any) => {
      if (where.id === 'remote') {
        return { workingMode: 'external', remoteHostId: 'ssh-1', workspaceId: 'workspace-1' }
      }
      if (where.id === 'external') return { workingMode: 'external', remoteHostId: null }
      return null
    }),
  },
}
mock.module('../lib/prisma', () => ({ prisma: prismaMock }))

const { localTerminalRoutes } = await import('../routes/local-terminal')

describe('local-terminal remote command routing', () => {
  test('gets quick commands from the runtime instead of local workspacesDir', async () => {
    const resolvePodUrl = mock(async () => 'http://runtime.test/')
    const fetchImpl = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('http://runtime.test/terminal/commands')
      return new Response(JSON.stringify({ commands: { scripts: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const router = localTerminalRoutes({
      runtimeManager: {} as any,
      workspacesDir: '/this/path-must-not-be-read',
      resolvePodUrl,
      fetchImpl,
    })

    const response = await router.request('/projects/remote/terminal/commands')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ commands: { scripts: [] } })
    expect(resolvePodUrl).toHaveBeenCalledWith('remote')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('uses the existing local quick-command behavior for managed projects', async () => {
    const router = localTerminalRoutes({
      runtimeManager: {} as any,
      workspacesDir: '/path-that-does-not-exist',
      resolvePodUrl: mock(async () => 'http://runtime.test'),
      fetchImpl: mock(async () => new Response('{}')),
    })

    const response = await router.request('/projects/managed/terminal/commands')
    expect(response.status).toBe(200)
    expect((await response.json() as any).commands).toBeDefined()
  })
})
