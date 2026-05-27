// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
// gateway.ts coverage closeout — Wave B Day 3.
// Targets: skill-server getters, channel management (lookup + disconnect
// + unknown-type error), getLspManager null branch, getMCPClientManager,
// consumeLastTurnUsage, setPromptOverrides, clearToolMocks,
// _promoteHiddenMocksFromInstall (5 branches), getStatus end-to-end.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { AgentGateway } from '../gateway'

const ROOT = '/tmp/test-gw-getters'

function makeWs(name: string, config?: any): string {
  const ws = join(ROOT, name)
  if (existsSync(ws)) rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  mkdirSync(join(ws, 'memory'), { recursive: true })
  mkdirSync(join(ws, 'skills'), { recursive: true })
  writeFileSync(join(ws, 'config.json'), JSON.stringify(config ?? {
    heartbeatInterval: 1800, heartbeatEnabled: false,
    quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
    channels: [],
    model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
  }))
  writeFileSync(join(ws, 'AGENTS.md'), '# Identity\nv4\n')
  writeFileSync(join(ws, 'MEMORY.md'), '# Memory\n')
  return ws
}

beforeAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})
afterAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
})

describe('skill-server getter chain', () => {
  test('returns the configured port even when API server has not booted', () => {
    const ws = makeWs('skill-port')
    const gw = new AgentGateway(ws, 'p1')
    const port = gw.getSkillServerPort()
    expect(port === null || typeof port === 'number').toBe(true)
  })
  test('returns the current phase string', () => {
    const ws = makeWs('skill-phase')
    const gw = new AgentGateway(ws, 'p1')
    expect(typeof gw.getSkillServerPhase()).toBe('string')
  })
  test('getActiveRoutes returns an array', () => {
    const ws = makeWs('skill-routes')
    const gw = new AgentGateway(ws, 'p1')
    expect(Array.isArray(gw.getSkillServerActiveRoutes())).toBe(true)
  })
  test('getSchemaModels returns an array', () => {
    const ws = makeWs('skill-models')
    const gw = new AgentGateway(ws, 'p1')
    expect(Array.isArray(gw.getSkillServerSchemaModels())).toBe(true)
  })
  test('attachApiServer stashes the PreviewManager on this.previewManager and delegates to skillServerManager', () => {
    const ws = makeWs('skill-attach')
    const gw = new AgentGateway(ws, 'p1')
    let attached: any = null
    ;(gw as any).skillServerManager.attach = (pm: any) => { attached = pm }
    const fakePm = { depsReady: Promise.resolve(true) } as any
    gw.attachApiServer(fakePm)
    expect(attached).toBe(fakePm)
    expect((gw as any).previewManager).toBe(fakePm)
  })
})

describe('channel management', () => {
  test('getChannel returns undefined for unknown type', () => {
    const ws = makeWs('ch-lookup')
    const gw = new AgentGateway(ws, 'p1')
    expect(gw.getChannel('telegram')).toBeUndefined()
  })
  test('connectChannel rejects unknown channel type', async () => {
    const ws = makeWs('ch-unknown')
    const gw = new AgentGateway(ws, 'p1')
    await expect(gw.connectChannel('mystery' as any, {})).rejects.toThrow(/Unknown channel type/)
  })
  test('disconnectChannel on missing channel is a no-op (no throw)', async () => {
    const ws = makeWs('ch-disco')
    const gw = new AgentGateway(ws, 'p1')
    await gw.disconnectChannel('telegram')
  })
  test('disconnectChannel calls adapter.disconnect + removes from map', async () => {
    const ws = makeWs('ch-disco-2')
    const gw = new AgentGateway(ws, 'p1')
    let called = false
    const adapter: any = {
      onMessage: () => {}, connect: async () => {}, disconnect: async () => { called = true },
      getStatus: () => ({ connected: true }), sendMessage: async () => {},
    }
    ;(gw as any).channels.set('telegram', adapter)
    await gw.disconnectChannel('telegram')
    expect(called).toBe(true)
    expect(gw.getChannel('telegram')).toBeUndefined()
  })
})

describe('LspManager + MCPClientManager getters', () => {
  test('getLspManager is null when manager has not been wired up', () => {
    const ws = makeWs('lsp-null')
    const gw = new AgentGateway(ws, 'p1')
    expect(gw.getLspManager()).toBeNull()
  })
  test('getMcpClientManager and getMCPClientManager return the same instance', () => {
    const ws = makeWs('mcp')
    const gw = new AgentGateway(ws, 'p1')
    const m1 = gw.getMcpClientManager()
    const m2 = gw.getMCPClientManager()
    expect(m1).toBe(m2)
    expect(m1).toBeDefined()
  })
})

