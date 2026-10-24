// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A workspace runtime's root is a meta-agent sandbox, not an app: nothing but
 * the workspace-level files belong there, so AGENTS.md and WORKSPACE.md must
 * send "build me an app" through `project_create` instead of `src/App.tsx`
 * (SHO-194).
 *
 * Run: bun test packages/agent-runtime/src/__tests__/workspace-root-defaults.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_WORKSPACE_FILES,
  PROJECT_AGENTS_MD,
  WORKSPACE_RUNTIME_AGENTS_MD,
  getRuntimeTemplatePath,
  seedPersonalCompanionTemplate,
  seedWorkspaceDefaults,
  seedWorkspaceRuntimeDefaults,
} from '../workspace-defaults'
import { initWorkspaceMembers } from '../workspace-members'

const RULE = 'project_create'

function templateAgentsMd(): string {
  const templatePath = getRuntimeTemplatePath()
  if (!templatePath) throw new Error('runtime-template not found — this suite needs the checked-in template')
  return readFileSync(join(templatePath, 'AGENTS.md'), 'utf-8')
}

/**
 * The order a cloud warm-pool pre-seed runs in: `seedWorkspaceDefaults` first,
 * then `seedRuntimeTemplate` copies over it — and AGENTS.md is not in
 * `RUNTIME_TEMPLATE_SKIP`, so the root file ends up the template's own document.
 */
function seedAsPoolPreseed(target: string): void {
  seedWorkspaceDefaults(target)
  const templatePath = getRuntimeTemplatePath()
  if (!templatePath) throw new Error('runtime-template not found')
  cpSync(join(templatePath, 'AGENTS.md'), join(target, 'AGENTS.md'))
}

let dir: string
let saved: Record<string, string | undefined>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shogo-workspace-root-'))
  saved = {
    WORKSPACE_RUNTIME: process.env.WORKSPACE_RUNTIME,
    WORKSPACE_ID: process.env.WORKSPACE_ID,
    WORKSPACE_DIR: process.env.WORKSPACE_DIR,
    WORKSPACE_PROJECT_IDS: process.env.WORKSPACE_PROJECT_IDS,
    WORKSPACE_AVAILABLE_PROJECTS: process.env.WORKSPACE_AVAILABLE_PROJECTS,
    SHOGO_RUNTIME_SUBSTRATE: process.env.SHOGO_RUNTIME_SUBSTRATE,
  }
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('workspace-runtime AGENTS.md', () => {
  test('replaces the project App Development section and nothing else', () => {
    expect(WORKSPACE_RUNTIME_AGENTS_MD).not.toBe(PROJECT_AGENTS_MD)
    expect(WORKSPACE_RUNTIME_AGENTS_MD).toContain(RULE)
    expect(WORKSPACE_RUNTIME_AGENTS_MD).toContain('project_call')
    expect(WORKSPACE_RUNTIME_AGENTS_MD).not.toContain('Edit src/App.tsx for the main UI')
    // Everything outside the section stays identical.
    expect(WORKSPACE_RUNTIME_AGENTS_MD).toContain('# Identity')
    expect(WORKSPACE_RUNTIME_AGENTS_MD).toContain('## Priorities')
    expect(WORKSPACE_RUNTIME_AGENTS_MD).toContain('Use memory tools to persist important facts the user shares')
    expect(PROJECT_AGENTS_MD).toContain('Edit src/App.tsx for the main UI')
  })

  test('a workspace runtime is seeded with the workspace AGENTS.md', () => {
    seedWorkspaceRuntimeDefaults(dir)
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf-8')
    expect(agents).toBe(WORKSPACE_RUNTIME_AGENTS_MD)
    expect(agents).toContain(RULE)
    // The other defaults are untouched.
    expect(readFileSync(join(dir, 'TOOLS.md'), 'utf-8')).toBe(DEFAULT_WORKSPACE_FILES['TOOLS.md'])
    expect(existsSync(join(dir, 'memory'))).toBe(true)
  })

  test('upgrades a pristine project default', () => {
    writeFileSync(join(dir, 'AGENTS.md'), PROJECT_AGENTS_MD)
    seedWorkspaceRuntimeDefaults(dir)
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toBe(WORKSPACE_RUNTIME_AGENTS_MD)
  })

  test('leaves an edited AGENTS.md alone', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# My agent\n\nBe terse.\n')
    seedWorkspaceRuntimeDefaults(dir)
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toBe('# My agent\n\nBe terse.\n')
  })

  test('a single-project workspace still gets the project default', () => {
    seedWorkspaceDefaults(dir)
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toBe(PROJECT_AGENTS_MD)
  })

  /**
   * The cloud warm pool never reaches `seedRuntimeTemplate`'s skip list for
   * AGENTS.md: `ensureWorkspaceFiles` seeds the project default and the template
   * copy lands on top of it, so the root file is the template's own document.
   */
  test("upgrades the runtime template's AGENTS.md a pool pre-seed left at the root", () => {
    seedAsPoolPreseed(dir)
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toBe(templateAgentsMd())

    seedWorkspaceRuntimeDefaults(dir)
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf-8')
    expect(agents).toContain(RULE)
    expect(agents).toContain('project_call')
    expect(agents).not.toContain('The workspace is a standard Vite + React')
    expect(agents).not.toContain('Edit src/App.tsx for the main UI')
    // Only the App Development section changes; the template's own sections stay.
    expect(agents).toContain('## Testing')
    expect(agents).toContain('## Custom server code that must survive regeneration')
  })

  test('upgrading a pool-booted root twice changes nothing', () => {
    seedAsPoolPreseed(dir)
    seedWorkspaceRuntimeDefaults(dir)
    const once = readFileSync(join(dir, 'AGENTS.md'), 'utf-8')
    seedWorkspaceRuntimeDefaults(dir)
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toBe(once)
  })

  test("leaves an edited runtime-template AGENTS.md alone", () => {
    seedAsPoolPreseed(dir)
    const edited = `${templateAgentsMd()}\n- Never touch production.\n`
    writeFileSync(join(dir, 'AGENTS.md'), edited)
    seedWorkspaceRuntimeDefaults(dir)
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toBe(edited)
  })
})

