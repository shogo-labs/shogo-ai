// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-43 — more than one workspace in local mode.
 *
 * Boots the real generated workspace routes plus the local workspace routes
 * against a real SQLite database (desktop migrations replayed), so this covers
 * what unit tests can't: the owner row, the agent profile, the guards, cascade
 * deletion and the on-disk wipe actually surviving a trip through Hono.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Hono } from 'hono'
import { setupChannelsTestDb } from '../../__tests__/helpers/channels-test-db'

const { dir } = setupChannelsTestDb()

const { prisma } = await import('../../lib/prisma')
const { createLocalGeneratedRoutes } = await import('../../generated/local-routes')
const { localWorkspaceRoutes } = await import('../local-workspaces')

const db = prisma as any
const workspacesDir = mkdtempSync(join(tmpdir(), 'shogo-ws-int-'))

/** Runtime manager stand-in: records which runtimes a delete tore down. */
const stopped: string[] = []
const runtimeManager = {
  stopWorkspace: async (workspaceId: string) => {
    stopped.push(workspaceId)
  },
  stop: async (projectId: string) => {
    stopped.push(projectId)
  },
  workspaceActivity: async (workspaceId: string) => ({
    running: workspaceId === busyWorkspaceId,
    inFlight: workspaceId === busyWorkspaceId,
  }),
}
let busyWorkspaceId = ''

const app = new Hono()
app.use('*', async (c, next) => {
  const userId = c.req.header('x-user')
  c.set('auth', { userId, isAuthenticated: !!userId } as never)
  await next()
})
app.route('/api', localWorkspaceRoutes({ runtimeManager, workspacesDir }))
app.route('/api', createLocalGeneratedRoutes(db))

const request = (path: string, userId: string | null, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      ...(userId ? { 'x-user': userId } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })

let owner: string
let viewer: string
let outsider: string
let personalWorkspaceId: string

const suffix = crypto.randomUUID().slice(0, 8)

beforeAll(async () => {
  const mkUser = (name: string) =>
    db.user.create({ data: { name, email: `${name}-${suffix}@example.com` } })
  const [ownerUser, viewerUser, outsiderUser] = await Promise.all([
    mkUser('owner'),
    mkUser('viewer'),
    mkUser('outsider'),
  ])
  owner = ownerUser.id
  viewer = viewerUser.id
  outsider = outsiderUser.id

  // The seeded companion space every local install gets.
  const personal = await db.workspace.create({
    data: { name: 'Local User Personal', slug: `local-personal-${suffix}`, kind: 'personal' },
  })
  personalWorkspaceId = personal.id
  await db.member.create({
    data: { userId: owner, workspaceId: personal.id, role: 'owner', isBillingAdmin: true },
  })
  await db.member.create({ data: { userId: viewer, workspaceId: personal.id, role: 'viewer' } })
})

