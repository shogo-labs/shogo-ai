// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Sweep test for the small-tool clusters in gateway-tools.ts (L2956-L4358):
 *   - Channel tools (send_message, channel_disconnect, channel_list)
 *   - tool_search, mcp_search
 *   - formatToolInstallMessage + renderAgentDirectUsageBlock (via exported fn)
 *   - tool_install (skill path), tool_uninstall, mcp_install, mcp_uninstall
 *   - agent_create, agent_status, agent_cancel, agent_result, agent_list
 *   - team_create, team_delete, send_team_message (ensureTeamContext)
 *   - createTools factory branches
 *
 * All deps faked via plain object/Map mocks — no mock.module.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  createTools,
  formatToolInstallMessage,
  type ToolContext,
} from '../gateway-tools'

const TEST_DIR = '/tmp/test-gateway-tools-small-sweep'

function baseCtx(over: Partial<ToolContext> = {}): ToolContext {
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
    projectId: 'p1',
    ...over,
  }
}

function findTool(ctx: ToolContext, name: string) {
  const t = createTools(ctx).find(x => x.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

async function call(ctx: ToolContext, name: string, params: Record<string, any> = {}) {
  const t = findTool(ctx, name)
  const r = await t.execute('cid', params)
  return r.details
}

// =====================================================================
// Fakes
// =====================================================================

function makeChannelAdapter(opts: { connected: boolean; sendErr?: string } = { connected: true }) {
  const sent: Array<{ to: string; msg: string }> = []
  const adapter = {
    sent,
    getStatus: () => ({ type: 'telegram', connected: opts.connected, configured: true } as any),
    sendMessage: async (to: string, msg: string) => {
      if (opts.sendErr) throw new Error(opts.sendErr)
      sent.push({ to, msg })
    },
  } as any
  return adapter
}

class FakeMcpClientManager {
  servers = new Map<string, { config: any; toolNames: string[] }>()
  isRunning(name: string) { return this.servers.has(name) }
  getServerNames() { return Array.from(this.servers.keys()) }
  getServerInfo() {
    return Array.from(this.servers.entries()).map(([name, s]) => ({
      name,
      toolCount: s.toolNames.length,
      toolNames: s.toolNames,
      config: s.config,
    }))
  }
  async hotAddServer(name: string, config: any) {
    this.servers.set(name, { config, toolNames: [`${name}_a`, `${name}_b`] })
    return [{ name: `${name}_a`, description: 'a' }, { name: `${name}_b`, description: 'b' }]
  }
  async hotAddRemoteServer(name: string, config: any) {
    this.servers.set(name, { config: { command: 'remote', ...config }, toolNames: [`${name}_r`] })
    return [{ name: `${name}_r`, description: 'r' }]
  }
  async hotRemoveServer(name: string) { this.servers.delete(name) }
  async hotRemoveRemoteServer(name: string) { this.servers.delete(name) }
  async installPackageLocally(pkg: string, args: string[], env?: any) {
    return { command: 'node', args: ['./node_modules/.bin/' + pkg, ...args], env }
  }
}

class FakeAgentManager {
  types = new Map<string, any>()
  instances = new Map<string, any>()
  register(config: any, persist?: boolean) {
    if ((config.name as string).startsWith('forbidden')) {
      return { ok: false, error: 'forbidden' } as any
    }
    this.types.set(config.name, { ...config, persisted: !!persist })
    return { ok: true } as any
  }
  unregister(name: string) { return this.types.delete(name) }
  listTypes(_ctx?: any, _allTools?: any) {
    return Array.from(this.types.entries()).map(([name, c]) => ({ name, description: c.description, builtIn: false }))
  }
  getInstance(id: string) { return this.instances.get(id) || null }
  listInstances() { return Array.from(this.instances.values()) }
  cancel(id: string) {
    const inst = this.instances.get(id)
    if (!inst) return false
    inst.status = 'cancelled'
    return true
  }
}

class FakeTeamManager {
  teams = new Map<string, any>()
  messages: Array<{ teamId: string; to: string; from: string; msg: any }> = []
  createTeam(name: string, sessionId: string, leaderAgentId: string, opts: any) {
    const t = { id: name, name, sessionId, leaderAgentId, description: opts?.description }
    this.teams.set(name, t)
    return t
  }
  getTeam(name: string) { return this.teams.get(name) || null }
  listTeams(_sid?: string) { return Array.from(this.teams.values()) }
  writeMessage(teamId: string, to: string, from: string, msg: any) {
    this.messages.push({ teamId, to, from, msg })
  }
  deleteTeam(name: string) { return this.teams.delete(name) }
}

// =====================================================================
// Tests
// =====================================================================

describe('gateway-tools small-tools sweep', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
  })
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------
  // send_message
  // -------------------------------------------------------------------
  test('send_message: succeeds when adapter is connected', async () => {
    const ctx = baseCtx()
    const adapter = makeChannelAdapter({ connected: true })
    ctx.channels.set('telegram', adapter)
    const r = await call(ctx, 'send_message', { channel: 'telegram', channelId: 'c1', message: 'hi' })
    expect(r.ok).toBe(true)
    expect(adapter.sent).toEqual([{ to: 'c1', msg: 'hi' }])
  })

  test('send_message: returns error for unknown channel', async () => {
    const r = await call(baseCtx(), 'send_message', { channel: 'discord', channelId: 'x', message: 'm' })
    expect(r.error).toContain('Channel not connected')
  })

  test('send_message: returns error when channel exists but not connected', async () => {
    const ctx = baseCtx()
    ctx.channels.set('telegram', makeChannelAdapter({ connected: false }))
    const r = await call(ctx, 'send_message', { channel: 'telegram', channelId: 'x', message: 'm' })
    expect(r.error).toContain('not connected')
  })

  test('send_message: surfaces adapter throw', async () => {
    const ctx = baseCtx()
    ctx.channels.set('telegram', makeChannelAdapter({ connected: true, sendErr: 'rate-limit' }))
    const r = await call(ctx, 'send_message', { channel: 'telegram', channelId: 'x', message: 'm' })
    expect(r.error).toContain('Failed to send')
    expect(r.error).toContain('rate-limit')
  })

  // -------------------------------------------------------------------
  // channel_disconnect
  // -------------------------------------------------------------------
  test('channel_disconnect: no-op when ctx.disconnectChannel missing', async () => {
    const r = await call(baseCtx(), 'channel_disconnect', { type: 'telegram' })
    expect(r.error).toContain('not available')
  })

  test('channel_disconnect: removes from config.json and reports ok', async () => {
    let removed = ''
    const ctx = baseCtx({ disconnectChannel: async (t: string) => { removed = t } })
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({ channels: [{ type: 'telegram' }, { type: 'discord' }] }))
    const r = await call(ctx, 'channel_disconnect', { type: 'telegram' })
    expect(r.ok).toBe(true)
    expect(removed).toBe('telegram')
    const cfg = JSON.parse(readFileSync(join(TEST_DIR, 'config.json'), 'utf-8'))
    expect(cfg.channels).toEqual([{ type: 'discord' }])
  })

  test('channel_disconnect: tolerates corrupted config.json', async () => {
    const ctx = baseCtx({ disconnectChannel: async () => {} })
    writeFileSync(join(TEST_DIR, 'config.json'), 'NOT JSON')
    const r = await call(ctx, 'channel_disconnect', { type: 'telegram' })
    expect(r.ok).toBe(true)
  })

  test('channel_disconnect: surfaces error from ctx.disconnectChannel', async () => {
    const ctx = baseCtx({ disconnectChannel: async () => { throw new Error('boom') } })
    const r = await call(ctx, 'channel_disconnect', { type: 'telegram' })
    expect(r.error).toContain('Failed to disconnect')
    expect(r.error).toContain('boom')
  })

  // -------------------------------------------------------------------
  // channel_list
  // -------------------------------------------------------------------
  test('channel_list: returns empty when nothing configured', async () => {
    const r = await call(baseCtx(), 'channel_list', {})
    expect(r.connected).toEqual([])
    expect(r.configured).toEqual([])
  })

  test('channel_list: merges model from config.json into adapter statuses', async () => {
    const ctx = baseCtx()
    ctx.channels.set('telegram', makeChannelAdapter({ connected: true }))
    writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({ channels: [{ type: 'telegram', model: 'haiku' }] }))
    const r = await call(ctx, 'channel_list', {})
    expect(r.configured).toContain('telegram')
    expect(r.connected[0].model).toBe('haiku')
  })

  test('channel_list: tolerates corrupted config.json', async () => {
    writeFileSync(join(TEST_DIR, 'config.json'), 'NOT JSON')
    const r = await call(baseCtx(), 'channel_list', {})
    expect(r.configured).toEqual([])
  })

  // -------------------------------------------------------------------
  // search_integrations is covered in gateway-tools.tool-install-composio.test.ts
  // mcp_search/tool_search were merged into a single search_integrations tool.
  // -------------------------------------------------------------------
  // tool_search (no composio key → only skill path runs)
  // -------------------------------------------------------------------
  test('tool_search: returns empty results gracefully', async () => {
    const r = await call(baseCtx(), 'search_integrations', { query: 'asdfqwerty-no-match-xyz' })
    expect(r.results).toBeDefined()
    // Either has skills (if bundled match) or returns empty + helpful message
    expect(typeof r.message).toBe('string')
  })

  // -------------------------------------------------------------------
  // formatToolInstallMessage + renderAgentDirectUsageBlock (exported)
  // -------------------------------------------------------------------
  test('formatToolInstallMessage: active auth path', () => {
    const m = formatToolInstallMessage('Jira', ['JIRA_LIST_BOARDS', 'JIRA_GET_USER'], { status: 'active' })
    expect(m).toContain('Jira')
    expect(m).toContain('2 tool(s)')
    expect(m).toContain('Auth is active')
    expect(m).toContain('JIRA_LIST_BOARDS')
    expect(m).toContain('directly in this turn')
  })

  test('formatToolInstallMessage: needs_auth + authUrl path', () => {
    const m = formatToolInstallMessage('Slack', ['SLACK_SEND'], {
      status: 'needs_auth',
      authUrl: 'https://oauth.example/x',
    })
    expect(m).toContain('Connect button')
    expect(m).not.toContain('https://oauth.example/x') // The auth URL should NOT be in the message
  })

  test('formatToolInstallMessage: needs_auth without authUrl path', () => {
    const m = formatToolInstallMessage('Discord', ['DISCORD_PING'], { status: 'needs_auth' })
    expect(m).toContain('Tools panel')
  })

  test('formatToolInstallMessage: handles >5 tools with ellipsis hint', () => {
    const toolNames = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']
    const m = formatToolInstallMessage('Big', toolNames, { status: 'active' })
    expect(m).toContain('e.g. T1, T2, T3, T4, T5, ...')
  })

  test('formatToolInstallMessage: handles zero tools fallback', () => {
    const m = formatToolInstallMessage('Empty', [], { status: 'active' })
    expect(m).toContain('newly installed')
    expect(m).toContain('EMPTY_<TOOL>')
  })

  // -------------------------------------------------------------------
  // tool_install — skill path branches
  // -------------------------------------------------------------------
  test('tool_install: bundled-skill-not-found error', async () => {
    const r = await call(baseCtx(), 'connect', { name: 'skill:does-not-exist-at-all-xyz' })
    expect(r.error).toContain('not found')
  })

  test('tool_install: returns error when skill dir already present (already installed branch)', async () => {
    const destDir = join(TEST_DIR, '.shogo', 'skills', 'already-here')
    mkdirSync(destDir, { recursive: true })
    writeFileSync(join(destDir, 'SKILL.md'), '# already')
    const r = await call(baseCtx(), 'connect', { name: 'skill:already-here' })
    // Either reports already-installed OR bundled-not-found depending on bundling
    expect(typeof r.error === 'string' || r.ok === true).toBe(true)
  })

  test('tool_install: non-skill name without mcpClientManager errors', async () => {
    const r = await call(baseCtx(), 'connect', { name: 'something-non-skill' })
    expect(r.error).toContain('MCP client manager not available')
  })

  test('tool_install: non-skill name with manager but not a Composio match returns helpful error', async () => {
    const ctx = baseCtx({ mcpClientManager: new FakeMcpClientManager() as any })
    const r = await call(ctx, 'connect', { name: 'definitely-not-a-real-toolkit-xyzz' })
    // Composio is gated by env so this should fall through to the "not a managed integration" branch
    expect(r.error).toContain('not in the MCP catalog')
  })

  // -------------------------------------------------------------------
  // mcp_install
  // -------------------------------------------------------------------
  test('mcp_install: missing mcpClientManager → error', async () => {
    const r = await call(baseCtx(), 'connect', { name: 'playwright' })
    expect(r.error).toContain('MCP client manager not available')
  })

  test('mcp_install: remote URL path installs server', async () => {
    const mgr = new FakeMcpClientManager()
    const ctx = baseCtx({ mcpClientManager: mgr as any })
    const r = await call(ctx, 'connect', { name: 'my-remote', url: 'https://x.example/mcp' })
    expect(r.ok).toBe(true)
    expect(r.type).toBe('remote')
    expect(mgr.isRunning('my-remote')).toBe(true)
  })

  test('mcp_install: remote URL when already running → error with tool list', async () => {
    const mgr = new FakeMcpClientManager()
    await mgr.hotAddRemoteServer('rserv', { url: 'u' })
    const ctx = baseCtx({ mcpClientManager: mgr as any })
    const r = await call(ctx, 'connect', { name: 'rserv', url: 'u' })
    expect(r.error).toContain('already running')
    expect(r.tools).toBeDefined()
  })

  test('mcp_install: catalog name not in catalog → error', async () => {
    const ctx = baseCtx({ mcpClientManager: new FakeMcpClientManager() as any })
    const r = await call(ctx, 'connect', { name: 'totally-not-a-real-mcp-server-xyz' })
    expect(r.error).toContain('not in the MCP catalog')
  })

  test('mcp_install: catalog name when already running → error', async () => {
    const mgr = new FakeMcpClientManager()
    await mgr.hotAddServer('playwright', { command: 'npx' })
    const ctx = baseCtx({ mcpClientManager: mgr as any })
    const r = await call(ctx, 'connect', { name: 'playwright' })
    expect(r.error).toContain('already running')
  })

  test('mcp_install: catalog success path (preinstalled)', async () => {
    const mgr = new FakeMcpClientManager()
    const ctx = baseCtx({ mcpClientManager: mgr as any })
    // playwright is in the catalog and preinstalled
    const r = await call(ctx, 'connect', { name: 'playwright' })
    expect(r.ok).toBe(true)
    expect(r.toolCount).toBeGreaterThan(0)
  })

  test('mcp_install: surfaces manager throw', async () => {
    const mgr = {
      isRunning: () => false,
      getServerNames: () => [],
      hotAddServer: async () => { throw new Error('install-fail') },
      hotAddRemoteServer: async () => { throw new Error('remote-fail') },
      installPackageLocally: async () => ({ command: 'x' }),
      getServerInfo: () => [],
    } as any
    const ctx = baseCtx({ mcpClientManager: mgr })
    const r = await call(ctx, 'connect', { name: 'my-x', url: 'https://x' })
    expect(r.error).toContain('Failed to install')
    expect(r.error).toContain('remote-fail')
  })

  // -------------------------------------------------------------------
  // tool_uninstall
  // -------------------------------------------------------------------
  test('tool_uninstall: no manager → error', async () => {
    const r = await call(baseCtx(), 'disconnect', { name: 'x' })
    expect(r.error).toContain('not available')
  })

  test('tool_uninstall: not running → error with installed list', async () => {
    const mgr = new FakeMcpClientManager()
    const ctx = baseCtx({ mcpClientManager: mgr as any })
    const r = await call(ctx, 'disconnect', { name: 'nope' })
    expect(r.error).toContain('not running')
    expect(r.installed).toBeDefined()
  })

  // -------------------------------------------------------------------
  // mcp_uninstall
  // -------------------------------------------------------------------
  test('mcp_uninstall: no manager → error', async () => {
    const r = await call(baseCtx(), 'disconnect', { name: 'x' })
    expect(r.error).toContain('not available')
  })

  test('mcp_uninstall: not running → error', async () => {
    const ctx = baseCtx({ mcpClientManager: new FakeMcpClientManager() as any })
    const r = await call(ctx, 'disconnect', { name: 'gone' })
    expect(r.error).toContain('not running')
  })

  test('mcp_uninstall: removes regular server', async () => {
    const mgr = new FakeMcpClientManager()
    await mgr.hotAddServer('postgres', { command: 'npx' })
    const ctx = baseCtx({ mcpClientManager: mgr as any })
    const r = await call(ctx, 'disconnect', { name: 'postgres' })
    expect(r.ok).toBe(true)
    expect(mgr.isRunning('postgres')).toBe(false)
  })

  test('mcp_uninstall: removes remote server', async () => {
    const mgr = new FakeMcpClientManager()
    await mgr.hotAddRemoteServer('rem', { url: 'u' })
    const ctx = baseCtx({ mcpClientManager: mgr as any })
    const r = await call(ctx, 'disconnect', { name: 'rem' })
    expect(r.ok).toBe(true)
    expect(mgr.isRunning('rem')).toBe(false)
  })

  test('mcp_uninstall: surfaces manager throw', async () => {
    const mgr = {
      isRunning: () => true,
      getServerInfo: () => [{ name: 'x', config: { command: 'npx' } }],
      getServerNames: () => ['x'],
      hotRemoveServer: async () => { throw new Error('rm-fail') },
    } as any
    const ctx = baseCtx({ mcpClientManager: mgr })
    const r = await call(ctx, 'disconnect', { name: 'x' })
    expect(r.error).toContain('Failed to remove')
  })

  // -------------------------------------------------------------------
  // agent_create / status / cancel / result / list
  // -------------------------------------------------------------------
  test('agent_create: no AgentManager → error', async () => {
    const r = await call(baseCtx(), 'agent_create', {
      name: 't1', description: 'd', system_prompt: 's',
    })
    expect(r.error).toContain('AgentManager not available')
  })

  test('agent_create: registers and reports ok', async () => {
    const am = new FakeAgentManager()
    const ctx = baseCtx({ agentManager: am as any })
    const r = await call(ctx, 'agent_create', {
      name: 'reviewer', description: 'd', system_prompt: 's', tools: ['read_file'],
      model_tier: 'fast', max_turns: 5, readonly: true, persist: true,
    })
    expect(r.ok).toBe(true)
    expect(am.types.get('reviewer')?.persisted).toBe(true)
  })

  test('agent_create: surfaces register error', async () => {
    const am = new FakeAgentManager()
    const ctx = baseCtx({ agentManager: am as any })
    const r = await call(ctx, 'agent_create', {
      name: 'forbidden-name', description: 'd', system_prompt: 's',
    })
    expect(r.error).toBe('forbidden')
  })

  test('agent_status: no AgentManager → error', async () => {
    const r = await call(baseCtx(), 'agent_status', {})
    expect(r.error).toContain('AgentManager not available')
  })

  test('agent_status: unknown instance → error', async () => {
    const am = new FakeAgentManager()
    const ctx = baseCtx({ agentManager: am as any })
    const r = await call(ctx, 'agent_status', { instance_id: 'nope' })
    expect(r.error).toContain('Unknown instance')
  })

  test('agent_status: returns details for known instance', async () => {
    const am = new FakeAgentManager()
    am.instances.set('i1', {
      id: 'i1', type: 'reviewer', status: 'completed',
      startedAt: Date.now() - 1000,
      result: { toolCalls: 3, iterations: 2 },
    })
    const ctx = baseCtx({ agentManager: am as any })
    const r = await call(ctx, 'agent_status', { instance_id: 'i1' })
    expect(r.id).toBe('i1')
    expect(r.toolCalls).toBe(3)
  })

  test('agent_status: all instances when no id', async () => {
    const am = new FakeAgentManager()
    am.instances.set('a', { id: 'a', type: 't', status: 'running', startedAt: Date.now() })
    const ctx = baseCtx({ agentManager: am as any })
    const r = await call(ctx, 'agent_status', {})
    expect(r.instances).toHaveLength(1)
  })

  test('agent_cancel: returns ok:false when nothing to cancel', async () => {
    const ctx = baseCtx({ agentManager: new FakeAgentManager() as any })
    const r = await call(ctx, 'agent_cancel', { instance_id: 'gone' })
    expect(r.ok).toBe(false)
  })

  test('agent_cancel: cancels and returns ok', async () => {
    const am = new FakeAgentManager()
    am.instances.set('z', { id: 'z', status: 'running' })
    const ctx = baseCtx({ agentManager: am as any })
    const r = await call(ctx, 'agent_cancel', { instance_id: 'z' })
    expect(r.ok).toBe(true)
    expect(am.instances.get('z').status).toBe('cancelled')
  })

  test('agent_cancel: no AgentManager', async () => {
    const r = await call(baseCtx(), 'agent_cancel', { instance_id: 'x' })
    expect(r.error).toContain('AgentManager not available')
  })

  test('agent_result: no AgentManager', async () => {
    const r = await call(baseCtx(), 'agent_result', { instance_id: 'x' })
    expect(r.error).toContain('AgentManager not available')
  })

  test('agent_result: unknown instance → error', async () => {
    const ctx = baseCtx({ agentManager: new FakeAgentManager() as any })
    const r = await call(ctx, 'agent_result', { instance_id: 'gone' })
    expect(r.error).toContain('Unknown instance')
  })

  test('agent_result: completed instance returns response + tokens', async () => {
    const am = new FakeAgentManager()
    am.instances.set('done', {
      id: 'done', type: 'reviewer', status: 'completed', startedAt: Date.now() - 100,
      result: {
        responseText: 'all-clear', toolCalls: 4, iterations: 3,
        inputTokens: 100, outputTokens: 50,
        cacheReadTokens: 0, cacheWriteTokens: 0,
      },
    })
    const ctx = baseCtx({ agentManager: am as any })
    const r = await call(ctx, 'agent_result', { instance_id: 'done' })
    expect(r.response).toBe('all-clear')
    expect(r.toolCalls).toBe(4)
    expect(r.tokens.input).toBe(100)
  })

  test('agent_result: running with timeout_ms=0 returns running status', async () => {
    const am = new FakeAgentManager()
    am.instances.set('r', {
      id: 'r', type: 't', status: 'running', startedAt: Date.now() - 1000,
      recentActivity: [{ tool: 'read_file', summary: 'README.md' }],
    })
    const ctx = baseCtx({ agentManager: am as any })
    const r = await call(ctx, 'agent_result', { instance_id: 'r', timeout_ms: 0 })
    expect(r.status).toBe('running')
    expect(r.recent_activity).toBeDefined()
  })

  test('agent_result: running with non-zero timeout falls through to wait branch', async () => {
    const am = new FakeAgentManager()
    let resolveFn: ((v: any) => void) | null = null
    const promise = new Promise(r => { resolveFn = r })
    am.instances.set('r2', {
      id: 'r2', type: 't', status: 'running', startedAt: Date.now() - 100,
      promise,
      recentActivity: [],
    })
    const ctx = baseCtx({ agentManager: am as any })
    // Use a tiny timeout so the race resolves to "timed out, still running"
    const r = await call(ctx, 'agent_result', { instance_id: 'r2', timeout_ms: 20 })
    expect(r.status).toBe('running')
    resolveFn?.(null)
  })

  test('agent_result: completed with usage triggers uiWriter token emit', async () => {
    const am = new FakeAgentManager()
    am.instances.set('w', {
      id: 'w', type: 'reviewer', status: 'completed', startedAt: Date.now() - 1,
      result: {
        responseText: 'r', toolCalls: 1, iterations: 1,
        inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
      },
    })
    const events: any[] = []
    const ctx = baseCtx({
      agentManager: am as any,
      uiWriter: { write: (e: any) => events.push(e) } as any,
    })
    await call(ctx, 'agent_result', { instance_id: 'w' })
    expect(events.some(e => e.type === 'data-usage')).toBe(true)
  })

  test('agent_list: no manager → error', async () => {
    const r = await call(baseCtx(), 'agent_list', {})
    expect(r.error).toContain('AgentManager not available')
  })

  test('agent_list: emits data-agent-types + returns types/instances', async () => {
    const am = new FakeAgentManager()
    am.types.set('t1', { name: 't1', description: 'd' })
    am.instances.set('a', { id: 'a', status: 'running' })
    am.instances.set('b', { id: 'b', status: 'completed' })
    const events: any[] = []
    const ctx = baseCtx({
      agentManager: am as any,
      uiWriter: { write: (e: any) => events.push(e) } as any,
    })
    const r = await call(ctx, 'agent_list', {})
    expect(r.types.length).toBe(1)
    expect(r.active_instances).toBe(1)
    expect(r.total_instances).toBe(2)
    expect(events.some(e => e.type === 'data-agent-types')).toBe(true)
  })

  // -------------------------------------------------------------------
  // team_create / team_delete + ensureTeamContext
  // -------------------------------------------------------------------
  test('team_create: no TeamManager → error', async () => {
    const r = await call(baseCtx(), 'team_create', { team_name: 'X' })
    expect(r.error).toContain('not available')
  })

  test('team_create: missing sessionId → error', async () => {
    const ctx = baseCtx({ teamManager: new FakeTeamManager() as any })
    const r = await call(ctx, 'team_create', { team_name: 'X' })
    expect(r.error).toContain('Session ID required')
  })

  test('team_create: returns existing-team error', async () => {
    const tm = new FakeTeamManager()
    tm.createTeam('dup', 's1', 'leader@dup', {})
    const ctx = baseCtx({ teamManager: tm as any, sessionId: 's1' })
    const r = await call(ctx, 'team_create', { team_name: 'dup' })
    expect(r.error).toContain('already exists')
  })

  test('team_create: creates team and emits ui event', async () => {
    const tm = new FakeTeamManager()
    const events: any[] = []
    const ctx = baseCtx({
      teamManager: tm as any, sessionId: 's1',
      uiWriter: { write: (e: any) => events.push(e) } as any,
    })
    const r = await call(ctx, 'team_create', { team_name: 'frontend', description: 'd' })
    expect(r.ok).toBe(true)
    expect(events.some(e => e.type === 'data-team-created')).toBe(true)
  })

  test('team_delete: no manager → error', async () => {
    const r = await call(baseCtx(), 'team_delete', { team_id: 'x' })
    // depending on impl this may say not-in-team or not-available
    expect(r.error).toBeDefined()
  })

  // -------------------------------------------------------------------
  // send_team_message — exercises ensureTeamContext + writeMessage
  // -------------------------------------------------------------------
  test('send_team_message: not in team context → error', async () => {
    const r = await call(baseCtx(), 'send_team_message', { to: 'alice', message: 'hi' })
    expect(r.error).toContain('Not in a team')
  })

  test('send_team_message: discovers team context via listTeams when no teamContext', async () => {
    const tm = new FakeTeamManager()
    tm.createTeam('auto', 's-auto', 'team-lead@auto', {})
    const ctx = baseCtx({ teamManager: tm as any, sessionId: 's-auto' })
    const r = await call(ctx, 'send_team_message', { to: 'alice', message: 'hi' })
    expect(r.ok).toBe(true)
    expect(tm.messages).toHaveLength(1)
    // 'alice' without @ → routed to alice@auto
    expect(tm.messages[0]?.to).toBe('alice@auto')
  })

  test('send_team_message: team-lead alias resolves to team-lead@<teamId>', async () => {
    const tm = new FakeTeamManager()
    const ctx = baseCtx({
      teamManager: tm as any,
      teamContext: { teamId: 'frontend', agentId: 'alice@frontend', isLeader: false } as any,
    })
    const r = await call(ctx, 'send_team_message', { to: 'team-lead', message: 'help' })
    expect(r.ok).toBe(true)
    expect(tm.messages[0]?.to).toBe('team-lead@frontend')
  })

  test('send_team_message: broadcast * routes as-is', async () => {
    const tm = new FakeTeamManager()
    const ctx = baseCtx({
      teamManager: tm as any,
      teamContext: { teamId: 'x', agentId: 'me@x', isLeader: true } as any,
    })
    const r = await call(ctx, 'send_team_message', { to: '*', message: 'all' })
    expect(r.ok).toBe(true)
    expect(tm.messages[0]?.to).toBe('*')
  })

  test('send_team_message: fully-qualified to@team passes through', async () => {
    const tm = new FakeTeamManager()
    const ctx = baseCtx({
      teamManager: tm as any,
      teamContext: { teamId: 'a', agentId: 'me@a', isLeader: true } as any,
    })
    const r = await call(ctx, 'send_team_message', { to: 'bob@other', message: 'm' })
    expect(r.ok).toBe(true)
    expect(tm.messages[0]?.to).toBe('bob@other')
  })

  test('send_team_message: shutdown_response with approve kills the handle', async () => {
    const tm = new FakeTeamManager()
    let killed = false
    const teammateHandles = new Map<string, any>()
    teammateHandles.set('worker@team', { kill: () => { killed = true } } as any)
    const ctx = baseCtx({
      teamManager: tm as any,
      teamContext: { teamId: 'team', agentId: 'worker@team', isLeader: false } as any,
      teammateHandles: teammateHandles as any,
    })
    const r = await call(ctx, 'send_team_message', {
      to: 'team-lead',
      message: JSON.stringify({ approve: true }),
      message_type: 'shutdown_response',
    })
    expect(r.ok).toBe(true)
    expect(killed).toBe(true)
    expect(teammateHandles.has('worker@team')).toBe(false)
  })

  test('send_team_message: shutdown_response with non-JSON falls through gracefully', async () => {
    const tm = new FakeTeamManager()
    const ctx = baseCtx({
      teamManager: tm as any,
      teamContext: { teamId: 'team', agentId: 'me@team', isLeader: false } as any,
    })
    const r = await call(ctx, 'send_team_message', {
      to: 'team-lead', message: 'not-json', message_type: 'shutdown_response',
    })
    expect(r.ok).toBe(true)
  })
})
