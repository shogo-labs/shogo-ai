// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The template copy filter must skip `node_modules` and `.git` *directories*
 * only. The previous substring test (`src.includes('.git')`) also dropped
 * `.gitignore`, which is how every desktop project seeded by 1.14.x ended up
 * committing node_modules on its first open.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

mock.module('../runtime/build-project-env', () => ({
  buildProjectEnv: async () => ({}),
}))
mock.module('../runtime', () => ({
  getRuntimeManager: () => ({
    prepareWarmWorkspace: async () => null,
    prepareProjectWorkspace: async () => '/tmp/none',
  }),
}))

const { isTemplateCopyExcluded, ensureWorkspaceGitignore } = await import('../runtime/manager')
const { HostWarmPoolController, hostPoolScratchRoot } = await import('../host-warm-pool-controller')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('isTemplateCopyExcluded', () => {
  test('skips node_modules and .git directories at any depth', () => {
    expect(isTemplateCopyExcluded('C:\\t\\node_modules')).toBe(true)
    expect(isTemplateCopyExcluded('C:\\t\\node_modules\\react\\index.js')).toBe(true)
    expect(isTemplateCopyExcluded('/t/.git')).toBe(true)
    expect(isTemplateCopyExcluded('/t/.git/HEAD')).toBe(true)
    expect(isTemplateCopyExcluded('/t/src/lib/node_modules/x.js')).toBe(true)
  })

  test('keeps dotfiles and names that merely contain the skipped words', () => {
    expect(isTemplateCopyExcluded('C:\\t\\.gitignore')).toBe(false)
    expect(isTemplateCopyExcluded('/t/.gitattributes')).toBe(false)
    expect(isTemplateCopyExcluded('/t/.github/workflows/ci.yml')).toBe(false)
    expect(isTemplateCopyExcluded('/t/src/node_modules_shim.ts')).toBe(false)
    expect(isTemplateCopyExcluded('/t/package.json')).toBe(false)
  })
})

describe('ensureWorkspaceGitignore', () => {
  test('copies the first template .gitignore into a workspace that lacks one', () => {
    const root = mkdtempSync(join(tmpdir(), 'shogo-gi-'))
    dirs.push(root)
    const template = join(root, 'template')
    const project = join(root, 'project')
    mkdirSync(template)
    mkdirSync(project)
    writeFileSync(join(template, '.gitignore'), 'node_modules\n')

    expect(ensureWorkspaceGitignore(project, [join(root, 'missing'), template])).toBe(true)
    expect(readFileSync(join(project, '.gitignore'), 'utf8')).toBe('node_modules\n')
    // Idempotent: an existing ignore file is never overwritten.
    writeFileSync(join(project, '.gitignore'), 'custom\n')
    expect(ensureWorkspaceGitignore(project, [template])).toBe(false)
    expect(readFileSync(join(project, '.gitignore'), 'utf8')).toBe('custom\n')
  })
})

describe('host pool runtime spawn env', () => {
  test('points idle pool runtimes at a private scratch workspace and skips the pod pre-seed', () => {
    const prevEntry = process.env.AGENT_RUNTIME_ENTRY
    const prevWs = process.env.WORKSPACES_DIR
    const root = mkdtempSync(join(tmpdir(), 'shogo-pool-'))
    dirs.push(root)
    process.env.AGENT_RUNTIME_ENTRY = '/opt/agent-runtime.js'
    process.env.WORKSPACES_DIR = root
    try {
      const controller = new HostWarmPoolController(1, 1)
      const { env } = (controller as any).buildSpawn(38300, 'host-test-1')
      expect(env.PROJECT_ID).toBe('__POOL__')
      expect(env.SHOGO_POOL_SKIP_PRESEED).toBe('1')
      expect(env.WORKSPACE_DIR).toBe(join(hostPoolScratchRoot(), 'host-test-1'))
      expect(env.PROJECT_DIR).toBe(env.WORKSPACE_DIR)
      expect(env.WORKSPACE_DIR.startsWith(join(root, '.pool'))).toBe(true)
      expect(existsSync(env.WORKSPACE_DIR)).toBe(true)
      // Never the container default that resolves to a shared C:\app\workspace.
      expect(env.WORKSPACE_DIR).not.toBe('/app/workspace')
    } finally {
      if (prevEntry === undefined) delete process.env.AGENT_RUNTIME_ENTRY
      else process.env.AGENT_RUNTIME_ENTRY = prevEntry
      if (prevWs === undefined) delete process.env.WORKSPACES_DIR
      else process.env.WORKSPACES_DIR = prevWs
    }
  })
})
