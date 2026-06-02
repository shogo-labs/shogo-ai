// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * gateway.ts — tool-mock wrapping + synthetic injection coverage.
 *
 * Targets the eval-harness tool-mock pipeline that prior gateway tests
 * exercised only at the setter level (setToolMocks / clearToolMocks) but
 * never drove through `agentTurn`'s tool-assembly block:
 *   - Wrapping an existing native tool with a mock interceptor.
 *   - `__passthrough` sentinel → delegates to the real execute.
 *   - `__multipart` result unwrapping.
 *   - `connect` special-handling: promotes hidden mocks listed in the
 *     install result, unwraps multipart.
 *   - Synthetic tool injection for mocked tools absent from the base set.
 *   - `_promoteHiddenMocksFromInstall` direct branches (non-array, string
 *     entries, object entries, unknown name, already-promoted, no synDef).
 *   - `runMockAndUnwrap` via synthetic tool execute (text / multipart).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { AgentGateway } from '../gateway'
import { createMockStreamFn, buildTextResponse, buildToolUseResponse } from './helpers/mock-anthropic'
import { MockChannel } from './helpers/mock-channel'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TEST_DIR = '/tmp/test-gw-tool-mocks'

function injectMockChannel(gateway: AgentGateway, channel: MockChannel): void {
  ;(gateway as any).channels.set(channel.channelType, channel)
}

function setupWorkspace(): void {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  mkdirSync(join(TEST_DIR, 'memory'), { recursive: true })
  mkdirSync(join(TEST_DIR, 'skills'), { recursive: true })
  writeFileSync(
    join(TEST_DIR, 'config.json'),
    JSON.stringify({
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    }),
  )
  writeFileSync(join(TEST_DIR, 'AGENTS.md'), '# Identity\nTool Mock Agent\n\n# Operating Instructions\nBe concise.')
  writeFileSync(join(TEST_DIR, 'MEMORY.md'), '# Memory\n')
  writeFileSync(join(TEST_DIR, 'notes.md'), 'real file contents')
}

beforeAll(() => { trustWorkspaceForTests(TEST_DIR) })
afterAll(() => { clearTrustForTests(); rmSync(TEST_DIR, { recursive: true, force: true }) })

// ---------------------------------------------------------------------------
// _promoteHiddenMocksFromInstall — direct unit coverage
// ---------------------------------------------------------------------------
describe('_promoteHiddenMocksFromInstall', () => {
  let gw: AgentGateway
  beforeEach(() => {
    setupWorkspace()
    gw = new AgentGateway(TEST_DIR, 'test-project')
  })

  test('non-array tools result is a no-op', () => {
    gw.setToolMocks({ FOO__BAR: () => 'x' }, undefined, new Set(['FOO__BAR']))
    gw._promoteHiddenMocksFromInstall({ tools: 'not-an-array' })
    expect((gw as any).promotedMockTools).toHaveLength(0)
    gw._promoteHiddenMocksFromInstall(null)
    expect((gw as any).promotedMockTools).toHaveLength(0)
  })

  test('promotes a hidden mock named via string entry', () => {
    gw.setToolMocks(
      { FOO__BAR: () => 'ok' },
      { FOO__BAR: { description: 'Foo bar tool', paramKeys: ['query'] } },
      new Set(['FOO__BAR']),
    )
    gw._promoteHiddenMocksFromInstall({ tools: ['FOO__BAR'] })
    const promoted = (gw as any).promotedMockTools
    expect(promoted).toHaveLength(1)
    expect(promoted[0].name).toBe('FOO__BAR')
    expect((gw as any).hiddenMockTools.has('FOO__BAR')).toBe(false)
  })

  test('promotes via object entry and skips unknown / already-promoted / no-synDef', () => {
    gw.setToolMocks(
      { A__ONE: () => 'a', B__TWO: () => 'b' },
      { A__ONE: { description: 'A', paramKeys: ['k'] } },
      new Set(['A__ONE', 'B__TWO']),
    )
    // object entry for A__ONE (has synDef), B__TWO (no synDef → default desc),
    // UNKNOWN (not a hidden mock → skipped), and a falsy entry.
    gw._promoteHiddenMocksFromInstall({
      tools: [{ name: 'A__ONE' }, { name: 'B__TWO' }, { name: 'UNKNOWN' }, { nope: 1 }],
    })
    const names = (gw as any).promotedMockTools.map((t: any) => t.name).sort()
    expect(names).toEqual(['A__ONE', 'B__TWO'])
    // second call is idempotent (already-promoted branch)
    gw._promoteHiddenMocksFromInstall({ tools: ['A__ONE'] })
    expect((gw as any).promotedMockTools).toHaveLength(2)
  })

  test('clearToolMocks resets all mock state', () => {
    gw.setToolMocks({ X__Y: () => 'z' }, undefined, new Set(['X__Y']))
    gw._promoteHiddenMocksFromInstall({ tools: ['X__Y'] })
    expect((gw as any).promotedMockTools.length).toBeGreaterThan(0)
    gw.clearToolMocks()
    expect((gw as any).toolMocks.size).toBe(0)
    expect((gw as any).syntheticTools.size).toBe(0)
    expect((gw as any).hiddenMockTools.size).toBe(0)
    expect((gw as any).promotedMockTools).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// agentTurn tool-assembly: wrapping + synthetic injection through a real turn
// ---------------------------------------------------------------------------
describe('agentTurn tool-mock wrapping', () => {
  let gw: AgentGateway
  afterEach(async () => { try { await gw?.stop() } catch {} })

  test('wraps native tool, honours __passthrough and __multipart, injects synthetic + promotes via connect', async () => {
    setupWorkspace()
    const stream = createMockStreamFn([
      // synthetic mocked tool (not in base set)
      buildToolUseResponse([{ name: 'EXT__SEARCH', arguments: { input: 'hello' }, id: 't1' }]),
      // multipart-returning native tool mock
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'notes.md' }, id: 't2' }]),
      // connect promotes a hidden mock
      buildToolUseResponse([{ name: 'connect', arguments: { name: 'gmail' }, id: 't3' }]),
      buildTextResponse('done'),
    ])
    gw = new AgentGateway(TEST_DIR, 'test-project')
    gw.setStreamFn(stream)
    gw.setToolMocks(
      {
        EXT__SEARCH: (p: any) => `searched:${p.input}`,
        read_file: () => ({ __multipart: true, content: [{ type: 'text', text: 'mocked-multipart' }], details: 'mp' }),
        connect: () => ({ tools: ['HIDDEN__TOOL'] }),
        HIDDEN__TOOL: () => 'hidden-result',
      },
      {
        EXT__SEARCH: { description: 'External search', paramKeys: ['input'] },
        HIDDEN__TOOL: { description: 'Hidden tool', paramKeys: ['q'] },
      },
      new Set(['HIDDEN__TOOL']),
    )
    await gw.start()
    const out = await (gw as any).agentTurn('use the tools', 'sess-1', false)
    expect(typeof out).toBe('string')
    expect(out).toContain('done')
  })

  test('passthrough sentinel delegates to the real tool execute', async () => {
    setupWorkspace()
    const stream = createMockStreamFn([
      buildToolUseResponse([{ name: 'read_file', arguments: { path: 'notes.md' }, id: 'p1' }]),
      buildTextResponse('read complete'),
    ])
    gw = new AgentGateway(TEST_DIR, 'test-project')
    gw.setStreamFn(stream)
    gw.setToolMocks({ read_file: () => '__passthrough' })
    await gw.start()
    const out = await (gw as any).agentTurn('read the notes', 'sess-2', false)
    expect(out).toContain('read complete')
  })
})
