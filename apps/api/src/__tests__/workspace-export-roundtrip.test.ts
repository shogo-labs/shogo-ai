// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace export/import, end to end: one archive of the whole workspace,
 * restored into a new one — against a REAL SQLite database (the desktop
 * migration history), not an in-memory stand-in.
 *
 * The service-level round-trip test uses a fake Prisma client, so it cannot see
 * a column the real schema rejects, a unique constraint, a missing required
 * field, or an insert-order violation. This file is that pass: seed → export →
 * read the bytes → import → assert the restored workspace.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { setupChannelsTestDb } from './helpers/channels-test-db'

// Must happen before anything imports lib/prisma.
const { dir: dbDir } = setupChannelsTestDb()

// The collector resolves project trees from WORKSPACES_DIR, so the fixture has
// to live where the code will look for it.
const filesDir = mkdtempSync(join(tmpdir(), 'sho42-e2e-'))
process.env.WORKSPACES_DIR = filesDir

const { prisma } = await import('../lib/prisma')
const { buildWorkspaceArchive } = await import('../services/workspace-export/export')
const { importWorkspace, readWorkspaceArchive } = await import('../services/workspace-export/import')

const ids = {
  user: 'u-owner',
  otherUser: 'u-other',
  workspace: 'ws-sho42',
  project: 'p-sho42',
  member: 'm-owner',
  otherMember: 'm-other',
  channel: 'c-channel',
  dm: 'c-dm',
  board: 'b-1',
}

async function seed() {
  await prisma.user.create({
    data: { id: ids.user, email: 'owner@example.com', name: 'Owner' } as any,
  })
  await prisma.user.create({
    data: { id: ids.otherUser, email: 'other@example.com', name: 'Other' } as any,
  })
  await prisma.workspace.create({
    data: { id: ids.workspace, name: 'Acme', slug: `acme-${Date.now()}`, kind: 'team' } as any,
  })
  await prisma.member.create({
    data: { id: ids.member, userId: ids.user, workspaceId: ids.workspace, role: 'owner' } as any,
  })
  await prisma.member.create({
    data: {
      id: ids.otherMember,
      userId: ids.otherUser,
      workspaceId: ids.workspace,
      role: 'member',
    } as any,
  })
  await prisma.project.create({
    data: { id: ids.project, workspaceId: ids.workspace, name: 'Landing' } as any,
  })
  await prisma.agentConfig.create({
    data: {
      id: 'ac-1',
      projectId: ids.project,
      channels: JSON.stringify([{ type: 'slack', botToken: 'xoxb-live-secret' }]),
    } as any,
  })
  await prisma.gitHubConnection.create({
    data: {
      id: 'gh-1',
      projectId: ids.project,
      repoOwner: 'acme',
      repoName: 'landing',
      repoFullName: 'acme/landing',
      encryptedToken: 'enc-token-value',
    } as any,
  })
  await prisma.conversation.create({
    data: { id: ids.channel, workspaceId: ids.workspace, name: 'general', kind: 'channel' } as any,
  })
  await prisma.conversation.create({
    data: { id: ids.dm, workspaceId: ids.workspace, name: 'dm', kind: 'dm' } as any,
  })
  await prisma.conversationMember.create({
    data: { id: 'cm-1', conversationId: ids.channel, userId: ids.user } as any,
  })
  await prisma.conversationMember.create({
    data: { id: 'cm-2', conversationId: ids.channel, userId: ids.otherUser } as any,
  })
  await prisma.conversationMember.create({
    data: { id: 'cm-3', conversationId: ids.dm, userId: ids.otherUser } as any,
  })
  await prisma.conversationMessage.create({
    data: {
      id: 'msg-1',
      conversationId: ids.channel,
      workspaceId: ids.workspace,
      seq: 1,
      authorUserId: ids.user,
      text: 'hello channel',
    } as any,
  })
  await prisma.conversationMessage.create({
    data: {
      id: 'msg-dm',
      conversationId: ids.dm,
      workspaceId: ids.workspace,
      seq: 2,
      authorUserId: ids.otherUser,
      text: 'private',
    } as any,
  })
  await prisma.chatSession.create({
    data: {
      id: 'cs-1',
      inferredName: 'a chat',
      createdByUserId: ids.user,
      workspaceId: ids.workspace,
      contextType: 'workspace',
    } as any,
  })
  await prisma.board.create({
    data: {
      id: ids.board,
      workspaceId: ids.workspace,
      name: 'Board',
      slug: 'board',
      keyPrefix: 'TST',
    } as any,
  })
  await prisma.boardColumn.create({
    data: { id: 'col-1', boardId: ids.board, name: 'Todo', position: 0 } as any,
  })
  await prisma.workItem.create({
    data: {
      id: 'wi-1',
      workspaceId: ids.workspace,
      boardId: ids.board,
      columnId: 'col-1',
      key: 'TST-1',
      number: 1,
      title: 'A card',
    } as any,
  })
}

