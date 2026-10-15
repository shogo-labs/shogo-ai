// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Board, department and company templates: the checked-in YAML matches the
 * source, every template validates, applies to an empty workspace, and a
 * second apply (against the state the first one produced) is empty.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  BoardSpecSchema,
  computeSystemDiff,
  parseSystemManifest,
  resolveAgentRef,
  type LiveBoard,
  type LiveProject,
  type LiveTeamChannels,
  type LiveTrigger,
  type SystemDiff,
  type SystemLock,
  type SystemManifest,
} from '../system-manifest'
import {
  BOARD_TEMPLATES,
  COMPANIES,
  DEPARTMENTS,
  boardTemplateArgs,
  listWorkTemplates,
  mergeWorkTemplate,
  renderAllTemplateFiles,
  renderBundleYaml,
} from '../work-templates'
import { TEMPLATES_DIR } from '../work-templates-gen'

const CALLER = 'p-caller'

function parse(yaml: string): SystemManifest {
  const r = parseSystemManifest(yaml)
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.manifest!
}

const EMPTY = { channels: [], groups: {} }

function firstApply(m: SystemManifest): SystemDiff {
  return computeSystemDiff(m, [{ id: CALLER, name: 'Workspace', description: null, attachments: [], agent: null }], null, {
    callerProjectId: CALLER, teamChannels: EMPTY, boards: [], triggers: [],
  })
}

/** The workspace as it would be after `diff` was applied. */
function applied(m: SystemManifest, diff: SystemDiff) {
  const bindings: Record<string, string> = Object.fromEntries(diff.create.map((c) => [c.key, `p-${c.key}`]))
  const live: LiveProject[] = [
    { id: CALLER, name: 'Workspace', description: null, attachments: Object.values(bindings).map((id) => ({ attachedProjectId: id, attachMode: 'readwrite' as const })), agent: null },
    ...m.projects.map((p) => ({
      id: bindings[p.key],
      name: p.name,
      description: p.description ?? null,
      attachments: p.attachments.map((a) => ({ attachedProjectId: bindings[a.project], attachMode: a.mode })),
      agent: { heartbeatEnabled: p.agent?.heartbeat?.enabled ?? false, heartbeatInterval: p.agent?.heartbeat?.interval ?? 0, modelName: p.agent?.model ?? 'auto', modelProvider: p.agent?.provider ?? '' },
      capabilities: { ...(p.agent?.capabilities ?? {}) },
    })),
  ]
  const files = new Map(m.projects.flatMap((p) => Object.entries(p.files).map(([path, body]) => [`${bindings[p.key]}:${path}`, body])))
  const teamChannels: LiveTeamChannels = {
    groups: {},
    channels: diff.teamChannels.map((op) => ({
      name: op.name,
      topic: op.topic ?? null,
      private: op.private,
      agents: op.agents.map((a) => ({ projectId: bindings[a.key], agentTrigger: a.agentTrigger, agentKeywords: a.agentKeywords, agentContextMode: a.agentContextMode })),
      userEmails: [],
    })),
  }
  const boards: LiveBoard[] = diff.boards.map((op, i) => ({
    id: `b${i}`,
    name: op.name,
    channelName: op.channel,
    itemType: String(op.values.item_type),
    keyPrefix: String(op.values.key_prefix ?? ''),
    description: (op.values.description as string | undefined) ?? null,
    fieldsSchema: op.values.fields ?? [],
    postToChannel: String(op.values.post_to_channel ?? 'all'),
    requiresHumanReview: !!op.values.requires_human_review,
    defaultAssigneeAgentRef: op.values.default_agent ? resolveAgentRef(String(op.values.default_agent), bindings) : null,
    archivedAt: null,
    columns: ((op.values.columns as any[]) ?? []).map((c, position) => ({
      id: `b${i}c${position}`, name: c.name, position, category: c.category ?? 'active', wipLimit: c.wip_limit ?? null,
      agentRef: c.agent ? resolveAgentRef(c.agent, bindings) : null, slaHours: c.sla_hours ?? null,
    })),
  }))
  const triggers: LiveTrigger[] = diff.triggers.map((t, i) => ({ id: `t${i}`, name: t.spec!.name, eventType: t.spec!.event, target: t.spec!.target, targetProjectId: null }))
  const lock: SystemLock = {
    version: 1, name: m.name, bindings,
    ...(triggers.length ? { triggers: Object.fromEntries(diff.triggers.map((t, i) => [t.key, { id: `t${i}`, hash: t.hash! }])) } : {}),
  }
  return { live, lock, opts: { callerProjectId: CALLER, teamChannels, boards, triggers, readFile: (id: string, path: string) => files.get(`${id}:${path}`) ?? null } }
}

describe('generated template files', () => {
  test('templates/ matches work-templates.ts (regenerate with work-templates-gen.ts)', () => {
    for (const [rel, content] of Object.entries(renderAllTemplateFiles())) {
      expect({ rel, content: readFileSync(join(TEMPLATES_DIR, rel), 'utf-8') }).toEqual({ rel, content })
    }
  })

  test('the catalog lists 14 boards, 8 departments and 6 companies', () => {
    expect(BOARD_TEMPLATES).toHaveLength(14)
    expect(DEPARTMENTS).toHaveLength(8)
    expect(COMPANIES).toHaveLength(6)
    expect(listWorkTemplates()).toHaveLength(28)
  })
})

