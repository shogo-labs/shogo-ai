// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `.shogo/agents/<name>.md` custom subagent types must be auto-registered
 * with the gateway's AgentManager during `start()`, so
 * `agent_spawn({ type: "<name>" })` resolves them without the coordinator
 * having to fall back to `general-purpose` or re-declare them at runtime
 * via `agent_create`.
 *
 * Regression test for a real bug with two layers:
 *
 * 1. `loadCustomAgents()` existed (and is exercised directly by
 *    `subagent.test.ts`) but nothing ever called it at gateway startup, so
 *    every `.shogo/agents/*.md` file on disk was silently invisible to
 *    `agent_spawn` / `agent_list` for the entire life of the process.
 * 2. The first fix attempt called `loadCustomAgents()` + `register()` in the
 *    *constructor*. That looked fine in isolation (registry has the entry
 *    right after `new AgentGateway(...)`), but `start()` later calls
 *    `agentManager.attachPersistence(sessionPersistence)`, which does
 *    `registry.clear()` then hydrates from the on-disk SQLite session DB —
 *    silently wiping out anything registered before it. Reproduced live
 *    against the issue-pipeline-solo template: `agent_spawn({ type:
 *    "planner" })` still failed with "Unknown agent type" even though the
 *    boot log printed "Loaded 8 custom agent type(s) from .shogo/agents/".
 *    The fix must run the registration *after* `attachPersistence()`
 *    inside `start()`, not in the constructor.
 *
 * These tests exercise the real `start()` path (not just construction) so
 * they catch ordering regressions like #2, not just the presence of #1's
 * fix.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
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

let liveGateways: AgentGateway[] = []

beforeAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})
afterAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
})
afterEach(async () => {
  for (const gw of liveGateways) {
    await gw.stop().catch(() => {})
  }
  liveGateways = []
})

async function startedGateway(ws: string): Promise<AgentGateway> {
  const gw = new AgentGateway(ws, 'p1')
  await gw.start()
  liveGateways.push(gw)
  return gw
}

describe('AgentGateway auto-registers .shogo/agents/*.md (post-attachPersistence, in start())', () => {
  test('a well-formed custom agent file is registered and resolvable by name after start()', async () => {
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

    const gw = await startedGateway(ws)
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

  test('multiple custom agent files are all registered after start()', async () => {
    const ws = makeWs('multi')
    mkdirSync(join(ws, '.shogo', 'agents'), { recursive: true })
    for (const name of ['security', 'scalability', 'dry']) {
      writeFileSync(
        join(ws, '.shogo', 'agents', `${name}.md`),
        `---\nname: ${name}\ndescription: ${name} reviewer\nmodel: claude-haiku-4-5\n---\n\nReview the diff.\n`,
      )
    }

    const gw = await startedGateway(ws)
    for (const name of ['security', 'scalability', 'dry']) {
      expect(gw.agentManager.getConfig(name)).not.toBeNull()
    }
  })

  test('a missing .shogo/agents directory does not throw and registers nothing extra', async () => {
    const ws = makeWs('no-agents-dir')
    const gw = await startedGateway(ws)
    expect(gw.agentManager.getConfig('analyst')).toBeNull()
  })

  test('a malformed agent file gets a filename fallback, not a silent skip', async () => {
    const ws = makeWs('malformed')
    mkdirSync(join(ws, '.shogo', 'agents'), { recursive: true })
    writeFileSync(join(ws, '.shogo', 'agents', 'broken.md'), '---\nmodel: claude-haiku-4-5\n---\n\nNo name or description.\n')
    writeFileSync(
      join(ws, '.shogo', 'agents', 'ok.md'),
      '---\nname: ok\ndescription: fine\n---\n\nBody.\n',
    )

    const gw = await startedGateway(ws)
    expect(gw.agentManager.getConfig('broken')).not.toBeNull()
    expect(gw.agentManager.getConfig('broken')?.description).toContain('No name or description')
    expect(gw.agentManager.getConfig('ok')).not.toBeNull()
  })

  test('custom agents survive attachPersistence() — the actual regression', async () => {
    // Directly reproduces the bug: registering before attachPersistence()
    // runs (e.g. in the constructor) gets wiped by its registry.clear().
    // This test fails if the registration is ever moved back to before
    // that call.
    const ws = makeWs('survives-persistence')
    mkdirSync(join(ws, '.shogo', 'agents'), { recursive: true })
    writeFileSync(
      join(ws, '.shogo', 'agents', 'planner.md'),
      '---\nname: planner\ndescription: Turns a picked option into a plan\nmodel: hoshi-2-0\n---\n\nPlan the work.\n',
    )

    const gw = await startedGateway(ws)
    // If registration happened before attachPersistence()'s registry.clear(),
    // this would be null even though the boot-time log claimed success.
    expect(gw.agentManager.getConfig('planner')).not.toBeNull()
    expect(gw.agentManager.listTypes().some(t => t.name === 'planner')).toBe(true)
  })
})
