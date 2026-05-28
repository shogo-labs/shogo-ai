// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cumulative-pipeline-scoring contract for `runEval`.
 *
 * For pipeline phases (where `EvalRunnerConfig.pipelineToolCalls` is
 * supplied by the caller), intention-phase criteria see the union of
 * tool calls across all completed pipeline phases plus the current
 * phase. Execution-phase criteria still see only the current phase's
 * tool calls. Standalone evals (no `pipelineToolCalls`) behave exactly
 * as before — `toolCalls` is this-phase-only for both intention and
 * execution.
 *
 * This locks in the fix for the MiMo-eval bucket B failure: phases
 * that correctly skip work because earlier phases already did it were
 * being scored against an empty per-phase tool-call array, so
 * `usedTool('write_file', 'src/App.tsx')` failed even when the file
 * existed. Now those checks pass on later phases as long as ANY phase
 * of the same pipeline performed the action.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { runEval, type EvalRunnerConfig } from './runner'
import type { AgentEval, ToolCallRecord } from './types'

interface FakeServer {
  url: string
  close: () => void
  setReply: (text: string, toolCalls: Array<{ name: string; input: unknown }>) => void
}

/**
 * Minimal fake of the agent-runtime SSE endpoint. Returns one response
 * per call: a tool-input block per tool call, then a text block, then
 * [DONE]. Just enough for `parseSSEStream` in runner.ts to populate
 * `text` and `toolCalls`.
 */
function startFakeServer(): FakeServer {
  let nextText = ''
  let nextToolCalls: Array<{ name: string; input: unknown }> = []
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url)
      if (u.pathname.endsWith('/agent/chat')) {
        const lines: string[] = []
        // Emit one tool-input frame per call. The runner's parser
        // accepts `tool-input-start`/`tool-input-available` events;
        // see runner.ts::parseSSEStream.
        for (let i = 0; i < nextToolCalls.length; i++) {
          const tc = nextToolCalls[i]
          const toolCallId = `tc-${i}`
          lines.push(`data: ${JSON.stringify({ type: 'tool-input-available', toolCallId, toolName: tc.name, input: tc.input })}`)
          lines.push('')
        }
        lines.push(`data: ${JSON.stringify({ type: 'text-delta', id: 't1', delta: nextText })}`)
        lines.push('')
        lines.push(`data: ${JSON.stringify({ type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } })}`)
        lines.push('')
        lines.push('data: [DONE]')
        lines.push('')
        return new Response(lines.join('\n') + '\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return {
    url: `http://localhost:${server.port}`,
    close: () => server.stop(true),
    setReply: (text, toolCalls) => { nextText = text; nextToolCalls = toolCalls },
  }
}

const baseConfig = (server: FakeServer, overrides: Partial<EvalRunnerConfig> = {}): EvalRunnerConfig => ({
  agentEndpoint: `${server.url}/agent/chat`,
  timeoutMs: 30_000,
  verbose: false,
  workspaceDir: '/tmp/runner-pipeline-test',
  ...overrides,
})

function makeEval(criteria: AgentEval['validationCriteria']): AgentEval {
  return {
    id: 'test',
    name: 'test',
    category: 'test',
    level: 1,
    input: 'do the thing',
    maxScore: criteria.reduce((s, c) => s + c.points, 0),
    validationCriteria: criteria,
  }
}

