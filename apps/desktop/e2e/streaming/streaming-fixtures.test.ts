// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Checks for the streaming e2e's own fixtures (bun test). If these are wrong,
 * the e2e verdicts mean nothing.
 *
 *   bun test apps/desktop/e2e/streaming/streaming-fixtures.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { FakeLlmServer, expectedTokens, marker, token } from './fake-llm-server'
import { checkSequence, isCleanPrefix, isExactRun, maxDivergenceMs, renderLag } from './stream-probe'

const tools = [{ type: 'function', function: { name: 'read_file', parameters: {} } }]

async function complete(url: string, messages: unknown[], withTools = true): Promise<string> {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake-stream', stream: true, messages, ...(withTools ? { tools } : {}) }),
  })
  return res.text()
}

function parseSse(text: string) {
  return text
    .split('\n\n')
    .filter((f) => f.startsWith('data: ') && !f.includes('[DONE]'))
    .map((f) => JSON.parse(f.slice(6)))
    .filter((c) => c.choices?.length)
    .map((c) => c.choices[0])
}

const textOf = (choices: any[]) => choices.map((c) => c.delta.content ?? '').join('')
const tokensIn = (text: string, tag: string) =>
  [...text.matchAll(new RegExp(`t${tag}w(\\d{4})`, 'g'))].map((m) => Number(m[1]))

describe('FakeLlmServer', () => {
  const llm = new FakeLlmServer()
  beforeAll(() => llm.start())
  afterAll(() => llm.stop())

  test('a finished reply ends with a usage chunk, like a real server', async () => {
    const text = await complete(llm.url, [{ role: 'user', content: `${marker('long', 'u', 5, { ms: 1 })} go` }])
    const usage = text
      .split('\n\n')
      .filter((f) => f.startsWith('data: ') && !f.includes('[DONE]'))
      .map((f) => JSON.parse(f.slice(6)))
      .find((c) => c.usage)
    expect(usage.usage.completion_tokens).toBe(5)
  })

  test('long streams exactly n numbered tokens', async () => {
    const out = parseSse(await complete(llm.url, [{ role: 'user', content: `${marker('long', 'a', 30, { ms: 1 })} go` }]))
    expect(tokensIn(textOf(out), 'a')).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
    expect(out.at(-1)!.finish_reason).toBe('stop')
    expect(llm.sentAt('a')).toHaveLength(30)
  })

  test('requests without tools stay plain even when they quote a marker', async () => {
    const out = parseSse(await complete(llm.url, [{ role: 'user', content: `title for: ${marker('long', 'q', 500)}` }], false))
    expect(textOf(out)).toBe('ok')
  })

  test('tool script splits tokens across rounds and calls a tool between them', async () => {
    const user = { role: 'user', content: `${marker('tool', 't', 30, { ms: 1, rounds: 2 })} go` }
    const r0 = parseSse(await complete(llm.url, [user]))
    expect(tokensIn(textOf(r0), 't')).toEqual(Array.from({ length: 10 }, (_, i) => i + 1))
    expect(r0.at(-1)!.finish_reason).toBe('tool_calls')
    const call = r0.flatMap((c) => c.delta.tool_calls ?? [])
    expect(call[0].function.name).toBe('read_file')
    expect(JSON.parse(call.map((c: any) => c.function.arguments).join(''))).toEqual({ path: 'AGENTS.md', offset: 1, limit: 1 })

    const toolReply = (id: string) => ({ role: 'tool', tool_call_id: id, content: 'x' })
    const asst = { role: 'assistant', content: null, tool_calls: [{ id: 'call_t_0', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }
    const r1 = parseSse(await complete(llm.url, [user, asst, toolReply('call_t_0')]))
    expect(tokensIn(textOf(r1), 't')).toEqual(Array.from({ length: 10 }, (_, i) => i + 11))
    expect(r1.at(-1)!.finish_reason).toBe('tool_calls')

    const r2 = parseSse(await complete(llm.url, [user, asst, toolReply('call_t_0'), asst, toolReply('call_t_1')]))
    expect(tokensIn(textOf(r2), 't')).toEqual(Array.from({ length: 10 }, (_, i) => i + 21))
    expect(r2.at(-1)!.finish_reason).toBe('stop')

    expect(llm.sentAt('t')).toHaveLength(30)
    expect(llm.requestsFor('t').map((t) => t.round)).toEqual([0, 1, 2])
  })

  test('hold sends no tokens until released', async () => {
    const pending = complete(llm.url, [{ role: 'user', content: marker('hold', 'h', 10, { ms: 1 }) }])
    await llm.waitForTurn('h')
    await new Promise((r) => setTimeout(r, 150))
    expect(llm.sentAt('h')).toHaveLength(0)
    llm.release('h')
    expect(tokensIn(textOf(parseSse(await pending)), 'h')).toHaveLength(10)
  })

  // Hang-up detection (`wasCancelled`) is not tested here: Bun's node:http
  // never reports a client hang-up. The e2e runs under Node and asserts it in
  // the Stop scenarios.

  test('release before the request arrives still lets it through', async () => {
    llm.release('early')
    const out = parseSse(await complete(llm.url, [{ role: 'user', content: marker('hold', 'early', 5, { ms: 1 }) }]))
    expect(tokensIn(textOf(out), 'early')).toHaveLength(5)
  })
})

describe('sequence checks', () => {
  test('exact run vs duplicates, gaps and reordering', () => {
    expect(isExactRun([1, 2, 3], 3)).toBe(true)
    expect(isExactRun([1, 2, 3, 3], 3)).toBe(false)
    expect(checkSequence([1, 2, 2, 3])).toMatchObject({ repeats: 1, gaps: [], outOfOrder: 0 })
    expect(checkSequence([1, 3, 4])).toMatchObject({ gaps: [2] })
    expect(checkSequence([1, 2, 3, 2])).toMatchObject({ outOfOrder: 1, repeats: 1 })
    expect(isCleanPrefix([1, 2, 3])).toBe(true)
    expect(isCleanPrefix([1, 3])).toBe(false)
  })

  test('token helpers agree', () => {
    expect(token('a', 7)).toBe('taw0007')
    expect(expectedTokens('a', 2)).toEqual(['taw0001', 'taw0002'])
  })
})

describe('lag analysis', () => {
  const sample = (t: number, max: number) => ({ t, max, distinct: max, total: max })

  test('render lag is the time from send to first sample showing it', () => {
    const lag = renderLag({ sentAt: [100, 200, 300] }, [sample(150, 1), sample(260, 2), sample(500, 3)])
    expect(lag.firstTokenMs).toBe(50)
    expect(lag.maxMs).toBe(200)
    expect(lag.neverShown).toBe(0)
  })

  test('tokens that never appear are counted', () => {
    expect(renderLag({ sentAt: [100, 200] }, [sample(150, 1)]).neverShown).toBe(1)
  })

  test('divergence is how long the slower view takes to reach what the faster one showed', () => {
    const ahead = [sample(100, 1), sample(200, 2)]
    const behind = [sample(400, 1), sample(900, 2)]
    expect(maxDivergenceMs(ahead, behind)).toBe(700)
    expect(maxDivergenceMs(ahead, ahead)).toBe(0)
  })
})