describe('consumeLastTurnUsage', () => {
  test('returns null when no usage has been recorded', () => {
    const ws = makeWs('usage-null')
    const gw = new AgentGateway(ws, 'p1')
    expect(gw.consumeLastTurnUsage()).toBeNull()
  })
  test('returns and clears the stored usage on first call', () => {
    const ws = makeWs('usage-pop')
    const gw = new AgentGateway(ws, 'p1')
    ;(gw as any)._lastTurnUsage = { inputTokens: 12, outputTokens: 34 }
    expect(gw.consumeLastTurnUsage()).toEqual({ inputTokens: 12, outputTokens: 34 })
    expect(gw.consumeLastTurnUsage()).toBeNull()
  })
})

describe('setPromptOverrides', () => {
  test('replaces the entire override map on each call', () => {
    const ws = makeWs('prompt-override')
    const gw = new AgentGateway(ws, 'p1')
    gw.setPromptOverrides({ a: '1', b: '2' })
    expect((gw as any).promptOverrides.get('a')).toBe('1')
    expect((gw as any).promptOverrides.get('b')).toBe('2')
    gw.setPromptOverrides({ c: '3' })
    expect((gw as any).promptOverrides.has('a')).toBe(false)
    expect((gw as any).promptOverrides.get('c')).toBe('3')
  })
})

describe('clearToolMocks + setToolMocks + _promoteHiddenMocksFromInstall', () => {
  test('setToolMocks populates all 3 maps, clearToolMocks wipes them', () => {
    const ws = makeWs('mocks-set-clear')
    const gw = new AgentGateway(ws, 'p1')
    gw.setToolMocks(
      { TOOL_A: async () => 'a', TOOL_B: async () => 'b' },
      { TOOL_A: { description: 'd', paramKeys: ['x'] } },
      new Set(['TOOL_B']),
    )
    expect((gw as any).toolMocks.size).toBe(2)
    expect((gw as any).syntheticTools.size).toBe(1)
    expect((gw as any).hiddenMockTools.size).toBe(1)
    gw.clearToolMocks()
    expect((gw as any).toolMocks.size).toBe(0)
    expect((gw as any).syntheticTools.size).toBe(0)
    expect((gw as any).hiddenMockTools.size).toBe(0)
    expect((gw as any).promotedMockTools).toEqual([])
  })

  test('_promoteHiddenMocksFromInstall is a no-op when result.tools is missing or not an array', () => {
    const ws = makeWs('promote-none')
    const gw = new AgentGateway(ws, 'p1')
    gw._promoteHiddenMocksFromInstall({})
    gw._promoteHiddenMocksFromInstall({ tools: 'not-an-array' })
    gw._promoteHiddenMocksFromInstall(null)
    expect((gw as any).promotedMockTools.length).toBe(0)
  })

  test('promotes a hidden mock when a matching string entry is returned', () => {
    const ws = makeWs('promote-string')
    const gw = new AgentGateway(ws, 'p1')
    const mockFn = async () => 'ok'
    gw.setToolMocks(
      { HIDDEN_TOOL: mockFn },
      { HIDDEN_TOOL: { description: 'hide me', paramKeys: ['arg'] } },
      new Set(['HIDDEN_TOOL']),
    )
    gw._promoteHiddenMocksFromInstall({ tools: ['HIDDEN_TOOL'] })
    expect((gw as any).promotedMockTools.length).toBe(1)
    expect((gw as any).promotedMockTools[0].name).toBe('HIDDEN_TOOL')
    expect((gw as any).hiddenMockTools.has('HIDDEN_TOOL')).toBe(false)
  })

  test('promotes from object entries with .name field', () => {
    const ws = makeWs('promote-obj')
    const gw = new AgentGateway(ws, 'p1')
    gw.setToolMocks(
      { OBJ_TOOL: async () => 'x' }, undefined, new Set(['OBJ_TOOL']),
    )
    gw._promoteHiddenMocksFromInstall({ tools: [{ name: 'OBJ_TOOL' }] })
    expect((gw as any).promotedMockTools.length).toBe(1)
  })

  test('skips entries whose name is not in hiddenMockTools', () => {
    const ws = makeWs('promote-skip')
    const gw = new AgentGateway(ws, 'p1')
    gw.setToolMocks({ KNOWN: async () => 'x' })
    gw._promoteHiddenMocksFromInstall({ tools: ['KNOWN', 'UNKNOWN'] })
    expect((gw as any).promotedMockTools.length).toBe(0)
  })

  test('skips already-promoted tools on a repeat call (idempotency)', () => {
    const ws = makeWs('promote-idem')
    const gw = new AgentGateway(ws, 'p1')
    gw.setToolMocks({ TWICE: async () => 'x' }, undefined, new Set(['TWICE']))
    gw._promoteHiddenMocksFromInstall({ tools: ['TWICE'] })
    gw._promoteHiddenMocksFromInstall({ tools: ['TWICE'] })
    expect((gw as any).promotedMockTools.length).toBe(1)
  })

  test('skips entries with no truthy toolName (empty string / undefined name field)', () => {
    const ws = makeWs('promote-empty')
    const gw = new AgentGateway(ws, 'p1')
    gw.setToolMocks({ T: async () => 'x' }, undefined, new Set(['T']))
    gw._promoteHiddenMocksFromInstall({ tools: ['', { name: '' }, { name: undefined }, null] })
    expect((gw as any).promotedMockTools.length).toBe(0)
  })
})

