// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Three ways a move could quietly disagree with the plan the user approved.
 *
 * Each of these shipped broken and was found by QA's real-HTTP/real-SQLite test
 * (the stubbed service tests could not see any of them), so each gets a guard
 * here rather than only a fix:
 *
 *   1. the records phase streamed a partial `Workspace` row and died on it;
 *   2. a *resumed* job rebuilt its identity from nothing, so it streamed a
 *      different row set than the plan showed;
 *   3. the workspace's own root — `.workspace-roots/<workspaceId>` — was never
 *      mapped from the `__workspace_root__` sentinel outside the HTTP routes,
 *      so root files neither appeared in the plan nor landed anywhere real.
 *
 *   bun test apps/api/src/services/workspace-move/__tests__/plan-fidelity.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moveJobContext } from '../index'
import { moveDirFor, walkMoveFiles } from '../files'
import { shouldMoveModel } from '../records'
import { sourceFileManifest } from '../serve'
import { mergesOnNaturalKey, receiveFile, targetFileManifest } from '../receive'
import { WORKSPACE_ROOT_ID } from '../types'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..', '..')
const SCHEMA = join(REPO_ROOT, 'prisma', 'schema.prisma')
const RECEIVE = join(import.meta.dir, '..', 'receive.ts')

// ── 1. The records phase must not stream a row the target cannot insert ────

describe('records phase streams only rows the target can insert', () => {
  test('the models the target creates itself never travel', () => {
    // `initTargetWorkspace` writes the target `Workspace` (with its own slug) and
    // the relink step writes `ProjectFolder`; streaming either one either fails
    // on a required column or duplicates what the target already has.
    expect({ workspace: shouldMoveModel('Workspace'), projectFolder: shouldMoveModel('ProjectFolder') }).toEqual({
      workspace: false,
      projectFolder: false,
    })
  })

  test('everything else still travels', () => {
    for (const model of ['Conversation', 'ChatMessage', 'Project', 'AgentSchedule', 'EventSubscription', 'Member']) {
      expect({ model, moves: shouldMoveModel(model) }).toEqual({ model, moves: true })
    }
  })

  /**
   * The second form of the same bug, found by the acceptance test: a model that
   * *does* travel, but whose target row `initTargetWorkspace` has already
   * written. Streaming it collides on a unique constraint instead of the primary
   * key, so the id-keyed upsert fallback does not save it — silently on Postgres
   * (`skipDuplicates` swallows it) and as a P2002 on SQLite. Both `Member` and
   * `WorkspaceAgentProfile` were in that state.
   *
   * Reads the source so a model added to `initTargetWorkspace` later cannot
   * reintroduce it: it must be either never streamed or merged on its natural
   * key.
   */
  test('every row initTargetWorkspace writes is either never streamed or merged', () => {
    const src = readFileSync(RECEIVE, 'utf8')
    const start = src.indexOf('export async function initTargetWorkspace')
    const body = src.slice(start, src.indexOf('function clientFor', start))
    const written = [...body.matchAll(/db\.(\w+)\s*\.\s*create\(/g)].map((m) =>
      m[1].charAt(0).toUpperCase() + m[1].slice(1),
    )
    // A broken regex would otherwise make this guard pass by finding nothing.
    expect(written.sort()).toEqual(['Member', 'Workspace', 'WorkspaceAgentProfile'])

    const uncovered = written.filter((model) => shouldMoveModel(model) && !mergesOnNaturalKey(model))
    expect(uncovered).toEqual([])
  })

  /**
   * The general form of the bug: `collectWorkspaceSnapshot` selects a *subset*
   * of columns for some models, and the move then inserts that subset. Any
   * required column left out of the projection makes the first chunk of that
   * model fail — and it fails at runtime, hours into a move, not in a unit test.
   *
   * So: for every model in the schema, every scalar that is required and has no
   * default must either be in the model's projection, or the model must not
   * travel at all.
   */
  test('every required column of a streamed model is in the source projection', () => {
    const schema = readFileSync(SCHEMA, 'utf8')
    const models = new Map<string, string>()
    const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g
    let m: RegExpExecArray | null
    while ((m = modelRe.exec(schema)) !== null) models.set(m[1]!, m[2]!)

    const requiredScalars = (body: string): string[] => {
      const out: string[] = []
      for (const raw of body.split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('//') || line.startsWith('///') || line.startsWith('@@')) continue
        const parts = line.split(/\s+/)
        if (parts.length < 2) continue
        const [name, type] = parts as [string, string]
        // Relations, lists and optional columns are not the failure mode here.
        if (type.endsWith('?') || type.endsWith(']')) continue
        if (/^(String|Int|Float|Boolean|DateTime|Json|BigInt|Decimal)$/.test(type) === false) continue
        if (line.includes('@default') || line.includes('@updatedAt')) continue
        out.push(name)
      }
      return out
    }

    // The projection `collectWorkspaceSnapshot` asks for, where it asks for one.
    const projections: Record<string, string[]> = {
      Workspace: ['id', 'name', 'kind'],
    }

    const offenders: string[] = []
    for (const [model, body] of models) {
      const projection = projections[model]
      if (!projection) continue // full row: nothing can be missing
      const missing = requiredScalars(body).filter((field) => !projection.includes(field))
      if (missing.length && shouldMoveModel(model)) offenders.push(`${model}: ${missing.join(', ')}`)
    }

    expect(
      offenders,
      'These models are projected with a column subset AND streamed, so the first chunk ' +
        `will fail on the missing required column(s): ${offenders.join(' | ')}. Either widen the ` +
        'projection in collectWorkspaceSnapshot or add the model to NOT_MOVED in records.ts.',
    ).toEqual([])
  })
})

