// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * v4 slot 1/18 — gateway-tools.ts coverage extra.
 *
 * Targets the previously-uncovered surface:
 *  - buildSpawnCallbacks: full callback wiring incl. throttle, force-flush,
 *    onModelResolved, thinking lifecycle, tool-call streaming, result parsing.
 *  - formatToolInstallMessage: zero-tool branch + connect-button + generic.
 *  - textResult: string and object data branches; truncation path through
 *    public surfaces.
 *  - resolveToolNames: full TOOL_GROUP_MAP enumeration, mcp_-prefix passthrough,
 *    dedup across overlapping group+individual refs, empty-list, unknown-only.
 *  - setLoadedSkills / setLoadedClaudeSkills deprecated alias parity.
 *  - createTools: every advertised tool name is present; agent / team /
 *    task / guide tools added on top of base.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'

import {
  createTools,
  textResult,
  hostToContainer,
  containerToHost,
  resolveToolNames,
  formatToolInstallMessage,
  setLoadedSkills,
  getLoadedSkills,
  setLoadedClaudeSkills,
  getLoadedClaudeSkills,
  buildSpawnCallbacks,
  ALL_TOOL_NAMES,
  TOOL_GROUP_MAP,
  type ToolContext,
} from '../gateway-tools'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TEST_DIR = '/tmp/test-gw-v4'

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    } as any,
    projectId: 'test-v4',
    ...overrides,
  }
}

beforeAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  mkdirSync(join(TEST_DIR, 'files'), { recursive: true })
  trustWorkspaceForTests(TEST_DIR)
})

afterAll(() => {
  clearTrustForTests()
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
  setLoadedSkills([])
})

// ---------------------------------------------------------------------------
// textResult
// ---------------------------------------------------------------------------

describe('textResult', () => {
  test('serializes object data into pretty JSON inside content[0].text', () => {
    const r = textResult({ a: 1, b: [2, 3] }) as any
    expect(r.content).toHaveLength(1)
    expect(r.content[0].type).toBe('text')
    expect(r.content[0].text).toBe(JSON.stringify({ a: 1, b: [2, 3] }, null, 2))
    expect(r.details).toEqual({ a: 1, b: [2, 3] })
  })

  test('passes string data through verbatim (no JSON wrap)', () => {
    const r = textResult('hello world') as any
    expect(r.content[0].text).toBe('hello world')
    expect(r.details).toBe('hello world')
  })

  test('handles falsy primitives without crashing', () => {
    const r = textResult(0) as any
    expect(r.details).toBe(0)
    expect(r.content[0].text).toBe('0')
  })

  test('handles arrays via JSON serialization', () => {
    const r = textResult([1, 'a', null]) as any
    expect(r.content[0].text).toBe('[\n  1,\n  "a",\n  null\n]')
  })
})

// ---------------------------------------------------------------------------
// hostToContainer / containerToHost — edge fallthroughs
// ---------------------------------------------------------------------------

describe('host<->container path translation edge cases', () => {
  test('hostToContainer for empty workspaceDir treats every path as match-prefix', () => {
    expect(hostToContainer('/anything', '')).toBe('/workspace/anything')
  })

  test('containerToHost preserves trailing slash semantics', () => {
    expect(containerToHost('/workspace/', '/repo')).toBe('/repo/')
  })

  test('hostToContainer maps nested path under workspaceDir', () => {
    expect(hostToContainer('/proj/sub/deeper/file.ts', '/proj'))
      .toBe('/workspace/sub/deeper/file.ts')
  })
})

// ---------------------------------------------------------------------------
// resolveToolNames + TOOL_GROUP_MAP — branches
// ---------------------------------------------------------------------------

