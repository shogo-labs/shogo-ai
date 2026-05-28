// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import os from 'os'
import { join } from 'path'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const projects = new Map<string, any>()
const folders = new Map<string, any>()
let projectSeq = 1
let folderSeq = 1
let workspaceFindFirstResult: any = { id: 'workspace-1' }
let transactionShouldThrow = false

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
        Object.assign(row, data)
        return row
      }),
    },
    projectFolder: {
      create: mock(async ({ data }: any) => {
        const row = { id: `folder-${folderSeq++}`, lastOpenedAt: null, ...data }
        folders.set(row.id, row)
        return row
      }),
      update: mock(async ({ where, data }: any) => {
        const row = folders.get(where.id)
        Object.assign(row, data)
        return row
      }),
      updateMany: mock(async ({ where, data }: any) => {
        let count = 0
        for (const row of folders.values()) {
          if (where.projectId && row.projectId !== where.projectId) continue
          if (where.path && row.path !== where.path) continue
          if (where.isPrimary !== undefined && row.isPrimary !== where.isPrimary) continue
          Object.assign(row, data)
          count++
        }
        return { count }
      }),
    },
  }
}

const prisma = {
  $transaction: mock(async (fn: any) => {
    if (transactionShouldThrow) throw new Error('transaction failed')
    return fn(makeTx())
  }),
  workspace: {
    findFirst: mock(async () => workspaceFindFirstResult),
  },
  project: {
    findUnique: mock(async ({ where }: any) => {
      const row = projects.get(where.id)
      if (!row) return null
      return { ...row, projectFolders: [...folders.values()].filter((f) => f.projectId === row.id) }
    }),
    findMany: mock(async () => [...projects.values()].map((p) => ({
      ...p,
      projectFolders: [...folders.values()].filter((f) => f.projectId === p.id),
    }))),
    update: mock(async ({ where, data }: any) => {
      const row = projects.get(where.id)
      Object.assign(row, data)
      return { ...row, projectFolders: [...folders.values()].filter((f) => f.projectId === row.id) }
    }),
  },
  projectFolder: {
    create: mock(async ({ data }: any) => {
      const row = { id: `folder-${folderSeq++}`, lastOpenedAt: null, ...data }
      folders.set(row.id, row)
      return row
    }),
    findUnique: mock(async ({ where }: any) => folders.get(where.id) ?? null),
    delete: mock(async ({ where }: any) => {
      const row = folders.get(where.id)
      folders.delete(where.id)
      return row
    }),
  },
}

mock.module('../lib/prisma', () => withPrismaExports({ prisma }))

mock.module('../lib/runtime/manager', () => ({
  getRuntimeManager: mock(() => ({
    start: mock(async () => ({})),
    status: mock(() => null),
    stop: mock(async () => undefined),
  })),
}))

let localProjectsRoutes: typeof import('../routes/local-projects').localProjectsRoutes
let rootDir = ''
let childDir = ''
let otherDir = ''

beforeEach(async () => {
  projects.clear()
  folders.clear()
  projectSeq = 1
  folderSeq = 1
  workspaceFindFirstResult = { id: 'workspace-1' }
  transactionShouldThrow = false
  // Sandbox safety: route handlers call os.homedir() to validate paths
  // are under $HOME. The container's $HOME is /app which is read-only,
  // so we redirect homedir() to a writable tmp ancestor for the duration
  // of the suite. afterAll() doesn't need to restore because each test
  // file runs in its own process under run-tests-isolated.ts.
  ;(os as { homedir: () => string }).homedir = () => os.tmpdir()
  rootDir = mkdtempSync(join(os.tmpdir(), 'shogo-local-projects-'))
  childDir = join(rootDir, 'child')
  otherDir = join(rootDir, 'other')
  mkdirSync(childDir)
  mkdirSync(otherDir)
  const mod = await import('../routes/local-projects')
  localProjectsRoutes = mod.localProjectsRoutes
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

function appWithAuth() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth' as never, { userId: 'user-1' } as never)
    await next()
  })
  app.route('/', localProjectsRoutes())
  return app
}

function appWithoutAuth() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('auth' as never, null as never)
    await next()
  })
  app.route('/', localProjectsRoutes())
  return app
}

async function json(res: Response) {
  return res.json() as Promise<any>
}

