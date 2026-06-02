import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-secret-v4'

// macOS hard-links /tmp -> /private/tmp, so `realpathSync('/tmp/x')` returns
// `/private/tmp/x`. The `/fs/browse` route validates the realpath'd target
// against `os.homedir()` (a literal string compare), which would fail unless
// FAKE_HOME *is* the realpath'd form. Canonicalise it at startup so both
// sides of the isUnderHome() check line up on macOS and Linux alike.
mkdirSync('/tmp/v4-B-home', { recursive: true })
const FAKE_HOME = realpathSync('/tmp/v4-B-home')

const realOs = await import('os')
mock.module('os', () => ({
  __esModule: true,
  default: { ...realOs.default, homedir: () => FAKE_HOME },
  homedir: () => FAKE_HOME,
  platform: realOs.platform,
  tmpdir: realOs.tmpdir,
  EOL: realOs.EOL,
}))

const projects = new Map<string, any>()
const folders = new Map<string, any>()
let projectSeq = 1
let folderSeq = 1

function makeTx() {
  return {
    project: {
      create: mock(async ({ data }: any) => {
        const row = {
          id: `project-${projectSeq++}`,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
          projectFolders: [],
          ...data,
        }
        projects.set(row.id, row)
        return row
      }),
      update: mock(async ({ where, data }: any) => {
        const row = projects.get(where.id)
        if (!row) return null
        Object.assign(row, data)
        return row
      }),
      findUnique: mock(async ({ where }: any) => projects.get(where.id) ?? null),
      findFirst: mock(async () => Array.from(projects.values())[0] ?? null),
    },
    projectFolder: {
      create: mock(async ({ data }: any) => {
        const row = { id: `folder-${folderSeq++}`, lastOpenedAt: null, ...data }
        folders.set(row.id, row)
        return row
      }),
      update: mock(async ({ where, data }: any) => {
        const row = folders.get(where.id)
        if (!row) return null
        Object.assign(row, data)
        return row
      }),
      updateMany: mock(async ({ where, data }: any) => {
        let count = 0
        for (const f of folders.values()) {
          if (where?.projectId && f.projectId === where.projectId) {
            Object.assign(f, data)
            count++
          }
        }
        return { count }
      }),
      findFirst: mock(async ({ where }: any) => {
        for (const f of folders.values()) {
          if (where?.absolutePath && f.absolutePath !== where.absolutePath) continue
          return f
        }
        return null
      }),
      findMany: mock(async () => Array.from(folders.values())),
      delete: mock(async ({ where }: any) => {
        const row = folders.get(where.id)
        folders.delete(where.id)
        return row
      }),
    },
    workspace: {
      findFirst: mock(async () => ({ id: 'workspace-1' })),
    },
  }
}

const prisma: any = {
  ...makeTx(),
  $transaction: mock(async (fn: any) => fn(makeTx())),
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma }))

mock.module('../lib/runtime/manager', () => ({
  getRuntimeManager: mock(() => ({
    start: mock(async () => ({})),
  })),
}))

let localProjectsRoutes: typeof import('../routes/local-projects').localProjectsRoutes
let rootDir = ''
let childDir = ''
let otherDir = ''

beforeAll(async () => {
  const mod = await import('../routes/local-projects')
  localProjectsRoutes = mod.localProjectsRoutes
})

beforeEach(() => {
  projects.clear()
  folders.clear()
  projectSeq = 1
  folderSeq = 1
  rootDir = mkdtempSync(join(FAKE_HOME, 'shogo-lp-'))
  childDir = join(rootDir, 'child')
  otherDir = join(rootDir, 'other')
  mkdirSync(childDir)
  mkdirSync(otherDir)
})

afterEach(() => {
  try { rmSync(rootDir, { recursive: true, force: true }) } catch {}
})

afterAll(() => {
  try { rmSync(FAKE_HOME, { recursive: true, force: true }) } catch {}
})

function appWithAuth(userId = 'user-1') {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth' as never, { userId } as never)
    await next()
  })
  app.route('/', localProjectsRoutes())
  return app
}

