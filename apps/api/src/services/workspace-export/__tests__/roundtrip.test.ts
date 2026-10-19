// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Export → import round trip over an in-memory Prisma stand-in.
 *
 * This is the test that would catch the expensive mistakes: a model that never
 * makes it into `data/`, a project whose files land under the old id, an id
 * that is not remapped, a secret that survives redaction, or a DM that leaks
 * because the scoping predicate forgot the requester.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'

type Row = Record<string, any>

/** Minimal Prisma stand-in: one table per model, `where` supports `=`, `in`, `not`. */
class FakeDb {
  tables = new Map<string, Row[]>()

  rows(model: string): Row[] {
    if (!this.tables.has(model)) this.tables.set(model, [])
    return this.tables.get(model)!
  }

  matches(row: Row, where: any): boolean {
    if (!where) return true
    return Object.entries(where).every(([key, condition]: [string, any]) => {
      const value = row[key]
      if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
        if ('in' in condition) return (condition.in as any[]).includes(value)
        if ('not' in condition) return value !== condition.not
        if ('equals' in condition) return value === condition.equals
      }
      return value === condition
    })
  }

  model(name: string) {
    const table = this.rows(name)
    return {
      findMany: async ({ where }: any = {}) => table.filter((row) => this.matches(row, where)),
      findFirst: async ({ where }: any = {}) => table.find((row) => this.matches(row, where)) ?? null,
      findUnique: async ({ where }: any = {}) => table.find((row) => this.matches(row, where)) ?? null,
      count: async ({ where }: any = {}) => table.filter((row) => this.matches(row, where)).length,
      create: async ({ data }: any) => {
        table.push({ ...data })
        return data
      },
      createMany: async ({ data }: any) => {
        for (const row of data) table.push({ ...row })
        return { count: data.length }
      },
    }
  }

  proxy(): any {
    const self = this
    return new Proxy(
      {
        $transaction: async (fn: any) => fn(self.proxy()),
      },
      {
        get(target, prop: string) {
          if (prop in target) return (target as any)[prop]
          if (prop === 'then') return undefined
          return self.model(prop.charAt(0).toUpperCase() + prop.slice(1))
        },
      },
    )
  }
}

const db = new FakeDb()
const workspaceId = 'ws-1'
const projectId = 'p1'
const sessionId = 's1'
const boardId = 'b1'
const columnId = 'col1'
const workItemId = 'w1'
const channelId = 'c1'
const dmId = 'd1'
const userId = 'u1'

// No `mock.module` for Prisma: the services take an injected client, so this
// test cannot leak a fake database into (or inherit one from) another file.
const database = db.proxy()

const { buildWorkspaceArchive } = await import('../export')
const { importWorkspace, readWorkspaceArchive } = await import('../import')

let tmp: string
let workspaceRoot: string
let projectsBase: string
let previousWorkspacesDir: string | undefined