describe('localProjectsRoutes fs browse', () => {
  test('lists directories first, includes files when requested, and rejects invalid paths', async () => {
    writeFileSync(join(rootDir, '.hidden'), 'hidden')
    writeFileSync(join(rootDir, 'file.txt'), 'file')
    mkdirSync(join(rootDir, 'z-dir'))

    const body = await json(await appWithAuth().request(
      `http://api.test/fs/browse?path=${encodeURIComponent(rootDir)}&includeFiles=true`,
    ))

    expect(body.path).toBe(rootDir)
    expect(body.entries.map((e: any) => e.name)).toEqual(['child', 'other', 'z-dir', '.hidden', 'file.txt'])
    expect(body.entries.find((e: any) => e.name === '.hidden').hidden).toBe(true)

    const invalid = await appWithAuth().request('http://api.test/fs/browse?path=relative')
    expect(invalid.status).toBe(400)
    expect((await json(invalid)).code).toBe('not_absolute')
  })

  test('rejects unauthenticated browse and omits files by default', async () => {
    writeFileSync(join(rootDir, 'file.txt'), 'file')
    const unauth = await appWithoutAuth().request(`http://api.test/fs/browse?path=${encodeURIComponent(rootDir)}`)
    expect(unauth.status).toBe(401)

    const body = await json(await appWithAuth().request(`http://api.test/fs/browse?path=${encodeURIComponent(rootDir)}`))
    expect(body.entries.map((e: any) => e.name)).toEqual(['child', 'other'])
  })

  test('reports common path validation errors and tolerates dangling symlinks', async () => {
    const filePath = join(rootDir, 'plain.txt')
    writeFileSync(filePath, 'file')
    const fileRes = await appWithAuth().request(`http://api.test/fs/browse?path=${encodeURIComponent(filePath)}`)
    expect(fileRes.status).toBe(400)
    expect((await json(fileRes)).code).toBe('not_directory')

    symlinkSync(join(rootDir, 'missing-target'), join(rootDir, 'dangling-link'))
    const body = await json(await appWithAuth().request(
      `http://api.test/fs/browse?path=${encodeURIComponent(rootDir)}&includeFiles=true`,
    ))
    const link = body.entries.find((e: any) => e.name === 'dangling-link')
    expect(link).toMatchObject({ isSymlink: true, isDirectory: false })
  })
})