describe('personal companion on a pool-booted root', () => {
  test("replaces the runtime template's AGENTS.md with the companion persona", () => {
    seedAsPoolPreseed(dir)
    expect(seedPersonalCompanionTemplate(dir)).toBe(true)
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf-8')
    expect(agents).toContain('# Personal Companion')
    expect(agents).not.toContain('Edit src/App.tsx for the main UI')
  })

  test('replaces the workspace-runtime upgrade too, in the boot order server.ts uses', () => {
    seedAsPoolPreseed(dir)
    seedWorkspaceRuntimeDefaults(dir)
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toContain(RULE)
    expect(seedPersonalCompanionTemplate(dir)).toBe(true)
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toContain('# Personal Companion')
  })
})

describe('WORKSPACE.md', () => {
  function writeManifestAs(opts: { metal: boolean }): string {
    process.env.WORKSPACE_RUNTIME = 'true'
    process.env.WORKSPACE_ID = 'ws-test'
    process.env.WORKSPACE_DIR = dir
    process.env.WORKSPACE_PROJECT_IDS = ''
    process.env.WORKSPACE_AVAILABLE_PROJECTS = '[]'
    if (opts.metal) process.env.SHOGO_RUNTIME_SUBSTRATE = 'metal'
    else delete process.env.SHOGO_RUNTIME_SUBSTRATE
    initWorkspaceMembers()
    return readFileSync(join(dir, 'WORKSPACE.md'), 'utf-8')
  }

  test('carries the project_create rule on a metal runtime', () => {
    const manifest = writeManifestAs({ metal: true })
    expect(manifest).toContain(RULE)
    expect(manifest).toContain('never scaffold `package.json`, `src/` or `prisma/` in this root')
  })

  test('carries the project_create rule on a non-metal runtime', () => {
    const manifest = writeManifestAs({ metal: false })
    expect(manifest).toContain(RULE)
    expect(manifest).toContain('never scaffold `package.json`, `src/` or `prisma/` in this root')
  })
})
