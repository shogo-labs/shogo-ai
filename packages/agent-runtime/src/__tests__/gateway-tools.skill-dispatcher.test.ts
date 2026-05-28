// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// gateway-tools.ts — `skill` tool dispatcher coverage sweep.
// Targets the ~150 uncov lines in createSkillTool (L4490-4720) by exercising
// all four actions (search, install, run_script, invoke) with their happy
// paths and error tails.

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'

const TEST_DIR = '/tmp/test-gateway-tools-skill-dispatcher'
const SKILL_DIR_SRC = '/tmp/test-gateway-tools-skill-src'
const SKILL_DIR_INSTALLED = join(TEST_DIR, '.shogo', 'skills', 'mock-skill')

// --- Toggleable mocks ----------------------------------------------------

let manifest: any[] = []
let bundledSkill: any = null
let sandboxResult: any = { exitCode: 0, stdout: '', stderr: '' }
let sandboxThrows: Error | null = null
let subagentResult: any = { toolCalls: [], iterations: 1, response: 'done' }

mock.module('../skills', () => ({
  loadSkillRegistryManifest: () => manifest,
  loadBundledClaudeCodeSkill: (_source: string, _dirName: string) => bundledSkill,
  loadAllSkills: () => [],
  loadBundledSkills: (_existing: Set<string>) => [],
  searchSkills: () => [],
  loadSkills: () => [],
  loadSkillsFromDir: () => [],
  loadAllClaudeCodeSkills: () => [],
  loadClaudeCodeSkills: () => [],
  migrateFromLegacySkills: () => {},
  parseFrontmatter: (raw: string) => ({ frontmatter: {}, body: raw }),
  buildSkillsPromptSection: () => '',
  matchSkill: () => null,
}))

mock.module('../sandbox-exec', () => ({
  sandboxExec: (_args: any) => {
    if (sandboxThrows) throw sandboxThrows
    return sandboxResult
  },
  sandboxExecAsync: () => ({}),
  shouldSandbox: () => false,
}))

mock.module('../subagent', () => ({
  runSubagent: async (_cfg: any, _content: string, _ctx: any) => subagentResult,
  getBuiltinSubagentConfig: (_type: string) => ({
    toolNames: ['read_file'],
    model: 'claude-sonnet-4-5',
  }),
  loadCustomAgents: () => [],
}))

const _gw = await import('../gateway-tools')
const createTools = _gw.createTools
const setLoadedSkills = _gw.setLoadedSkills
type ToolContext = import('../gateway-tools').ToolContext
const { trustWorkspaceForTests, clearTrustForTests } = await import('./helpers/test-trust')

function makeCtx(overrides: Partial<typeof ToolContext.prototype> = {} as any): any {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'skill-dispatcher-test',
    sessionId: 'session-1',
    mainSessionIds: ['session-1'],
    sandbox: undefined,
    ...overrides,
  }
}

function getTool(ctx: any, name: string) {
  const tools = createTools(ctx)
  const tool = tools.find((t: any) => t.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  return tool
}

async function exec(ctx: any, name: string, params: Record<string, any>) {
  const tool = getTool(ctx, name)
  const result = await tool.execute('test-call', params)
  return result.details ?? result
}

beforeAll(() => {
  trustWorkspaceForTests(TEST_DIR)
})

afterAll(() => {
  clearTrustForTests()
})

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  rmSync(SKILL_DIR_SRC, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  manifest = []
  bundledSkill = null
  sandboxResult = { exitCode: 0, stdout: '', stderr: '' }
  sandboxThrows = null
  subagentResult = { toolCalls: [], iterations: 1, response: 'done' }
  setLoadedSkills([])
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  rmSync(SKILL_DIR_SRC, { recursive: true, force: true })
  setLoadedSkills([])
})

// =============================================================================
// action='search'
// =============================================================================