describe('board templates', () => {
  for (const t of BOARD_TEMPLATES) {
    test(`${t.id} is a valid board`, () => {
      const file = parseYaml(readFileSync(join(TEMPLATES_DIR, `boards/${t.id}.yaml`), 'utf-8'))
      const r = BoardSpecSchema.safeParse(file.board)
      expect(r.success ? [] : r.error.issues).toEqual([])
      expect(boardTemplateArgs(t.id)).toMatchObject({ channel: t.channel, name: t.board.name, item_type: t.board.itemType })
    })
  }
})

const BUNDLES = [
  ...DEPARTMENTS.map((d) => ['department', d.id] as const),
  ...COMPANIES.map((c) => ['company', c.id] as const),
]

describe('department and company bundles', () => {
  for (const [kind, id] of BUNDLES) {
    describe(`${kind} ${id}`, () => {
      const m = parse(renderBundleYaml(kind, id))

      test('applies to an empty workspace', () => {
        const diff = firstApply(m)
        expect(diff.create.map((c) => c.key).sort()).toEqual(m.projects.map((p) => p.key).sort())
        expect(diff.teamChannels.map((c) => c.action)).toEqual(m.teamChannels.map(() => 'create'))
        expect(diff.boards).toHaveLength(m.teamChannels.reduce((n, c) => n + c.boards.length, 0))
        expect(diff.boards.every((b) => b.action === 'create' && b.values.default_agent)).toBe(true)
        expect(diff.triggers.map((t) => t.key).sort()).toEqual(m.triggers.map((t) => t.key).sort())
        expect(diff.manual.every((s) => s.includes('connect integration'))).toBe(true)
      })

      test('a second apply is empty', () => {
        const first = firstApply(m)
        const { live, lock, opts } = applied(m, first)
        const second = computeSystemDiff(m, live, lock, opts)
        expect({ ...second, manual: [] }).toMatchObject({ create: [], configure: [], attach: [], teamChannels: [], boards: [], triggers: [] })
        expect(second.empty).toBe(true)
      })

      test('card key prefixes are unique', () => {
        const prefixes = m.teamChannels.flatMap((c) => c.boards.map((b) => b.keyPrefix))
        expect(new Set(prefixes).size).toBe(prefixes.length)
      })
    })
  }

  test('department agents can work cards but not change boards; only engineering gets problems', () => {
    for (const d of DEPARTMENTS) {
      expect(d.agent.capabilities).toMatchObject({ boardsEnabled: true, boardAdminEnabled: false })
      expect(!!d.agent.capabilities.problemsEnabled).toBe(d.id === 'engineering')
    }
  })

  test('channels holding candidate, money or contract details are private', () => {
    const m = parse(renderBundleYaml('company', 'saas-startup'))
    expect(m.teamChannels.filter((c) => c.private).map((c) => c.name).sort()).toEqual(['finance', 'people'])
  })
})

describe('mergeWorkTemplate', () => {
  test('starts a manifest from a department and is a no-op the second time', () => {
    const once = mergeWorkTemplate(null, 'support', { workspaceName: 'Acme' })
    expect(once.added).toEqual(['project support-agent', 'channel #support', 'board #support Tickets'])
    expect(parse(once.yaml).name).toBe('Acme')
    const twice = mergeWorkTemplate(once.yaml, 'support')
    expect(twice.added).toEqual([])
    expect(parse(twice.yaml)).toEqual(parse(once.yaml))
  })

  test('a company after one of its departments adds only the rest', () => {
    const support = mergeWorkTemplate(null, 'support').yaml
    const r = mergeWorkTemplate(support, 'ecommerce')
    expect(r.skipped).toContain('project support-agent')
    expect(r.skipped).toContain('board #support Tickets')
    const m = parse(r.yaml)
    expect(m.projects.map((p) => p.key)).toEqual(['support-agent', 'marketing-agent', 'operations-agent', 'finance-agent'])
    expect(m.teamChannels.find((c) => c.name === 'support')!.members).toHaveLength(1)
  })

  test('keeps what the manifest already has', () => {
    const own = [
      'version: 1', 'name: Ours', 'projects:', '  - key: support-agent', '    name: Our Support Bot',
      'teamChannels:', '  - name: support', '    private: true', '    boards:', '      - { name: Tickets, itemType: ticket, keyPrefix: TIX }',
    ].join('\n')
    const m = parse(mergeWorkTemplate(own, 'support').yaml)
    expect(m.projects).toHaveLength(1)
    expect(m.projects[0].name).toBe('Our Support Bot')
    const ch = m.teamChannels[0]
    expect(ch.private).toBe(true)
    expect(ch.boards.map((b) => b.keyPrefix)).toEqual(['TIX'])
    expect(ch.members.map((x: any) => x.project)).toEqual(['support-agent'])
  })

  test('adds a board template to a channel the manifest declares, and refuses others', () => {
    const base = mergeWorkTemplate(null, 'sales').yaml
    const r = mergeWorkTemplate(base, 'legal-review', { channel: '#sales' })
    expect(r.added).toEqual(['board #sales Contracts'])
    expect(() => mergeWorkTemplate(base, 'support-tickets')).toThrow(/board_create with template "support-tickets"/)
    expect(() => mergeWorkTemplate(base, 'hiring-candidates', { channel: 'people' })).toThrow(/"people" department template/)
    expect(() => mergeWorkTemplate(base, 'nope')).toThrow(/Unknown template/)
  })
})