function seedWorkspace() {
  const seed = (model: string, rows: Row[]) => {
    db.rows(model).push(...rows)
  }

  seed('Workspace', [{ id: workspaceId, name: 'Acme', kind: 'team', slug: 'acme' }])
  seed('Member', [
    { id: 'm1', workspaceId, userId, role: 'owner', isBillingAdmin: true },
    { id: 'm2', workspaceId, userId: 'u-other-instance', role: 'member', isBillingAdmin: false },
  ])
  seed('Project', [{ id: projectId, workspaceId, name: 'Landing page', slug: 'landing' }])
  seed('ProjectFolder', [{ id: 'pf1', projectId, path: join(projectsBase, projectId), branch: null }])
  seed('AgentConfig', [
    {
      id: 'ac1',
      projectId,
      model: 'auto',
      channels: JSON.stringify([
        { type: 'slack', botToken: 'xoxb-secret', teamId: 'T1' },
        { type: 'github', pat: 'ghp_secret', owner: 'acme' },
      ]),
    },
  ])
  seed('GitHubConnection', [
    { id: 'gh1', projectId, repo: 'acme/site', encryptedToken: 'ciphertext', tokenLogin: 'acme-bot' },
  ])
  seed('ChatSession', [
    {
      id: sessionId,
      workspaceId,
      projectId,
      contextType: 'project',
      contextId: projectId,
      title: 'Build the hero',
    },
  ])
  seed('ChatMessage', [
    { id: 'msg1', workspaceId, sessionId, role: 'user', content: 'make a hero' },
    { id: 'msg2', workspaceId, sessionId, role: 'assistant', content: 'done' },
  ])
  seed('Board', [{ id: boardId, workspaceId, name: 'Dev', slug: 'dev' }])
  seed('BoardColumn', [{ id: columnId, workspaceId, boardId, name: 'Todo', position: 0 }])
  seed('WorkItem', [
    { id: workItemId, workspaceId, boardId, columnId, key: 'AC-1', title: 'Ship it' },
  ])
  seed('Conversation', [
    { id: channelId, workspaceId, kind: 'channel', name: 'general' },
    { id: dmId, workspaceId, kind: 'dm', name: null },
  ])
  seed('ConversationMember', [
    { id: 'cm1', workspaceId, conversationId: channelId, userId },
    { id: 'cm2', workspaceId, conversationId: dmId, userId: 'someone-else' },
  ])
  seed('ConversationMessage', [
    { id: 'cmsg1', workspaceId, conversationId: channelId, authorUserId: userId, content: 'hi team' },
    { id: 'cmsg2', workspaceId, conversationId: dmId, authorUserId: 'someone-else', content: 'secret' },
  ])
  // Only the owner has an account on this instance; the other member's user
  // row is deliberately absent so the import has to report the mismatch.
  seed('User', [{ id: userId, email: 'owner@example.com', name: 'Owner' }])
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'shogo-ws-roundtrip-'))
  previousWorkspacesDir = process.env.WORKSPACES_DIR
  projectsBase = join(tmp, 'workspaces')
  process.env.WORKSPACES_DIR = projectsBase
  db.tables.clear()

  mkdirSync(join(projectsBase, projectId, 'src'), { recursive: true })
  writeFileSync(join(projectsBase, projectId, 'src/App.tsx'), 'export const app = 1')
  writeFileSync(join(projectsBase, projectId, '.env'), 'PUBLIC_URL=https://acme.test\nSLACK_BOT_TOKEN=xoxb-real-secret\n')

  workspaceRoot = join(projectsBase, '.workspace-roots', workspaceId)
  mkdirSync(join(workspaceRoot, 'memory'), { recursive: true })
  writeFileSync(join(workspaceRoot, 'AGENTS.md'), '# AGENTS')
  writeFileSync(join(workspaceRoot, 'memory/2026-10-18.md'), '- decided things')
  symlinkSync(join(projectsBase, projectId), join(workspaceRoot, projectId))

  seedWorkspace()
})

afterEach(() => {
  if (previousWorkspacesDir === undefined) delete process.env.WORKSPACES_DIR
  else process.env.WORKSPACES_DIR = previousWorkspacesDir
  rmSync(tmp, { recursive: true, force: true })
})

async function exportArchive(extra: Record<string, any> = {}) {
  return buildWorkspaceArchive({
    workspaceId,
    requesterId: userId,
    isOwner: true,
    options: { includeAttachments: false },
    workspaceRootOverride: workspaceRoot,
    db: database,
    ...extra,
  })
}