describe('skill action=search', () => {
  test('empty manifest returns no-skills message', async () => {
    manifest = []
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { action: 'search' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.results).toEqual([])
    expect(parsed.message).toContain('No external skills available')
  })

  test('no query returns first 20 results with prompt to filter', async () => {
    manifest = Array.from({ length: 25 }, (_, i) => ({
      name: `skill-${i}`, description: `Description ${i}`,
      source: 'bundled', sourceDescription: 'Bundled skills',
    }))
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { action: 'search' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.total).toBe(25)
    expect(parsed.results).toHaveLength(20)
    expect(parsed.message).toContain('Provide a query')
  })

  test('with query filters by name/description/source (case-insensitive)', async () => {
    manifest = [
      { name: 'pdf-tools', description: 'Manipulate PDFs', source: 'bundled', sourceDescription: 'x' },
      { name: 'image-utils', description: 'Image processing', source: 'bundled', sourceDescription: 'x' },
      { name: 'PDFOcr', description: 'OCR for scanned files', source: 'community', sourceDescription: 'y' },
    ]
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { action: 'search', query: 'pdf' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.total).toBe(2)
    expect(parsed.results.map((s: any) => s.name).sort()).toEqual(['PDFOcr', 'pdf-tools'])
  })

  test('truncates to 20 with "Showing 20 of N" message when > 20 matches', async () => {
    manifest = Array.from({ length: 30 }, (_, i) => ({
      name: `tool-${i}`, description: 'helper tool', source: 'bundled', sourceDescription: 'x',
    }))
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { action: 'search', query: 'tool' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.total).toBe(30)
    expect(parsed.results).toHaveLength(20)
    expect(parsed.message).toContain('Showing 20 of 30')
  })
})

// =============================================================================
// action='install'
// =============================================================================

