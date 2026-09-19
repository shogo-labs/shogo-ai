// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `.shogo/agents/<name>.md` custom subagent types must be auto-registered
 * with the gateway's AgentManager at construction time, so
 * `agent_spawn({ type: "<name>" })` resolves them without the coordinator
 * having to fall back to `general-purpose` or re-declare them at runtime
 * via `agent_create`.
 *
 * Regression test for a real bug: `loadCustomAgents()` existed (and is
 * exercised directly by `subagent.test.ts`) but nothing ever called it at
 * gateway startup, so every `.shogo/agents/*.md` file on disk was silently
 * invisible to `agent_spawn` / `agent_list` for the entire life of the
 * process — reproduced live against the issue-pipeline-solo template.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { AgentGateway } from '../gateway'

const ROOT = '/tmp/test-gw-custom-agent-autoload'

function makeWs(name: string): string {
  const ws = join(ROOT, name)
  if (existsSync(ws)) rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  mkdirSync(join(ws, 'memory'), { recursive: true })
  writeFileSync(join(ws, 'config.json'), JSON.stringify({
    heartbeatInterval: 1800, heartbeatEnabled: false,
    quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
    channels: [],
    model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
  }))
  writeFileSync(join(ws, 'AGENTS.md'), '# Identity\nv4\n')
  return ws
}

beforeAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})
afterAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
})

describe('AgentGateway auto-registers .shogo/agents/*.md at construction', () => {
  test('a well-formed custom agent file is registered and resolvable by name', () => {
    const ws = makeWs('happy-path')
    mkdirSync(join(ws, '.shogo', 'agents'), { recursive: true })
    writeFileSync(
      join(ws, '.shogo', 'agents', 'analyst.md'),
      [
        '---',
        'name: analyst',
        'description: Root-cause analysis and 5 solution options',
        'tools: [read_file, search, exec]',
        'model: hoshi-2-0',
        'maxTurns: 15',
        '---',
        '',
        '# Analyst',
        '',
        'Turn a report into a root cause and 5 options.',
        '',
      ].join('\n'),
    )

    const gw = new AgentGateway(ws, 'p1')
    const config = gw.agentManager.getConfig('analyst')
    expect(config).not.toBeNull()
    expect(config?.description).toBe('Root-cause analysis and 5 solution options')
    expect(config?.model).toBe('hoshi-2-0')
    expect(config?.maxTurns).toBe(15)
    expect(config?.toolNames).toEqual(['read_file', 'search', 'exec'])
    expect(config?.systemPrompt).toContain('Turn a report into a root cause')

    const listed = gw.agentManager.listTypes()
    expect(listed.some(t => t.name === 'analyst' && !t.builtin)).toBe(true)
  })

  test('multiple custom agent files are all registered', () => {
    const ws = makeWs('multi')
    mkdirSync(join(ws, '.shogo', 'agents'), { recursive: true })
    for (const name of ['security', 'scalability', 'dry']) {
      writeFileSync(
        join(ws, '.shogo', 'agents', `${name}.md`),
        `---\nname: ${name}\ndescription: ${name} reviewer\nmodel: claude-haiku-4-5\n---\n\nReview the diff.\n`,
      )
    }

    const gw = new AgentGateway(ws, 'p1')
    for (const name of ['security', 'scalability', 'dry']) {
      expect(gw.agentManager.getConfig(name)).not.toBeNull()
    }
  })

  test('a missing .shogo/agents directory does not throw and registers nothing extra', () => {
    const ws = makeWs('no-agents-dir')
    expect(() => new AgentGateway(ws, 'p1')).not.toThrow()
    const gw = new AgentGateway(ws, 'p1')
    expect(gw.agentManager.getConfig('analyst')).toBeNull()
  })

  test('a malformed agent file (missing name/description) is skipped, not fatal', () => {
    const ws = makeWs('malformed')
    mkdirSync(join(ws, '.shogo', 'agents'), { recursive: true })
    writeFileSync(join(ws, '.shogo', 'agents', 'broken.md'), '---\nmodel: claude-haiku-4-5\n---\n\nNo name or description.\n')
    writeFileSync(
      join(ws, '.shogo', 'agents', 'ok.md'),
      '---\nname: ok\ndescription: fine\n---\n\nBody.\n',
    )

    expect(() => new AgentGateway(ws, 'p1')).not.toThrow()
    const gw = new AgentGateway(ws, 'p1')
    expect(gw.agentManager.getConfig('broken')).toBeNull()
    expect(gw.agentManager.getConfig('ok')).not.toBeNull()
  })
})
