// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for system-manifest.ts — pure schema/diff logic backing the
 * `system_apply` tool. No I/O; everything here is deterministic.
 */
import { describe, test, expect } from 'bun:test'
import {
  parseSystemManifest,
  isSafeRelativePath,
  resolveBindings,
  computeSystemDiff,
  summarizeDiff,
  IMPLICIT_ANCHOR,
  type LiveProject,
  type SystemLock,
} from '../system-manifest'

// ─── isSafeRelativePath ──────────────────────────────────────────────────

describe('isSafeRelativePath', () => {
  test('accepts ordinary relative paths', () => {
    expect(isSafeRelativePath('AGENTS.md')).toBe(true)
    expect(isSafeRelativePath('.shogo/agents/reviewer.md')).toBe(true)
    expect(isSafeRelativePath('a/b/c.txt')).toBe(true)
  })

  test('rejects absolute paths, traversal, and an empty path', () => {
    expect(isSafeRelativePath('/etc/passwd')).toBe(false)
    expect(isSafeRelativePath('../secrets')).toBe(false)
    expect(isSafeRelativePath('a/../../b')).toBe(false)
    expect(isSafeRelativePath('a/./b')).toBe(false)
    expect(isSafeRelativePath('C:\\Windows')).toBe(false)
    expect(isSafeRelativePath('')).toBe(false)
  })
})

// ─── parseSystemManifest ─────────────────────────────────────────────────

const MINIMAL_YAML = `
version: 1
name: issue-pipeline
projects:
  - key: intake
    name: Intake
  - key: planner
    name: Planner
    attachments:
      - project: intake
`