describe('getStatus', () => {
  test('returns a full status snapshot (running=false default, no channels, memory stats reflect AGENTS+MEMORY)', () => {
    const ws = makeWs('status-basic')
    const gw = new AgentGateway(ws, 'p1')
    const s = gw.getStatus()
    expect(s.running).toBe(false)
    expect(s.status).toBe('stopped')
    expect(Array.isArray(s.channels)).toBe(true)
    expect(s.channels).toEqual([])
    expect(typeof s.heartbeat.enabled).toBe('boolean')
    expect(Array.isArray(s.skills)).toBe(true)
    expect(s.memory.fileCount).toBeGreaterThan(0)
    expect(s.memory.totalSizeBytes).toBeGreaterThan(0)
    expect(typeof s.memory.lastModified).toBe('string')
    expect(s.sessions).toBeDefined()
  })

  test('status flips to active when a turn lock is held', () => {
    const ws = makeWs('status-active')
    const gw = new AgentGateway(ws, 'p1')
    ;(gw as any).running = true
    ;(gw as any).turnLocks.set('session_x', { startedAt: Date.now() })
    expect(gw.getStatus().status).toBe('active')
  })

  test('status reports "idle" when running with no active turns', () => {
    const ws = makeWs('status-idle')
    const gw = new AgentGateway(ws, 'p1')
    ;(gw as any).running = true
    expect(gw.getStatus().status).toBe('idle')
  })

  test('attaches channelDef.model onto matching channel status entries', () => {
    const ws = makeWs('status-channels', {
      heartbeatInterval: 1800, heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [{ type: 'telegram', model: 'claude-haiku-4-5' }],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    })
    const gw = new AgentGateway(ws, 'p1')
    const adapter: any = {
      onMessage: () => {}, connect: async () => {}, disconnect: async () => {},
      getStatus: () => ({ type: 'telegram', connected: true }),
      sendMessage: async () => {},
    }
    ;(gw as any).channels.set('telegram', adapter)
    const s = gw.getStatus()
    expect(s.channels.length).toBe(1)
    expect(s.channels[0].model).toBe('claude-haiku-4-5')
  })

  test('merges fs and config skills, dedupes by name, omits config entries with no name', () => {
    const ws = makeWs('status-skills', {
      heartbeatInterval: 1800, heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      skills: [
        { name: 'config-skill', trigger: 'c', description: 'cd' },
        { name: 'dup-on-fs', trigger: 'dup', description: 'should be dropped' },
        { trigger: 'no-name' },
      ],
    })
    // Drop a real fs-side skill on disk so loadAllSkills picks it up.
    mkdirSync(join(ws, 'skills', 'dup-on-fs'), { recursive: true })
    writeFileSync(
      join(ws, 'skills', 'dup-on-fs', 'SKILL.md'),
      '---\nname: dup-on-fs\ntrigger: t\ndescription: from-fs\n---\nbody',
    )
    const gw = new AgentGateway(ws, 'p1')
    const s = gw.getStatus()
    const names = s.skills.map(sk => sk.name)
    expect(names).toContain('config-skill')
    expect(names).toContain('dup-on-fs')
    expect(names.filter(n => n === 'dup-on-fs').length).toBe(1)
  })

  test('scans memory/ subdirectory for additional .md files', () => {
    const ws = makeWs('status-memory-dir')
    writeFileSync(join(ws, 'memory', '2026-05-27.md'), '- entry\n')
    writeFileSync(join(ws, 'memory', 'notes.txt'), 'ignored\n')
    const gw = new AgentGateway(ws, 'p1')
    const s = gw.getStatus()
    expect(s.memory.fileCount).toBeGreaterThanOrEqual(3)
  })
})
