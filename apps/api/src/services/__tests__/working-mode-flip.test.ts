// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-18 acceptance tests — a managed project becoming `external`, for real.
 *
 * The unit tests next door prove each half of the flip in isolation: the
 * service with `git-repo-store` mocked, the route with the service mocked, the
 * manifest diff from hand-written live rows. What none of them can prove is
 * that the halves meet — that after `configureProject({ workingMode:
 * 'external' })` the *same folder* is refused by the real checkpoint service,
 * that the row the runtime resolves its workspace from points at the files the
 * project already had, and that the state the flip leaves behind is what makes
 * a second `system_apply` a no-op.
 *
 * So this file only mocks Prisma (there is no database in scope) and the two
 * modules that would reach for the outside world (`git-repo-store` → S3, the
 * billing/tier gate, the generated project hooks). Everything else — the
 * lifecycle service, `checkpoint.service`, `git.service`, the manifest diff —
 * runs as shipped against a real temporary workspace and real git.
 *
 * Acceptance criteria covered:
 *  - the flip creates a primary `ProjectFolder` at the workspace the project
 *    already renders from, and leaves every file byte-identical;
 *  - nothing is created at the workspaces root (no clone, no template seed);
 *  - `GET` config reflects the mode;
 *  - the checkpoint call that succeeded before the flip returns the existing
 *    external refusal afterwards and writes no commit;
 *  - a manifest pinning `workingMode: external` is one configure op before the
 *    flip and empty after it;
 *  - external → managed is refused by the service.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LiveProject } from '../../../../../packages/agent-runtime/src/system-manifest'

// ─── outside-world mocks ─────────────────────────────────────────────────────

mock.module('@shogo/shared-runtime', () => ({
  // No tech stack in these tests declares a compute floor.
  getMinimumInstanceSize: () => null,
}))

mock.module('../billing.service', () => ({
  canRunTechStackOnInstanceSize: async () => ({ allowed: true, currentSize: 'micro', requiredSize: null }),
  hasPaidSubscription: async () => true,
}))

mock.module('../../generated/project.hooks', () => ({
  projectHooks: {
    beforeCreate: async () => ({ ok: true }),
    afterCreate: async () => {},
  },
}))

// The durable-repo probe talks to object storage. Refusing on a durable repo is
// covered by the unit tests; here the project has none.
mock.module('../git-repo-store', () => ({
  durableRepoExists: async () => false,
}))

// ─── prisma stub (shared by the lifecycle service and the checkpoint service) ─

interface ProjectRow {
  id: string
  name: string
  description: string | null
  workspaceId: string
  workingMode: string
  settings: unknown
  slackEnabled: boolean
  hidden: boolean
  createdAt: Date
}

const projects = new Map<string, ProjectRow>()
const folders: Array<{ id: string; projectId: string; path: string; isPrimary: boolean }> = []
const checkpoints: Array<Record<string, any>> = []
let idCounter = 0

const prismaStub = {
  project: {
    findUnique: async ({ where }: { where: { id: string } }) => projects.get(where.id) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const existing = projects.get(where.id)
      if (!existing) throw new Error('not found')
      const updated = { ...existing, ...data }
      projects.set(where.id, updated)
      return updated
    },
  },
  projectFolder: {
    findMany: async ({ where }: { where: { projectId: string } }) =>
      folders.filter((folder) => folder.projectId === where.projectId),
    create: async ({ data }: { data: { projectId: string; path: string; isPrimary?: boolean } }) => {
      const row = {
        id: `folder_${++idCounter}`,
        projectId: data.projectId,
        path: data.path,
        isPrimary: data.isPrimary === true,
      }
      folders.push(row)
      return row
    },
  },
  agentConfig: {
    findUnique: async () => null,
  },
  projectCheckpoint: {
    create: async ({ data }: { data: Record<string, any> }) => {
      const row = { id: `cp_${++idCounter}`, createdAt: new Date(), ...data }
      checkpoints.push(row)
      return row
    },
    findFirst: async () => null,
    findUnique: async () => null,
    findMany: async ({ where }: { where: { projectId: string } }) =>
      checkpoints.filter((checkpoint) => checkpoint.projectId === where.projectId),
    deleteMany: async () => ({ count: 0 }),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      ...checkpoints.find((checkpoint) => checkpoint.id === where.id),
      ...data,
    }),
  },
  gitHubConnection: {
    // `syncAfterCheckpoint` bails out when there is no connection row.
    findUnique: async () => null,
  },
}

mock.module('../../lib/prisma', () =>
  require('../../__tests__/helpers/prisma-mock-exports').withPrismaExports({ prisma: prismaStub }),
)

const lifecycle = await import('../project-lifecycle.service')
const checkpointService = await import('../checkpoint.service')
const { computeSystemDiff, parseSystemManifest } = await import(
  '../../../../../packages/agent-runtime/src/system-manifest'
)

// ─── helpers ────────────────────────────────────────────────────────────────

let workspacesDir: string
let previousWorkspacesDir: string | undefined
const tmpDirs: string[] = []

beforeEach(() => {
  projects.clear()
  folders.length = 0
  checkpoints.length = 0
  idCounter = 0
  workspacesDir = mkdtempSync(join(tmpdir(), 'sho18-ws-'))
  previousWorkspacesDir = process.env.WORKSPACES_DIR
  process.env.WORKSPACES_DIR = workspacesDir
})

