// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Structural checks for the eng-pod template (`templates/eng-pod/`): the
 * checked-in manifest matches its generator, applies cleanly to an empty
 * workspace, wires #eng the way the demo needs (auto coordinator, isolated
 * reviewer), ships its permission rules, and the prompts mention the tools and
 * hand-off lines the flow depends on.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeSystemDiff, parseSystemManifest } from '../system-manifest'
import { loadDirTemplates } from '../template-loader'
import { ALL_TOOL_NAMES } from '../gateway-tools'
import { CHANNEL_TOOL_NAMES } from '../channel-tools'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIR = join(__dirname, '..', '..', 'templates', 'eng-pod')
const read = (p: string) => readFileSync(join(DIR, p), 'utf-8')
const manifest = () => parseSystemManifest(read('shogo-system.yaml'))

describe('eng-pod manifest', () => {
  test('shogo-system.yaml matches what eng-pod-manifest-gen.ts produces (no drift)', async () => {
    const { renderManifestYaml } = await import('../eng-pod-manifest-gen')
    expect(read('shogo-system.yaml')).toBe(renderManifestYaml())
  })

  test('parses cleanly: the coordinator anchors, plus a builder and a reviewer', () => {
    const parsed = manifest()
    expect(parsed.errors).toEqual([])
    expect(parsed.manifest!.anchor).toBe('coordinator')
    expect(parsed.manifest!.projects.map((p) => p.key).sort()).toEqual(['builder', 'coordinator', 'reviewer'])
    const names = parsed.manifest!.projects.map((p) => p.name)
    expect(new Set(names).size).toBe(3)
  })

  test('applies to an empty workspace with no manual steps: two projects, one channel', () => {
    const diff = computeSystemDiff(manifest().manifest!, [], null, {
      callerProjectId: 'caller-1',
      teamChannels: { channels: [], groups: { maintainers: ['lead@example.com'] } },
    })
    expect(diff.create.map((c) => c.key).sort()).toEqual(['builder', 'reviewer'])
    expect(diff.adopt).toEqual([{ kind: 'adopt', key: 'coordinator', projectId: 'caller-1', reason: 'anchor' }])
    expect(diff.manual).toEqual([])
    expect(diff.teamChannels.map((c) => `${c.action} ${c.name}`)).toEqual(['create eng'])
  })

  test('#eng: the coordinator watches (auto), the builder runs when tagged, the reviewer is isolated, maintainers are in', () => {
    const [eng] = computeSystemDiff(manifest().manifest!, [], null, {
      callerProjectId: 'caller-1',
      teamChannels: { channels: [], groups: { maintainers: ['lead@example.com'] } },
    }).teamChannels
    const by = Object.fromEntries(eng.agents.map((a) => [a.key, a]))
    expect(by.coordinator.agentTrigger).toBe('auto')
    expect(by.builder.agentTrigger).toBe('mention')
    expect(by.reviewer.agentTrigger).toBe('mention')
    expect(by.coordinator.agentContextMode).toBe('shared')
    expect(by.builder.agentContextMode).toBe('shared')
    expect(by.reviewer.agentContextMode).toBe('isolated')
    expect(eng.groupHandles).toEqual(['maintainers'])
  })

  test('the reviewer can read the builder\'s checkout but not change it', () => {
    const diff = computeSystemDiff(manifest().manifest!, [], null, { callerProjectId: 'caller-1' })
    const edges = diff.attach.filter((a) => a.anchorKey !== '__caller__').map((a) => `${a.anchorKey}>${a.targetKey}:${a.mode}`).sort()
    expect(edges).toContain('reviewer>builder:readonly')
    expect(edges.some((e) => e.startsWith('builder>'))).toBe(false)
  })
})

describe('eng-pod permission rules', () => {
  const rules = (project: string) => {
    const spec = manifest().manifest!.projects.find((p) => p.key === project)!
    return JSON.parse(spec.files['.shogo/permissions.json'])
  }

  test('only the builder can ask to merge; everyone is blocked from merging in the shell', () => {
    expect(rules('builder').actions.github_merge_pr).toBe('ask')
    expect(rules('coordinator').actions.github_merge_pr).toBe('block')
    expect(rules('reviewer').actions.github_merge_pr).toBe('block')
    for (const key of ['builder', 'coordinator', 'reviewer']) {
      expect(rules(key).shellCommands.deny).toContain('*gh pr merge*')
    }
  })
})

describe('eng-pod prompts', () => {
  const channelTools = new Set<string>(CHANNEL_TOOL_NAMES)
  const toolsIn = (text: string) => [...text.matchAll(/`((?:team_chat|github)_[a-z_]+)/g)].map((m) => m[1])

  test('every tool they name exists', () => {
    const known = new Set<string>([...channelTools, ...ALL_TOOL_NAMES])
    for (const file of ['.shogo/AGENTS.md', 'builder/AGENTS.md', 'reviewer/AGENTS.md']) {
      for (const tool of toolsIn(read(file))) expect([file, tool, known.has(tool)]).toEqual([file, tool, true])
    }
  })

  test('the hand-offs the flow depends on are spelled out', () => {
    const coordinator = read('.shogo/AGENTS.md')
    const builder = read('builder/AGENTS.md')
    const reviewer = read('reviewer/AGENTS.md')
    // The coordinator writes the criteria the reviewer will be judged from, and passes the card id on.
    expect(coordinator).toContain('["Triage", "Fix", "Review", "Merge"]')
    expect(coordinator).toContain('criteria')
    expect(coordinator).toContain('card message id')
    // The builder carries the attempt count, because the reviewer cannot remember it.
    expect(builder).toContain('Review attempt 1 of 2.')
    expect(builder).toContain('Review attempt 2 of 2.')
    expect(builder).toContain('github_merge_pr')
    expect(builder).toContain('PUBLIC_PREVIEW_URL')
    expect(reviewer).toContain('PASS')
    expect(reviewer).toContain('FAIL')
    expect(reviewer).toContain('kind: "alert"')
    expect(reviewer).toContain('attempt 2')
  })

  test('the briefing prompt asks for the three lists', () => {
    const prompt = read('briefing.prompt.md')
    for (const heading of ['Shipped', 'Waiting on you', 'Blocked']) expect(prompt).toContain(heading)
  })
})

describe('eng-pod in the template catalog', () => {
  test('is listed with its skill and pinned model, and does not run a heartbeat', () => {
    const t = loadDirTemplates().find((x) => x.id === 'eng-pod')!
    expect(t).toBeTruthy()
    expect(t.name).toBe('Engineering Team in a Channel')
    expect(t.skills).toContain('task-source-github-issues')
    expect(t.settings.modelName).toBe('claude-sonnet-4-6')
    expect(t.settings.heartbeatEnabled).toBe(false)
    expect(t.files['AGENTS.md']).toContain('Coordinator')
  })
})
