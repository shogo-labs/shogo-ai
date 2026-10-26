// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reproduction (SHO-223): Dev 1 sent `exec {"command": ""}` four times in a row.
 * `Type.String()` accepts `""`, so the call reached `execute`, ran an empty
 * shell command and came back exit 0 — which reads as success. Nothing told the
 * model its arguments had been lost.
 *
 * The fix is one schema-driven guard in `wrapSingleTool`, so every tool (gateway,
 * MCP, composio) rejects a missing or blank required string before it runs.
 * pi-agent-core turns the thrown error into an `isError` tool result whose text
 * is the message asserted here, and `agent-loop` records that as `{ error }`,
 * which the `no_progress` breaker counts.
 */
import { describe, test, expect } from 'bun:test'
import { runAgentLoop } from '@mariozechner/pi-agent-core'
import type {
  AgentContext,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  StreamFn,
} from '@mariozechner/pi-agent-core'
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
} from '@mariozechner/pi-ai'
import {
  emptyArgsMessage,
  findEmptyFromNames,
  findEmptyRequiredArgs,
  requiredStringProps,
} from '../tool-arg-guard'
import { wrapToolsWithOrchestration } from '../tool-orchestration'
import { LoopDetector } from '../loop-detector'

/** Mirrors the real `exec` schema: one required string, optional non-strings. */
const execSchema = {
  type: 'object',
  properties: {
    command: { type: 'string' },
    timeout: { type: 'number' },
    background: { type: 'boolean' },
  },
  required: ['command'],
}

/** Mirrors `write_file`: two required strings. */
const writeSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['path', 'content'],
}

/** Mirrors `read_file`: one required string plus optional/union extras. */
const readSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    offset: { anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }] },
    limit: { type: 'number' },
  },
  required: ['path'],
}

function makeTool(
  name: string,
  parameters: unknown,
  options: { gate?: Promise<void> } = {},
): { tool: AgentTool; calls: any[] } {
  const calls: any[] = []
  const tool: AgentTool = {
    name,
    description: `Mock ${name}`,
    label: name,
    parameters: parameters as any,
    execute: async (_toolCallId: string, params: any) => {
      calls.push(params)
      if (options.gate) await options.gate
      return { content: [{ type: 'text' as const, text: `ok:${name}` }], details: { ok: true } }
    },
  }
  return { tool, calls }
}

