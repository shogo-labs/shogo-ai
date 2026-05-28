// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// gateway-tools.ts — tool_install "skill:" branch coverage
// Targets L3173-3210: createToolInstallTool's bundled-skill copy path
// (mkdirSync destDir, readdirSync srcDir, cpSync for subdirs, writeFileSync
// for files). Plus the already-installed and not-found branches.

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let bundledSkills: any[] = []
let installedSkills: any[] = []

mock.module('../skills', () => ({
  loadAllSkills: (_wd: string) => installedSkills,
  loadBundledSkills: (_existing: Set<string>) => bundledSkills,
  searchSkills: () => [],
  loadSkills: () => [],
  loadSkillsFromDir: () => [],
  loadSkillRegistryManifest: () => ({ catalog: [] }),
  loadBundledClaudeCodeSkill: () => null,
  loadAllClaudeCodeSkills: () => [],
  loadClaudeCodeSkills: () => [],
  migrateFromLegacySkills: () => {},
  parseFrontmatter: (raw: string) => ({ frontmatter: {}, body: raw }),
  buildSkillsPromptSection: () => '',
  matchSkill: () => null,
}))

const { createTools } = await import('../gateway-tools')

let TEST_DIR: string
let BUNDLE_DIR: string

function freshDirs() {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'tool-install-skill-'))
  BUNDLE_DIR = mkdtempSync(join(tmpdir(), 'bundle-skill-'))
}

function makeCtx(): any {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800, heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [], model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'proj-skill-install',
    sessionId: 'sess-1',
    mainSessionIds: ['sess-1'],
    mcpClientManager: { install: async () => ({ ok: true }) },
  }
}

async function exec(ctx: any, params: Record<string, any>) {
  const tools = createTools(ctx)
  const t = tools.find((x: any) => x.name === 'tool_install')!
  const r = await t.execute('id', params)
  return r.details ?? r
}

beforeEach(() => {
  freshDirs()
  bundledSkills = []
  installedSkills = []
})
afterEach(() => {
  if (TEST_DIR && existsSync(TEST_DIR)) {
    try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
  }
  if (BUNDLE_DIR && existsSync(BUNDLE_DIR)) {
    try { rmSync(BUNDLE_DIR, { recursive: true, force: true }) } catch {}
  }
})

describe('tool_install skill: prefix', () => {
  test('bundled skill not found returns error with tool_search hint', async () => {
    const ctx = makeCtx()
    const r = await exec(ctx, { name: 'skill:nonexistent' })
    expect(String(r.error)).toContain('Bundled skill "nonexistent" not found')
    expect(String(r.error)).toContain('tool_search')
  })

  test('already-installed skill returns error with existing path', async () => {
    mkdirSync(join(TEST_DIR, '.shogo', 'skills', 'already-here'), { recursive: true })
    writeFileSync(join(TEST_DIR, '.shogo', 'skills', 'already-here', 'SKILL.md'), '# already')
    const ctx = makeCtx()
    const r = await exec(ctx, { name: 'skill:already-here' })
    expect(String(r.error)).toContain('already installed')
    expect(r.path).toBe('.shogo/skills/already-here/SKILL.md')
  })

  test('happy path: copies bundled skill files + subdirs to .shogo/skills/<name>', async () => {
    // Seed BUNDLE_DIR with a file and a subdir
    writeFileSync(join(BUNDLE_DIR, 'SKILL.md'), '# my-skill\n\nInstructions here.')
    writeFileSync(join(BUNDLE_DIR, 'helper.ts'), 'export const x = 1\n')
    mkdirSync(join(BUNDLE_DIR, 'templates'), { recursive: true })
    writeFileSync(join(BUNDLE_DIR, 'templates', 'one.txt'), 'template one')
    mkdirSync(join(BUNDLE_DIR, 'templates', 'nested'), { recursive: true })
    writeFileSync(join(BUNDLE_DIR, 'templates', 'nested', 'two.txt'), 'template two')

    bundledSkills = [{ name: 'my-skill', skillDir: BUNDLE_DIR }]

    const ctx = makeCtx()
    const r = await exec(ctx, { name: 'skill:my-skill' })
    expect(r.ok).toBe(true)
    expect(r.type).toBe('skill')
    expect(r.name).toBe('my-skill')
    expect(r.path).toBe('.shogo/skills/my-skill/SKILL.md')
    expect(String(r.message)).toContain('Skill "my-skill" installed')

    // Verify on disk: top-level file
    const destSkill = join(TEST_DIR, '.shogo', 'skills', 'my-skill')
    expect(readFileSync(join(destSkill, 'SKILL.md'), 'utf-8')).toContain('# my-skill')
    expect(readFileSync(join(destSkill, 'helper.ts'), 'utf-8')).toContain('export const x = 1')
    // Verify recursive copy of subdir + nested
    expect(readFileSync(join(destSkill, 'templates', 'one.txt'), 'utf-8')).toBe('template one')
    expect(readFileSync(join(destSkill, 'templates', 'nested', 'two.txt'), 'utf-8')).toBe('template two')
  })

  test('only file (no subdirs) skill installs cleanly', async () => {
    writeFileSync(join(BUNDLE_DIR, 'SKILL.md'), '# minimal')
    bundledSkills = [{ name: 'minimal', skillDir: BUNDLE_DIR }]
    const ctx = makeCtx()
    const r = await exec(ctx, { name: 'skill:minimal' })
    expect(r.ok).toBe(true)
    expect(readFileSync(join(TEST_DIR, '.shogo', 'skills', 'minimal', 'SKILL.md'), 'utf-8')).toBe('# minimal')
  })
})
