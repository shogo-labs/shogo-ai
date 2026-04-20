// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Message } from '@mariozechner/pi-ai'
import { filterIncompleteToolCalls, createAgentId } from '../subagent'
import {
  FORK_BOILERPLATE_TAG,
  buildForkDirective,
  isInForkChild,
  SUBAGENT_GUIDE,
} from '../subagent-prompts'
import { SqliteSessionPersistence } from '../sqlite-session-persistence'
import { createTools, type ToolContext } from '../gateway-tools'
import { FileStateCache } from '../file-state-cache'

// ---------------------------------------------------------------------------
// filterIncompleteToolCalls
// ---------------------------------------------------------------------------

describe('filterIncompleteToolCalls', () => {
  test('removes assistant messages with unmatched tool calls', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello', timestamp: 0 },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc-1', name: 'read_file', arguments: { path: 'foo.ts' } },
        ],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse',
        timestamp: 1,
      },
      // No toolResult for tc-1
    ]
    const filtered = filterIncompleteToolCalls(messages)
    expect(filtered).toHaveLength(1)
    expect(filtered[0].role).toBe('user')
  })

  test('keeps assistant messages with completed tool calls', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello', timestamp: 0 },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc-1', name: 'read_file', arguments: { path: 'foo.ts' } },
        ],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse',
        timestamp: 1,
      },
      {
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'read_file',
        content: [{ type: 'text', text: 'file contents' }],
        isError: false,
        timestamp: 2,
      },
    ]
    const filtered = filterIncompleteToolCalls(messages)
    expect(filtered).toHaveLength(3)
  })

  test('keeps assistant messages with only text content', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello', timestamp: 0 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello there!' }],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: 1,
      },
    ]
    const filtered = filterIncompleteToolCalls(messages)
    expect(filtered).toHaveLength(2)
  })

  test('handles empty message array', () => {
    expect(filterIncompleteToolCalls([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Fork Prompts: buildForkDirective, isInForkChild
// ---------------------------------------------------------------------------

describe('buildForkDirective', () => {
  test('includes fork-boilerplate tag', () => {
    const directive = buildForkDirective('Search for all API endpoints')
    expect(directive).toContain(`<${FORK_BOILERPLATE_TAG}>`)
    expect(directive).toContain(`</${FORK_BOILERPLATE_TAG}>`)
  })

  test('includes the user directive', () => {
    const directive = buildForkDirective('Refactor the auth module')
    expect(directive).toContain('Your directive: Refactor the auth module')
  })

  test('contains fork worker rules', () => {
    const directive = buildForkDirective('test')
    expect(directive).toContain('You are a forked worker process')
    expect(directive).toContain('Do NOT spawn sub-agents')
  })
})

describe('isInForkChild', () => {
  test('returns true when user message contains fork boilerplate (string content)', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: `<${FORK_BOILERPLATE_TAG}>worker rules</${FORK_BOILERPLATE_TAG}>\nYour directive: do stuff`,
        timestamp: 0,
      },
    ]
    expect(isInForkChild(messages)).toBe(true)
  })

  test('returns true when user message contains fork boilerplate (array content)', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `<${FORK_BOILERPLATE_TAG}>instructions</${FORK_BOILERPLATE_TAG}>\nYour directive: analyze`,
          },
        ],
        timestamp: 0,
      },
    ]
    expect(isInForkChild(messages)).toBe(true)
  })

  test('returns false when no fork boilerplate exists', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello world', timestamp: 0 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: 1,
      },
    ]
    expect(isInForkChild(messages)).toBe(false)
  })

  test('returns false for empty messages', () => {
    expect(isInForkChild([])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// createAgentId
// ---------------------------------------------------------------------------

describe('createAgentId', () => {
  test('generates id with label slug', () => {
    const id = createAgentId('My Test Agent')
    expect(id).toMatch(/^a-my-test-agent-[0-9a-f]{16}$/)
  })

  test('generates id without label', () => {
    const id = createAgentId()
    expect(id).toMatch(/^a-agent-[0-9a-f]{16}$/)
  })

  test('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createAgentId()))
    expect(ids.size).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// SUBAGENT_GUIDE content
// ---------------------------------------------------------------------------

describe('SUBAGENT_GUIDE', () => {
  test('includes default agent types', () => {
    expect(SUBAGENT_GUIDE).toContain('explore')
    expect(SUBAGENT_GUIDE).toContain('general-purpose')
    expect(SUBAGENT_GUIDE).toContain('code-reviewer')
    expect(SUBAGENT_GUIDE).toContain('browser_qa')
  })

  test('includes agent_create guidance', () => {
    expect(SUBAGENT_GUIDE).toContain('agent_create')
  })

  test('includes orchestration patterns', () => {
    expect(SUBAGENT_GUIDE).toContain('Fan-out')
    expect(SUBAGENT_GUIDE).toContain('Pipeline')
    expect(SUBAGENT_GUIDE).toContain('Escalate')
    expect(SUBAGENT_GUIDE).toContain('Evaluate')
  })

  test('includes fork mode guidance', () => {
    expect(SUBAGENT_GUIDE).toContain('Fork Mode')
    expect(SUBAGENT_GUIDE).toContain('Omit type')
  })

  test('includes lifecycle management tools', () => {
    expect(SUBAGENT_GUIDE).toContain('agent_spawn')
    expect(SUBAGENT_GUIDE).toContain('agent_result')
    expect(SUBAGENT_GUIDE).toContain('agent_status')
    expect(SUBAGENT_GUIDE).toContain('agent_cancel')
    expect(SUBAGENT_GUIDE).toContain('agent_list')
  })
})

// ---------------------------------------------------------------------------
// Unified tool set: includes agent_* tools + SkillServerSync
// ---------------------------------------------------------------------------

describe('unified createTools', () => {
  const workspaceDir = join(tmpdir(), `shogo-test-tools-${Date.now()}`)
  let tools: ReturnType<typeof createTools>

  beforeAll(() => {
    mkdirSync(workspaceDir, { recursive: true })
    const ctx: ToolContext = {
      workspaceDir,
      channels: new Map(),
      config: {
        model: { provider: 'anthropic', name: 'claude-sonnet-4-6' },
      } as any,
      projectId: 'test',
      fileStateCache: new FileStateCache(),
    }
    tools = createTools(ctx)
  })

  afterAll(() => {
    rmSync(workspaceDir, { recursive: true, force: true })
  })

  test('includes all agent orchestration tools', () => {
    const names = tools.map(t => t.name)
    expect(names).toContain('agent_create')
    expect(names).toContain('agent_spawn')
    expect(names).toContain('agent_status')
    expect(names).toContain('agent_cancel')
    expect(names).toContain('agent_result')
    expect(names).toContain('agent_list')
  })

  test('includes skill_server_sync', () => {
    const names = tools.map(t => t.name)
    expect(names).toContain('skill_server_sync')
  })

  test('does NOT include task or task_status', () => {
    const names = tools.map(t => t.name)
    expect(names).not.toContain('task')
    expect(names).not.toContain('task_status')
  })

  test('agent_spawn has optional type parameter', () => {
    const spawnTool = tools.find(t => t.name === 'agent_spawn')
    expect(spawnTool).toBeDefined()
    const schema = spawnTool!.parameters
    const props = (schema as any).properties
    expect(props.type).toBeDefined()
    // Type is wrapped in Optional, so it should not be in required
    const required = (schema as any).required || []
    expect(required).not.toContain('type')
  })

  test('agent_spawn has model_tier, max_turns, readonly parameters', () => {
    const spawnTool = tools.find(t => t.name === 'agent_spawn')
    expect(spawnTool).toBeDefined()
    const props = (spawnTool!.parameters as any).properties
    expect(props.model_tier).toBeDefined()
    expect(props.max_turns).toBeDefined()
    expect(props.readonly).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Transcript persistence (SqliteSessionPersistence)
// ---------------------------------------------------------------------------

describe('subagent transcript persistence', () => {
  const workspaceDir = join(tmpdir(), `shogo-test-transcript-${Date.now()}`)
  let persistence: SqliteSessionPersistence

  beforeAll(() => {
    mkdirSync(workspaceDir, { recursive: true })
    persistence = new SqliteSessionPersistence(workspaceDir)
  })

  afterAll(() => {
    persistence.close()
    rmSync(workspaceDir, { recursive: true, force: true })
  })

  test('save and load transcript', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello', timestamp: Date.now() },
    ]
    await persistence.saveSubagentTranscript('a-test-001', 'session-1', 'explore', 'test agent', messages)

    const loaded = await persistence.loadSubagentTranscript('a-test-001')
    expect(loaded).not.toBeNull()
    expect(loaded!.agentType).toBe('explore')
    expect(loaded!.description).toBe('test agent')
    expect(loaded!.messages).toHaveLength(1)
    expect(loaded!.messages[0].role).toBe('user')
  })

  test('load returns null for non-existent agent', async () => {
    const result = await persistence.loadSubagentTranscript('a-nonexistent-999')
    expect(result).toBeNull()
  })

  test('list transcripts by session', async () => {
    await persistence.saveSubagentTranscript('a-list-001', 'session-list', 'explore', 'search agent', [])
    await persistence.saveSubagentTranscript('a-list-002', 'session-list', 'general-purpose', 'general agent', [])
    await persistence.saveSubagentTranscript('a-list-003', 'session-other', 'explore', 'other session', [])

    const transcripts = await persistence.listSubagentTranscripts('session-list')
    expect(transcripts).toHaveLength(2)
    const types = transcripts.map(t => t.agentType)
    expect(types).toContain('explore')
    expect(types).toContain('general-purpose')
  })

  test('upsert (update) existing transcript', async () => {
    const msg1: Message[] = [{ role: 'user', content: 'v1', timestamp: 0 }]
    const msg2: Message[] = [
      { role: 'user', content: 'v1', timestamp: 0 },
      { role: 'user', content: 'v2', timestamp: 1 },
    ]
    await persistence.saveSubagentTranscript('a-upsert-001', 'session-up', 'explore', 'v1', msg1)
    await persistence.saveSubagentTranscript('a-upsert-001', 'session-up', 'explore', 'v2', msg2)

    const loaded = await persistence.loadSubagentTranscript('a-upsert-001')
    expect(loaded!.description).toBe('v2')
    expect(loaded!.messages).toHaveLength(2)
  })
})