describe('localProjectsRoutes from folders', () => {
  test('rejects unauthenticated and invalid JSON requests', async () => {
    expect((await appWithoutAuth().request('http://api.test/from-folders', { method: 'POST' })).status).toBe(401)

    const invalid = await appWithAuth().request('http://api.test/from-folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(invalid.status).toBe(400)
    expect((await json(invalid)).error).toBe('invalid_json')
  })

  test('asks for git-root confirmation when a subfolder is inside a repo', async () => {
    mkdirSync(join(rootDir, '.git'))

    const res = await appWithAuth().request('http://api.test/from-folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [childDir] }),
    })

    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({
      needsGitRootChoice: true,
      gitRoot: rootDir,
      picked: childDir,
    })
  })

  test('creates a new external project and bootstraps .shogo metadata', async () => {
    mkdirSync(join(rootDir, '.git'))
    writeFileSync(join(rootDir, '.gitignore'), 'node_modules\n')

    const res = await appWithAuth().request('http://api.test/from-folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Local Repo',
        paths: [childDir, otherDir],
        acceptedGitRoot: true,
      }),
    })
    const body = await json(res)

    expect(res.status).toBe(201)
    expect(body).toMatchObject({ rebound: false, project: { id: 'project-1' } })
    expect(existsSync(join(rootDir, '.shogo', 'project.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(rootDir, '.shogo', 'project.json'), 'utf-8')).projectId).toBe('project-1')
    expect(readFileSync(join(rootDir, '.gitignore'), 'utf-8')).toContain('.shogo/local/')
    expect([...folders.values()]).toHaveLength(2)
  })

  test('returns no-workspace and bootstrap-partial responses for creation edge cases', async () => {
    workspaceFindFirstResult = null
    const noWorkspace = await appWithAuth().request('http://api.test/from-folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [rootDir], acceptedGitRoot: false }),
    })
    expect(noWorkspace.status).toBe(400)
    expect((await json(noWorkspace)).error).toBe('no_workspace_for_user')

    workspaceFindFirstResult = { id: 'workspace-1' }
    writeFileSync(join(rootDir, '.shogo'), 'not a directory')
    const partial = await appWithAuth().request('http://api.test/from-folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [rootDir], acceptedGitRoot: false }),
    })

    expect(partial.status).toBe(201)
    expect((await json(partial)).warning).toBe('bootstrap_partial')
  })

  test('returns create_failed when the project transaction fails', async () => {
    transactionShouldThrow = true
    const res = await appWithAuth().request('http://api.test/from-folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [rootDir], acceptedGitRoot: false }),
    })
    expect(res.status).toBe(500)
    expect((await json(res)).error).toBe('create_failed')
  })

  test('rebinds an existing project.json and backfills external settings', async () => {
    projects.set('existing-project', {
      id: 'existing-project',
      name: 'Existing',
      workingMode: 'external',
      settings: JSON.stringify({ techStackId: 'react', custom: true }),
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    })
    folders.set('folder-existing', {
      id: 'folder-existing',
      projectId: 'existing-project',
      path: rootDir,
      isPrimary: true,
      lastOpenedAt: null,
    })
    mkdirSync(join(rootDir, '.shogo'), { recursive: true })
    writeFileSync(join(rootDir, '.shogo', 'project.json'), JSON.stringify({
      projectId: 'existing-project',
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    }))

    const res = await appWithAuth().request('http://api.test/from-folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [rootDir, otherDir], acceptedGitRoot: false }),
    })

    expect(await json(res)).toMatchObject({ rebound: true, project: { id: 'existing-project' } })
    expect(folders.get('folder-existing').lastOpenedAt).toBeInstanceOf(Date)
    expect([...folders.values()].some((f) => f.path === otherDir)).toBe(true)
    expect(JSON.stringify(projects.get('existing-project').settings)).not.toContain('techStackId')
  })

  test('rebind handles malformed existing settings', async () => {
    projects.set('existing-project', {
      id: 'existing-project',
      name: 'Existing',
      workingMode: 'external',
      settings: '{bad json',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    })
    folders.set('folder-existing', {
      id: 'folder-existing',
      projectId: 'existing-project',
      path: rootDir,
      isPrimary: true,
      lastOpenedAt: null,
    })
    mkdirSync(join(rootDir, '.shogo'), { recursive: true })
    writeFileSync(join(rootDir, '.shogo', 'project.json'), JSON.stringify({ projectId: 'existing-project' }))

    const res = await appWithAuth().request('http://api.test/from-folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [rootDir], acceptedGitRoot: false }),
    })

    expect(res.status).toBe(200)
    expect(JSON.stringify(projects.get('existing-project').settings)).toContain('workingMode')
  })

  test('returns errors for missing paths and foreign project metadata', async () => {
    const missing = await appWithAuth().request('http://api.test/from-folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [] }),
    })
    expect(missing.status).toBe(400)

    mkdirSync(join(rootDir, '.shogo'), { recursive: true })
    writeFileSync(join(rootDir, '.shogo', 'project.json'), JSON.stringify({
      projectId: 'missing-project',
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    }))
    const foreign = await appWithAuth().request('http://api.test/from-folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [rootDir], acceptedGitRoot: false }),
    })
    expect(foreign.status).toBe(409)
    expect((await json(foreign)).error).toBe('alreadyBoundElsewhere')
  })
})

