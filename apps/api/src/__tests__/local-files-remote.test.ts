import { describe, expect, mock, test } from 'bun:test'

const fsCalls: string[] = []
const prismaMock = {
  project: {
    findUnique: mock(async ({ where }: any) => {
      if (where.id === 'remote') return { id: 'remote', workingMode: 'external', remoteHostId: 'ssh-1' }
      if (where.id === 'external') return { id: 'external', workingMode: 'external', remoteHostId: null }
      return null
    }),
  },
}

mock.module('../lib/prisma', () => ({ prisma: prismaMock }))
mock.module('fs/promises', () => ({
  readdir: async () => { fsCalls.push('readdir'); throw new Error('local filesystem touched') },
  readFile: async () => { fsCalls.push('readFile'); throw new Error('local filesystem touched') },
  writeFile: async () => { fsCalls.push('writeFile'); throw new Error('local filesystem touched') },
  mkdir: async () => { fsCalls.push('mkdir'); throw new Error('local filesystem touched') },
  stat: async () => { fsCalls.push('stat'); throw new Error('local filesystem touched') },
  unlink: async () => { fsCalls.push('unlink'); throw new Error('local filesystem touched') },
}))

const { localFilesRoutes } = await import('../routes/local-files')
const router = localFilesRoutes({ workspacesDir: '/local/workspaces' })

describe('local-files remote project guard', () => {
  test('rejects remote projects before touching the local workspace', async () => {
    fsCalls.length = 0
    const response = await router.request('/projects/remote/files')
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: {
        code: 'remote_project_requires_runtime',
      },
    })
    expect(fsCalls).toEqual([])
  })

  test('rejects remote projects before local relative-path validation', async () => {
    fsCalls.length = 0
    const response = await router.request('/projects/remote/files/%2Fetc')
    expect(response.status).toBe(409)
    expect((await response.json() as any).error.code).toBe('remote_project_requires_runtime')
    expect(fsCalls).toEqual([])
  })

  test('rejects folder-linked projects instead of joining workspacesDir', async () => {
    fsCalls.length = 0
    const response = await router.request('/projects/external/workspace/manifest')
    expect(response.status).toBe(409)
    expect((await response.json() as any).error.code).toBe('external_project_requires_runtime')
    expect(fsCalls).toEqual([])
  })
})