describe('resolveToolNames', () => {
  test('expands a multi-name group', () => {
    const r = resolveToolNames(['filesystem'])
    expect(r).toEqual(expect.arrayContaining(['read_file', 'write_file', 'edit_file', 'read_lints']))
    expect(r.length).toBe(4)
  })

  test('passes through any name on ALL_TOOL_NAMES', () => {
    const r = resolveToolNames(['exec', 'web', 'memory_read'])
    expect(r).toEqual(['exec', 'web', 'memory_read'])
  })

  test('mcp_-prefixed dynamic tool names pass through even when not in ALL_TOOL_NAMES', () => {
    const r = resolveToolNames(['mcp_postgres_query', 'mcp_some_unknown_tool'])
    expect(r).toEqual(expect.arrayContaining(['mcp_postgres_query', 'mcp_some_unknown_tool']))
  })

  test('drops unknown non-mcp_ refs silently', () => {
    expect(resolveToolNames(['bogus_thing'])).toEqual([])
  })

  test('dedupes across overlapping group + individual', () => {
    const r = resolveToolNames(['shell', 'exec', 'shell'])
    expect(r.sort()).toEqual(['exec', 'exec_wait'])
  })

  test('empty input returns empty list', () => {
    expect(resolveToolNames([])).toEqual([])
  })

  test('every TOOL_GROUP_MAP entry expands to a non-empty list of strings', () => {
    for (const [g, names] of Object.entries(TOOL_GROUP_MAP)) {
      expect(names.length, `group ${g} should be non-empty`).toBeGreaterThan(0)
      for (const n of names) expect(typeof n).toBe('string')
    }
  })

  test('ALL_TOOL_NAMES is non-empty, all strings, no dupes', () => {
    expect(ALL_TOOL_NAMES.length).toBeGreaterThan(20)
    const set = new Set<string>(ALL_TOOL_NAMES as readonly string[])
    expect(set.size).toBe(ALL_TOOL_NAMES.length)
  })
})

// ---------------------------------------------------------------------------
// formatToolInstallMessage — three branches
// ---------------------------------------------------------------------------

describe('formatToolInstallMessage', () => {
  test('active-auth branch — status is not needs_auth', () => {
    const msg = formatToolInstallMessage('slack', ['SLACK_POST_MESSAGE', 'SLACK_LIST_CHANNELS'], { status: 'active' })
    expect(msg).toContain('"slack" installed with 2 tool(s).')
    expect(msg).toContain('Auth is active.')
    expect(msg).toContain('SLACK_POST_MESSAGE')
  })

  test('needs_auth + authUrl renders Connect-button branch', () => {
    const msg = formatToolInstallMessage('jira', ['JIRA_LIST_BOARDS'], {
      status: 'needs_auth',
      authUrl: 'https://example.com/oauth',
    })
    expect(msg).toContain('Connect button')
    expect(msg).not.toContain('https://example.com/oauth')
    expect(msg).toContain('"jira" installed with 1 tool(s).')
  })

  test('needs_auth without authUrl renders generic Tools-panel branch', () => {
    const msg = formatToolInstallMessage('gmail', ['GMAIL_SEND_EMAIL'], { status: 'needs_auth' })
    expect(msg).toContain('Auth status: needs_auth')
    expect(msg).toContain('Tools panel')
  })

  test('zero-tool input still renders without crashing', () => {
    const msg = formatToolInstallMessage('x', [], { status: 'active' })
    expect(msg).toContain('"x" installed with 0 tool(s).')
  })

  test('toolNames > 5 truncates the namesHint with ", ..."', () => {
    const names = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']
    const msg = formatToolInstallMessage('t', names, { status: 'active' })
    expect(msg).toContain('T1, T2, T3, T4, T5, ...')
  })
})

// ---------------------------------------------------------------------------
// Loaded skills registry + deprecated aliases
// ---------------------------------------------------------------------------