function makeWorkspaceRoot() {
  const root = join(filesDir, '.workspace-roots', ids.workspace)
  mkdirSync(join(root, 'memory'), { recursive: true })
  writeFileSync(join(root, 'AGENTS.md'), '# workspace agent\n')
  writeFileSync(join(root, 'memory', '2026-10-19.md'), 'a memory\n')
  writeFileSync(join(root, '._AGENTS.md'), 'appledouble junk\n')
  const projectDir = join(filesDir, ids.project)
  mkdirSync(join(projectDir, 'src'), { recursive: true })
  writeFileSync(join(projectDir, 'src', 'App.tsx'), 'export default 1\n')
  writeFileSync(join(projectDir, '.env'), 'API_TOKEN=super-secret\nPUBLIC_URL=https://x\n')
  return root
}

beforeAll(async () => {
  await seed()
})

afterAll(async () => {
  await prisma.$disconnect().catch(() => {})
  rmSync(filesDir, { recursive: true, force: true })
  rmSync(dbDir, { recursive: true, force: true })
})

describe('SHO-42 e2e: export an entire workspace, import it back (real DB)', () => {
  test('the archive carries every in-scope row, redacted credentials and no other member’s DM', async () => {
    const root = makeWorkspaceRoot()
    const result = await buildWorkspaceArchive({
      workspaceId: ids.workspace,
      requesterId: ids.user,
      isOwner: true,
      options: { includeAttachments: false },
      db: prisma,
      workspaceRootOverride: root,
    })
    const zip = unzipSync(new Uint8Array(await Bun.file(result.tempPath).arrayBuffer()))
    const names = Object.keys(zip)

    // One file per included model, exactly as the manifest promises.
    expect(names).toContain('workspace.json')
    expect(names).toContain('manifest.json')
    expect(names).toContain('data/WorkItem.json')
    expect(names).toContain('data/Conversation.json')

    const workItems = JSON.parse(new TextDecoder().decode(zip['data/WorkItem.json']))
    expect(workItems.map((row: any) => row.key)).toEqual(['TST-1'])

    // Redaction: the token column is blank and the file says to set it again.
    const connections = JSON.parse(new TextDecoder().decode(zip['data/GitHubConnection.json']))
    expect(connections[0].encryptedToken).toBeNull()
    expect(names).toContain('credentials-required.json')
    const creds = JSON.parse(new TextDecoder().decode(zip['credentials-required.json']))
    expect(JSON.stringify(creds)).toContain('GitHubConnection.encryptedToken')

    // The agent config's channel token is stripped too.
    const configs = JSON.parse(new TextDecoder().decode(zip['data/AgentConfig.json']))
    expect(JSON.stringify(configs)).not.toContain('xoxb-live-secret')

    // `.env` inside a project is redacted, not shipped verbatim.
    const envEntry = Object.keys(zip).find((name) => name.endsWith('/files/.env'))
    expect(envEntry).toBeTruthy()
    const envText = new TextDecoder().decode(zip[envEntry!])
    expect(envText).not.toContain('super-secret')
    expect(envText).toContain('PUBLIC_URL=https://x')

    // DM policy: the DM the requester is not a member of is out; the channel is in.
    const conversations = JSON.parse(new TextDecoder().decode(zip['data/Conversation.json']))
    expect(conversations.map((row: any) => row.kind).sort()).toEqual(['channel'])

    // Files: workspace root files travel, the project's tree travels once.
    expect(names).toContain('workspace/AGENTS.md')
    expect(names).toContain('workspace/memory/2026-10-19.md')
    expect(names).toContain(`projects/${ids.project}/files/src/App.tsx`)
    // macOS detritus never travels.
    expect(names).not.toContain('workspace/._AGENTS.md')
  })

  test('a password-protected archive carries the credentials in place', async () => {
    const root = makeWorkspaceRoot()
    const result = await buildWorkspaceArchive({
      workspaceId: ids.workspace,
      requesterId: ids.user,
      isOwner: true,
      options: { includeAttachments: false, password: 'letmein' },
      db: prisma,
      workspaceRootOverride: root,
    })
    const parsed = await readWorkspaceArchive(
      new Uint8Array(await Bun.file(result.tempPath).arrayBuffer()),
      'letmein',
    )
    const connections = parsed.rows.get('GitHubConnection') ?? []
    expect(connections[0].encryptedToken).toBe('enc-token-value')
    expect(result.manifest.options.passwordProtected).toBe(true)
  })

  test('owner opt-in includes every DM and says so in the manifest', async () => {
    const root = makeWorkspaceRoot()
    const result = await buildWorkspaceArchive({
      workspaceId: ids.workspace,
      requesterId: ids.user,
      isOwner: true,
      options: { includeAttachments: false, includeAllDms: true },
      db: prisma,
      workspaceRootOverride: root,
    })
    const zip = unzipSync(new Uint8Array(await Bun.file(result.tempPath).arrayBuffer()))
    const conversations = JSON.parse(new TextDecoder().decode(zip['data/Conversation.json']))
    expect(conversations.map((row: any) => row.kind).sort()).toEqual(['channel', 'dm'])
    expect(result.manifest.options.includeAllDms).toBe(true)
  })

  test('import restores into a NEW workspace with every id remapped', async () => {
    const root = makeWorkspaceRoot()
    const result = await buildWorkspaceArchive({
      workspaceId: ids.workspace,
      requesterId: ids.user,
      isOwner: true,
      options: { includeAttachments: false },
      db: prisma,
      workspaceRootOverride: root,
    })
    const archive = new Uint8Array(await Bun.file(result.tempPath).arrayBuffer())
    const outDir = mkdtempSync(join(tmpdir(), 'sho42-import-'))
    try {
      const report = await importWorkspace({
        archive,
        requesterId: ids.user,
        name: 'Restored',
        db: prisma,
        workspacesDirOverride: outDir,
      })

      expect(report.workspace.name).toBe('Restored')
      expect(report.workspace.id).not.toBe(ids.workspace)
      expect(report.stats.rowsSkipped).toBe(0)

      const restored = await prisma.workspace.findUnique({
        where: { id: report.workspace.id },
        select: { name: true, kind: true },
      })
      expect(restored?.name).toBe('Restored')

      // The source workspace is untouched.
      const source = await prisma.workspace.findUnique({ where: { id: ids.workspace } })
      expect(source?.name).toBe('Acme')

      // Every project row is re-keyed, and its files follow the new id.
      const projects = await prisma.project.findMany({
        where: { workspaceId: report.workspace.id },
        select: { id: true, name: true },
      })
      expect(projects).toHaveLength(1)
      expect(projects[0].id).not.toBe(ids.project)
      expect(projects[0].name).toBe('Landing')

      const cards = await prisma.workItem.findMany({
        where: { workspaceId: report.workspace.id },
        select: { key: true, boardId: true },
      })
      expect(cards.map((c) => c.key)).toEqual(['TST-1'])
      expect(cards[0].boardId).not.toBe(ids.board)

      const restoredFile = Bun.file(
        join(outDir, projects[0].id, 'src', 'App.tsx'),
      )
      expect(await restoredFile.exists()).toBe(true)
      expect(await Bun.file(join(outDir, '.workspace-roots', report.workspace.id, 'AGENTS.md')).exists()).toBe(
        true,
      )
      expect(await Bun.file(join(outDir, '.workspace-roots', report.workspace.id, 'import-report.json')).exists()).toBe(
        true,
      )

      // Two imports of one archive never collide.
      const second = await importWorkspace({
        archive,
        requesterId: ids.user,
        name: 'Restored again',
        db: prisma,
        workspacesDirOverride: outDir,
      })
      expect(second.workspace.id).not.toBe(report.workspace.id)
      expect(second.stats.rowsSkipped).toBe(0)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  test('dryRun validates and writes nothing', async () => {
    const root = makeWorkspaceRoot()
    const result = await buildWorkspaceArchive({
      workspaceId: ids.workspace,
      requesterId: ids.user,
      isOwner: true,
      options: { includeAttachments: false },
      db: prisma,
      workspaceRootOverride: root,
    })
    const archive = new Uint8Array(await Bun.file(result.tempPath).arrayBuffer())
    const outDir = mkdtempSync(join(tmpdir(), 'sho42-dry-'))
    const before = await prisma.workspace.count()
    try {
      const report = await importWorkspace({
        archive,
        requesterId: ids.user,
        name: 'Dry',
        dryRun: true,
        db: prisma,
        workspacesDirOverride: outDir,
      })
      expect(report.dryRun).toBe(true)
      expect(report.workspace.id).toBe('')
      expect(await prisma.workspace.count()).toBe(before)
      expect(require('node:fs').readdirSync(outDir)).toEqual([])
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  test('an excluded model inside a hand-crafted archive is ignored, and a bad path is refused', async () => {
    const root = makeWorkspaceRoot()
    const result = await buildWorkspaceArchive({
      workspaceId: ids.workspace,
      requesterId: ids.user,
      isOwner: true,
      options: { includeAttachments: false },
      db: prisma,
      workspaceRootOverride: root,
    })
    const entries = unzipSync(new Uint8Array(await Bun.file(result.tempPath).arrayBuffer()))

    const { zipSync } = await import('fflate')
    const withCreds = {
      ...entries,
      'data/ApiKey.json': new TextEncoder().encode(
        JSON.stringify([{ id: 'k1', workspaceId: ids.workspace, keyHash: 'x' }]),
      ),
    }
    const parsed = await readWorkspaceArchive(zipSync(withCreds))
    expect(parsed.rows.has('ApiKey')).toBe(false)
    expect(parsed.warnings.join(' ')).toContain('ApiKey')

    const hostile = { ...entries, '../escape.txt': new TextEncoder().encode('nope') }
    await expect(readWorkspaceArchive(zipSync(hostile))).rejects.toThrow(/unsafe path/i)
  })
})
