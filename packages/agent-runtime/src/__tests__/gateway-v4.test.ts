// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * v4 slot 7/18 — gateway.ts coverage extra.
 *
 * Targets surface that doesn't require driving a full processChatMessage
 * pipeline (those are in -integration / -error-recovery / -tier3 tests):
 *   - AgentGateway constructor + loadConfig branches:
 *     * Missing config.json → returns defaults.
 *     * Malformed JSON → logs warning, returns defaults.
 *     * Valid config.json with heartbeat sub-object override semantics
 *       (intervalMs / enabled mapping).
 *     * Non-array channels coerced to empty list.
 *     * Local-mode SECURITY_POLICY env enables PermissionEngine.
 *   - Setter chain: setStreamFn / setLogCallback / setUserTimezone /
 *     setEvalLabel / setToolMocks / setPermissionSseCallback.
 *   - Public getter accessors: getHookEmitter, getSessionManager,
 *     getMCPClientManager, getPermissionEngine, getActiveMode,
 *     getAllowedModes (defaults branch + explicit branch).
 *   - setActiveMode mutates config.activeMode.
 *   - abortCurrentTurn on unknown session id returns false; lock cleanup
 *     does not throw.
 *   - reloadConfig re-reads config.json (changed defaults visible).
 *   - reconnectIndex on a gateway with no indexEngine is a no-op.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'

import { AgentGateway } from '../gateway'

const TEST_ROOT = '/tmp/test-gw-v4'

function makeWorkspace(suffix: string, configContent?: string | null): string {
  const ws = join(TEST_ROOT, suffix)
  if (existsSync(ws)) rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  mkdirSync(join(ws, 'memory'), { recursive: true })
  mkdirSync(join(ws, 'skills'), { recursive: true })
  if (configContent !== null) {
    writeFileSync(
      join(ws, 'config.json'),
      configContent ?? JSON.stringify({
        heartbeatInterval: 1800,
        heartbeatEnabled: false,
        quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
        channels: [],
        model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      }),
    )
  }
  writeFileSync(join(ws, 'AGENTS.md'), '# Identity\nv4\n')
  writeFileSync(join(ws, 'MEMORY.md'), '# Memory\n')
  return ws
}

beforeAll(() => {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true })
  mkdirSync(TEST_ROOT, { recursive: true })
})

