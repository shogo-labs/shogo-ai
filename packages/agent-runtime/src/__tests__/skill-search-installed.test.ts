// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-57 — `skill({ action: "search" })` must find the skills installed in the
// workspace. The registry manifest (`bundled-claude-skills/manifest.json`) is
// fetched at Docker build time and does not exist in a source checkout, so the
// pre-fix search answered "No external skills available in the registry." even
// with 117 skills installed. These tests run against the real `./skills` module
// (no mock) so the absent manifest is the real one.

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

const TEST_DIR = '/tmp/test-skill-search-installed'

mock.module('../sandbox-exec', () => ({
  sandboxExec: () => ({ exitCode: 0, stdout: '', stderr: '' }),
  sandboxExecAsync: () => ({}),
  shouldSandbox: () => false,
}))

const _gw = await import('../gateway-tools')
const createTools = _gw.createTools
const setLoadedSkills = _gw.setLoadedSkills
const { loadSkillRegistryManifest } = await import('../skills')
const { trustWorkspaceForTests, clearTrustForTests } = await import('./helpers/test-trust')

function makeSkill(name: string, description: string, overrides: Record<string, any> = {}): any {
  return {
    name,
    description,
    content: `# ${name}\n\nBody for ${name}.`,
    skillDir: join(TEST_DIR, '.shogo', 'skills', name),
    disableModelInvocation: false,
    userInvocable: true,
    ...overrides,
  }
}

const INSTALLED = [
  makeSkill('acf-fields', 'Advanced Custom Fields reference for WordPress theming'),
  makeSkill('pdf-tools', 'Extract, split and merge PDF documents'),
  makeSkill('release-notes', 'Write release notes from merged pull requests'),
]

function makeCtx(): any {
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
    projectId: 'skill-search-installed-test',
    sessionId: 'session-1',
    mainSessionIds: ['session-1'],
    sandbox: undefined,
  }
}

async function skillTool() {
  const tools = createTools(makeCtx())
  const tool = tools.find((t: any) => t.name === 'skill')
  if (!tool) throw new Error('skill tool not found')
  return tool
}

async function callSkill(params: Record<string, any>): Promise<any> {
  const tool = await skillTool()
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
  mkdirSync(join(TEST_DIR, '.shogo', 'skills'), { recursive: true })
  setLoadedSkills(INSTALLED)
})

afterEach(() => {
  setLoadedSkills([])
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('skill action=search finds installed skills (SHO-57)', () => {
  test('a source checkout has no registry manifest — the installed list is the whole story', () => {
    expect(loadSkillRegistryManifest()).toEqual([])
  })

  test('a query matching an installed skill returns it, marked installed with an invoke hint', async () => {
    const res = await callSkill({ action: 'search', query: 'acf' })

    expect(res.results.length).toBeGreaterThan(0)
    const first = res.results[0]
    expect(first.name).toBe('acf-fields')
    expect(first.installed).toBe(true)
    expect(first.source).toBe('installed')
    expect(first.action).toBe('invoke')
    expect(res.message).not.toContain('No external skills available')
  })

  test('installed matches come before registry entries', async () => {
    // The registry manifest is a build artifact; synthesise one for this test.
    const registryDir = join(import.meta.dir, '..', 'bundled-claude-skills')
    const manifestPath = join(registryDir, 'manifest.json')
    const preexisting = existsSync(manifestPath)
    if (!preexisting) {
      mkdirSync(registryDir, { recursive: true })
      writeFileSync(
        manifestPath,
        JSON.stringify([
          { name: 'pdf-registry-kit', description: 'PDF helper from the external registry', source: 'bundled', sourceDescription: 'Bundled', dirName: 'pdf-registry-kit' },
        ]),
      )
    }
    try {
      const res = await callSkill({ action: 'search', query: 'pdf' })
      expect(res.results.length).toBeGreaterThan(0)
      expect(res.results[0].name).toBe('pdf-tools')
      expect(res.results[0].installed).toBe(true)
      expect(res.results[0].source).toBe('installed')
      const registryRow = res.results.find((r: any) => r.sourceType === 'registry')
      if (registryRow) {
        expect(res.results.indexOf(registryRow)).toBeGreaterThan(0)
        expect(registryRow.action).toBe('install')
        expect(registryRow.dir_name).toBe('pdf-registry-kit')
      }
    } finally {
      if (!preexisting) rmSync(registryDir, { recursive: true, force: true })
    }
  })

  test('no query lists the installed index with a count, not a registry-only answer', async () => {
    const res = await callSkill({ action: 'search' })

    expect(res.total).toBe(3)
    expect(res.results.map((r: any) => r.name).sort()).toEqual(['acf-fields', 'pdf-tools', 'release-notes'])
    expect(res.message).toContain('3 installed')
    expect(res.message).not.toContain('No external skills available')
  })

  test('a query with no match says how many installed skills were searched', async () => {
    const res = await callSkill({ action: 'search', query: 'kubernetes-operator' })

    expect(res.results).toEqual([])
    expect(res.message).toContain('3 installed skills')
    expect(res.message).not.toContain('No external skills available')
  })

  test('a near-miss invoke points at a search that can find installed skills', async () => {
    const res = await callSkill({ action: 'invoke', skill: 'acf-field' })

    expect(res.error).toContain('Skill not found')
    expect(res.hint).toContain('installed')
    expect(res.hint).not.toContain('find and install new skills')
  })

  test('disableModelInvocation skills are listed but never suggested as invocable', async () => {
    setLoadedSkills([
      makeSkill('secret-runbook', 'Internal runbook for on-call', { disableModelInvocation: true }),
      makeSkill('release-notes', 'Write release notes from merged pull requests'),
    ])

    const res = await callSkill({ action: 'search', query: 'runbook' })
    const hit = res.results.find((r: any) => r.name === 'secret-runbook')

    expect(hit).toBeDefined()
    expect(hit.installed).toBe(true)
    expect(hit.action).not.toBe('invoke')
    expect(hit.message ?? hit.note ?? '').not.toContain('action: "invoke"')
  })

  test('the skill tool description says the listed skills are installed and invocable', async () => {
    const tool = await skillTool()
    const description: string = tool.description

    expect(description.toLowerCase()).toContain('installed')
    expect(description).toContain('invoke')
    expect(description).toContain('Available Skills')
    expect(description).not.toMatch(/search[^.]*registry only/i)
  })
})