describe('parseSystemManifest', () => {
  test('parses valid YAML into a typed manifest', () => {
    const result = parseSystemManifest(MINIMAL_YAML)
    expect(result.ok).toBe(true)
    expect(result.manifest?.projects).toHaveLength(2)
    expect(result.manifest?.projects[1].attachments).toEqual([{ project: 'intake', mode: 'readwrite' }])
  })

  test('rejects malformed YAML', () => {
    const result = parseSystemManifest('version: 1\nname: [unterminated')
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/YAML parse error/)
  })

  test('rejects a schema violation (missing required version)', () => {
    const result = parseSystemManifest({ name: 'x', projects: [{ key: 'a', name: 'A' }] })
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  test('rejects duplicate project keys', () => {
    const result = parseSystemManifest({
      version: 1,
      name: 'dup',
      projects: [{ key: 'a', name: 'A' }, { key: 'a', name: 'A2' }],
    })
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('duplicate project key "a"')
  })

  test('rejects an attachment referencing an unknown key', () => {
    const result = parseSystemManifest({
      version: 1,
      name: 'bad-ref',
      projects: [{ key: 'a', name: 'A', attachments: [{ project: 'ghost' }] }],
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('unknown key "ghost"'))).toBe(true)
  })

  test('rejects self-attachment', () => {
    const result = parseSystemManifest({
      version: 1,
      name: 'self',
      projects: [{ key: 'a', name: 'A', attachments: [{ project: 'a' }] }],
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('cannot attach to itself'))).toBe(true)
  })

  test('rejects an unsafe file path', () => {
    const result = parseSystemManifest({
      version: 1,
      name: 'unsafe-file',
      projects: [{ key: 'a', name: 'A', files: { '../escape.md': 'x' } }],
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('unsafe file path'))).toBe(true)
  })

  test('rejects an anchor that is not a declared project key', () => {
    const result = parseSystemManifest({
      version: 1,
      name: 'bad-anchor',
      anchor: 'ghost',
      projects: [{ key: 'a', name: 'A' }],
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('anchor "ghost"'))).toBe(true)
  })

  test('accepts an already-parsed object (not just YAML strings)', () => {
    const result = parseSystemManifest({ version: 1, name: 'obj', projects: [{ key: 'a', name: 'A' }] })
    expect(result.ok).toBe(true)
  })
})

// ─── resolveBindings ─────────────────────────────────────────────────────

function live(overrides: Partial<LiveProject> = {}): LiveProject {
  return { id: 'id', name: 'name', description: null, attachments: [], agent: null, ...overrides }
}

describe('resolveBindings', () => {
  test('binds the anchor key to the caller regardless of lock/name', () => {
    const manifest = parseSystemManifest({
      version: 1,
      name: 'm',
      anchor: 'me',
      projects: [{ key: 'me', name: 'Anything' }],
    }).manifest!
    const { bindings, adopt } = resolveBindings(manifest, [], null, 'caller-1')
    expect(bindings.me).toBe('caller-1')
    expect(adopt).toEqual([{ kind: 'adopt', key: 'me', projectId: 'caller-1', reason: 'anchor' }])
  })

  test('prefers a lock binding over name matching', () => {
    const manifest = parseSystemManifest({
      version: 1,
      name: 'm',
      projects: [{ key: 'planner', name: 'Planner' }],
    }).manifest!
    const liveProjects = [live({ id: 'proj-locked', name: 'Planner' }), live({ id: 'proj-other', name: 'Planner' })]
    const lock: SystemLock = { version: 1, name: 'm', bindings: { planner: 'proj-locked' } }
    const { bindings, adopt } = resolveBindings(manifest, liveProjects, lock, 'caller-1')
    expect(bindings.planner).toBe('proj-locked')
    expect(adopt).toHaveLength(0)
  })

  test('adopts unambiguously by exact name when there is no lock entry', () => {
    const manifest = parseSystemManifest({
      version: 1,
      name: 'm',
      projects: [{ key: 'planner', name: 'Planner' }],
    }).manifest!
    const liveProjects = [live({ id: 'proj-1', name: 'Planner' })]
    const { bindings, adopt } = resolveBindings(manifest, liveProjects, null, 'caller-1')
    expect(bindings.planner).toBe('proj-1')
    expect(adopt).toEqual([{ kind: 'adopt', key: 'planner', projectId: 'proj-1', reason: 'name' }])
  })

  test('leaves a key unbound (destined for create) when the name match is ambiguous', () => {
    const manifest = parseSystemManifest({
      version: 1,
      name: 'm',
      projects: [{ key: 'planner', name: 'Planner' }],
    }).manifest!
    const liveProjects = [live({ id: 'proj-1', name: 'Planner' }), live({ id: 'proj-2', name: 'Planner' })]
    const { bindings } = resolveBindings(manifest, liveProjects, null, 'caller-1')
    expect(bindings.planner).toBeUndefined()
  })

  test('leaves a key unbound when there is no lock and no name match', () => {
    const manifest = parseSystemManifest({
      version: 1,
      name: 'm',
      projects: [{ key: 'planner', name: 'Planner' }],
    }).manifest!
    const { bindings } = resolveBindings(manifest, [], null, 'caller-1')
    expect(bindings.planner).toBeUndefined()
  })
})

// ─── computeSystemDiff ────────────────────────────────────────────────────

describe('computeSystemDiff', () => {
  test('a manifest with no live projects is entirely creates + implicit-anchor attaches, never empty', () => {
    const manifest = parseSystemManifest(MINIMAL_YAML).manifest!
    const diff = computeSystemDiff(manifest, [], null, { callerProjectId: 'caller-1' })
    expect(diff.create.map((c) => c.key)).toEqual(['intake', 'planner'])
    expect(diff.empty).toBe(false)
    // Implicit anchor: caller manages every manifest project read-write.
    expect(diff.attach.filter((a) => a.anchorKey === IMPLICIT_ANCHOR)).toHaveLength(2)
    // Declared attachment planner -> intake, unresolved targetId (intake not yet created).
    expect(diff.attach.some((a) => a.anchorKey === 'planner' && a.targetKey === 'intake' && a.targetId === null)).toBe(true)
  })

  test('a fully-adopted, fully-attached, unchanged manifest is empty', () => {
    const manifest = parseSystemManifest(MINIMAL_YAML).manifest!
    const liveProjects = [
      live({ id: 'id-intake', name: 'Intake', attachments: [{ attachedProjectId: 'caller-1', attachMode: 'readwrite' }] }),
      live({
        id: 'id-planner',
        name: 'Planner',
        attachments: [
          { attachedProjectId: 'id-intake', attachMode: 'readwrite' },
          { attachedProjectId: 'caller-1', attachMode: 'readwrite' },
        ],
      }),
    ]
    // Caller also has the anchor→project edges already recorded from its side.
    const callerAsLive = live({
      id: 'caller-1',
      attachments: [
        { attachedProjectId: 'id-intake', attachMode: 'readwrite' },
        { attachedProjectId: 'id-planner', attachMode: 'readwrite' },
      ],
    })
    const diff = computeSystemDiff(manifest, [...liveProjects, callerAsLive], null, { callerProjectId: 'caller-1' })
    expect(diff.create).toHaveLength(0)
    expect(diff.attach).toHaveLength(0)
    expect(diff.detach).toHaveLength(0)
    expect(diff.empty).toBe(true)
  })

  test('detaches a manifest-declared edge that was removed from the manifest', () => {
    const manifest = parseSystemManifest({
      version: 1,
      name: 'm',
      projects: [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }], // no attachment a -> b anymore
    }).manifest!
    const liveProjects = [
      live({ id: 'id-a', name: 'A', attachments: [{ attachedProjectId: 'id-b', attachMode: 'readwrite' }] }),
      live({ id: 'id-b', name: 'B' }),
    ]
    const diff = computeSystemDiff(manifest, liveProjects, null, { callerProjectId: 'caller-1' })
    expect(diff.detach).toEqual([{ kind: 'detach', anchorKey: 'a', anchorId: 'id-a', targetKey: 'b', targetId: 'id-b' }])
  })

  test('never detaches an edge to a project outside the manifest', () => {
    const manifest = parseSystemManifest({
      version: 1,
      name: 'm',
      projects: [{ key: 'a', name: 'A' }],
    }).manifest!
    const liveProjects = [live({ id: 'id-a', name: 'A', attachments: [{ attachedProjectId: 'unrelated-project', attachMode: 'readwrite' }] })]
    const diff = computeSystemDiff(manifest, liveProjects, null, { callerProjectId: 'caller-1' })
    expect(diff.detach).toHaveLength(0)
  })

  test('remodes an attachment whose mode changed without detaching first', () => {
    const manifest = parseSystemManifest({
      version: 1,
      name: 'm',
      projects: [
        { key: 'a', name: 'A', attachments: [{ project: 'b', mode: 'readonly' }] },
        { key: 'b', name: 'B' },
      ],
    }).manifest!
    const liveProjects = [
      live({ id: 'id-a', name: 'A', attachments: [{ attachedProjectId: 'id-b', attachMode: 'readwrite' }] }),
      live({ id: 'id-b', name: 'B' }),
    ]
    const diff = computeSystemDiff(manifest, liveProjects, null, { callerProjectId: 'caller-1' })
    // Filter out the implicit-anchor attach ops (no manifest anchor is
    // declared here, so the caller also attaches read-write to both a and b).
    const declared = diff.attach.filter((a) => a.anchorKey !== IMPLICIT_ANCHOR)
    expect(declared).toEqual([
      { kind: 'attach', anchorKey: 'a', anchorId: 'id-a', targetKey: 'b', targetId: 'id-b', mode: 'readonly', changeMode: true },
    ])
    expect(diff.detach).toHaveLength(0)
  })

  test('produces a configure op only for agent/description fields that actually differ', () => {
    const manifest = parseSystemManifest({
      version: 1,
      name: 'm',
      projects: [{ key: 'a', name: 'A', description: 'new desc', agent: { model: 'sonnet', heartbeat: { enabled: true, interval: 900 } } }],
    }).manifest!
    const liveProjects = [
      live({ id: 'id-a', name: 'A', description: 'old desc', agent: { heartbeatEnabled: false, heartbeatInterval: 900, modelName: 'sonnet' } }),
    ]
    const diff = computeSystemDiff(manifest, liveProjects, null, { callerProjectId: 'caller-1' })
    expect(diff.configure).toHaveLength(1)
    expect(diff.configure[0].patch).toEqual({
      description: 'new desc',
      agent: { heartbeatEnabled: true }, // interval and model already match -> omitted
    })
  })

  test('regression: a spec.agent.provider matching live.agent.modelProvider produces no op (idempotent), a mismatch does', () => {
    // `agentPatch` used to set `patch.modelProvider = a.provider` whenever
    // `a.provider` was defined, with no comparison against the live value
    // (unlike `model`, which is compared) — every apply against an
    // already-configured project with an explicit `provider` (e.g. `'custom'`
    // for a non-Anthropic admin model) reported a spurious configure op
    // forever, breaking the "second apply is an empty diff" idempotency
    // guarantee. Found live running the issue-pipeline multi-project eval
    // after adding `provider: 'custom'` to every module so Hoshi 2.0 stages
    // stop silently falling back to a default Anthropic model.
    const manifestFor = (provider: string) =>
      parseSystemManifest({
        version: 1,
        name: 'm',
        projects: [{ key: 'a', name: 'A', agent: { model: 'hoshi-2-0', provider, heartbeat: { enabled: false } } }],
      }).manifest!
    const liveProjects = [
      live({ id: 'id-a', name: 'A', agent: { heartbeatEnabled: false, heartbeatInterval: 1800, modelName: 'hoshi-2-0', modelProvider: 'custom' } }),
    ]

    const matching = computeSystemDiff(manifestFor('custom'), liveProjects, null, { callerProjectId: 'caller-1' })
    expect(matching.configure).toHaveLength(0)

    const mismatched = computeSystemDiff(manifestFor('anthropic'), liveProjects, null, { callerProjectId: 'caller-1' })
    expect(mismatched.configure).toHaveLength(1)
    expect(mismatched.configure[0].patch).toEqual({ agent: { modelProvider: 'anthropic' } })
  })

  test('surfaces channels/integrations as manual steps, never as ops', () => {
    const manifest = parseSystemManifest({
      version: 1,
      name: 'm',
      projects: [{ key: 'a', name: 'A', channels: ['slack'], integrations: ['jira'] }],
    }).manifest!
    const diff = computeSystemDiff(manifest, [], null, { callerProjectId: 'caller-1' })
    expect(diff.manual).toEqual([
      'a: connect channel "slack" (channel_connect needs credentials)',
      'a: connect integration "jira" (Composio / MCP auth)',
    ])
  })

  test('an explicit anchor project attaches read-write to its own attachment list, not implicitly to every project', () => {
    const manifest = parseSystemManifest({
      version: 1,
      name: 'm',
      anchor: 'me',
      projects: [
        { key: 'me', name: 'Me', attachments: [{ project: 'worker' }] },
        { key: 'worker', name: 'Worker' },
      ],
    }).manifest!
    const diff = computeSystemDiff(manifest, [], null, { callerProjectId: 'caller-1' })
    // No implicit-anchor attach ops when the manifest declares its own anchor.
    expect(diff.attach.filter((a) => a.anchorKey === IMPLICIT_ANCHOR)).toHaveLength(0)
    expect(diff.attach.some((a) => a.anchorKey === 'me' && a.targetKey === 'worker')).toBe(true)
  })

  test('reports file creates/updates/unchanged via the readFile callback', () => {
    const manifest = parseSystemManifest({
      version: 1,
      name: 'm',
      projects: [{ key: 'a', name: 'A', files: { 'AGENTS.md': 'new content', 'SAME.md': 'same' } }],
    }).manifest!
    const liveProjects = [live({ id: 'id-a', name: 'A' })]
    const readFile = (projectId: string, path: string) => {
      if (path === 'AGENTS.md') return 'old content'
      if (path === 'SAME.md') return 'same'
      return null
    }
    const diff = computeSystemDiff(manifest, liveProjects, null, { callerProjectId: 'caller-1', readFile })
    const byPath = new Map(diff.files.map((f) => [f.path, f.action]))
    expect(byPath.get('AGENTS.md')).toBe('update')
    expect(byPath.get('SAME.md')).toBe('unchanged')
  })
})