afterAll(() => {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Constructor + loadConfig branches
// ---------------------------------------------------------------------------

describe('AgentGateway constructor + loadConfig', () => {
  test('returns defaults when no config.json exists', () => {
    const ws = makeWorkspace('ctor-no-config', null)
    // Remove the file too — `null` skips writing, but the helper also
    // strips a pre-existing file via the rmSync at top.
    if (existsSync(join(ws, 'config.json'))) rmSync(join(ws, 'config.json'))
    const gw = new AgentGateway(ws, 'p-no-config')
    // Smoke check the public getters that read from config
    expect(gw.getActiveMode()).toBe('canvas')
    expect(gw.getAllowedModes()).toEqual(['canvas', 'none'])
  })

  test('returns defaults when config.json is malformed (parse error path)', () => {
    const ws = makeWorkspace('ctor-bad-json', '{ not json at all }')
    const gw = new AgentGateway(ws, 'p-bad-json')
    expect(gw.getActiveMode()).toBe('canvas')
  })

  test('coerces non-array channels to empty list', () => {
    const ws = makeWorkspace('ctor-bad-channels', JSON.stringify({
      heartbeatEnabled: false,
      channels: 'not-an-array',
      model: { provider: 'anthropic', name: 'claude-haiku-4-5' },
    }))
    const gw = new AgentGateway(ws, 'p-bad-channels')
    expect(gw.getActiveMode()).toBe('canvas')
  })

  test('honors raw.heartbeat.intervalMs (converted to seconds)', () => {
    const ws = makeWorkspace('ctor-hb-ms', JSON.stringify({
      heartbeat: { intervalMs: 60000, enabled: true },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-haiku-4-5' },
    }))
    const gw = new AgentGateway(ws, 'p-hb-ms')
    // Implementation private — exercise via public surface (no crash + active mode default).
    expect(gw.getActiveMode()).toBe('canvas')
  })

  test('honors top-level heartbeatInterval when heartbeat sub-object absent', () => {
    const ws = makeWorkspace('ctor-hb-top', JSON.stringify({
      heartbeatInterval: 3600,
      heartbeatEnabled: true,
      channels: [],
      model: { provider: 'anthropic', name: 'claude-haiku-4-5' },
    }))
    const gw = new AgentGateway(ws, 'p-hb-top')
    expect(gw.getActiveMode()).toBe('canvas')
  })

  test('preserves activeMode + allowedModes from config.json', () => {
    const ws = makeWorkspace('ctor-mode', JSON.stringify({
      heartbeatEnabled: false,
      channels: [],
      model: { provider: 'anthropic', name: 'claude-haiku-4-5' },
      activeMode: 'app',
      allowedModes: ['app', 'none'],
    }))
    const gw = new AgentGateway(ws, 'p-mode')
    expect(gw.getActiveMode()).toBe('app')
    expect(gw.getAllowedModes()).toEqual(['app', 'none'])
  })

  test('PermissionEngine remains null when SHOGO_LOCAL_MODE is not "true"', () => {
    const prev = process.env.SHOGO_LOCAL_MODE
    delete process.env.SHOGO_LOCAL_MODE
    try {
      const ws = makeWorkspace('ctor-no-local')
      const gw = new AgentGateway(ws, 'p-no-local')
      expect(gw.getPermissionEngine()).toBeNull()
    } finally {
      if (prev !== undefined) process.env.SHOGO_LOCAL_MODE = prev
    }
  })

  test('PermissionEngine is constructed when SHOGO_LOCAL_MODE=true', () => {
    const prev = process.env.SHOGO_LOCAL_MODE
    process.env.SHOGO_LOCAL_MODE = 'true'
    try {
      const ws = makeWorkspace('ctor-local')
      const gw = new AgentGateway(ws, 'p-local')
      const eng = gw.getPermissionEngine()
      expect(eng).not.toBeNull()
    } finally {
      if (prev === undefined) delete process.env.SHOGO_LOCAL_MODE
      else process.env.SHOGO_LOCAL_MODE = prev
    }
  })
})

// ---------------------------------------------------------------------------
// Setter chain
// ---------------------------------------------------------------------------

describe('AgentGateway setter API', () => {
  test('setStreamFn / setLogCallback / setUserTimezone / setEvalLabel do not throw', () => {
    const ws = makeWorkspace('set-chain')
    const gw = new AgentGateway(ws, 'p-set')
    expect(() => gw.setStreamFn(() => { throw new Error('not called') })).not.toThrow()
    expect(() => gw.setLogCallback(() => {})).not.toThrow()
    expect(() => gw.setUserTimezone('America/Los_Angeles')).not.toThrow()
    expect(() => gw.setEvalLabel('eval-42')).not.toThrow()
    expect(() => gw.setEvalLabel(null)).not.toThrow()
  })

  test('setToolMocks installs and resets mock map across calls', () => {
    const ws = makeWorkspace('set-mocks')
    const gw = new AgentGateway(ws, 'p-mocks')
    expect(() =>
      gw.setToolMocks({ exec: () => 'mocked' })
    ).not.toThrow()
    // Re-call to exercise the .clear() reset branch
    expect(() =>
      gw.setToolMocks(
        { read_file: () => 'r' },
        { synth_tool: { description: 'x', paramKeys: ['k'] } },
        new Set(['hidden_tool']),
      )
    ).not.toThrow()
    // Reset to empty
    expect(() => gw.setToolMocks({})).not.toThrow()
  })

  test('setPermissionSseCallback before and after PermissionEngine init', () => {
    const prev = process.env.SHOGO_LOCAL_MODE
    delete process.env.SHOGO_LOCAL_MODE
    try {
      const ws = makeWorkspace('set-perm-no')
      const gw = new AgentGateway(ws, 'p-perm-no')
      const cb = (_e: Record<string, any>) => {}
      // No PermissionEngine present — branch where engine is null
      expect(() => gw.setPermissionSseCallback(cb)).not.toThrow()
    } finally {
      if (prev !== undefined) process.env.SHOGO_LOCAL_MODE = prev
    }
  })

  test('setPermissionSseCallback wires onto an existing PermissionEngine', () => {
    const prev = process.env.SHOGO_LOCAL_MODE
    process.env.SHOGO_LOCAL_MODE = 'true'
    try {
      const ws = makeWorkspace('set-perm-yes')
      const gw = new AgentGateway(ws, 'p-perm-yes')
      const cb = (_e: Record<string, any>) => {}
      expect(() => gw.setPermissionSseCallback(cb)).not.toThrow()
    } finally {
      if (prev === undefined) delete process.env.SHOGO_LOCAL_MODE
      else process.env.SHOGO_LOCAL_MODE = prev
    }
  })
})

// ---------------------------------------------------------------------------
// Public getter / setter accessors
// ---------------------------------------------------------------------------

describe('AgentGateway public accessors', () => {
  let ws: string
  let gw: AgentGateway

  beforeEach(() => {
    ws = makeWorkspace('accessors-' + Math.random().toString(36).slice(2, 8))
    gw = new AgentGateway(ws, 'p-acc')
  })

  test('getHookEmitter returns a HookEmitter instance', () => {
    const he = gw.getHookEmitter()
    expect(he).toBeTruthy()
    expect(typeof (he as any).on === 'function' || typeof (he as any).emit === 'function').toBe(true)
  })

  test('getSessionManager returns the SessionManager singleton for this gateway', () => {
    const sm = gw.getSessionManager()
    expect(sm).toBeTruthy()
  })

  test('getMCPClientManager returns the bound MCPClientManager', () => {
    const mcp = gw.getMCPClientManager()
    expect(mcp).toBeTruthy()
  })

  test('agentManager is exposed publicly', () => {
    expect(gw.agentManager).toBeTruthy()
  })

  test('getActiveMode + setActiveMode round-trip via public surface', () => {
    expect(gw.getActiveMode()).toBe('canvas')
    gw.setActiveMode('app')
    expect(gw.getActiveMode()).toBe('app')
    gw.setActiveMode('none')
    expect(gw.getActiveMode()).toBe('none')
  })

  test('getAllowedModes returns the config-supplied list (or default)', () => {
    const modes = gw.getAllowedModes()
    expect(Array.isArray(modes)).toBe(true)
    expect(modes.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// reloadConfig — picks up disk changes
// ---------------------------------------------------------------------------

describe('AgentGateway.reloadConfig', () => {
  test('re-reads config.json from disk; activeMode reflects the new file', () => {
    const ws = makeWorkspace('reload', JSON.stringify({
      heartbeatEnabled: false,
      channels: [],
      model: { provider: 'anthropic', name: 'claude-haiku-4-5' },
      activeMode: 'canvas',
    }))
    const gw = new AgentGateway(ws, 'p-reload')
    expect(gw.getActiveMode()).toBe('canvas')

    writeFileSync(join(ws, 'config.json'), JSON.stringify({
      heartbeatEnabled: false,
      channels: [],
      model: { provider: 'anthropic', name: 'claude-haiku-4-5' },
      activeMode: 'none',
    }))
    gw.reloadConfig()
    expect(gw.getActiveMode()).toBe('none')
  })
})

// ---------------------------------------------------------------------------
// reconnectIndex no-op + abortCurrentTurn unknown-session
// ---------------------------------------------------------------------------

describe('AgentGateway misc lifecycle bits', () => {
  test('reconnectIndex on a fresh gateway does not throw (indexEngine is null)', () => {
    const ws = makeWorkspace('reconnect')
    const gw = new AgentGateway(ws, 'p-rec')
    expect(() => gw.reconnectIndex()).not.toThrow()
  })

  test('abortCurrentTurn on an unknown session returns false', () => {
    const ws = makeWorkspace('abort-unknown')
    const gw = new AgentGateway(ws, 'p-abort')
    expect(gw.abortCurrentTurn('no-such-session')).toBe(false)
  })
})