// ── 2. A resume is the same job the plan was built for ─────────────────────

describe('a resumed job keeps the identity its plan was built with', () => {
  const plan = { target: { name: 'Moved', instanceSize: 'small' } }

  test('the row wins over the caller, which is what a resume does not have', () => {
    const row = { requesterId: 'admin-1', isOwner: false, ownerUserId: 'owner-1', plan }
    expect(moveJobContext(row, undefined)).toEqual({
      requesterId: 'admin-1',
      isOwner: false,
      ownerUserId: 'owner-1',
      instanceSize: 'small',
    })
  })

  test('a non-owner resume does not become an owner', () => {
    // This is the exact divergence QA reproduced: the plan excluded a DM the
    // requester could not see, and the resumed stream included it.
    const resumed = moveJobContext({ requesterId: 'admin-1', isOwner: false, ownerUserId: 'owner-1', plan })
    expect(resumed.isOwner).toBe(false)
  })

  test('the target size comes from the frozen plan, not the caller', () => {
    expect(moveJobContext({ plan }, { instanceSize: 'large' }).instanceSize).toBe('small')
  })

  test('the caller is a fallback only for rows written before the columns existed', () => {
    const legacy = { plan: { target: { name: 'Moved' } } }
    expect(moveJobContext(legacy, { requesterId: 'u-1', isOwner: false, instanceSize: 'large' })).toEqual({
      requesterId: 'u-1',
      isOwner: false,
      ownerUserId: 'u-1',
      instanceSize: 'large',
    })
  })

  test('with neither, the target still gets an owner rather than an empty string', () => {
    // The previous fallback left `ownerUserId: ''` and could create an ownerless
    // target workspace when the crash came before the first id was saved.
    const ctx = moveJobContext({ plan: { target: { name: 'Moved' } } })
    expect(ctx.ownerUserId).toBe(ctx.requesterId)
  })
})

// ── 3. The workspace root travels, and lands where it belongs ──────────────

describe('the workspace root', () => {
  const workspaceId = 'ws-root-test'

  test('the sentinel maps to .workspace-roots/<workspaceId>, not a stray directory', () => {
    expect(moveDirFor({ projectId: WORKSPACE_ROOT_ID, workspaceId, base: '/base' })).toBe(
      `/base/.workspace-roots/${workspaceId}`,
    )
  })

  test('a project id still maps to its own directory', () => {
    expect(moveDirFor({ projectId: 'proj-1', workspaceId, base: '/base' })).toBe('/base/proj-1')
  })

  test('the source manifest finds root files, and the target writes them to the root', async () => {
    const base = mkdtempSync(join(tmpdir(), 'sho246-root-'))
    try {
      const sourceRoot = moveDirFor({ projectId: WORKSPACE_ROOT_ID, workspaceId, base })
      mkdirSync(sourceRoot, { recursive: true })
      writeFileSync(join(sourceRoot, 'CLAUDE.md'), '# notes\n')
      writeFileSync(join(sourceRoot, '.shogoignore'), 'scratch/\n')

      const db = { projectFolder: { findFirst: async () => null } }
      const manifest = await sourceFileManifest(db, { workspaceId, projectId: WORKSPACE_ROOT_ID, base })
      expect(manifest.entries.map((e) => e.path).sort()).toEqual(['.shogoignore', 'CLAUDE.md'])

      // The target is a *different* workspace id, so the bytes have to be
      // written under the new one — this is what used to land in
      // `<base>/__workspace_root__` and be unreachable afterwards.
      const targetId = 'ws-root-target'
      await receiveFile(WORKSPACE_ROOT_ID, targetId, 'CLAUDE.md', new Uint8Array(Buffer.from('# notes\n')), base)

      const landed = join(base, '.workspace-roots', targetId, 'CLAUDE.md')
      expect(readFileSync(landed, 'utf8')).toBe('# notes\n')
      expect(targetFileManifest(WORKSPACE_ROOT_ID, targetId, base)).resolves.toMatchObject({
        projectId: WORKSPACE_ROOT_ID,
      })
      expect(walkMoveFiles(join(base, WORKSPACE_ROOT_ID)).then((w) => w.entries.length)).resolves.toBe(0)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