describe('workspace export', () => {
  test('one file per included model, plus workspace and project files', async () => {
    const result = await exportArchive()
    try {
      const entries = unzipSync(new Uint8Array(readFileSync(result.tempPath)))
      const names = Object.keys(entries)

      const { INCLUDED_MODELS } = await import('../manifest')
      for (const model of INCLUDED_MODELS) {
        expect({ model, present: names.includes(`data/${model}.json`) }).toEqual({
          model,
          present: true,
        })
      }
      expect(names).toContain('workspace.json')
      expect(names).toContain('manifest.json')
      expect(names).toContain('README.md')
      expect(names).toContain('workspace/AGENTS.md')
      expect(names).toContain('workspace/memory/2026-10-18.md')
      // The project symlink inside the root must not duplicate the tree.
      expect(names).not.toContain(`workspace/${projectId}/src/App.tsx`)
      expect(names).toContain(`projects/${projectId}/files/src/App.tsx`)
      expect(names).toContain(`projects/${projectId}/chats/${sessionId}.json`)
      expect(names).not.toContain(`projects/${projectId}/files/node_modules/x.js`)
    } finally {
      rmSync(result.tempPath, { force: true })
    }
  })

  test('secrets are redacted by default and listed in credentials-required.json', async () => {
    const result = await exportArchive()
    try {
      const entries = unzipSync(new Uint8Array(readFileSync(result.tempPath)))
      const decode = (name: string) => JSON.parse(new TextDecoder().decode(entries[name]!))

      const github = decode('data/GitHubConnection.json')
      expect(github[0].encryptedToken).toBeNull()
      expect(github[0].tokenLogin).toBe('acme-bot')

      const agents = decode('data/AgentConfig.json')
      const channels = agents[0].channels
      const parsed = typeof channels === 'string' ? JSON.parse(channels) : channels
      expect(parsed[0].botToken).toBeNull()
      expect(parsed[0].teamId).toBe('T1')
      expect(parsed[1].pat).toBeNull()

      const env = new TextDecoder().decode(entries[`projects/${projectId}/files/.env`]!)
      expect(env).toContain('PUBLIC_URL=https://acme.test')
      expect(env).toContain('SLACK_BOT_TOKEN=')
      expect(env).not.toContain('xoxb-real-secret')

      const required = decode('credentials-required.json')
      expect(required.credentials.map((entry: any) => entry.label)).toContain('env.SLACK_BOT_TOKEN')

      const manifest = decode('manifest.json')
      expect(manifest.options.redacted).toBe(true)
      expect(manifest.models.GitHubConnection.decision).toBe('include')
      expect(manifest.models.User.decision).toBe('exclude')
    } finally {
      rmSync(result.tempPath, { force: true })
    }
  })

  test("another member's DM is excluded unless an owner opts in", async () => {
    const result = await exportArchive()
    try {
      const entries = unzipSync(new Uint8Array(readFileSync(result.tempPath)))
      const conversations = JSON.parse(new TextDecoder().decode(entries['data/Conversation.json']!))
      expect(conversations.map((row: Row) => row.id)).toEqual([channelId])

      const messages = JSON.parse(new TextDecoder().decode(entries['data/ConversationMessage.json']!))
      expect(messages.map((row: Row) => row.id)).toEqual(['cmsg1'])
    } finally {
      rmSync(result.tempPath, { force: true })
    }

    const optedIn = await exportArchive({ options: { includeAllDms: true, includeAttachments: false } })
    try {
      const entries = unzipSync(new Uint8Array(readFileSync(optedIn.tempPath)))
      const conversations = JSON.parse(new TextDecoder().decode(entries['data/Conversation.json']!))
      expect(conversations.map((row: Row) => row.id).sort()).toEqual([channelId, dmId].sort())
    } finally {
      rmSync(optedIn.tempPath, { force: true })
    }
  })

  test('a password-protected archive carries secrets in place', async () => {
    const result = await exportArchive({ options: { password: 'hunter2', includeAttachments: false } })
    try {
      const parsed = await readWorkspaceArchive(new Uint8Array(readFileSync(result.tempPath)), 'hunter2')
      expect(parsed.manifest.options.passwordProtected).toBe(true)
      const github = parsed.rows.get('GitHubConnection')!
      expect(github[0].encryptedToken).toBe('ciphertext')
    } finally {
      rmSync(result.tempPath, { force: true })
    }
  })
})