function toolByName(tools: AgentTool[], name: string): AgentTool {
  const hit = tools.find((t) => t.name === name)
  if (!hit) throw new Error(`tool ${name} not found`)
  return hit
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

describe('findEmptyRequiredArgs / requiredStringProps', () => {
  test('reads required top-level string properties from the tool schema', () => {
    expect(requiredStringProps(execSchema)).toEqual(['command'])
    expect(requiredStringProps(writeSchema)).toEqual(['path', 'content'])
    expect(requiredStringProps(readSchema)).toEqual(['path'])
  })

  test('flags missing, null, "" and whitespace-only values', () => {
    expect(findEmptyRequiredArgs(execSchema, {})).toEqual(['command'])
    expect(findEmptyRequiredArgs(execSchema, { command: undefined })).toEqual(['command'])
    expect(findEmptyRequiredArgs(execSchema, { command: null })).toEqual(['command'])
    expect(findEmptyRequiredArgs(execSchema, { command: '' })).toEqual(['command'])
    expect(findEmptyRequiredArgs(execSchema, { command: '   \n\t ' })).toEqual(['command'])
    expect(findEmptyRequiredArgs(execSchema, { command: 'ls' })).toEqual([])
  })

  test('never flags optional strings, or non-string required values', () => {
    const schema = {
      type: 'object',
      properties: {
        command: { type: 'string' },
        description: { type: 'string' },
        count: { type: 'number' },
        force: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['command', 'count', 'force', 'tags'],
    }

    expect(
      findEmptyRequiredArgs(schema, { command: 'ls', description: '', count: 0, force: false, tags: [] }),
    ).toEqual([])
  })

  test('fails open on schemas it cannot read', () => {
    expect(findEmptyRequiredArgs(undefined, {})).toEqual([])
    expect(findEmptyRequiredArgs({}, {})).toEqual([])
    expect(findEmptyRequiredArgs({ type: 'object' }, {})).toEqual([])
    expect(findEmptyRequiredArgs({ type: 'object', properties: { a: { type: 'string' } } }, {})).toEqual([])
    expect(findEmptyRequiredArgs({ anyOf: [{ type: 'object', required: ['a'] }] }, {})).toEqual([])
    expect(findEmptyRequiredArgs({ oneOf: [{ type: 'object', required: ['a'] }] }, {})).toEqual([])
  })

  test('exempts a property that declares x-empty-ok — "" is a real argument there', () => {
    // edit_file.old_string "" creates a file, edit_file.new_string "" deletes
    // text, write_file.content "" writes an empty file. Those schemas opt out.
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', 'x-empty-ok': true },
        new_string: { type: 'string', 'x-empty-ok': true },
      },
      required: ['path', 'old_string', 'new_string'],
    }

    expect(requiredStringProps(schema)).toEqual(['path'])
    expect(findEmptyRequiredArgs(schema, { path: 'a.txt', old_string: '', new_string: 'hi' })).toEqual([])
    expect(findEmptyRequiredArgs(schema, { path: 'a.txt', old_string: 'x', new_string: '' })).toEqual([])
    // The opt-out is per property: a blank path is still a lost argument.
    expect(findEmptyRequiredArgs(schema, { path: '', old_string: '', new_string: '' })).toEqual(['path'])
    // Only the literal `true` opts out.
    expect(requiredStringProps({ type: 'object', properties: { a: { type: 'string', 'x-empty-ok': false } }, required: ['a'] })).toEqual(['a'])
  })

  test('checks the top level only — nested required strings are left to schema validation', () => {
    const schema = {
      type: 'object',
      properties: {
        command: { type: 'string' },
        options: {
          type: 'object',
          properties: { cwd: { type: 'string' } },
          required: ['cwd'],
        },
      },
      required: ['command'],
    }
    expect(findEmptyRequiredArgs(schema, { command: 'ls', options: {} })).toEqual([])
  })

  test('message names the argument(s) and says the arguments were lost', () => {
    expect(emptyArgsMessage('exec', ['command'])).toBe(
      "exec: required argument 'command' was empty. Your tool-call arguments were lost; " +
        'resend the call with the content, or write large payloads with write_file.',
    )
    expect(emptyArgsMessage('write_file', ['path', 'content'])).toContain(
      "required arguments 'path', 'content' were empty",
    )
  })

  test('findEmptyFromNames is the per-call fast path over a precomputed list', () => {
    expect(findEmptyFromNames([], {})).toEqual([])
    expect(findEmptyFromNames(['a', 'b'], { a: '', b: 'x' })).toEqual(['a'])
    expect(findEmptyFromNames(['a'], null)).toEqual(['a'])
  })
})