describe('localProjectsRoutes folder management', () => {
  beforeEach(() => {
    projects.set('project-1', {
      id: 'project-1',
      name: 'External',
      workingMode: 'external',
      trustLevel: 'restricted',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    })
    folders.set('primary', {
      id: 'primary',
      projectId: 'project-1',
      path: rootDir,
      isPrimary: true,
      lastOpenedAt: null,
    })
    mkdirSync(join(rootDir, '.shogo'), { recursive: true })
  })

  test('adds folders, rejects duplicates, and deletes non-primary folders', async () => {
    const app = appWithAuth()
    const add = await app.request('http://api.test/project-1/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: otherDir }),
    })
    expect(add.status).toBe(201)
    const folder = (await json(add)).folder

    const duplicate = await app.request('http://api.test/project-1/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: otherDir }),
    })
    expect(duplicate.status).toBe(409)

    const deletePrimary = await app.request('http://api.test/project-1/folders/primary', { method: 'DELETE' })
    expect(deletePrimary.status).toBe(409)

    const deleted = await app.request(`http://api.test/project-1/folders/${folder.id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(folders.has(folder.id)).toBe(false)
  })

  test('folder routes reject unauthenticated, invalid JSON, missing projects, and managed projects', async () => {
    expect((await appWithoutAuth().request('http://api.test/project-1/folders', { method: 'POST' })).status).toBe(401)
    expect((await appWithAuth().request('http://api.test/project-1/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })).status).toBe(400)
    expect((await appWithAuth().request('http://api.test/missing/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: otherDir }),
    })).status).toBe(404)

    projects.get('project-1').workingMode = 'managed'
    expect((await appWithAuth().request('http://api.test/project-1/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: otherDir }),
    })).status).toBe(409)
  })

  test('folder routes reject invalid add paths and missing delete folders', async () => {
    const invalidPath = await appWithAuth().request('http://api.test/project-1/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'relative' }),
    })
    expect(invalidPath.status).toBe(400)
    expect((await json(invalidPath)).code).toBe('not_absolute')

    expect((await appWithAuth().request('http://api.test/project-1/folders/missing', { method: 'DELETE' })).status).toBe(404)
  })

  test('promotes a folder to primary and moves .shogo metadata', async () => {
    folders.set('secondary', {
      id: 'secondary',
      projectId: 'project-1',
      path: otherDir,
      isPrimary: false,
      lastOpenedAt: null,
    })

    const res = await appWithAuth().request('http://api.test/project-1/primary', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: 'secondary' }),
    })

    expect(res.status).toBe(200)
    expect(folders.get('primary').isPrimary).toBe(false)
    expect(folders.get('secondary').isPrimary).toBe(true)
    expect(existsSync(join(otherDir, '.shogo', 'project.json'))).toBe(true)
  })

  test('primary route handles validation, same-primary, and move failure branches', async () => {
    const app = appWithAuth()
    expect((await appWithoutAuth().request('http://api.test/project-1/primary', { method: 'POST' })).status).toBe(401)
    expect((await app.request('http://api.test/project-1/primary', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })).status).toBe(400)
    expect((await app.request('http://api.test/project-1/primary', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })).status).toBe(400)
    expect((await app.request('http://api.test/project-1/primary', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: 'primary' }),
    })).status).toBe(200)

    folders.set('secondary', {
      id: 'secondary',
      projectId: 'project-1',
      path: otherDir,
      isPrimary: false,
      lastOpenedAt: null,
    })
    mkdirSync(join(otherDir, '.shogo'), { recursive: true })
    writeFileSync(join(otherDir, '.shogo', 'occupied.txt'), 'block rename')

    const failedMove = await app.request('http://api.test/project-1/primary', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: 'secondary' }),
    })
    expect(failedMove.status).toBe(500)
    expect((await json(failedMove)).error).toBe('shogo_dir_move_failed')
  })

  test('primary route rejects managed projects', async () => {
    folders.set('secondary', {
      id: 'secondary',
      projectId: 'project-1',
      path: otherDir,
      isPrimary: false,
      lastOpenedAt: null,
    })
    projects.get('project-1').workingMode = 'managed'

    const res = await appWithAuth().request('http://api.test/project-1/primary', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: 'secondary' }),
    })

    expect(res.status).toBe(409)
    expect((await json(res)).error).toBe('not_external_project')
  })

  test('updates trust and lists recent projects', async () => {
    folders.get('primary').lastOpenedAt = new Date('2026-01-02T00:00:00Z')
    const app = appWithAuth()

    const trust = await json(await app.request('http://api.test/project-1/trust', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trusted: true }),
    }))
    expect(trust.project.trustLevel).toBe('trusted')

    const recent = await json(await app.request('http://api.test/recent'))
    expect(recent.projects[0]).toMatchObject({ id: 'project-1', _lastOpenedAt: expect.any(Number) })
  })

  test('trust and recent routes enforce auth and body validation', async () => {
    expect((await appWithoutAuth().request('http://api.test/project-1/trust', { method: 'POST' })).status).toBe(401)
    expect((await appWithAuth().request('http://api.test/project-1/trust', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })).status).toBe(400)
    expect((await appWithAuth().request('http://api.test/project-1/trust', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trusted: 'yes' }),
    })).status).toBe(400)
    expect((await appWithoutAuth().request('http://api.test/recent')).status).toBe(401)
  })
})