afterAll(async () => {
  await db.$disconnect?.()
  rmSync(workspacesDir, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

describe('POST /api/workspaces (local)', () => {
  test('creates a team workspace with exactly one owner and an agent profile', async () => {
    const res = await request('/api/workspaces', owner, {
      method: 'POST',
      body: JSON.stringify({ name: '  Client Work  ' }),
    })
    expect(res.status).toBe(201)
    const body: any = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data.name).toBe('Client Work')
    expect(body.data.kind).toBe('team')
    expect(typeof body.data.slug).toBe('string')
    expect(body.data.slug.length).toBeGreaterThan(0)

    const members = await db.member.findMany({ where: { workspaceId: body.data.id } })
    expect(members).toHaveLength(1)
    expect(members[0].role).toBe('owner')
    expect(members[0].userId).toBe(owner)

    const profile = await db.workspaceAgentProfile.findUnique({
      where: { workspaceId: body.data.id },
    })
    expect(profile).not.toBeNull()
  })

  test('has no plan or count limit', async () => {
    for (const name of ['Second', 'Third', 'Fourth']) {
      const res = await request('/api/workspaces', owner, {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      expect(res.status).toBe(201)
    }
    const owned = await db.member.count({ where: { userId: owner, role: 'owner' } })
    expect(owned).toBeGreaterThanOrEqual(5)
  })

  test('rejects a blank name with invalid_name', async () => {
    const res = await request('/api/workspaces', owner, {
      method: 'POST',
      body: JSON.stringify({ name: '   ' }),
    })
    expect(res.status).toBe(400)
    const body: any = await res.json()
    expect(body.error.code).toBe('invalid_name')
  })

  test('refuses kind=personal — the companion space already exists', async () => {
    const res = await request('/api/workspaces', owner, {
      method: 'POST',
      body: JSON.stringify({ name: 'Not Allowed', kind: 'personal' }),
    })
    expect(res.status).toBe(409)
    const body: any = await res.json()
    expect(body.error.code).toBe('personal_workspace_exists')
  })

  test('requires authentication', async () => {
    const res = await request('/api/workspaces', null, {
      method: 'POST',
      body: JSON.stringify({ name: 'Anon' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('GET /api/workspaces (local)', () => {
  test('lists only workspaces the caller belongs to, in creation order', async () => {
    const res = await request('/api/workspaces', owner)
    expect(res.status).toBe(200)
    const body: any = await res.json()
    const items = body.items ?? body.data ?? []
    const ids = items.map((w: any) => w.id)
    expect(ids[0]).toBe(personalWorkspaceId)
    const createdAt = items.map((w: any) => new Date(w.createdAt).getTime())
    expect([...createdAt].sort((a, b) => a - b)).toEqual(createdAt)
  })

  test('does not leak a workspace the caller is not a member of', async () => {
    const res = await request('/api/workspaces', outsider)
    const body: any = await res.json()
    const items = body.items ?? body.data ?? []
    expect(items.map((w: any) => w.id)).not.toContain(personalWorkspaceId)
  })
})

describe('PATCH /api/workspaces/:id (local)', () => {
  let workspaceId: string

  beforeAll(async () => {
    const res = await request('/api/workspaces', owner, {
      method: 'POST',
      body: JSON.stringify({ name: 'Rename Me' }),
    })
    workspaceId = ((await res.json()) as any).data.id
  })

  test('renames without touching the slug', async () => {
    const before = await db.workspace.findUnique({ where: { id: workspaceId } })
    const res = await request(`/api/workspaces/${workspaceId}`, owner, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Renamed' }),
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.name).toBe('Renamed')
    expect(body.data.slug).toBe(before.slug)
  })

  test('refuses a kind change', async () => {
    const res = await request(`/api/workspaces/${workspaceId}`, owner, {
      method: 'PATCH',
      body: JSON.stringify({ kind: 'personal' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('kind_immutable')
  })

  test('refuses a blank name', async () => {
    const res = await request(`/api/workspaces/${workspaceId}`, owner, {
      method: 'PATCH',
      body: JSON.stringify({ name: '' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('invalid_name')
  })

  test('still applies the settings scalars the generated PATCH allowed', async () => {
    // Shadowing the generated route must not silently drop a toggle that some
    // other screen writes through the same endpoint.
    const res = await request(`/api/workspaces/${workspaceId}`, owner, {
      method: 'PATCH',
      body: JSON.stringify({ chatMode: 'team', slug: 'hijacked-slug' }),
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.chatMode).toBe('team')
    expect(body.data.slug).not.toBe('hijacked-slug')
  })

  test('refuses a non-member and a viewer', async () => {
    const asOutsider = await request(`/api/workspaces/${personalWorkspaceId}`, outsider, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Hijacked' }),
    })
    expect(asOutsider.status).toBe(403)
    const asViewer = await request(`/api/workspaces/${personalWorkspaceId}`, viewer, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Hijacked' }),
    })
    expect(asViewer.status).toBe(403)
  })
})

describe('delete guards (local)', () => {
  test('the personal workspace cannot be deleted', async () => {
    const res = await request(`/api/workspaces/${personalWorkspaceId}`, owner, { method: 'DELETE' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.code).toBe('personal_workspace_required')
    expect(await db.workspace.findUnique({ where: { id: personalWorkspaceId } })).not.toBeNull()
  })

  test('a non-owner cannot delete', async () => {
    const res = await request(`/api/workspaces/${personalWorkspaceId}`, viewer, { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  test('the only owned workspace cannot be deleted', async () => {
    const short = crypto.randomUUID().slice(0, 6)
    const solo = await db.user.create({ data: { name: 'solo', email: `solo-${short}@example.com` } })
    const ws = await db.workspace.create({
      data: { name: 'Solo', slug: `solo-${short}`, kind: 'team' },
    })
    await db.member.create({ data: { userId: solo.id, workspaceId: ws.id, role: 'owner' } })

    const res = await request(`/api/workspaces/${ws.id}`, solo.id, { method: 'DELETE' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.code).toBe('last_workspace')
    expect(await db.workspace.findUnique({ where: { id: ws.id } })).not.toBeNull()
  })
})

describe('deletion preview + delete (local)', () => {
  let workspaceId: string
  let managedProjectId: string
  let linkedProjectId: string
  let managedDir: string
  let mergedRoot: string
  let userRepo: string
  // A state dir belonging to a project of some OTHER workspace: deleting this
  // one must never take it.
  const otherStateProjectId = 'proj-other-workspace-state'
  const stateDirOf = (id: string) => join(workspacesDir, '.shogo-state', id)

  beforeAll(async () => {
    const res = await request('/api/workspaces', owner, {
      method: 'POST',
      body: JSON.stringify({ name: 'To Be Deleted' }),
    })
    workspaceId = ((await res.json()) as any).data.id

    const managed = await db.project.create({ data: { name: 'Managed', workspaceId } })
    managedProjectId = managed.id
    managedDir = join(workspacesDir, managedProjectId)
    mkdirSync(join(managedDir, 'src'), { recursive: true })
    writeFileSync(join(managedDir, 'src', 'index.ts'), 'x'.repeat(2048))

    const linked = await db.project.create({
      data: { name: 'Linked', workspaceId, workingMode: 'external' },
    })
    linkedProjectId = linked.id
    userRepo = join(tmpdir(), `shogo-user-repo-${suffix}`)
    mkdirSync(userRepo, { recursive: true })
    writeFileSync(join(userRepo, 'package.json'), '{"name":"mine"}')
    await db.projectFolder.create({
      data: { projectId: linkedProjectId, path: userRepo, isPrimary: true },
    })

    mergedRoot = join(workspacesDir, '.workspace-roots', workspaceId)
    mkdirSync(mergedRoot, { recursive: true })
    symlinkSync(userRepo, join(mergedRoot, 'linked'))
    writeFileSync(join(mergedRoot, '.shogo-marker'), '')

    // SHO-151: the runtime keeps task logs outside the project tree, at
    // `<workspacesDir>/.shogo-state/<projectId>/tasks`. Both projects have some
    // (a folder-linked project's logs are app-owned too), and a project from
    // another workspace has some that must survive.
    for (const id of [managedProjectId, linkedProjectId]) {
      mkdirSync(join(workspacesDir, '.shogo-state', id, 'tasks'), { recursive: true })
      writeFileSync(join(workspacesDir, '.shogo-state', id, 'tasks', 'build.log'), 'x'.repeat(64))
    }
    mkdirSync(join(workspacesDir, '.shogo-state', otherStateProjectId, 'tasks'), { recursive: true })
  })

  test('the preview lists the app-owned dirs and keeps folder-linked paths out', async () => {
    const res = await request(`/api/workspaces/${workspaceId}/deletion-preview`, owner)
    expect(res.status).toBe(200)
    const { preview }: any = await res.json()
    expect(preview.removedDirs).toContain(managedDir)
    expect(preview.removedDirs).toContain(mergedRoot)
    expect(preview.removedDirs).not.toContain(userRepo)
    // Task logs are swept for every project the workspace owned, folder-linked
    // ones included, and the size shown covers them (SHO-151).
    expect(preview.removedDirs).toContain(stateDirOf(managedProjectId))
    expect(preview.removedDirs).toContain(stateDirOf(linkedProjectId))
    expect(preview.totalBytes).toBeGreaterThanOrEqual(2048 + 128)
    const linkedProject = preview.projects.find((p: any) => p.id === linkedProjectId)
    expect(linkedProject.folderLinked).toBe(true)
    expect(linkedProject.folderPath).toBe(userRepo)
  })

  test('the preview is membership-gated', async () => {
    const res = await request(`/api/workspaces/${workspaceId}/deletion-preview`, outsider)
    expect(res.status).toBe(403)
  })

  test('delete wipes rows, stops runtimes, removes app-owned files and keeps the user folder', async () => {
    stopped.length = 0
    const res = await request(`/api/workspaces/${workspaceId}`, owner, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.ok).toBe(true)
    expect(body.removedDirs).toContain(managedDir)
    expect(body.removedDirs).toContain(mergedRoot)
    expect(body.removedDirs).toContain(stateDirOf(managedProjectId))
    expect(body.removedDirs).toContain(stateDirOf(linkedProjectId))
    expect(body.warnings).toEqual([])

    expect(await db.workspace.findUnique({ where: { id: workspaceId } })).toBeNull()
    expect(await db.project.count({ where: { workspaceId } })).toBe(0)
    expect(await db.member.count({ where: { workspaceId } })).toBe(0)

    expect(existsSync(managedDir)).toBe(false)
    expect(existsSync(mergedRoot)).toBe(false)
    // SHO-151: the task logs are gone with the workspace...
    expect(existsSync(stateDirOf(managedProjectId))).toBe(false)
    expect(existsSync(stateDirOf(linkedProjectId))).toBe(false)
    // ...but nothing else under `.shogo-state` is, and the parent stays.
    expect(existsSync(join(stateDirOf(otherStateProjectId), 'tasks'))).toBe(true)
    expect(existsSync(join(workspacesDir, '.shogo-state'))).toBe(true)
    // The folder-linked project's real folder is untouched.
    expect(existsSync(join(userRepo, 'package.json'))).toBe(true)
    expect(statSync(userRepo).isDirectory()).toBe(true)

    // Both runtimes for the deleted workspace were torn down.
    expect(stopped).toContain(workspaceId)
    expect(stopped).toContain(managedProjectId)
    expect(stopped).toContain(linkedProjectId)
  })

  test('a second delete is refused', async () => {
    const res = await request(`/api/workspaces/${workspaceId}`, owner, { method: 'DELETE' })
    expect(res.status).toBe(403)
  })
})

describe('GET /api/workspaces/activity (local)', () => {
  test('reports which workspaces are running with work in flight', async () => {
    busyWorkspaceId = personalWorkspaceId
    const res = await request('/api/workspaces/activity', owner)
    expect(res.status).toBe(200)
    const { items }: any = await res.json()
    const personal = items.find((i: any) => i.workspaceId === personalWorkspaceId)
    expect(personal).toEqual({ workspaceId: personalWorkspaceId, running: true, inFlight: true })
    const idle = items.filter((i: any) => i.workspaceId !== personalWorkspaceId)
    expect(idle.every((i: any) => i.running === false && i.inFlight === false)).toBe(true)
  })
})

/**
 * SHO-71 — a Zernio profile is a standing per-account charge, so it has to go
 * with the workspace. This is the half of the wipe that leaves our database
 * entirely, and the only part of the delete that another company bills us for.
 */
describe('delete removes the Zernio profile (social)', () => {
  const deleted: string[] = []
  let fake: any

  beforeAll(async () => {
    const { setSocialClient } = await import('../../services/social/client')
    fake = {
      mode: 'cloud',
      async request(req: any) {
        if (req.method === 'DELETE') deleted.push(req.path)
        return {}
      },
    }
    setSocialClient(fake)
  })

  afterAll(async () => {
    const { setSocialClient } = await import('../../services/social/client')
    setSocialClient(null)
  })

  async function ownedWorkspace(label: string) {
    const res = await request('/api/workspaces', owner, {
      method: 'POST',
      body: JSON.stringify({ name: label }),
    })
    const id = ((await res.json()) as any).data.id as string
    await db.socialProfile.create({
      data: { workspaceId: id, zernioProfileId: `zp_${id}`, externalId: id, name: label },
    })
    return id
  }

  test('the profile is deleted at Zernio before the workspace rows disappear', async () => {
    const id = await ownedWorkspace('Brand X')
    deleted.length = 0

    const res = await request(`/api/workspaces/${id}`, owner, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(deleted).toEqual([`/profiles/zp_${id}`])
    expect(await db.socialProfile.findUnique({ where: { workspaceId_localWorkspaceId: { workspaceId: id, localWorkspaceId: '' } } })).toBeNull()
    expect(await db.workspace.findUnique({ where: { id } })).toBeNull()
  })

  test('a provider failure does not block the wipe and is reported', async () => {
    const { setSocialClient, SocialError } = await import('../../services/social/client')
    const id = await ownedWorkspace('Brand Y')
    setSocialClient({
      mode: 'cloud',
      async request() {
        throw new SocialError(502, 'provider_unreachable', 'Zernio is down')
      },
    })
    try {
      const res = await request(`/api/workspaces/${id}`, owner, { method: 'DELETE' })
      expect(res.status).toBe(200)
      const body: any = await res.json()
      expect(body.warnings.join(' | ')).toContain('social profile: provider_unreachable: Zernio is down')
      // The workspace still goes; only the charge is left behind, and loudly.
      expect(await db.socialProfile.findUnique({ where: { workspaceId_localWorkspaceId: { workspaceId: id, localWorkspaceId: '' } } })).toBeNull()
      expect(await db.workspace.findUnique({ where: { id } })).toBeNull()
    } finally {
      setSocialClient(fake)
    }
  })
})
