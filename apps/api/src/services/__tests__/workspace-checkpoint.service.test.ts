// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for autoCheckpointWorkspaceProjects — per-project auto-checkpoint
 * on workspace chat turns. Driven entirely through injection seams so it
 * needs no real git, prisma, or mock.module (keeping it isolation-safe).
 *
 *   bun test apps/api/src/services/__tests__/workspace-checkpoint.service.test.ts
 */

import { describe, expect, it } from 'bun:test'
import { autoCheckpointWorkspaceProjects } from '../workspace-checkpoint.service'

function baseSeams(overrides: Record<string, unknown> = {}) {
  const created: Array<{ projectId: string; workspacePath: string }> = []
  const initialised: string[] = []
  const seams = {
    workspacesDir: '/ws',
    _existsSync: () => true,
    _isGitAvailable: () => true,
    _isGitRepo: () => true,
    _initRepo: async (p: string) => {
      initialised.push(p)
      return { created: true, branch: 'main' }
    },
    _getStatus: async (_p: string) => ({ hasChanges: true }),
    _createCheckpoint: async (opts: any) => {
      created.push({ projectId: opts.projectId, workspacePath: opts.workspacePath })
      return { id: `cp-${opts.projectId}` }
    },
    _loadWorkingModes: async (ids: string[]) => new Map(ids.map((id) => [id, 'managed'])),
    ...overrides,
  }
  return { seams, created, initialised }
}

describe('autoCheckpointWorkspaceProjects', () => {
  it('checkpoints each dirty attached project independently', async () => {
    const { seams, created } = baseSeams()
    const results = await autoCheckpointWorkspaceProjects(['p1', 'p2'], seams as any)
    expect(results).toEqual([
      { projectId: 'p1', status: 'checkpointed', checkpointId: 'cp-p1' },
      { projectId: 'p2', status: 'checkpointed', checkpointId: 'cp-p2' },
    ])
    expect(created.map((c) => c.workspacePath).sort()).toEqual(['/ws/p1', '/ws/p2'])
  })

  it('skips clean projects (no changes → no checkpoint)', async () => {
    const { seams, created } = baseSeams({
      _getStatus: async (p: string) => ({ hasChanges: p.endsWith('p2') }),
    })
    const results = await autoCheckpointWorkspaceProjects(['p1', 'p2'], seams as any)
    expect(results[0]).toEqual({ projectId: 'p1', status: 'clean' })
    expect(results[1]).toEqual({ projectId: 'p2', status: 'checkpointed', checkpointId: 'cp-p2' })
    expect(created.map((c) => c.projectId)).toEqual(['p2'])
  })

  it('never auto-commits external projects (and never inits a repo there)', async () => {
    const { seams, created, initialised } = baseSeams({
      _isGitRepo: () => false, // would init if not guarded
      _loadWorkingModes: async () => new Map([['p1', 'external'], ['p2', 'managed']]),
    })
    const results = await autoCheckpointWorkspaceProjects(['p1', 'p2'], seams as any)
    expect(results[0]).toEqual({ projectId: 'p1', status: 'skipped-external' })
    expect(results[1].status).toBe('baselined') // p2 not yet a repo → baseline
    // The external project's folder must never get a .git.
    expect(initialised).toEqual(['/ws/p2'])
    expect(created.map((c) => c.projectId)).toEqual(['p2'])
  })

  it('baselines never-tracked projects unconditionally (init auto-commits → tree clean)', async () => {
    // initRepo commits the initial tree, so a post-init dirty check would be
    // false. The baseline must still be recorded (does NOT consult getStatus).
    let statusCalled = false
    const { seams, initialised } = baseSeams({
      _isGitRepo: () => false,
      _getStatus: async () => {
        statusCalled = true
        return { hasChanges: false }
      },
    })
    const results = await autoCheckpointWorkspaceProjects(['p1'], seams as any)
    expect(initialised).toEqual(['/ws/p1'])
    expect(results[0].status).toBe('baselined')
    expect(statusCalled).toBe(false)
  })

  it('uses a distinct baseline message (not the AI-edit message)', async () => {
    const messages: string[] = []
    const { seams } = baseSeams({
      _isGitRepo: (p: string) => p.endsWith('p2'), // p1 new (baseline), p2 existing (change)
      _createCheckpoint: async (opts: any) => {
        messages.push(`${opts.projectId}:${opts.message}`)
        return { id: `cp-${opts.projectId}` }
      },
    })
    await autoCheckpointWorkspaceProjects(['p1', 'p2'], {
      ...(seams as any),
      message: 'AI: turn xyz',
      baselineMessage: 'Workspace baseline',
    })
    expect(messages).toContain('p1:Workspace baseline')
    expect(messages).toContain('p2:AI: turn xyz')
  })

  it('skips missing project folders', async () => {
    const { seams } = baseSeams({ _existsSync: (p: string) => !p.endsWith('p2') })
    const results = await autoCheckpointWorkspaceProjects(['p1', 'p2'], seams as any)
    expect(results[0].status).toBe('checkpointed')
    expect(results[1]).toEqual({ projectId: 'p2', status: 'skipped-missing' })
  })

  it('short-circuits when git is unavailable', async () => {
    const { seams, created } = baseSeams({ _isGitAvailable: () => false })
    const results = await autoCheckpointWorkspaceProjects(['p1', 'p2'], seams as any)
    expect(results).toEqual([
      { projectId: 'p1', status: 'skipped-no-git' },
      { projectId: 'p2', status: 'skipped-no-git' },
    ])
    expect(created).toEqual([])
  })

  it('isolates per-project failures (one error does not block others)', async () => {
    const { seams } = baseSeams({
      _createCheckpoint: async (opts: any) => {
        if (opts.projectId === 'p1') throw new Error('git boom')
        return { id: `cp-${opts.projectId}` }
      },
    })
    const results = await autoCheckpointWorkspaceProjects(['p1', 'p2'], seams as any)
    expect(results[0]).toEqual({ projectId: 'p1', status: 'error', error: 'git boom' })
    expect(results[1].status).toBe('checkpointed')
  })

  it('de-dupes and ignores empty ids', async () => {
    const { seams, created } = baseSeams()
    const results = await autoCheckpointWorkspaceProjects(['p1', 'p1', '', 'p2'], seams as any)
    expect(results.map((r) => r.projectId)).toEqual(['p1', 'p2'])
    expect(created.map((c) => c.projectId)).toEqual(['p1', 'p2'])
  })

  it('returns [] for no project ids', async () => {
    const { seams } = baseSeams()
    expect(await autoCheckpointWorkspaceProjects([], seams as any)).toEqual([])
  })
})
