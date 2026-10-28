// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The pack catalogue is data: 13 packs, each a valid `shogo-system.yaml` plus
 * questions the install wizard can render. These tests keep a typo in a
 * channel name, an unanswered prompt or a stale generated file from reaching a
 * listing.
 */
import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listPackTemplates, renderAllPackFiles, getPackTemplate } from '../pack-templates'
import { applyAnswersToManifest, parseSystemManifest, renderProfileSection, resolveScheduleValues } from '../system-manifest'

const TEMPLATES_DIR = join(import.meta.dir, '..', '..', 'templates')

describe('pack templates', () => {
  const packs = listPackTemplates()

  test('the catalogue has 13 packs with unique ids', () => {
    expect(packs).toHaveLength(13)
    expect(new Set(packs.map((p) => p.id)).size).toBe(13)
    expect(getPackTemplate('self-evolving')?.name).toBe('Self Evolving')
    expect(getPackTemplate('department-engineering')).toBeTruthy()
  })

  test('every pack parses as a manifest with schedules and setup', () => {
    for (const pack of packs) {
      const parsed = parseSystemManifest(pack.manifest)
      expect({ id: pack.id, errors: parsed.errors }).toEqual({ id: pack.id, errors: [] })
      expect(parsed.manifest!.setup?.questions.length).toBeGreaterThan(0)
      expect(parsed.manifest!.projects.length).toBeGreaterThan(0)
      expect(parsed.manifest!.teamChannels.length).toBeGreaterThan(0)
    }
  })

  test('every question is answerable and lands in a file or the profile', () => {
    for (const pack of packs) {
      const manifest = parseSystemManifest(pack.manifest).manifest!
      const bodies = manifest.projects.flatMap((p) => Object.values(p.files)).join('\n')
      const prompts = [...manifest.schedules.map((s) => s.prompt), ...manifest.triggers.map((t) => t.prompt ?? '')].join('\n')
      for (const q of manifest.setup!.questions) {
        const path = q.applies ?? `profile.${q.id}`
        const token = `{{answers.${path}}}`
        expect({ id: pack.id, question: q.id, answered: bodies.includes(token) || prompts.includes(token) }).toEqual({
          id: pack.id,
          question: q.id,
          answered: true,
        })
        if (q.type === 'choice' || q.type === 'multi') expect(q.options?.length ?? 0).toBeGreaterThan(0)
      }
    }
  })

  test('channel, project and agent references stay inside their own pack', () => {
    for (const pack of packs) {
      const manifest = parseSystemManifest(pack.manifest).manifest!
      const projectKeys = new Set(manifest.projects.map((p) => p.key))
      const channels = new Set(manifest.teamChannels.map((c) => c.name))
      for (const ch of manifest.teamChannels) {
        for (const m of ch.members) if ('project' in m) expect(projectKeys.has(m.project)).toBe(true)
        for (const b of ch.boards) {
          for (const c of b.columns ?? []) if (c.agent && c.agent !== 'workspace') expect(projectKeys.has(c.agent)).toBe(true)
          if (b.defaultAgent && b.defaultAgent !== 'workspace') expect(projectKeys.has(b.defaultAgent)).toBe(true)
        }
      }
      for (const s of manifest.schedules) {
        if (s.project) expect(projectKeys.has(s.project)).toBe(true)
        if (s.channel) expect(channels.has(s.channel)).toBe(true)
        for (const token of s.prompt.matchAll(/\{\{agent\.([a-z0-9-]+)\}\}/g)) expect(projectKeys.has(token[1])).toBe(true)
        for (const token of s.prompt.matchAll(/\{\{channel\.([a-z0-9_-]+)\}\}/g)) expect(channels.has(token[1])).toBe(true)
      }
      for (const t of manifest.triggers) {
        if (t.project) expect(projectKeys.has(t.project)).toBe(true)
        if (t.notify) expect(channels.has(t.notify)).toBe(true)
      }
    }
  })

  test('specialist packs ship their schedules disabled except the self-evolving daily run', () => {
    for (const pack of packs) {
      for (const s of parseSystemManifest(pack.manifest).manifest!.schedules) {
        const enabledByDefault = pack.id === 'self-evolving'
        expect({ pack: pack.id, schedule: s.key, enabled: s.enabled }).toEqual({ pack: pack.id, schedule: s.key, enabled: enabledByDefault })
      }
    }
  })

  test('every answer reaches the profile as the answer, never as its default', () => {
    const answerFor = (q: { id: string; type?: string; options?: string[]; default?: unknown }) => {
      if (q.type === 'choice' || q.type === 'multi') {
        const option = [...(q.options ?? [])].reverse().find((o) => o !== q.default)
        if (!option) throw new Error(`question ${q.id} has no non-default option to answer with`)
        return option
      }
      if (q.type === 'confirm') return true
      return `answer-${q.id}`
    }
    for (const pack of packs) {
      const manifest = parseSystemManifest(pack.manifest).manifest!
      const answers: Record<string, unknown> = {}
      for (const q of manifest.setup!.questions) answers[q.applies ?? `profile.${q.id}`] = answerFor(q)
      const section = renderProfileSection(manifest.setup, answers) ?? ''
      const bodies = applyAnswersToManifest(manifest, answers).projects.flatMap((p) => Object.values(p.files)).join('\n')
      for (const q of manifest.setup!.questions) {
        const raw = answerFor(q)
        const shown = Array.isArray(raw) ? raw.join(', ') : raw === true ? 'yes' : String(raw)
        const line = `- **${q.header}**: ${shown}`
        expect({ pack: pack.id, question: q.id, line: section.includes(line) }).toEqual({ pack: pack.id, question: q.id, line: true })
        // The file the install writes carries it too — not the placeholder, not the default.
        expect({ pack: pack.id, question: q.id, inFile: bodies.includes(shown) }).toEqual({ pack: pack.id, question: q.id, inFile: true })
        expect({ pack: pack.id, question: q.id, unresolved: bodies.includes(`{{answers.${q.applies ?? `profile.${q.id}`}}}`) }).toEqual({ pack: pack.id, question: q.id, unresolved: false })
      }
    }
  })

  test('a pack that asks for a time runs at that time, in that zone', () => {
    const manifest = parseSystemManifest(getPackTemplate('self-evolving')!.manifest).manifest!
    const values = resolveScheduleValues(manifest.schedules[0], {
      answers: { 'profile.review-time': '18:30', 'profile.timezone': 'America/New_York' },
    })
    expect(values).toMatchObject({ cronExpression: '30 18 * * *', timezone: 'America/New_York' })
    expect(values.error).toBeUndefined()
    // Monday rollup: same answered hour, Monday only.
    const rollup = resolveScheduleValues(manifest.schedules[1], {
      answers: { 'profile.review-time': '18:30', 'profile.timezone': 'America/New_York' },
    })
    expect(rollup).toMatchObject({ cronExpression: '30 18 * * 1', timezone: 'America/New_York' })
  })

  test('generated templates/packs files match the source', () => {
    for (const [rel, content] of Object.entries(renderAllPackFiles())) {
      const abs = join(TEMPLATES_DIR, rel)
      expect({ rel, exists: existsSync(abs) }).toEqual({ rel, exists: true })
      expect({ rel, same: readFileSync(abs, 'utf-8') === content }).toEqual({ rel, same: true })
    }
  })
})
