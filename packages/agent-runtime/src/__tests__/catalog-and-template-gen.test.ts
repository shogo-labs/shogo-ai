// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Greenfield sweep (batch 3): integration-catalog.ts, template-generator/grouper.ts,
 * template-generator/skill-reader.ts — all previously never loaded by any test.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── @shogo/shared-runtime mock for grouper.groupSkills ────────────────────────
let sendMessageJSONImpl: (prompt: string, opts: any) => Promise<any> = async () => ({
  data: { groups: [] }, usage: { inputTokens: 0, outputTokens: 0 },
})
mock.module('@shogo/shared-runtime', () => ({
  sendMessageJSON: (prompt: string, opts: any) => sendMessageJSONImpl(prompt, opts),
}))

import { INTEGRATION_CATALOG, resolveIntegrations } from '../integration-catalog'
import { groupSkills } from '../template-generator/grouper'
import { readBundledSkills } from '../template-generator/skill-reader'

// ════════════════════════════════════════════════════════════════════════════
describe('integration-catalog', () => {
  test('INTEGRATION_CATALOG is a well-formed category map', () => {
    const keys = Object.keys(INTEGRATION_CATALOG)
    expect(keys.length).toBeGreaterThan(0)
    for (const [id, cat] of Object.entries(INTEGRATION_CATALOG)) {
      expect(cat.id).toBe(id)
      expect(cat.label.length).toBeGreaterThan(0)
      expect(Array.isArray(cat.options)).toBe(true)
      expect(cat.options.length).toBeGreaterThan(0)
      for (const opt of cat.options) {
        expect(opt.toolkit.length).toBeGreaterThan(0)
        expect(opt.name.length).toBeGreaterThan(0)
      }
    }
  })

  test('resolveIntegrations maps known categories and drops unknown', () => {
    const known = Object.keys(INTEGRATION_CATALOG)[0]
    const resolved = resolveIntegrations([
      { categoryId: known, description: 'primary', required: true },
      { categoryId: '__does_not_exist__', description: 'skip me' },
    ])
    expect(resolved.length).toBe(1)
    expect(resolved[0].id).toBe(known)
    expect(resolved[0].description).toBe('primary')
    expect(resolved[0].required).toBe(true)
  })

  test('resolveIntegrations returns [] for empty/all-unknown refs', () => {
    expect(resolveIntegrations([])).toEqual([])
    expect(resolveIntegrations([{ categoryId: 'nope', description: 'x' }])).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('template-generator/grouper', () => {
  const skills = [
    { name: 'sales-crm', description: 'CRM ops', trigger: '', tools: [], content: '', contentHash: 'h1', dirPath: '/a' },
    { name: 'support-tickets', description: 'Tickets', trigger: '', tools: [], content: '', contentHash: 'h2', dirPath: '/b' },
  ]

  test('dryRun returns [] without calling the LLM', async () => {
    let called = false
    sendMessageJSONImpl = async () => { called = true; return { data: { groups: [] }, usage: {} } }
    const out = await groupSkills(skills, { dryRun: true })
    expect(out).toEqual([])
    expect(called).toBe(false)
  })

  test('valid groups pass through; unknown skill names are filtered out', async () => {
    sendMessageJSONImpl = async () => ({
      data: { groups: [
        { templateId: 'sales-ops', name: 'Sales Ops', category: 'sales', description: 'd', icon: '💼', tags: ['x'], skillNames: ['sales-crm', 'ghost-skill'] },
        { templateId: 'empty-grp', name: 'Empty', category: 'operations', description: 'd', icon: '⚙️', tags: [], skillNames: ['only-unknown'] },
      ] },
      usage: { inputTokens: 10, outputTokens: 20 },
    })
    const out = await groupSkills(skills)
    // 'ghost-skill' removed; 'empty-grp' dropped entirely (no valid skills left)
    expect(out.length).toBe(1)
    expect(out[0].templateId).toBe('sales-ops')
    expect(out[0].skillNames).toEqual(['sales-crm'])
  })

  test('all-unknown groups produce an empty result', async () => {
    sendMessageJSONImpl = async () => ({
      data: { groups: [{ templateId: 'g', name: 'G', category: 'sales', description: 'd', icon: '💼', tags: [], skillNames: ['nope'] }] },
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    expect(await groupSkills(skills)).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('template-generator/skill-reader', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'skill-reader-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function writeSkill(name: string, frontmatter: string, body = 'Body content') {
    const sd = join(dir, name)
    mkdirSync(sd, { recursive: true })
    writeFileSync(join(sd, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`)
  }

  test('returns [] when the skills dir does not exist', () => {
    expect(readBundledSkills(join(dir, 'missing'))).toEqual([])
  })

  test('reads + parses skills, tools as array and as comma string', () => {
    writeSkill('alpha', 'name: Alpha\ndescription: First skill\ntrigger: when asked\ntools: [read_file, web]')
    writeSkill('beta', 'name: Beta\ndescription: Second\ntrigger: x\ntools: exec, search , ')
    // a directory without SKILL.md is ignored
    mkdirSync(join(dir, 'no-skill-md'), { recursive: true })

    const out = readBundledSkills(dir).sort((a, b) => a.name.localeCompare(b.name))
    expect(out.map((s) => s.name)).toEqual(['Alpha', 'Beta'])
    const alpha = out[0]
    expect(alpha.description).toBe('First skill')
    expect(alpha.trigger).toBe('when asked')
    expect(alpha.tools).toEqual(['read_file', 'web'])
    expect(alpha.content.trim()).toBe('Body content')
    expect(alpha.contentHash).toMatch(/^[0-9a-f]{16}$/)
    expect(alpha.dirPath).toContain('alpha')
    // beta: tools given as comma-separated string → trimmed + filtered
    expect(out[1].tools).toEqual(['exec', 'search'])
  })

  test('falls back to dir name + empty fields when frontmatter is sparse', () => {
    writeSkill('gamma', 'description: only desc')
    const [g] = readBundledSkills(dir)
    expect(g.name).toBe('gamma') // falls back to directory name
    expect(g.trigger).toBe('')
    expect(g.tools).toEqual([])
  })

  test('default arg path resolves without throwing (bundled-skills may be absent)', () => {
    expect(Array.isArray(readBundledSkills())).toBe(true)
  })
})