describe('wrapToolsWithOrchestration — empty-argument guard', () => {
  test('rejects exec with an empty command before it runs', async () => {
    const { tool, calls } = makeTool('exec', execSchema)
    const { tools } = wrapToolsWithOrchestration([tool])
    const exec = toolByName(tools, 'exec')

    const error = await exec.execute('call-1', { command: '' }).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("required argument 'command' was empty")
    expect((error as Error).message).toContain('arguments were lost')
    expect(calls).toHaveLength(0)

    // Whitespace-only is the same failure — `exec "   "` also exits 0 silently.
    await expect(exec.execute('call-2', { command: '   ' })).rejects.toThrow(/command/)
    expect(calls).toHaveLength(0)
  })

  test('rejects any second tool by its own schema — no tool-specific code', async () => {
    const { tool, calls } = makeTool('write_file', writeSchema)
    const { tools } = wrapToolsWithOrchestration([tool])
    const write = toolByName(tools, 'write_file')

    await expect(write.execute('call-1', { path: 'a.txt', content: '' })).rejects.toThrow(
      /write_file: required argument 'content' was empty/,
    )
    await expect(write.execute('call-2', { content: 'hi' })).rejects.toThrow(
      /required argument 'path' was empty/,
    )
    expect(calls).toHaveLength(0)
  })

  test('concurrency-safe tools are guarded too', async () => {
    const { tool, calls } = makeTool('read_file', readSchema)
    const { tools } = wrapToolsWithOrchestration([tool])
    const read = toolByName(tools, 'read_file')

    await expect(read.execute('call-1', { path: '' })).rejects.toThrow(
      /read_file: required argument 'path' was empty/,
    )
    expect(calls).toHaveLength(0)

    const ok = await read.execute('call-2', { path: 'AGENTS.md' })
    expect((ok.content[0] as any).text).toBe('ok:read_file')
    expect(calls).toHaveLength(1)
  })

  test('a schema that opts out still runs with an empty required string', async () => {
    // The real edit_file / write_file schemas mark these `'x-empty-ok': true`:
    // "" creates a file, deletes text, or writes an empty file.
    const editSchema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', 'x-empty-ok': true },
        new_string: { type: 'string', 'x-empty-ok': true },
      },
      required: ['path', 'old_string', 'new_string'],
    }
    const writeEmptySchema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string', 'x-empty-ok': true },
      },
      required: ['path', 'content'],
    }
    const { tool: edit, calls: editCalls } = makeTool('edit_file', editSchema)
    const { tool: write, calls: writeCalls } = makeTool('write_file', writeEmptySchema)
    const { tools } = wrapToolsWithOrchestration([edit, write])

    await toolByName(tools, 'edit_file').execute('call-1', { path: 'a.txt', old_string: '', new_string: 'hi\n' })
    await toolByName(tools, 'edit_file').execute('call-2', { path: 'a.txt', old_string: 'DROP\n', new_string: '' })
    await toolByName(tools, 'write_file').execute('call-3', { path: 'empty.txt', content: '' })

    expect(editCalls).toHaveLength(2)
    expect(writeCalls).toHaveLength(1)

    // The exemption is per property — a blank path is still a lost argument.
    await expect(
      toolByName(tools, 'edit_file').execute('call-4', { path: '', old_string: '', new_string: 'hi\n' }),
    ).rejects.toThrow(/required argument 'path' was empty/)
    expect(editCalls).toHaveLength(2)
  })

  test('leaves optional strings, required numbers and required booleans alone', async () => {
    const schema = {
      type: 'object',
      properties: {
        command: { type: 'string' },
        description: { type: 'string' },
        count: { type: 'number' },
        force: { type: 'boolean' },
      },
      required: ['command', 'count', 'force'],
    }
    const { tool, calls } = makeTool('exec', schema)
    const { tools } = wrapToolsWithOrchestration([tool])

    await toolByName(tools, 'exec').execute('call-1', {
      command: 'ls',
      description: '',
      count: 0,
      force: false,
    })
    expect(calls).toHaveLength(1)
  })

  test('a rejected call takes neither the semaphore nor the write mutex', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { tool: slowWrite } = makeTool('write_file', writeSchema, { gate })
    const { tool: blockedWrite, calls: blockedCalls } = makeTool('edit_file', writeSchema)

    // One slot, so a call that reached the semaphore would queue behind `pending`.
    const { tools, state } = wrapToolsWithOrchestration([slowWrite, blockedWrite], { maxConcurrency: 1 })
    const pending = toolByName(tools, 'write_file').execute('call-1', { path: 'a.txt', content: 'x' })
    await tick()
    expect(state.writeMutex.isLocked).toBe(true)

    const outcome = await Promise.race([
      toolByName(tools, 'edit_file')
        .execute('call-2', { path: 'a.txt', content: '' })
        .then(() => 'resolved', (e: Error) => e),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 500)),
    ])
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toContain("required argument 'content' was empty")
    expect(blockedCalls).toHaveLength(0)
    expect(state.semaphore.waiting).toBe(0)

    release()
    await pending
  })

  test('an empty call after the guard still counts as no progress', async () => {
    // The reported failure mode: a model that keeps sending the empty call. The
    // guard's error is an isError result, which agent-loop records as `{ error }`,
    // so the existing no-progress breaker still stops it — at 5, before 10.
    const { tool } = makeTool('exec', execSchema)
    const { tools } = wrapToolsWithOrchestration([tool])
    const exec = toolByName(tools, 'exec')
    const detector = new LoopDetector()

    let last
    for (let i = 0; i < 5; i++) {
      const output = await exec
        .execute(`call-${i}`, { command: '' })
        .then(() => ({ details: {} }), (e: Error) => ({ error: e.message }))
      last = detector.recordAndCheck('exec', { command: '' }, output)
    }

    expect(last?.loopDetected).toBe(true)
    expect(last?.reason).toBe('no_progress')
  })
})