describe('runEval — cumulative pipeline scoring', () => {
  let server: FakeServer
  beforeAll(() => { server = startFakeServer() })
  afterAll(() => server.close())

  test('standalone eval (no pipelineToolCalls): intention sees only this-phase calls', async () => {
    server.setReply('done', [{ name: 'write_file', input: { path: 'src/App.tsx' } }])
    const ev = makeEval([
      { name: 'wrote App.tsx (intention)', points: 1, phase: 'intention',
        validate: r => r.toolCalls.some(t => t.name === 'write_file') },
      { name: 'no schema write (intention)', points: 1, phase: 'intention',
        validate: r => !r.toolCalls.some(t => t.name === 'write_file' && (t.input as any).path?.includes('schema.prisma')) },
    ])
    const result = await runEval(ev, baseConfig(server))
    expect(result.score).toBe(2)
    expect(result.pipelineToolCalls).toBeUndefined()
  })

  test('pipeline phase 2: intention sees prior phase tool calls', async () => {
    // The current phase calls only `read_file`, but the prior pipeline
    // phase already wrote schema + App.tsx. Intention checks for those
    // earlier writes should pass, even though THIS phase didn't do them.
    server.setReply('reused existing files', [
      { name: 'read_file', input: { path: 'prisma/schema.prisma' } },
    ])
    const priorPhaseCalls: ToolCallRecord[] = [
      { name: 'write_file', input: { path: 'prisma/schema.prisma', content: 'model Lead {}' }, output: { ok: true }, error: undefined },
      { name: 'write_file', input: { path: 'src/App.tsx', content: '...' }, output: { ok: true }, error: undefined },
    ]
    const ev = makeEval([
      { name: 'pipeline ever wrote schema (intention)', points: 5, phase: 'intention',
        validate: r => r.toolCalls.some(t => t.name === 'write_file' && String((t.input as any).path).includes('schema.prisma')) },
      { name: 'pipeline ever wrote App.tsx (intention)', points: 5, phase: 'intention',
        validate: r => r.toolCalls.some(t => t.name === 'write_file' && String((t.input as any).path).includes('src/App.tsx')) },
      // Execution: this phase was supposed to read the schema and produce a response.
      { name: 'this phase read schema (execution)', points: 5, phase: 'execution',
        validate: r => r.toolCalls.some(t => t.name === 'read_file' && String((t.input as any).path).includes('schema.prisma')) },
      // Negative execution: this phase did NOT write any files (it should have read, not written).
      { name: 'this phase did not write (execution)', points: 5, phase: 'execution',
        validate: r => !r.toolCalls.some(t => t.name === 'write_file') },
    ])
    const result = await runEval(ev, baseConfig(server, { pipelineToolCalls: priorPhaseCalls }))
    expect(result.score).toBe(20)
    // pipelineToolCalls on the result should expose the union for log/debugging.
    expect(result.pipelineToolCalls).toBeDefined()
    expect(result.pipelineToolCalls!.length).toBe(3) // 2 prior + 1 this phase
    // toolCalls field on the result is still this-phase-only for downstream logs.
    expect(result.toolCalls.length).toBe(1)
  })

  test('execution criteria do NOT see prior phase calls', async () => {
    // Without the phase-aware swap, this execution criterion would
    // *erroneously* pass because the prior phase wrote schema. The
    // bug-prevention guarantee is: execution criteria only see what
    // THIS phase did.
    server.setReply('did nothing', [])
    const priorPhaseCalls: ToolCallRecord[] = [
      { name: 'write_file', input: { path: 'prisma/schema.prisma' }, output: { ok: true }, error: undefined },
    ]
    const ev = makeEval([
      // Execution check: did this phase write the schema? No.
      { name: 'this phase wrote schema (execution)', points: 5, phase: 'execution',
        validate: r => r.toolCalls.some(t => t.name === 'write_file' && String((t.input as any).path).includes('schema.prisma')) },
    ])
    const result = await runEval(ev, baseConfig(server, { pipelineToolCalls: priorPhaseCalls }))
    expect(result.score).toBe(0)
    expect(result.criteriaResults[0].passed).toBe(false)
  })

  test('default phase (unspecified) is treated as intention', async () => {
    server.setReply('ok', [])
    const priorPhaseCalls: ToolCallRecord[] = [
      { name: 'write_file', input: { path: 'src/App.tsx' }, output: { ok: true }, error: undefined },
    ]
    const ev = makeEval([
      // Phase unspecified — runner treats as intention; should see prior phase's call.
      { name: 'someone wrote App.tsx', points: 7,
        validate: r => r.toolCalls.some(t => t.name === 'write_file') },
    ])
    const result = await runEval(ev, baseConfig(server, { pipelineToolCalls: priorPhaseCalls }))
    expect(result.score).toBe(7)
  })

  test('empty pipelineToolCalls behaves like standalone (no swap)', async () => {
    server.setReply('done', [{ name: 'write_file', input: { path: 'src/App.tsx' } }])
    const ev = makeEval([
      { name: 'wrote App.tsx', points: 3, phase: 'intention',
        validate: r => r.toolCalls.some(t => t.name === 'write_file') },
    ])
    const result = await runEval(ev, baseConfig(server, { pipelineToolCalls: [] }))
    expect(result.score).toBe(3)
    // No prior phase calls → no cumulative array on the result.
    expect(result.pipelineToolCalls).toBeUndefined()
  })
})
