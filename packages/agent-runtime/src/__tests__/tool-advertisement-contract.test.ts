// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Prompts and tool descriptions must only advertise tools, CLIs and env the
 * main agent actually has. Each block here pins one mismatch found while
 * triaging eval failures (model calls a tool/CLI that isn't there).
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { createTools, workspaceAgentToolsRegistered, type ToolContext } from '../gateway-tools'
import { FileStateCache } from '../file-state-cache'
import { buildCodeAgentGeneralGuide } from '../code-agent-prompt'
import { OPTIMIZED_MCP_DISCOVERY_GUIDE } from '../optimized-prompts'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const WS = '/tmp/test-tool-advertisement-contract'
const gatewaySrc = readFileSync(join(__dirname, '..', 'gateway.ts'), 'utf-8')

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceDir: WS,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    } as any,
    projectId: 'test',
    fileStateCache: new FileStateCache(),
    ...overrides,
  }
}

const toolNames = (ctx: ToolContext) => new Set(createTools(ctx).map((t) => t.name))
const tool = (ctx: ToolContext, name: string) => createTools(ctx).find((t) => t.name === name)!

afterAll(() => rmSync(WS, { recursive: true, force: true }))

describe('code-graph tools (impact_radius / detect_changes / review_context)', () => {
  test('coding guide does not tell the main agent to call them directly', () => {
    const guide = buildCodeAgentGeneralGuide(false)
    expect(guide).not.toContain('impact_radius({')
    expect(guide).toContain('bound to the `explore` and `code-reviewer` subagents')
  })

  test('agent_spawn example uses the real `prompt` parameter', () => {
    const guide = buildCodeAgentGeneralGuide(false)
    expect(guide).toContain('agent_spawn({ type: "code-reviewer", prompt:')
    expect(guide).not.toMatch(/agent_spawn\(\{[^}]*\btask:/)
  })

  describe('write_file impact hint', () => {
    beforeEach(() => {
      rmSync(WS, { recursive: true, force: true })
      mkdirSync(WS, { recursive: true })
      trustWorkspaceForTests(WS)
    })
    afterEach(() => clearTrustForTests())

    test('delegates to a subagent instead of naming a tool the main agent lacks', async () => {
      const graph = { getImpactRadius: () => ({ impactedFiles: ['src/a.ts', 'src/b.ts'] }) }
      const ctx = makeCtx({ workspaceGraph: graph as any })
      const r: any = (await tool(ctx, 'write_file').execute('c1', { path: 'src/util.ts', content: 'export const x = 1\n' })).details
      expect(r.impact_note).toContain('src/a.ts')
      expect(r.impact_note).toContain('explore or code-reviewer subagent')
      expect(r.impact_note).not.toMatch(/^.*Use impact_radius/)
    })
  })
})

describe('server_sync', () => {
  test('main agent is not told to call server_sync (it is devops-subagent only)', () => {
    expect(gatewaySrc).not.toContain("'server_sync({})'")
    expect(gatewaySrc).toContain('agent_spawn({ type: "devops", prompt: "Run server_sync')
  })
})

describe('schedule_create', () => {
  const prev = process.env.WORKSPACE_ID
  afterEach(() => {
    if (prev === undefined) delete process.env.WORKSPACE_ID
    else process.env.WORKSPACE_ID = prev
  })

  test('not registered in a project runtime, and the prompt uses the same gate', () => {
    delete process.env.WORKSPACE_ID
    expect(workspaceAgentToolsRegistered({})).toBe(false)
    expect(toolNames(makeCtx()).has('schedule_create')).toBe(false)
    expect(gatewaySrc).toContain('workspaceAgentToolsRegistered({ workspaceId: process.env.WORKSPACE_ID })')
  })

  test('registered when a workspace id is known', () => {
    process.env.WORKSPACE_ID = 'ws-1'
    expect(workspaceAgentToolsRegistered({})).toBe(true)
    expect(toolNames(makeCtx()).has('schedule_create')).toBe(true)
  })
})

describe('terminal_exec', () => {
  test('not registered without the desktop terminal bridge', () => {
    expect(toolNames(makeCtx()).has('terminal_exec')).toBe(false)
  })

  test('registered when the desktop bridge is wired', () => {
    const ctx = makeCtx({ terminalExec: async () => ({ ok: true }) as any })
    expect(toolNames(ctx).has('terminal_exec')).toBe(true)
  })
})

describe('pre-installed CLIs', () => {
  test('glab and oci are not advertised as installed', () => {
    expect(OPTIMIZED_MCP_DISCOVERY_GUIDE).not.toMatch(/\|\s*glab\s*\|/)
    expect(OPTIMIZED_MCP_DISCOVERY_GUIDE).not.toMatch(/\|\s*oci\s*\|/)
    expect(OPTIMIZED_MCP_DISCOVERY_GUIDE).toContain('CLIs are NOT installed')
  })
})

describe('GitHub credential guidance is consistent', () => {
  test('github_connect, connect and the integrations guide agree on where a GitHub token goes', () => {
    const ctx = makeCtx()
    const gh = tool(ctx, 'github_connect').description
    const connect = tool(ctx, 'connect').description
    expect(gh).toContain('do not also write it to `.env`')
    expect(gh).toContain('without naming a repository')
    expect(connect).toContain('for a project\'s repository, use `github_connect`')
    expect(connect).not.toContain('If gh is not authenticated, save a PAT to `.env` as GITHUB_TOKEN and retry.')
    expect(OPTIMIZED_MCP_DISCOVERY_GUIDE).not.toContain('GITHUB_TOKEN=ghp_xxx')
    expect(OPTIMIZED_MCP_DISCOVERY_GUIDE).toContain('do not also write it to `.env`')
  })
})