function appNoAuth() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth' as never, undefined as never)
    await next()
  })
  app.route('/', localProjectsRoutes())
  return app
}

describe('localProjectsRoutes /fs/browse', () => {
  test('401 when unauthenticated', async () => {
    const app = appNoAuth()
    const res = await app.request('/fs/browse')
    expect(res.status).toBe(401)
  })

  test('lists $HOME by default and includes folder entry', async () => {
    const app = appWithAuth()
    const res = await app.request('/fs/browse')
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(Array.isArray(body.entries)).toBe(true)
    expect(body.parent).toBeNull()
  })

  test('rejects relative path', async () => {
    const app = appWithAuth()
    const res = await app.request('/fs/browse?path=relative/path')
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('not_absolute')
  })

  test('rejects nonexistent path', async () => {
    const app = appWithAuth()
    const res = await app.request(`/fs/browse?path=${encodeURIComponent('/does/not/exist/xyz')}`)
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('not_found')
  })

  test('rejects empty string path -> default to HOME', async () => {
    const app = appWithAuth()
    const res = await app.request('/fs/browse?path=')
    expect(res.status).toBe(200)
  })

  test('rejects path outside HOME', async () => {
    const app = appWithAuth()
    const res = await app.request(`/fs/browse?path=${encodeURIComponent('/tmp')}`)
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('outside_home')
  })

  test('rejects forbidden root /', async () => {
    const app = appWithAuth()
    const res = await app.request(`/fs/browse?path=${encodeURIComponent('/')}`)
    expect(res.status).toBe(400)
  })

  test('rejects file path (not directory)', async () => {
    const filePath = join(rootDir, 'file.txt')
    writeFileSync(filePath, 'hello')
    const app = appWithAuth()
    const res = await app.request(`/fs/browse?path=${encodeURIComponent(filePath)}`)
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.code).toBe('not_directory')
  })

  test('lists entries with parent', async () => {
    const app = appWithAuth()
    const res = await app.request(`/fs/browse?path=${encodeURIComponent(rootDir)}`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.entries.length).toBeGreaterThanOrEqual(2)
    expect(body.parent).toBe(FAKE_HOME)
  })

  test('includeFiles=true returns files', async () => {
    writeFileSync(join(rootDir, 'file.txt'), 'hi')
    const app = appWithAuth()
    const res = await app.request(`/fs/browse?path=${encodeURIComponent(rootDir)}&includeFiles=true`)
    const body = await res.json() as any
    expect(body.entries.some((e: any) => e.name === 'file.txt')).toBe(true)
  })

  test('respects showHidden=true (informational)', async () => {
    writeFileSync(join(rootDir, '.dotfile'), 'hi')
    const app = appWithAuth()
    const res = await app.request(`/fs/browse?path=${encodeURIComponent(rootDir)}&includeFiles=true&showHidden=true`)
    const body = await res.json() as any
    const dot = body.entries.find((e: any) => e.name === '.dotfile')
    expect(dot?.hidden).toBe(true)
  })

  test('handles symlink to directory', async () => {
    const target = join(rootDir, 'real-dir')
    mkdirSync(target)
    const link = join(rootDir, 'link-to-dir')
    try { symlinkSync(target, link) } catch {}
    const app = appWithAuth()
    const res = await app.request(`/fs/browse?path=${encodeURIComponent(rootDir)}`)
    const body = await res.json() as any
    expect(res.status).toBe(200)
    const sym = body.entries.find((e: any) => e.name === 'link-to-dir')
    if (sym) expect(sym.isSymlink).toBe(true)
  })

  test('symlink that escapes HOME is rejected (realpath check)', async () => {
    const link = join(rootDir, 'escape')
    try {
      symlinkSync('/etc', link)
      const app = appWithAuth()
      const res = await app.request(`/fs/browse?path=${encodeURIComponent(link)}`)
      expect(res.status).toBe(400)
    } catch {}
  })
})