describe('skill action=install', () => {
  test('returns error when source or dir_name missing', async () => {
    const ctx = makeCtx()
    const r1 = await exec(ctx, 'skill', { action: 'install', source: 'bundled' })
    const p1 = JSON.parse(r1.content?.[0]?.text ?? r1.text ?? JSON.stringify(r1))
    expect(p1.error).toContain('source and dir_name are required')

    const r2 = await exec(ctx, 'skill', { action: 'install', dir_name: 'foo' })
    const p2 = JSON.parse(r2.content?.[0]?.text ?? r2.text ?? JSON.stringify(r2))
    expect(p2.error).toContain('source and dir_name are required')
  })

  test('returns error when bundled skill not found', async () => {
    bundledSkill = null
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { action: 'install', source: 'bundled', dir_name: 'missing' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.error).toContain('Skill "missing" not found in source "bundled"')
  })

  test('happy: copies skill dir contents to workspace .shogo/skills/<name>', async () => {
    // Create a source skill dir with a file and a subdir.
    mkdirSync(join(SKILL_DIR_SRC, 'scripts'), { recursive: true })
    writeFileSync(join(SKILL_DIR_SRC, 'SKILL.md'), '# my skill content')
    writeFileSync(join(SKILL_DIR_SRC, 'scripts', 'run.sh'), '#!/bin/sh\necho ok')

    bundledSkill = {
      name: 'mock-skill',
      description: 'A mock skill for tests',
      skillDir: SKILL_DIR_SRC,
      content: '# mock skill body',
      scripts: ['run.sh'],
    }
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { action: 'install', source: 'bundled', dir_name: 'mock-skill' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.installed).toBe('mock-skill')
    expect(parsed.source).toBe('bundled')
    expect(parsed.message).toContain('Skill "mock-skill" installed')
    // File contents should be copied
    expect(existsSync(join(SKILL_DIR_INSTALLED, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(SKILL_DIR_INSTALLED, 'scripts', 'run.sh'))).toBe(true)
  })
})

// =============================================================================
// action='run_script'
// =============================================================================

describe('skill action=run_script', () => {
  test('returns error when skill or script missing', async () => {
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { action: 'run_script', skill: 'foo' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.error).toContain('skill and script parameters are required')
  })

  test('rejects path traversal in script name', async () => {
    setLoadedSkills([{ name: 'demo', description: '', skillDir: SKILL_DIR_SRC, content: '', scripts: [] } as any])
    const ctx = makeCtx()
    const r1 = await exec(ctx, 'skill', { action: 'run_script', skill: 'demo', script: '../../etc/passwd' })
    const p1 = JSON.parse(r1.content?.[0]?.text ?? r1.text ?? JSON.stringify(r1))
    expect(p1.error).toBe('Invalid script filename.')

    const r2 = await exec(ctx, 'skill', { action: 'run_script', skill: 'demo', script: 'sub/run.sh' })
    const p2 = JSON.parse(r2.content?.[0]?.text ?? r2.text ?? JSON.stringify(r2))
    expect(p2.error).toBe('Invalid script filename.')
  })

  test('returns error when skill is not loaded', async () => {
    setLoadedSkills([])
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { action: 'run_script', skill: 'unknown', script: 'run.sh' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.error).toContain('Skill not found: unknown')
  })

  test('returns error with available list when script file missing', async () => {
    mkdirSync(SKILL_DIR_SRC, { recursive: true })
    setLoadedSkills([{
      name: 'demo', description: '', skillDir: SKILL_DIR_SRC, content: '',
      scripts: ['list.sh', 'parse.py'],
    } as any])
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { action: 'run_script', skill: 'demo', script: 'missing.sh' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.error).toContain('Script "missing.sh" not found')
    expect(parsed.available).toEqual(['list.sh', 'parse.py'])
  })

  test('happy: runs script through sandboxExec, returns truncated stdout/stderr', async () => {
    mkdirSync(join(SKILL_DIR_SRC, 'scripts'), { recursive: true })
    writeFileSync(join(SKILL_DIR_SRC, 'scripts', 'compute.py'), '# noop')
    setLoadedSkills([{
      name: 'demo', description: '', skillDir: SKILL_DIR_SRC, content: '',
      runtime: 'python3', scripts: ['compute.py'],
    } as any])
    sandboxResult = {
      exitCode: 42,
      stdout: 'a'.repeat(10000), // > 8000 → truncated
      stderr: 'b'.repeat(5000),  // > 4000 → truncated
    }
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', {
      action: 'run_script', skill: 'demo', script: 'compute.py', args: 'arg1 arg2',
    })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.skill).toBe('demo')
    expect(parsed.script).toBe('compute.py')
    expect(parsed.runtime).toBe('python3')
    expect(parsed.exitCode).toBe(42)
    expect(parsed.stdout?.length).toBe(8000)
    expect(parsed.stderr?.length).toBe(4000)
  })

  test('infers runtime from extension when found.runtime is absent', async () => {
    mkdirSync(join(SKILL_DIR_SRC, 'scripts'), { recursive: true })
    writeFileSync(join(SKILL_DIR_SRC, 'scripts', 'help.sh'), '#!/bin/sh')
    setLoadedSkills([{
      name: 'demo', description: '', skillDir: SKILL_DIR_SRC, content: '',
      scripts: ['help.sh'],
    } as any])
    sandboxResult = { exitCode: 0, stdout: 'ok', stderr: '' }
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { action: 'run_script', skill: 'demo', script: 'help.sh' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.runtime).toBeTruthy()
    expect(parsed.exitCode).toBe(0)
  })

  test('returns sanitized error when sandboxExec throws', async () => {
    mkdirSync(join(SKILL_DIR_SRC, 'scripts'), { recursive: true })
    writeFileSync(join(SKILL_DIR_SRC, 'scripts', 'fail.sh'), 'exit 1')
    setLoadedSkills([{
      name: 'demo', description: '', skillDir: SKILL_DIR_SRC, content: '',
      runtime: 'bash', scripts: ['fail.sh'],
    } as any])
    sandboxThrows = new Error('sandbox boom')
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { action: 'run_script', skill: 'demo', script: 'fail.sh' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.error).toContain('Script execution failed: sandbox boom')
  })
})

// =============================================================================
// action='invoke' (default)
// =============================================================================