describe('pi agent loop — the guard reaches the model as an error tool result', () => {
  const usage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }

  function fakeModel(): Model<Api> {
    return {
      id: 'fake', name: 'fake', api: 'openai-completions', provider: 'openai',
      baseUrl: 'https://example.invalid', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000, maxTokens: 100,
    } as Model<Api>
  }

  function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
    return {
      role: 'assistant', content, api: 'openai-completions', provider: 'openai', model: 'fake',
      usage, stopReason, timestamp: 0,
    } as AssistantMessage
  }

  test('exec {"command": ""} comes back isError with the guard text and never runs', async () => {
    // Round 1: the model sends the lost-arguments call. Round 2: it gives up and
    // answers, so the loop finishes normally instead of hanging on a tool result.
    let round = 0
    const streamFn = ((_model: Model<Api>) => {
      const s = createAssistantMessageEventStream()
      queueMicrotask(() => {
        if (round++ === 0) {
          const toolCall = { type: 'toolCall' as const, id: 'call_1', name: 'exec', arguments: { command: '' } }
          const message = assistant([toolCall], 'toolUse')
          s.push({ type: 'start', partial: message } as AssistantMessageEvent)
          s.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: message } as AssistantMessageEvent)
          s.push({ type: 'done', reason: 'toolUse', message } as AssistantMessageEvent)
        } else {
          const message = assistant([{ type: 'text', text: 'retrying' }], 'stop')
          s.push({ type: 'start', partial: message } as AssistantMessageEvent)
          s.push({ type: 'done', reason: 'stop', message } as AssistantMessageEvent)
        }
      })
      return s
    }) as StreamFn

    const { tool, calls } = makeTool('exec', execSchema)
    const { tools } = wrapToolsWithOrchestration([tool])
    const context: AgentContext = {
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'do it', timestamp: 0 } as AgentMessage],
      tools,
    }
    const config: AgentLoopConfig = { model: fakeModel(), convertToLlm: (messages) => messages as any }

    const events: any[] = []
    await runAgentLoop(
      [{ role: 'user', content: 'do it', timestamp: 0 } as AgentMessage],
      context,
      config,
      (event) => { events.push(event) },
      undefined,
      streamFn,
    )

    const end = events.find((e) => e.type === 'tool_execution_end')
    expect(end?.isError).toBe(true)
    expect(end?.result?.content?.[0]?.text).toContain("required argument 'command' was empty")
    expect(end?.result?.content?.[0]?.text).toContain('arguments were lost')
    expect(calls).toHaveLength(0)
  })
})