// ─── summarizeDiff ────────────────────────────────────────────────────────

describe('summarizeDiff', () => {
  test('renders one readable line per op, and omits unchanged files', () => {
    const manifest = parseSystemManifest(MINIMAL_YAML).manifest!
    const diff = computeSystemDiff(manifest, [], null, { callerProjectId: 'caller-1' })
    const lines = summarizeDiff(diff)
    expect(lines.some((l) => l.startsWith('create intake "Intake"'))).toBe(true)
    expect(lines.some((l) => l.startsWith('create planner "Planner"'))).toBe(true)
    expect(lines.some((l) => l.includes('(caller) → intake'))).toBe(true)
  })
})

// ─── teamChannels ────────────────────────────────────────────────────────

const CHANNELS_YAML = `
version: 1
name: issue-pipeline
projects:
  - key: intake
    name: Intake
  - key: analyst
    name: Analyst
teamChannels:
  - name: "#issue-pipeline"
    topic: One thread per issue
    members:
      - { project: intake, agentTrigger: all }
      - { project: analyst }
      - { group: "@maintainers" }
      - { user: Lead@Example.com }
  - name: pipeline-alerts
    private: true
    members:
      - { project: intake }
`

function channelsManifest() {
  const parsed = parseSystemManifest(CHANNELS_YAML)
  if (!parsed.ok || !parsed.manifest) throw new Error(parsed.errors.join('; '))
  return parsed.manifest
}