describe('workspace import', () => {
  async function makeArchive() {
    const result = await exportArchive()
    const bytes = new Uint8Array(readFileSync(result.tempPath))
    rmSync(result.tempPath, { force: true })
    return bytes
  }

  test('creates a new workspace, remaps ids and restores files', async () => {
    const bytes = await makeArchive()
    const target = join(tmp, 'imported')
    process.env.WORKSPACES_DIR = projectsBase

    const report = await importWorkspace({
      archive: bytes,
      requesterId: 'importer-1',
      name: 'Acme copy',
      workspacesDirOverride: target,
      db: database,
    })

    expect(report.workspace.name).toBe('Acme copy')
    expect(report.workspace.id).not.toBe(workspaceId)
    expect(report.stats.rowsInserted).toBeGreaterThan(5)

    const projects = db.rows('Project')
    const importedProject = projects.find((row) => row.workspaceId === report.workspace.id)!
    expect(importedProject.id).not.toBe(projectId)
    expect(importedProject.name).toBe('Landing page')

    // Children point at the new project, never at the old id.
    const importedConfigs = db.rows('AgentConfig').filter(
      (row) => row.projectId === importedProject.id,
    )
    expect(importedConfigs.length).toBe(1)
    expect(importedConfigs[0].id).not.toBe('ac1')

    // The chat session follows its project, and its messages follow the session.
    const importedSession = db
      .rows('ChatSession')
      .find((row) => row.workspaceId === report.workspace.id)!
    expect(importedSession.id).not.toBe(sessionId)
    expect(importedSession.projectId).toBe(importedProject.id)
    const importedMessages = db
      .rows('ChatMessage')
      .filter((row) => row.sessionId === importedSession.id)
    expect(importedMessages.map((row) => row.content).sort()).toEqual(['done', 'make a hero'])

    // Board children are rewired to the imported board and column.
    const importedBoard = db.rows('Board').find((row) => row.workspaceId === report.workspace.id)!
    const importedColumn = db
      .rows('BoardColumn')
      .find((row) => row.boardId === importedBoard.id)!
    const importedItem = db.rows('WorkItem').find((row) => row.boardId === importedBoard.id)!
    expect(importedItem.columnId).toBe(importedColumn.id)
    expect(importedItem.key).toBe('AC-1')

    // Members are matched by email: the owner's account exists, the other
    // member's does not.
    const members = db.rows('Member').filter((row) => row.workspaceId === report.workspace.id)
    expect(members.map((row) => row.userId).sort()).toEqual(['importer-1', userId].sort())
    // The member with no account on this instance is reported, not silently kept.
    expect(report.skippedRows.some((row) => row.model === 'Member')).toBe(true)

    const workspaceRootOut = join(target, '.workspace-roots', report.workspace.id)
    expect(readFileSync(join(workspaceRootOut, 'AGENTS.md'), 'utf8')).toBe('# AGENTS')
    expect(readFileSync(join(target, importedProject.id, 'src/App.tsx'), 'utf8')).toBe(
      'export const app = 1',
    )
    expect(existsSync(join(target, importedProject.id, 'src/App.tsx'))).toBe(true)
    expect(existsSync(join(workspaceRootOut, 'import-report.json'))).toBe(true)
  })

  test('dry run validates without writing anything', async () => {
    const bytes = await makeArchive()
    const before = db.rows('Project').length
    const report = await importWorkspace({
      archive: bytes,
      requesterId: 'importer-1',
      dryRun: true,
      workspacesDirOverride: join(tmp, 'imported-dry'),
      db: database,
    })
    expect(report.dryRun).toBe(true)
    expect(report.stats.rowsInserted).toBeGreaterThan(0)
    expect(db.rows('Project').length).toBe(before)
    expect(existsSync(join(tmp, 'imported-dry'))).toBe(false)
  })

  test('rejects an archive whose checksum does not match', async () => {
    const bytes = await makeArchive()
    const files = unzipSync(bytes)
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']!))
    manifest.entries.find((entry: any) => entry.path === 'data/WorkItem.json').sha256 = 'deadbeef'
    const { zipSync } = await import('fflate')
    files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest))

    let caught: any
    try {
      await readWorkspaceArchive(zipSync(files))
    } catch (err) {
      caught = err
    }
    expect(caught?.code).toBe('workspace_import_corrupt')
  })

  test('rejects an unsafe path', async () => {
    const { zipSync } = await import('fflate')
    const hostile = zipSync({
      'workspace.json': new TextEncoder().encode(
        JSON.stringify({ id: 'x', name: 'evil', formatVersion: '1.0' }),
      ),
      'manifest.json': new TextEncoder().encode(JSON.stringify({ entries: [] })),
      '../../etc/passwd': new TextEncoder().encode('root'),
    })
    let caught: any
    try {
      await readWorkspaceArchive(hostile)
    } catch (err) {
      caught = err
    }
    expect(caught?.code).toBe('workspace_import_unsafe_path')
  })

  test('wants a password for an encrypted archive', async () => {
    const result = await exportArchive({ options: { password: 'hunter2', includeAttachments: false } })
    const bytes = new Uint8Array(readFileSync(result.tempPath))
    rmSync(result.tempPath, { force: true })

    let caught: any
    try {
      await readWorkspaceArchive(bytes)
    } catch (err) {
      caught = err
    }
    expect(caught?.code).toBe('workspace_import_password_required')

    const parsed = await readWorkspaceArchive(bytes, 'hunter2')
    expect(parsed.workspace.name).toBe('Acme')
  })

  test('refuses an archive from a newer format version', async () => {
    const { zipSync } = await import('fflate')
    const newer = zipSync({
      'workspace.json': new TextEncoder().encode(
        JSON.stringify({ id: 'x', name: 'future', formatVersion: '9.9' }),
      ),
      'manifest.json': new TextEncoder().encode(JSON.stringify({ entries: [] })),
    })
    let caught: any
    try {
      await readWorkspaceArchive(newer)
    } catch (err) {
      caught = err
    }
    expect(caught?.code).toBe('workspace_import_unsupported_version')
  })

  test('ignores data for a model the format excludes', async () => {
    const bytes = await makeArchive()
    const files = unzipSync(bytes)
    const userRows = new TextEncoder().encode('[{"id":"u1","email":"x@y.z"}]')
    files['data/User.json'] = userRows
    // Keep the manifest honest about the extra entry.
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']!))
    const { createHash } = await import('node:crypto')
    manifest.entries.push({
      path: 'data/User.json',
      bytes: userRows.byteLength,
      sha256: createHash('sha256').update(userRows).digest('hex'),
    })
    files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest))
    const { zipSync } = await import('fflate')

    const report = await importWorkspace({
      archive: zipSync(files),
      requesterId: 'importer-1',
      name: 'no users',
      workspacesDirOverride: join(tmp, 'imported-users'),
      db: database,
    })
    expect(report.warnings.some((warning) => warning.includes('User is excluded'))).toBe(true)
    expect(db.rows('User').some((row) => row.email === 'x@y.z')).toBe(false)
  })
})