describe('skill action=invoke (default)', () => {
  test('returns error when skill name is missing', async () => {
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { action: 'invoke' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.error).toBe('skill name is required for invoke action.')
  })

  test('returns error with available list when skill not found', async () => {
    setLoadedSkills([
      { name: 'helper-a', description: '', skillDir: SKILL_DIR_SRC, content: '' } as any,
      { name: 'helper-b', description: '', skillDir: SKILL_DIR_SRC, content: '' } as any,
    ])
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { skill: 'unknown' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.error).toContain('Skill not found: unknown')
    expect(parsed.error).toContain('helper-a, helper-b')
  })

  test('runs setup script on first invoke and writes .setup-done marker', async () => {
    mkdirSync(SKILL_DIR_SRC, { recursive: true })
    setLoadedSkills([{
      name: 'with-setup', description: '', skillDir: SKILL_DIR_SRC,
      content: 'Hello world',
      setup: 'echo setup',
    } as any])
    sandboxResult = { exitCode: 0, stdout: '', stderr: '' }
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { skill: 'with-setup' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.skill).toBe('with-setup')
    expect(parsed.mode).toBe('inline')
    expect(existsSync(join(SKILL_DIR_SRC, '.setup-done'))).toBe(true)
  })

  test('swallows setup failure (sandboxExec throws) — setup is best-effort', async () => {
    mkdirSync(SKILL_DIR_SRC, { recursive: true })
    setLoadedSkills([{
      name: 'flaky-setup', description: '', skillDir: SKILL_DIR_SRC,
      content: 'Hello', setup: 'bad-cmd',
    } as any])
    sandboxThrows = new Error('setup boom')
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { skill: 'flaky-setup' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.skill).toBe('flaky-setup')
    expect(parsed.mode).toBe('inline')
    // .setup-done NOT written because exitCode wasn't 0
    expect(existsSync(join(SKILL_DIR_SRC, '.setup-done'))).toBe(false)
  })

  test('skips setup when .setup-done already exists', async () => {
    mkdirSync(SKILL_DIR_SRC, { recursive: true })
    writeFileSync(join(SKILL_DIR_SRC, '.setup-done'), '2026-01-01', 'utf-8')
    setLoadedSkills([{
      name: 'already-set-up', description: '', skillDir: SKILL_DIR_SRC,
      content: 'Hello', setup: 'should-not-run',
    } as any])
    sandboxThrows = new Error('should not be called')
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { skill: 'already-set-up' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.skill).toBe('already-set-up')
    // sandboxThrows should not have fired; no error in result
    expect(parsed.error).toBeUndefined()
  })

  test('substitutes $ARGUMENTS[i], $i, and $ARGUMENTS in content when args provided', async () => {
    setLoadedSkills([{
      name: 'argf', description: '', skillDir: SKILL_DIR_SRC,
      content: 'first=$ARGUMENTS[0] second=$ARGUMENTS[1] all=$ARGUMENTS combo=$1+$2',
    } as any])
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { skill: 'argf', args: 'alpha beta gamma' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.content).toContain('first=alpha')
    expect(parsed.content).toContain('second=beta')
    expect(parsed.content).toContain('all=alpha beta gamma')
    expect(parsed.content).toContain("combo=beta+gamma")
  })

  test('clears $ARGUMENTS placeholders when no args provided', async () => {
    setLoadedSkills([{
      name: 'noargf', description: '', skillDir: SKILL_DIR_SRC,
      content: 'first=$ARGUMENTS[0] all=$ARGUMENTS extra=$3',
    } as any])
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { skill: 'noargf' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.content).toBe('first= all= extra=')
  })

  test('substitutes ${CLAUDE_SKILL_DIR} and ${SKILL_DIR} with skill path', async () => {
    setLoadedSkills([{
      name: 'pathf', description: '', skillDir: SKILL_DIR_SRC,
      content: 'cd ${CLAUDE_SKILL_DIR} && ls ${SKILL_DIR}',
    } as any])
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { skill: 'pathf' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.content).toContain(SKILL_DIR_SRC)
    expect(parsed.content).not.toContain('${SKILL_DIR}')
  })

  test('runs in subagent when context=fork', async () => {
    setLoadedSkills([{
      name: 'fork-skill', description: 'Forked', skillDir: SKILL_DIR_SRC,
      content: 'do stuff',
      context: 'fork',
      agent: 'general-purpose',
    } as any])
    subagentResult = { toolCalls: [{ name: 'read_file' }], iterations: 3, response: 'sub-done' }
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { skill: 'fork-skill' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.skill).toBe('fork-skill')
    expect(parsed.mode).toBe('fork')
    expect(parsed.agent).toBe('general-purpose')
    expect(parsed.iterations).toBe(3)
    expect(parsed.toolCalls).toEqual([{ name: 'read_file' }])
  })

  test('inline mode returns content + instruction (default when no context=fork)', async () => {
    setLoadedSkills([{
      name: 'inline-skill', description: '', skillDir: SKILL_DIR_SRC,
      content: 'do the thing',
    } as any])
    const ctx = makeCtx()
    const res = await exec(ctx, 'skill', { skill: 'inline-skill' })
    const parsed = JSON.parse(res.content?.[0]?.text ?? res.text ?? JSON.stringify(res))
    expect(parsed.skill).toBe('inline-skill')
    expect(parsed.mode).toBe('inline')
    expect(parsed.content).toBe('do the thing')
    expect(parsed.instruction).toContain('Follow the skill instructions')
  })
})