afterEach(() => {
  if (previousWorkspacesDir === undefined) delete process.env.WORKSPACES_DIR
  else process.env.WORKSPACES_DIR = previousWorkspacesDir
  rmSync(workspacesDir, { recursive: true, force: true })
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

function seedProject(id = 'proj_1'): ProjectRow {
  const row: ProjectRow = {
    id,
    name: 'Existing project',
    description: null,
    workspaceId: 'ws_1',
    workingMode: 'managed',
    settings: { techStackId: 'nextjs' },
    slackEnabled: false,
    hidden: false,
    createdAt: new Date(),
  }
  projects.set(id, row)
  return row
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim()
}

/** Content hash of every user file in the tree — `.git` and `.shogo` are Shogo's own. */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string, rel: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.shogo') continue
      const abs = join(current, entry.name)
      const key = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        out[`${key}/`] = 'dir'
        walk(abs, key)
      } else {
        out[key] = createHash('sha256').update(readFileSync(abs)).digest('hex')
      }
    }
  }
  walk(dir, '')
  return out
}

function seedWorkspaceFiles(projectId: string): string {
  const dir = join(workspacesDir, projectId)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'AGENTS.md'), '# keep me\n')
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const v = 1\n')
  return dir
}

// ─── the flip ───────────────────────────────────────────────────────────────

describe('SHO-18 — managed → external on an existing project', () => {
  it('points the primary folder at the folder the project already renders from, and touches nothing on disk', async () => {
    const project = seedProject()
    const projectDir = seedWorkspaceFiles(project.id)
    const filesBefore = snapshotTree(projectDir)
    const rootBefore = readdirSync(workspacesDir).sort()

    const configured = await lifecycle.configureProject(project.id, { workingMode: 'external' })

    // Row + read-back agree.
    expect(configured.workingMode).toBe('external')
    expect(projects.get(project.id)!.workingMode).toBe('external')
    expect((await lifecycle.readProjectConfig(project.id)).workingMode).toBe('external')

    // External projects resolve their workspace from the primary folder row, so
    // the flip has to hand the resolver the directory the project already used.
    expect(folders).toEqual([{ id: expect.any(String), projectId: project.id, path: projectDir, isPrimary: true }])
    const primary = folders.find((folder) => folder.isPrimary)!.path
    expect(primary).toBe(join(workspacesDir, project.id))
    expect(existsSync(primary)).toBe(true)

    // Nothing created, moved, copied or re-cloned.
    expect(snapshotTree(projectDir)).toEqual(filesBefore)
    expect(readdirSync(workspacesDir).sort()).toEqual(rootBefore)
  })

  it('refuses the same checkpoint call the managed project was allowed a moment earlier, without writing a commit', async () => {
    const project = seedProject()
    const projectDir = seedWorkspaceFiles(project.id)

    // Proof by contrast: the identical call succeeds while the project is managed.
    const before = await checkpointService.createCheckpoint({
      projectId: project.id,
      workspacePath: projectDir,
      message: 'AI: edit (1 tool call)',
    })
    expect(before.commitSha).toBeTruthy()
    const headBefore = sh(projectDir, 'rev-parse', 'HEAD')
    const commitsBefore = sh(projectDir, 'rev-list', '--count', 'HEAD')

    await lifecycle.configureProject(project.id, { workingMode: 'external' })

    writeFileSync(join(projectDir, 'src', 'index.ts'), 'export const v = 2\n')
    await expect(
      checkpointService.createCheckpoint({
        projectId: project.id,
        workspacePath: projectDir,
        message: 'AI: edit (1 tool call)',
      }),
    ).rejects.toMatchObject({ code: 'checkpoints_disabled_in_external_mode' })

    expect(sh(projectDir, 'rev-parse', 'HEAD')).toBe(headBefore)
    expect(sh(projectDir, 'rev-list', '--count', 'HEAD')).toBe(commitsBefore)
    // The user's own uncommitted edit is still theirs, not swept into a commit.
    expect(readFileSync(join(projectDir, 'src', 'index.ts'), 'utf-8')).toBe('export const v = 2\n')
  })

  it('makes a manifest that pins workingMode: external an op before the flip and an empty diff after it', async () => {
    const project = seedProject()
    seedWorkspaceFiles(project.id)
    const manifest = parseSystemManifest({
      version: 1,
      name: 'm',
      projects: [{ key: 'app', name: project.name, workingMode: 'external' }],
    }).manifest!

    const liveFrom = async (): Promise<LiveProject[]> => {
      const config = await lifecycle.readProjectConfig(project.id)
      return [
        {
          id: config.id,
          name: config.name,
          description: config.description,
          workingMode: config.workingMode,
          attachments: [],
          agent: null,
          capabilities: {},
        },
      ]
    }

    const before = computeSystemDiff(manifest, await liveFrom(), null, { callerProjectId: 'caller' })
    expect(before.configure).toEqual([
      { kind: 'configure', key: 'app', projectId: project.id, patch: { workingMode: 'external' } },
    ])

    await lifecycle.configureProject(project.id, { workingMode: 'external' })

    // A second `system_apply` reads the state the flip produced and reports nothing.
    expect(computeSystemDiff(manifest, await liveFrom(), null, { callerProjectId: 'caller' }).configure).toEqual([])
  })

  it('refuses to turn the now-external project back into a managed one', async () => {
    const project = seedProject()
    const projectDir = seedWorkspaceFiles(project.id)
    const filesBefore = snapshotTree(projectDir)

    await lifecycle.configureProject(project.id, { workingMode: 'external' })
    const foldersAfterFlip = [...folders]

    await expect(lifecycle.configureProject(project.id, { workingMode: 'managed' })).rejects.toMatchObject({
      name: 'ProjectLifecycleError',
      code: 'working_mode_flip_not_supported',
    })

    expect(projects.get(project.id)!.workingMode).toBe('external')
    expect(folders).toEqual(foldersAfterFlip)
    expect(snapshotTree(projectDir)).toEqual(filesBefore)
  })
})