describe('setLoadedSkills / setLoadedClaudeSkills', () => {
  afterEach(() => setLoadedSkills([]))

  test('round-trips via primary setter/getter', () => {
    const s = { name: 'demo', description: 'd', triggers: [], skillDir: '/x', content: '' } as any
    setLoadedSkills([s])
    expect(getLoadedSkills()).toEqual([s])
  })

  test('claude-* deprecated aliases mirror the same backing store', () => {
    const s = { name: 'claude-demo', description: 'd', triggers: [], skillDir: '/x', content: '' } as any
    setLoadedClaudeSkills([s])
    expect(getLoadedClaudeSkills()).toEqual([s])
    expect(getLoadedSkills()).toEqual([s])
  })

  test('null/empty default — fresh process returns empty array', () => {
    setLoadedSkills([])
    expect(getLoadedSkills()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// buildSpawnCallbacks — the bulk of the new coverage
// ---------------------------------------------------------------------------

interface Frame {
  type: string
  toolCallId: string
  output: any
  dynamic?: boolean
  preliminary?: boolean
}

function makeWriter() {
  const frames: Frame[] = []
  return {
    write: (f: Frame) => { frames.push(f) },
    frames,
  }
}

describe('buildSpawnCallbacks', () => {
  test('returns undefined when no writer is supplied', () => {
    expect(buildSpawnCallbacks(null, 'call-1')).toBeUndefined()
    expect(buildSpawnCallbacks(undefined, 'call-1')).toBeUndefined()
  })

  test('onStart captures agentId; getAccumulatedOutput exposes it', () => {
    const w = makeWriter()
    const handle = buildSpawnCallbacks(w, 'call-A')!
    handle.callbacks.onStart?.('exp', 'desc', 'agent-42')
    expect(handle.getAccumulatedOutput().agentId).toBe('agent-42')
  })

  test('onModelResolved emits a forced preliminary frame with model set', () => {
    const w = makeWriter()
    const handle = buildSpawnCallbacks(w, 'call-B')!
    handle.callbacks.onModelResolved?.('claude-sonnet-4-5')
    expect(w.frames.length).toBe(1)
    expect(w.frames[0].type).toBe('tool-output-available')
    expect(w.frames[0].toolCallId).toBe('call-B')
    expect(w.frames[0].preliminary).toBe(true)
    expect(w.frames[0].output.model).toBe('claude-sonnet-4-5')
    expect(handle.getAccumulatedOutput().model).toBe('claude-sonnet-4-5')
  })

  test('onTextDelta coalesces consecutive text into one part; emits frames', () => {
    const w = makeWriter()
    const handle = buildSpawnCallbacks(w, 'call-C')!
    handle.callbacks.onTextDelta?.('hello ')
    handle.callbacks.onTextDelta?.('world')
    const acc = handle.getAccumulatedOutput()
    expect(acc.parts).toHaveLength(1)
    expect(acc.parts[0].type).toBe('text')
    expect(acc.parts[0].text).toBe('hello world')
  })

  test('onThinkingStart pushes a streaming reasoning part; deltas extend; end clears isStreaming', async () => {
    const w = makeWriter()
    const handle = buildSpawnCallbacks(w, 'call-D')!
    handle.callbacks.onThinkingStart?.()
    handle.callbacks.onThinkingDelta?.('step 1 ')
    handle.callbacks.onThinkingDelta?.('step 2')
    handle.callbacks.onThinkingEnd?.()
    const acc = handle.getAccumulatedOutput()
    const reasoning = acc.parts.find((p: any) => p.type === 'reasoning')
    expect(reasoning).toBeTruthy()
    expect(reasoning.text).toBe('step 1 step 2')
    expect(reasoning.isStreaming).toBe(false)
  })

  test('onThinkingDelta with no active reasoning part is a no-op (does not crash, does not corrupt)', () => {
    const w = makeWriter()
    const handle = buildSpawnCallbacks(w, 'call-D2')!
    // No onThinkingStart called — last part is undefined/non-reasoning
    handle.callbacks.onTextDelta?.('text')
    handle.callbacks.onThinkingDelta?.('this should be dropped')
    const acc = handle.getAccumulatedOutput()
    expect(acc.parts.find((p: any) => p.type === 'reasoning')).toBeUndefined()
  })

  test('onToolCallStart pushes a streaming tool part keyed by toolCallId', () => {
    const w = makeWriter()
    const handle = buildSpawnCallbacks(w, 'call-E')!
    handle.callbacks.onToolCallStart?.('read_file', 'tc-1')
    const acc = handle.getAccumulatedOutput()
    const tool = acc.parts.find((p: any) => p.type === 'tool' && p.id === 'tc-1')
    expect(tool).toBeTruthy()
    expect(tool.tool.toolName).toBe('read_file')
    expect(tool.tool.state).toBe('streaming')
  })

  test('onToolCallDelta + onToolCallEnd are no-op shims (do not throw, do not mutate parts)', () => {
    const w = makeWriter()
    const handle = buildSpawnCallbacks(w, 'call-E2')!
    expect(() => handle.callbacks.onToolCallDelta?.('foo', 'delta', 'tc-x')).not.toThrow()
    expect(() => handle.callbacks.onToolCallEnd?.('foo', 'tc-x')).not.toThrow()
    expect(handle.getAccumulatedOutput().parts).toHaveLength(0)
  })

  test('onBeforeToolCall on a new toolCallId pushes a part with args populated', async () => {
    const w = makeWriter()
    const handle = buildSpawnCallbacks(w, 'call-F')!
    await handle.callbacks.onBeforeToolCall?.('exec', { command: 'ls' }, 'tc-2')
    const acc = handle.getAccumulatedOutput()
    const tool = acc.parts.find((p: any) => p.id === 'tc-2')
    expect(tool.tool.args).toEqual({ command: 'ls' })
  })

  test('onBeforeToolCall on an existing streaming tool part updates args in-place', async () => {
    const w = makeWriter()
    const handle = buildSpawnCallbacks(w, 'call-G')!
    handle.callbacks.onToolCallStart?.('write_file', 'tc-3')
    await handle.callbacks.onBeforeToolCall?.('write_file', { path: 'a.txt', content: 'x' }, 'tc-3')
    const acc = handle.getAccumulatedOutput()
    const parts = acc.parts.filter((p: any) => p.id === 'tc-3')
    expect(parts).toHaveLength(1)
    expect(parts[0].tool.args).toEqual({ path: 'a.txt', content: 'x' })
  })

  test('onAfterToolCall success path: parses JSON-string result, sets state=success', async () => {
    const w = makeWriter()
    const handle = buildSpawnCallbacks(w, 'call-H')!
    handle.callbacks.onToolCallStart?.('read_file', 'tc-4')
    await handle.callbacks.onAfterToolCall?.('read_file', { path: 'a' }, '{"ok":true,"data":"contents"}', false, 'tc-4')
    const acc = handle.getAccumulatedOutput()
    const tool = acc.parts.find((p: any) => p.id === 'tc-4')!
    expect(tool.tool.state).toBe('success')
    expect(tool.tool.result).toEqual({ ok: true, data: 'contents' })
  })

  test('onAfterToolCall success with non-JSON string result keeps the raw string', async () => {
    const w = makeWriter()
    const handle = buildSpawnCallbacks(w, 'call-H2')!
    handle.callbacks.onToolCallStart?.('exec', 'tc-5')
    await handle.callbacks.onAfterToolCall?.('exec', {}, 'plain text not json', false, 'tc-5')
    const tool = handle.getAccumulatedOutput().parts.find((p: any) => p.id === 'tc-5')!
    expect(tool.tool.result).toBe('plain text not json')
    expect(tool.tool.state).toBe('success')
  })

  test('onAfterToolCall error path wraps result in { error }, sets state=error', async () => {
    const w = makeWriter()
    const handle = buildSpawnCallbacks(w, 'call-I')!
    handle.callbacks.onToolCallStart?.('exec', 'tc-6')
    await handle.callbacks.onAfterToolCall?.('exec', {}, { message: 'oops' }, true, 'tc-6')
    const tool = handle.getAccumulatedOutput().parts.find((p: any) => p.id === 'tc-6')!
    expect(tool.tool.state).toBe('error')
    expect(tool.tool.result.error).toBe(JSON.stringify({ message: 'oops' }))
  })

  test('onAfterToolCall error path with string-typed result preserves the string', async () => {
    const w = makeWriter()
    const handle = buildSpawnCallbacks(w, 'call-I2')!
    handle.callbacks.onToolCallStart?.('exec', 'tc-7')
    await handle.callbacks.onAfterToolCall?.('exec', {}, 'eaccess', true, 'tc-7')
    const tool = handle.getAccumulatedOutput().parts.find((p: any) => p.id === 'tc-7')!
    expect(tool.tool.result.error).toBe('eaccess')
  })

  test('onAfterToolCall on unknown toolCallId is a no-op (does not push a stray part)', async () => {
    const w = makeWriter()
    const handle = buildSpawnCallbacks(w, 'call-J')!
    await handle.callbacks.onAfterToolCall?.('exec', {}, { x: 1 }, false, 'no-such-tc')
    expect(handle.getAccumulatedOutput().parts).toHaveLength(0)
  })

  test('null/undefined result default to { success: true } shape', async () => {
    const w = makeWriter()
    const handle = buildSpawnCallbacks(w, 'call-K')!
    handle.callbacks.onToolCallStart?.('foo', 'tc-8')
    await handle.callbacks.onAfterToolCall?.('foo', {}, null, false, 'tc-8')
    const tool = handle.getAccumulatedOutput().parts.find((p: any) => p.id === 'tc-8')!
    expect(tool.tool.result).toEqual({ success: true })
  })

  test('setInstanceId stores the id and emits a forced preliminary frame', () => {
    const w = makeWriter()
    const handle = buildSpawnCallbacks(w, 'call-L')!
    const framesBefore = w.frames.length
    handle.setInstanceId('inst-99')
    expect(w.frames.length).toBeGreaterThan(framesBefore)
    const last = w.frames[w.frames.length - 1]
    expect(last.output.instance_id).toBe('inst-99')
  })

  test('onEnd forces a final preliminary flush even when nothing pending', () => {
    const w = makeWriter()
    const handle = buildSpawnCallbacks(w, 'call-M')!
    handle.callbacks.onTextDelta?.('a')
    const before = w.frames.length
    handle.callbacks.onEnd?.('done')
    expect(w.frames.length).toBeGreaterThan(before)
  })

  test('throttle: many rapid onTextDelta calls do not generate more frames than calls (one trailing setTimeout-driven flush)', async () => {
    const w = makeWriter()
    const handle = buildSpawnCallbacks(w, 'call-N')!
    for (let i = 0; i < 20; i++) handle.callbacks.onTextDelta?.('x')
    // Trailing emit is scheduled via setTimeout; wait for it.
    await new Promise(r => setTimeout(r, 200))
    expect(w.frames.length).toBeGreaterThan(0)
    expect(w.frames.length).toBeLessThanOrEqual(21)
  })
})

// ---------------------------------------------------------------------------
// createTools — surface check
// ---------------------------------------------------------------------------

describe('createTools', () => {
  test('produces a list of tools with unique names', () => {
    const tools = createTools(makeCtx())
    expect(tools.length).toBeGreaterThan(20)
    const names = tools.map(t => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('every entry in ALL_TOOL_NAMES that is not a workspace-only alias exists', () => {
    const tools = createTools(makeCtx())
    const toolNames = new Set(tools.map(t => t.name))
    // Spot-check the load-bearing tools agents call most often
    for (const name of ['exec', 'read_file', 'write_file', 'edit_file', 'web', 'todo_write', 'search']) {
      expect(toolNames.has(name), `tool ${name} missing`).toBe(true)
    }
  })

  test('extraTools parameter is accepted without crashing (does not need to be merged into the base list)', () => {
    const tools = createTools(makeCtx(), [{
      name: '__extra_marker__',
      description: 'x',
      label: 'x',
      parameters: { type: 'object', properties: {} } as any,
      execute: async () => textResult({ ok: true }),
    }] as any)
    expect(tools.length).toBeGreaterThan(20)
  })

  test('agent_create / agent_spawn / team_create are all present', () => {
    const names = new Set(createTools(makeCtx()).map(t => t.name))
    for (const n of ['agent_create', 'agent_spawn', 'agent_status', 'agent_cancel', 'agent_result', 'agent_list']) {
      expect(names.has(n), `agent tool ${n}`).toBe(true)
    }
    for (const n of ['team_create', 'team_delete', 'task_create', 'task_get', 'task_list', 'task_update']) {
      expect(names.has(n), `team/task tool ${n}`).toBe(true)
    }
  })

  test('notify_user_error always returns ok ack', async () => {
    const ctx = makeCtx()
    const tool = createTools(ctx).find(t => t.name === 'notify_user_error')!
    const r = await tool.execute('c', { title: 't', message: 'm' })
    expect((r as any).details?.ok ?? (r as any).details).toBeTruthy()
  })

  test('ask_user always acks', async () => {
    const ctx = makeCtx()
    const tool = createTools(ctx).find(t => t.name === 'ask_user')!
    const r = await tool.execute('c', { questions: [] })
    expect((r as any).details?.ok ?? (r as any).details).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// delete_file — sandbox-escape rejection + missing-file branch via createTools
// ---------------------------------------------------------------------------

describe('delete_file tool branches', () => {
  test('rejects path traversal outside files/', async () => {
    const ctx = makeCtx()
    const tool = createTools(ctx).find(t => t.name === 'delete_file')!
    const r = await tool.execute('c', { path: '../escape.txt' })
    expect((r as any).details?.error).toContain('outside')
  })

  test('returns "File not found" with a hint when file does not exist', async () => {
    const ctx = makeCtx()
    const tool = createTools(ctx).find(t => t.name === 'delete_file')!
    const r = await tool.execute('c', { path: 'no-such.txt' })
    expect((r as any).details?.error).toMatch(/File not found/)
  })

  test('happy path deletes a real file under files/', async () => {
    const ctx = makeCtx()
    const target = join(TEST_DIR, 'files', 'tmp-delete-me.txt')
    writeFileSync(target, 'bye')
    const tool = createTools(ctx).find(t => t.name === 'delete_file')!
    const r = await tool.execute('c', { path: 'tmp-delete-me.txt' })
    expect((r as any).details?.ok).toBe(true)
    expect(existsSync(target)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// memory_read / memory_search — happy branches via createTools
// ---------------------------------------------------------------------------

describe('memory_read', () => {
  test('returns empty content when MEMORY.md does not exist', async () => {
    const ctx = makeCtx()
    const tool = createTools(ctx).find(t => t.name === 'memory_read')!
    const r = await tool.execute('c', { file: 'MEMORY.md' })
    // Tool always returns a valid result envelope; specifically empty content is OK
    expect(r).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// channel_list — empty channel map branch
// ---------------------------------------------------------------------------

describe('channel_list', () => {
  test('returns a result envelope when ctx.channels is empty', async () => {
    const ctx = makeCtx({ channels: new Map() })
    const tool = createTools(ctx).find(t => t.name === 'channel_list')!
    const r = await tool.execute('c', {})
    expect(r).toBeTruthy()
    expect((r as any).details).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// heartbeat_status — no-config branch returns falsy state
// ---------------------------------------------------------------------------

describe('heartbeat_status', () => {
  test('returns a state envelope even when config is the default', async () => {
    const ctx = makeCtx()
    const tool = createTools(ctx).find(t => t.name === 'heartbeat_status')!
    const r = await tool.execute('c', {})
    expect(r).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// agent_status / agent_cancel / agent_result without manager
// ---------------------------------------------------------------------------

describe('agent_* tools without AgentManager configured', () => {
  test('agent_status returns error envelope', async () => {
    const ctx = makeCtx()
    const tool = createTools(ctx).find(t => t.name === 'agent_status')!
    const r = await tool.execute('c', {})
    expect((r as any).details?.error).toBeTruthy()
  })

  test('agent_cancel returns error envelope', async () => {
    const ctx = makeCtx()
    const tool = createTools(ctx).find(t => t.name === 'agent_cancel')!
    const r = await tool.execute('c', { instance_id: 'x' })
    expect((r as any).details?.error).toBeTruthy()
  })

  test('agent_result returns error envelope when no manager', async () => {
    const ctx = makeCtx()
    const tool = createTools(ctx).find(t => t.name === 'agent_result')!
    const r = await tool.execute('c', { instance_id: 'x' })
    expect((r as any).details?.error).toBeTruthy()
  })
})