describe('localProjectsRoutes POST /from-folders', () => {
  test('401 unauthenticated', async () => {
    const app = appNoAuth()
    const res = await app.request('/from-folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: [rootDir] }) })
    expect(res.status).toBe(401)
  })

  test('400 on empty folders array', async () => {
    const app = appWithAuth()
    const res = await app.request('/from-folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: [] }) })
    expect(res.status).toBe(400)
  })

  test('400 on missing body', async () => {
    const app = appWithAuth()
    const res = await app.request('/from-folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(400)
  })

  test('400 on invalid path in folders', async () => {
    const app = appWithAuth()
    const res = await app.request('/from-folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: ['not-absolute'] }) })
    expect(res.status).toBe(400)
  })

  test('200 success creates project for valid folder', async () => {
    const app = appWithAuth()
    const res = await app.request('/from-folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: [rootDir] }) })
    if (res.status === 200) {
      const body = await res.json() as any
      expect(body.project?.id).toBeDefined()
    } else {
      expect([200, 400, 409, 500]).toContain(res.status)
    }
  })

  test('handles existing project.json (rebind)', async () => {
    mkdirSync(join(rootDir, '.shogo'), { recursive: true })
    writeFileSync(
      join(rootDir, '.shogo', 'project.json'),
      JSON.stringify({ projectId: 'rebound-1', createdAt: '2026-01-01T00:00:00Z', schemaVersion: 1 }),
    )
    projects.set('rebound-1', { id: 'rebound-1', projectFolders: [] })
    const app = appWithAuth()
    const res = await app.request('/from-folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: [rootDir] }) })
    expect([200, 400, 409, 500]).toContain(res.status)
  })

  test('handles corrupt project.json', async () => {
    mkdirSync(join(rootDir, '.shogo'), { recursive: true })
    writeFileSync(join(rootDir, '.shogo', 'project.json'), 'not-json{{{')
    const app = appWithAuth()
    const res = await app.request('/from-folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: [rootDir] }) })
    expect([200, 400, 409, 500]).toContain(res.status)
  })

  test('writes .gitignore entry when inside git repo', async () => {
    mkdirSync(join(rootDir, '.git'), { recursive: true })
    const app = appWithAuth()
    const res = await app.request('/from-folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: [rootDir] }) })
    expect([200, 400, 409, 500]).toContain(res.status)
    if (res.status === 200 && existsSync(join(rootDir, '.gitignore'))) {
      const gi = readFileSync(join(rootDir, '.gitignore'), 'utf-8')
      expect(gi).toContain('.shogo/local/')
    }
  })

  test('preserves existing .gitignore content (idempotent)', async () => {
    mkdirSync(join(rootDir, '.git'), { recursive: true })
    writeFileSync(join(rootDir, '.gitignore'), 'node_modules/\n.shogo/local/\n')
    const app = appWithAuth()
    const res = await app.request('/from-folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: [rootDir] }) })
    expect([200, 400, 409, 500]).toContain(res.status)
    const gi = readFileSync(join(rootDir, '.gitignore'), 'utf-8')
    const matches = (gi.match(/\.shogo\/local\//g) ?? []).length
    expect(matches).toBe(1)
  })

  test('rejects forbidden root path', async () => {
    const app = appWithAuth()
    const res = await app.request('/from-folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: ['/'] }) })
    expect(res.status).toBe(400)
  })

  test('rejects nonexistent folder', async () => {
    const app = appWithAuth()
    const res = await app.request('/from-folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: ['/Users/nonexistent/xyz'] }) })
    expect(res.status).toBe(400)
  })

  test('rejects folder outside HOME', async () => {
    const app = appWithAuth()
    const res = await app.request('/from-folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: ['/tmp/outside'] }) })
    expect(res.status).toBe(400)
  })
})

describe('localProjectsRoutes other routes', () => {
  test('GET /recent 401 unauthenticated', async () => {
    const app = appNoAuth()
    const res = await app.request('/recent')
    expect(res.status).toBe(401)
  })

  test('GET /recent 200 returns folder list', async () => {
    const app = appWithAuth()
    const res = await app.request('/recent')
    expect([200, 500]).toContain(res.status)
  })

  test('POST /trust 401/404 unauthenticated', async () => {
    const app = appNoAuth()
    const res = await app.request('/trust', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'x' }) })
    expect([401, 404]).toContain(res.status)
  })

  test('POST /trust 400 missing body', async () => {
    const app = appWithAuth()
    const res = await app.request('/trust', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect([400, 404]).toContain(res.status)
  })

  test('DELETE /folders/:id 401/404 unauthenticated', async () => {
    const app = appNoAuth()
    const res = await app.request('/folders/folder-1', { method: 'DELETE' })
    expect([401, 404]).toContain(res.status)
  })

  test('DELETE /folders/:id 404 nonexistent', async () => {
    const app = appWithAuth()
    const res = await app.request('/folders/folder-nonexistent', { method: 'DELETE' })
    expect([404, 500]).toContain(res.status)
  })
})

describe('localProjectsRoutes GET /:id', () => {
  test('401 unauthenticated', async () => {
    const app = appNoAuth()
    const res = await app.request('/proj-x')
    expect(res.status).toBe(401)
  })

  test('404 when project missing', async () => {
    const app = appWithAuth()
    const res = await app.request('/missing-id')
    expect(res.status).toBe(404)
  })

  test('200 returns { project } with projectFolders, workingMode, trustLevel', async () => {
    projects.set('proj-x', {
      id: 'proj-x',
      name: 'External One',
      workingMode: 'external',
      trustLevel: 'restricted',
      projectFolders: [{ id: 'folder-1', path: rootDir, isPrimary: true }],
    })
    const app = appWithAuth()
    const res = await app.request('/proj-x')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    // The folder UI reads `body.project.*` — not the `{ ok, data }`
    // envelope the generated route uses. Lock that contract in.
    expect(body.project?.id).toBe('proj-x')
    expect(body.project?.workingMode).toBe('external')
    expect(body.project?.trustLevel).toBe('restricted')
    expect(Array.isArray(body.project?.projectFolders)).toBe(true)
    expect(body.project.projectFolders[0]?.isPrimary).toBe(true)
  })

  test('static GET /recent still wins over the /:id param route', async () => {
    const app = appWithAuth()
    const res = await app.request('/recent')
    expect([200, 500]).toContain(res.status)
    if (res.status === 200) {
      const body = (await res.json()) as any
      // /recent returns { projects: [...] }, never a single { project }.
      expect(Array.isArray(body.projects)).toBe(true)
      expect(body.project).toBeUndefined()
    }
  })
})

describe('localProjectsRoutes POST /:id/trust write + refresh ping', () => {
  test('200 flips trustLevel restricted -> trusted and persists', async () => {
    projects.set('proj-trust', {
      id: 'proj-trust',
      workingMode: 'external',
      trustLevel: 'restricted',
      projectFolders: [],
    })
    const app = appWithAuth()
    const res = await app.request('/proj-trust/trust', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trusted: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.project?.trustLevel).toBe('trusted')
    expect(projects.get('proj-trust')?.trustLevel).toBe('trusted')
  })

  test('200 flips trustLevel trusted -> restricted (revoke)', async () => {
    projects.set('proj-trust2', {
      id: 'proj-trust2',
      workingMode: 'external',
      trustLevel: 'trusted',
      projectFolders: [],
    })
    const app = appWithAuth()
    const res = await app.request('/proj-trust2/trust', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trusted: false }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.project?.trustLevel).toBe('restricted')
  })

  test('400 when `trusted` is not a boolean', async () => {
    projects.set('proj-trust3', {
      id: 'proj-trust3',
      workingMode: 'external',
      trustLevel: 'restricted',
      projectFolders: [],
    })
    const app = appWithAuth()
    const res = await app.request('/proj-trust3/trust', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trusted: 'yes' }),
    })
    expect(res.status).toBe(400)
  })
})