const boundLock: SystemLock = { version: 1, name: 'issue-pipeline', bindings: { intake: 'p-intake', analyst: 'p-analyst' } }
const boundLive = [live({ id: 'p-intake', name: 'Intake' }), live({ id: 'p-analyst', name: 'Analyst' })]

describe('teamChannels', () => {
  test('parses channels, strips # and @, lowercases emails, and defaults agentTrigger to mention', () => {
    const m = channelsManifest()
    expect(m.teamChannels.map((c) => c.name)).toEqual(['issue-pipeline', 'pipeline-alerts'])
    expect(m.teamChannels[0].members).toEqual([
      { project: 'intake', agentTrigger: 'all', contextMode: 'shared' },
      { project: 'analyst', agentTrigger: 'mention', contextMode: 'shared' },
      { group: 'maintainers' },
      { user: 'lead@example.com' },
    ])
    expect(m.teamChannels[1].private).toBe(true)
  })

  test('accepts the auto trigger for agents that watch a channel and answer only when relevant', () => {
    const m = parseSystemManifest({
      version: 1,
      name: 'x',
      projects: [{ key: 'a', name: 'A' }],
      teamChannels: [{ name: 'eng', members: [{ project: 'a', agentTrigger: 'auto' }] }],
    })
    expect(m.ok).toBe(true)
    expect(m.manifest!.teamChannels[0].members).toEqual([{ project: 'a', agentTrigger: 'auto', contextMode: 'shared' }])
  })

  test('rejects unknown project keys, duplicate channels, and keyword triggers without keywords', () => {
    const bad = parseSystemManifest({
      version: 1,
      name: 'x',
      projects: [{ key: 'a', name: 'A' }],
      teamChannels: [
        { name: 'ops', members: [{ project: 'ghost' }, { project: 'a', agentTrigger: 'keyword' }] },
        { name: 'ops' },
      ],
    })
    expect(bad.ok).toBe(false)
    expect(bad.errors.join('\n')).toContain('unknown key "ghost"')
    expect(bad.errors.join('\n')).toContain('duplicate team channel "ops"')
    expect(bad.errors.join('\n')).toContain('without keywords')
  })

  test('creates missing channels with agent, group and person members', () => {
    const diff = computeSystemDiff(channelsManifest(), boundLive, boundLock, {
      callerProjectId: 'p-intake',
      teamChannels: { channels: [], groups: { maintainers: ['ana@example.com'] } },
    })
    const [pipeline, alerts] = diff.teamChannels
    expect(pipeline.action).toBe('create')
    expect(pipeline.agents).toEqual([
      { key: 'intake', projectId: 'p-intake', agentTrigger: 'all', agentKeywords: null, agentContextMode: 'shared' },
      { key: 'analyst', projectId: 'p-analyst', agentTrigger: 'mention', agentKeywords: null, agentContextMode: 'shared' },
    ])
    expect(pipeline.groupHandles).toEqual(['maintainers'])
    expect(pipeline.userEmails).toEqual(['lead@example.com'])
    expect(alerts.private).toBe(true)
    expect(diff.empty).toBe(false)
    expect(summarizeDiff(diff)).toContain('create channel #pipeline-alerts: add agent intake (mention)')
  })

  test('a second run against the applied state is a no-op', () => {
    const teamChannels = {
      channels: [
        {
          name: 'issue-pipeline', topic: 'One thread per issue', private: false,
          agents: [
            { projectId: 'p-intake', agentTrigger: 'all', agentKeywords: null },
            { projectId: 'p-analyst', agentTrigger: 'mention', agentKeywords: null },
          ],
          userEmails: ['ana@example.com', 'lead@example.com', 'someone-who-joined@example.com'],
        },
        { name: 'pipeline-alerts', topic: null, private: true, agents: [{ projectId: 'p-intake', agentTrigger: 'mention', agentKeywords: null }], userEmails: [] },
      ],
      groups: { maintainers: ['ana@example.com'] },
    }
    const diff = computeSystemDiff(channelsManifest(), boundLive, boundLock, { callerProjectId: 'p-intake', teamChannels })
    expect(diff.teamChannels).toEqual([])
  })

  test('retriggers changed agents, removes undeclared manifest agents, and leaves outside agents alone', () => {
    const diff = computeSystemDiff(channelsManifest(), boundLive, boundLock, {
      callerProjectId: 'p-intake',
      teamChannels: {
        channels: [
          {
            name: 'pipeline-alerts', topic: null, private: true,
            agents: [
              { projectId: 'p-intake', agentTrigger: 'all', agentKeywords: null },
              { projectId: 'p-analyst', agentTrigger: 'mention', agentKeywords: null },
              { projectId: 'p-someone-elses', agentTrigger: 'mention', agentKeywords: null },
            ],
            userEmails: [],
          },
        ],
        groups: { maintainers: [] },
      },
    })
    const alerts = diff.teamChannels.find((c) => c.name === 'pipeline-alerts')!
    expect(alerts.action).toBe('update')
    expect(alerts.agents).toEqual([{ key: 'intake', projectId: 'p-intake', agentTrigger: 'mention', agentKeywords: null, agentContextMode: 'shared' }])
    expect(alerts.removeAgents).toEqual([{ key: 'analyst', projectId: 'p-analyst' }])
  })

  test('contextMode isolated is parsed, defaults to shared, and changing it re-applies the agent', () => {
    const parsed = parseSystemManifest({
      version: 1,
      name: 'x',
      projects: [{ key: 'reviewer', name: 'Reviewer' }],
      teamChannels: [{ name: 'eng', members: [{ project: 'reviewer', agentTrigger: 'mention', contextMode: 'isolated' }] }],
    })
    expect(parsed.ok).toBe(true)
    const manifest = parsed.manifest!
    expect(manifest.teamChannels[0].members).toEqual([{ project: 'reviewer', agentTrigger: 'mention', contextMode: 'isolated' }])
    expect(parseSystemManifest({ version: 1, name: 'x', projects: [{ key: 'r', name: 'R' }], teamChannels: [{ name: 'eng', members: [{ project: 'r', contextMode: 'secret' }] }] }).ok).toBe(false)

    const lock: SystemLock = { version: 1, name: 'x', bindings: { reviewer: 'p-rev' } }
    const liveProjects = [live({ id: 'p-rev', name: 'Reviewer' })]
    const channel = (agentContextMode?: string) => ({
      channels: [{ name: 'eng', topic: null, private: false, agents: [{ projectId: 'p-rev', agentTrigger: 'mention', agentKeywords: null, ...(agentContextMode ? { agentContextMode } : {}) }], userEmails: [] }],
      groups: {},
    })
    const diffFor = (agentContextMode?: string) =>
      computeSystemDiff(manifest, liveProjects, lock, { callerProjectId: 'p-rev', teamChannels: channel(agentContextMode) }).teamChannels
    expect(diffFor('isolated')).toEqual([])
    const changed = diffFor('shared')
    expect(changed).toHaveLength(1)
    expect(changed[0].agents).toEqual([{ key: 'reviewer', projectId: 'p-rev', agentTrigger: 'mention', agentKeywords: null, agentContextMode: 'isolated' }])
    expect(changed[0].changes.join(' ')).toContain('isolated')
    expect(diffFor()).toHaveLength(1)
  })

  test('unknown groups and an unreachable team chat become manual steps', () => {
    const noGroup = computeSystemDiff(channelsManifest(), boundLive, boundLock, {
      callerProjectId: 'p-intake',
      teamChannels: { channels: [], groups: {} },
    })
    expect(noGroup.manual.join('\n')).toContain('group @maintainers does not exist yet')
    expect(noGroup.teamChannels[0].groupHandles).toEqual([])

    const offline = computeSystemDiff(channelsManifest(), boundLive, boundLock, { callerProjectId: 'p-intake' })
    expect(offline.teamChannels).toEqual([])
    expect(offline.manual.join('\n')).toContain('create #issue-pipeline, #pipeline-alerts by hand')
  })

  test('agents of projects created in the same apply carry a null projectId', () => {
    const diff = computeSystemDiff(channelsManifest(), [], null, {
      callerProjectId: 'p-caller',
      teamChannels: { channels: [], groups: { maintainers: [] } },
    })
    expect(diff.teamChannels[0].agents.map((a) => a.projectId)).toEqual([null, null])
  })
})
