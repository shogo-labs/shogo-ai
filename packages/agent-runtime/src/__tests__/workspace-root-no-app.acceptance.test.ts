// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Acceptance coverage for the incident in SHO-194: a workspace chat with no
 * project attached was asked to build a portfolio site and built it in the
 * workspace runtime's own root. Two things had to be true for that:
 *
 *   1. the root already held the runtime template (a reused pool root, so the
 *      pre-seed manifest listed nothing and the assign-time cleanup was a
 *      no-op), and
 *   2. the root's AGENTS.md still called the root a Vite app and said "Edit
 *      src/App.tsx for the main UI".
 *
 * This spec replays the real pool boot -> assign sequence with the real runtime
 * template from `templates/runtime-template` (its `src/App.tsx` is the "Project
 * Ready" page the staging agent read) instead of a hand-written fixture.
 *
 * Run: bun test packages/agent-runtime/src/__tests__/workspace-root-no-app.acceptance.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discardPoolPreseedAtAssign,
  writePoolPreseedManifest,
} from '../workspace-pool-adopt'
import {
  seedPersonalCompanionTemplate,
  seedRuntimeTemplate,
  seedWorkspaceDefaults,
  seedWorkspaceRuntimeDefaults,
} from '../workspace-defaults'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const TEMPLATE_DIR = realpathSync(join(REPO_ROOT, 'templates', 'runtime-template'))
const PROJECT_ID = '4b0f6f30-9d2c-4f0e-9a51-6d39a7b7c111'

let tmp: string
let root: string
let savedTemplateEnv: string | undefined

function write(path: string, content = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

/**
 * The unassigned VM's own seeding pass, in the order `ensureWorkspaceFiles()`
 * runs it while `IS_WORKSPACE_RUNTIME` is still false: the workspace defaults
 * first, then the Vite runtime template copied over them.
 */
function poolBoot(): void {
  seedWorkspaceDefaults(root)
  seedRuntimeTemplate(root)
  write(join(root, '.shogo', 'install-marker'), 'sha256-of-package-json')
  write(join(root, 'node_modules', '.bin', 'vite'), 'vite')
  write(join(root, 'prisma', 'dev.db'), 'sqlite')
}

/** The pool's manifest write, which happens in the pre-seed's `finally`. */
function writeManifest(): void {
  writePoolPreseedManifest(root, { techStackId: 'react-app', distBuilt: false, exclude: [PROJECT_ID] })
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'shogo-qa194-'))
  root = join(tmp, 'workspace')
  mkdirSync(root, { recursive: true })
  savedTemplateEnv = process.env.RUNTIME_TEMPLATE_DIR
  process.env.RUNTIME_TEMPLATE_DIR = TEMPLATE_DIR
})

afterEach(() => {
  if (savedTemplateEnv === undefined) delete process.env.RUNTIME_TEMPLATE_DIR
  else process.env.RUNTIME_TEMPLATE_DIR = savedTemplateEnv
  rmSync(tmp, { recursive: true, force: true })
})

describe('SHO-194: a workspace root that booted from the warm pool', () => {
  test('boots with the runtime template in its root, as staging did', () => {
    poolBoot()

    // The exact file the staging agent read on its first `read_file`.
    expect(readFileSync(join(root, 'src', 'App.tsx'), 'utf-8')).toContain('Project Ready')
    expect(existsSync(join(root, 'package.json'))).toBe(true)
    expect(existsSync(join(root, '.shogo', 'install-marker'))).toBe(true)
  })

  test('the pool boot leaves the template AGENTS.md, not the workspace default', () => {
    // Cause 2 of the card: whatever landed here is what the agent read.
    poolBoot()
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toBe(
      readFileSync(join(TEMPLATE_DIR, 'AGENTS.md'), 'utf-8'),
    )
  })

  test('assign leaves no app in the root and keeps everything that is not the pool\'s', () => {
    poolBoot()
    // A project folder the assign attaches while the pre-seed is still running:
    // the pool is told about it through `exclude`.
    mkdirSync(join(root, PROJECT_ID, 'src'), { recursive: true })
    write(join(root, PROJECT_ID, 'package.json'), '{"name":"the users project"}')
    writeManifest()
    // Workspace files that only exist once the workspace itself is live.
    write(join(root, 'files', 'upload.png'), 'bytes')

    // ---- assign: the workspace runtime takes the root over ----
    seedWorkspaceRuntimeDefaults(root)
    const result = discardPoolPreseedAtAssign(root, { bootedFromPool: true })

    // (c) no package.json, src/ or node_modules at the root.
    for (const gone of ['package.json', 'src', 'node_modules', 'prisma', 'dist', 'server.tsx', 'index.html', 'vite.config.ts']) {
      expect(existsSync(join(root, gone))).toBe(false)
    }

    for (const kept of ['.shogo', 'memory', 'files', 'AGENTS.md', PROJECT_ID]) {
      expect(existsSync(join(root, kept))).toBe(true)
    }
    expect(readFileSync(join(root, PROJECT_ID, 'package.json'), 'utf-8')).toBe('{"name":"the users project"}')

    // The cleanup is reported, so a staging run can be read back from the log.
    expect(result.source).toBe('manifest')
    expect(result.removed).toContain('src')
  })

  test('the root app is removed even with no manifest (the silent no-op)', () => {
    poolBoot()
    writeManifest()
    rmSync(join(root, '.shogo', 'pool-preseed.json'), { force: true })

    const result = discardPoolPreseedAtAssign(root, { bootedFromPool: true })

    expect(result.source).toBe('template')
    expect(existsSync(join(root, 'src'))).toBe(false)
    expect(existsSync(join(root, 'package.json'))).toBe(false)
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true)
  })

  test('the root AGENTS.md after assign names project_create, not src/App.tsx', () => {
    // (a) the instructions the agent reads on the first turn after assign.
    poolBoot()
    writeManifest()
    seedWorkspaceRuntimeDefaults(root)
    discardPoolPreseedAtAssign(root, { bootedFromPool: true })

    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf-8')
    expect(agents).toContain('project_create')
    expect(agents).toContain('project_call')
    expect(agents).not.toContain('Edit src/App.tsx for the main UI')
  })

  test('a personal workspace gets the companion AGENTS.md over the pool copy', () => {
    poolBoot()
    writeManifest()
    seedWorkspaceRuntimeDefaults(root)
    seedPersonalCompanionTemplate(root)
    discardPoolPreseedAtAssign(root, { bootedFromPool: true })

    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf-8')
    expect(agents).toContain('project_create')
    expect(agents).not.toContain('Edit src/App.tsx for the main UI')
  })

  test('a workspace root that boots already assigned (resume) deletes nothing', () => {
    poolBoot()
    writeManifest()
    // The user's portfolio, built in the root the way session 545d935e did.
    write(join(root, 'portfolio', 'index.html'), '<h1>my portfolio</h1>')

    const result = discardPoolPreseedAtAssign(root, { bootedFromPool: false })

    expect(result).toEqual({ source: 'none', removed: [], why: 'resumed-runtime' })
    expect(readFileSync(join(root, 'portfolio', 'index.html'), 'utf-8')).toBe('<h1>my portfolio</h1>')
    expect(existsSync(join(root, 'src', 'App.tsx'))).toBe(true)
  })
})
