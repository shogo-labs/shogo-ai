// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Structural checks for the Phase 3 issue-pipeline templates
 * (`templates/issue-pipeline/` and `templates/issue-pipeline-solo/`).
 *
 * These do not execute the pipeline (that's Phase 4's e2e harness) — they
 * verify the artifacts are internally consistent: the checked-in manifest
 * matches what the generator would produce, it parses and diffs cleanly,
 * the findings contract is valid JSON, the solo template loads through the
 * normal template loader, and its custom subagent files parse.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeSystemDiff, parseSystemManifest, summarizeDiff, IMPLICIT_ANCHOR } from '../system-manifest'
import { loadCustomAgents } from '../subagent'
import { loadDirTemplates } from '../template-loader'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_BASE = join(__dirname, '..', '..', 'templates')
const MULTI_DIR = join(TEMPLATES_BASE, 'issue-pipeline')
const SOLO_DIR = join(TEMPLATES_BASE, 'issue-pipeline-solo')

const MODULE_KEYS = ['intake', 'analyst', 'planner', 'implementer', 'security', 'scalability', 'dry', 'done-gate', 'retrospective']
const REVIEWER_KEYS = ['security', 'scalability', 'dry']

describe('issue-pipeline (multi-project) manifest', () => {
  test('shogo-system.yaml matches what issue-pipeline-manifest-gen.ts produces (no drift)', async () => {
    const { renderManifestYaml } = await import('../issue-pipeline-manifest-gen')
    const expected = renderManifestYaml()
    const actual = readFileSync(join(MULTI_DIR, 'shogo-system.yaml'), 'utf-8')
    expect(actual).toBe(expected)
  })

  test('parses with zero errors and has one entry per module plus the anchor', () => {
    const yaml = readFileSync(join(MULTI_DIR, 'shogo-system.yaml'), 'utf-8')
    const parsed = parseSystemManifest(yaml)
    expect(parsed.errors).toEqual([])
    expect(parsed.ok).toBe(true)
    const keys = parsed.manifest!.projects.map((p) => p.key).sort()
    expect(keys).toEqual([...MODULE_KEYS, 'harness'].sort())
    expect(parsed.manifest!.anchor).toBe('harness')
  })

  test('every module has a distinct display name (project_call resolves by name without needing the lock file)', () => {
    const parsed = parseSystemManifest(readFileSync(join(MULTI_DIR, 'shogo-system.yaml'), 'utf-8'))
    const names = parsed.manifest!.projects.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('computeSystemDiff against an empty workspace creates all 10 projects and reports zero manual steps', () => {
    const parsed = parseSystemManifest(readFileSync(join(MULTI_DIR, 'shogo-system.yaml'), 'utf-8'))
    const diff = computeSystemDiff(parsed.manifest!, [], null, { callerProjectId: 'caller-1' })
    expect(diff.create.map((c) => c.key).sort()).toEqual(MODULE_KEYS.sort())
    expect(diff.manual).toEqual([])
    expect(diff.empty).toBe(false)
    // Anchor binds to the caller via 'adopt', not 'create'.
    expect(diff.adopt).toEqual([{ kind: 'adopt', key: 'harness', projectId: 'caller-1', reason: 'anchor' }])
  })

  test('attachment graph matches the design: reviewers/planner/analyst/done-gate readonly on intake, implementer readwrite, retrospective readwrite on the 5 amendable modules, harness readwrite on everything', () => {
    const parsed = parseSystemManifest(readFileSync(join(MULTI_DIR, 'shogo-system.yaml'), 'utf-8'))
    const diff = computeSystemDiff(parsed.manifest!, [], null, { callerProjectId: 'caller-1' })
    const declared = diff.attach.filter((a) => a.anchorKey !== IMPLICIT_ANCHOR)
    const byAnchor = (key: string) => declared.filter((a) => a.anchorKey === key).map((a) => `${a.targetKey}:${a.mode}`).sort()

    for (const readerKey of ['analyst', 'planner', 'security', 'scalability', 'dry', 'done-gate']) {
      expect(byAnchor(readerKey)).toEqual(['intake:readonly'])
    }
    expect(byAnchor('implementer')).toEqual(['intake:readwrite'])
    expect(byAnchor('retrospective')).toEqual(
      ['dry:readwrite', 'implementer:readwrite', 'planner:readwrite', 'scalability:readwrite', 'security:readwrite'],
    )
    expect(byAnchor('intake')).toEqual([])
    expect(byAnchor('harness')).toEqual(
      [...MODULE_KEYS].map((k) => `${k}:readwrite`).sort(),
    )
  })

  test('second apply against the resulting live graph reports an empty diff (idempotent)', () => {
    const parsed = parseSystemManifest(readFileSync(join(MULTI_DIR, 'shogo-system.yaml'), 'utf-8'))
    const manifest = parsed.manifest!
    const callerProjectId = 'harness-live-id'

    // Simulate the live graph after a first successful apply: one live
    // project per module (ids = "<key>-live-id"), all attachments and file
    // contents matching the manifest exactly, plus the anchor itself.
    const live = manifest.projects.map((spec) => {
      const id = spec.key === 'harness' ? callerProjectId : `${spec.key}-live-id`
      return {
        id,
        name: spec.name,
        description: spec.description ?? null,
        attachments: spec.attachments.map((a) => ({
          attachedProjectId: `${a.project}-live-id`,
          attachMode: a.mode,
        })),
        agent: spec.agent
          ? {
              heartbeatEnabled: spec.agent.heartbeat?.enabled ?? false,
              heartbeatInterval: spec.agent.heartbeat?.interval ?? 3600,
              modelName: spec.agent.model ?? 'claude-sonnet-4-6',
            }
          : null,
      }
    })
    const lock = {
      version: 1 as const,
      name: manifest.name,
      bindings: Object.fromEntries(manifest.projects.map((p) => [p.key, p.key === 'harness' ? callerProjectId : `${p.key}-live-id`])),
    }
    const fileContents = new Map<string, Map<string, string>>()
    for (const spec of manifest.projects) {
      fileContents.set(spec.key, new Map(Object.entries(spec.files)))
    }
    const readFile = (projectId: string, path: string): string | null => {
      const key = Object.keys(lock.bindings).find((k) => lock.bindings[k] === projectId)
      if (!key) return null
      return fileContents.get(key)?.get(path) ?? null
    }

    const diff = computeSystemDiff(manifest, live, lock, { callerProjectId, readFile })
    if (!diff.empty) {
      // Helpful failure output if the topology ever drifts from this test's simulation.
      console.log(summarizeDiff(diff).join('\n'))
    }
    expect(diff.empty).toBe(true)
  })
})

describe('issue-pipeline findings.schema.json', () => {
  for (const dir of [MULTI_DIR, SOLO_DIR]) {
    test(`${dir.includes('solo') ? 'solo' : 'multi'} copy is valid JSON with the expected required fields`, () => {
      const raw = readFileSync(join(dir, 'findings.schema.json'), 'utf-8')
      const schema = JSON.parse(raw)
      expect(schema.title).toBe('Finding')
      expect(schema.required).toEqual(
        expect.arrayContaining(['id', 'runId', 'reviewer', 'category', 'severity', 'summary', 'planGap', 'accepted', 'createdAt']),
      )
      expect(schema.properties.reviewer.enum).toEqual(REVIEWER_KEYS)
      expect(schema.properties.accepted.type).toEqual(['boolean', 'null'])
      expect(schema.properties.planGap.type).toEqual(['boolean', 'null'])
    })
  }

  test('multi-project and solo copies are identical (single source of truth)', () => {
    const multi = readFileSync(join(MULTI_DIR, 'findings.schema.json'), 'utf-8')
    const solo = readFileSync(join(SOLO_DIR, 'findings.schema.json'), 'utf-8')
    expect(solo).toBe(multi)
  })

  test('the manifest inlines findings.schema.json for every reviewer + judge + record-keeper, and nowhere else', () => {
    const parsed = parseSystemManifest(readFileSync(join(MULTI_DIR, 'shogo-system.yaml'), 'utf-8'))
    const withSchema = parsed.manifest!.projects.filter((p) => 'findings.schema.json' in p.files).map((p) => p.key).sort()
    expect(withSchema).toEqual([...REVIEWER_KEYS, 'done-gate', 'retrospective'].sort())
  })
})

describe('issue-pipeline module folders (multi-project)', () => {
  for (const key of MODULE_KEYS) {
    test(`${key}/AGENTS.md exists and documents a ## Learned section`, () => {
      const p = join(MULTI_DIR, key, 'AGENTS.md')
      expect(existsSync(p)).toBe(true)
      expect(readFileSync(p, 'utf-8')).toContain('## Learned')
    })
  }

  test('every module folder only contains files under safe relative paths that the manifest schema would accept', () => {
    // Re-derive the same file map generate-manifest.ts builds and assert
    // every path is one write_file/system_apply would accept.
    const { isSafeRelativePath } = require('../system-manifest') as typeof import('../system-manifest')
    for (const key of MODULE_KEYS) {
      const dir = join(MULTI_DIR, key)
      const walk = (d: string, base = d): string[] => {
        if (!existsSync(d)) return []
        return readdirSync(d, { withFileTypes: true }).flatMap((e) => {
          const abs = join(d, e.name)
          return e.isDirectory() ? walk(abs, base) : [abs.slice(base.length + 1)]
        })
      }
      for (const rel of walk(dir)) {
        expect(isSafeRelativePath(rel)).toBe(true)
      }
    }
  })
})

describe('issue-pipeline-solo template', () => {
  test('is discoverable via loadDirTemplates() with its skills', () => {
    const templates = loadDirTemplates()
    const solo = templates.find((t) => t.id === 'issue-pipeline-solo')
    expect(solo).toBeDefined()
    expect(solo!.files['AGENTS.md']).toContain('Issue Pipeline (Solo)')
    expect(solo!.files['HEARTBEAT.md']).toContain('Retrospective sweep')
    expect(new Set(solo!.skills)).toEqual(
      new Set(['reproduce', 'task-source-github-issues', 'task-source-jira', 'task-source-builtin']),
    )
  })

  test('the harness template (templates/issue-pipeline/) is also discoverable', () => {
    const templates = loadDirTemplates()
    const harness = templates.find((t) => t.id === 'issue-pipeline')
    expect(harness).toBeDefined()
    expect(harness!.files['AGENTS.md']).toContain('Issue Pipeline — Harness')
    expect(harness!.skills).toEqual(['run-system-apply'])
  })

  test('all 8 custom subagents parse via loadCustomAgents() with distinct names/descriptions', () => {
    const agents = loadCustomAgents(SOLO_DIR)
    const names = agents.map((a) => a.name).sort()
    expect(names).toEqual(['analyst', 'done-gate', 'dry', 'implementer', 'planner', 'retrospective', 'scalability', 'security'].sort())
    for (const a of agents) {
      expect(a.description.length).toBeGreaterThan(0)
      expect(a.systemPrompt).toContain('## Learned')
      expect(Array.isArray(a.tools)).toBe(true)
    }
  })

  test('the 3 reviewer subagents are read-only (no write/edit/delete tool in their allowlist)', () => {
    const agents = loadCustomAgents(SOLO_DIR)
    for (const key of REVIEWER_KEYS) {
      const agent = agents.find((a) => a.name === key)!
      expect(agent.tools).toBeDefined()
      for (const forbidden of ['write_file', 'edit_file', 'delete_file']) {
        expect(agent.tools).not.toContain(forbidden)
      }
    }
  })

  test('implementer and retrospective are the only subagents allowed to write files', () => {
    const agents = loadCustomAgents(SOLO_DIR)
    const canWrite = agents.filter((a) => a.tools?.includes('write_file')).map((a) => a.name).sort()
    expect(canWrite).toEqual(['implementer', 'retrospective'])
  })

  test('coordinator AGENTS.md references every subagent by name', () => {
    const coordinator = readFileSync(join(SOLO_DIR, '.shogo', 'AGENTS.md'), 'utf-8')
    for (const name of ['analyst', 'planner', 'implementer', 'security', 'scalability', 'dry', 'done-gate', 'retrospective']) {
      expect(coordinator).toContain(`type: "${name}"`)
    }
  })
})
