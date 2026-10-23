// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-172: a share link relayed through `project_call` must be repairable.
 *
 * The relaying agent never called `share_file`, so it used to learn no token
 * and the repair was a no-op — the user clicked a mangled link and got 404
 * `invalid_link`. These tests drive a real turn: a mocked `project_call`
 * result carries the minted URL, the model then repeats it with a re-encoded
 * payload, and both the live stream and the persisted message must carry the
 * minted token.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { AgentGateway } from '../gateway'
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai'
import { buildTextResponse, buildToolUseResponse } from './helpers/mock-anthropic'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const ROOT = '/tmp/test-sho172-share-link-relay'
const ORIGIN = 'https://studio.staging.shogo.ai'
const url = (token: string) => `${ORIGIN}/api/f/${token}`

const b64url = (value: string) => Buffer.from(value, 'utf8').toString('base64url')
const PAYLOAD = JSON.stringify({
  typ: 'shared-file',
  projectId: 'd3cce05d-5a1e-4c2b-9f30-6f1a2b3c4d5e',
  workspaceId: '0599aa18-8e7d-4f6a-9b21-3c4d5e6f7a8b',
  path: 'public/takes/2026-10-24-A.mp4',
  exp: 1792400531,
  iat: 1791795731,
})
const SIG = 'Rk7mQ2xT9vLp0aWz4NbCy6Hs8EdF1gJu3Kt5MoPq7Sw'
const MINTED = `${b64url(PAYLOAD)}.${SIG}`
// What the model re-typed: one extra JSON byte re-encodes every base64
// character after it, while the signature is copied exactly.
const MANGLED = `${b64url(PAYLOAD.replace('"workspaceId"', '"wworkspaceId"'))}.${SIG}`
const REPLY = `Here is the take: ${url(MANGLED)}\n\nThe link expires in 7 days.`
const REPAIRED_REPLY = REPLY.replace(url(MANGLED), url(MINTED))

function makeWorkspace(name: string): string {
  const ws = join(ROOT, name)
  if (existsSync(ws)) rmSync(ws, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  mkdirSync(join(ws, 'memory'), { recursive: true })
  mkdirSync(join(ws, 'skills'), { recursive: true })
  writeFileSync(join(ws, 'config.json'), JSON.stringify({
    heartbeatInterval: 1800,
    heartbeatEnabled: false,
    quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
    channels: [],
    model: { provider: 'custom', name: 'hoshi-2-0' },
  }))
  writeFileSync(join(ws, 'AGENTS.md'), '# Identity\nshare link relay test\n')
  writeFileSync(join(ws, 'MEMORY.md'), '# Memory\n- nothing yet\n')
  return ws
}

function assistantText(gw: AgentGateway, sessionId: string): string {
  const session = gw.getSessionManager().get(sessionId)
  return (session?.messages ?? [])
    .filter((m: any) => m.role === 'assistant' && Array.isArray(m.content))
    .flatMap((m: any) => m.content)
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n')
}

/**
 * A stream function whose second call streams its text in small deltas, like a
 * real provider — `createMockStreamFn` only emits start/done, so it never
 * exercises the live `LocalhostLinkRewriter` path.
 */
function streamingTurn(toolResponse: any, replyText: string, chunkSize = 17): any {
  const reply = buildTextResponse(replyText)
  let call = 0
  return () => {
    const stream = createAssistantMessageEventStream()
    const isToolCall = call++ === 0
    queueMicrotask(() => {
      if (isToolCall) {
        stream.push({ type: 'start', partial: toolResponse })
        stream.push({ type: 'done', reason: 'toolUse', message: toolResponse })
        stream.end(toolResponse)
        return
      }
      const partial: any = { ...reply, content: [{ type: 'text', text: '' }] }
      stream.push({ type: 'start', partial })
      stream.push({ type: 'text_start', contentIndex: 0, partial })
      for (let i = 0; i < replyText.length; i += chunkSize) {
        const delta = replyText.slice(i, i + chunkSize)
        partial.content[0].text += delta
        stream.push({ type: 'text_delta', contentIndex: 0, delta, partial })
      }
      stream.push({ type: 'text_end', contentIndex: 0, content: replyText, partial })
      stream.push({ type: 'done', reason: 'stop', message: reply })
      stream.end(reply)
    })
    return stream as any
  }
}

beforeAll(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})

afterAll(() => {
  clearTrustForTests()
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
})

describe('share link relayed through project_call (SHO-172)', () => {
  test('a non-share_file tool result teaches the token, and the mistyped copy is repaired in the stream and in history', async () => {
    const ws = makeWorkspace('relay')
    trustWorkspaceForTests(ws)
    const gw = new AgentGateway(ws, 'p-sho172-relay')
    gw.setToolMocks({
      project_call: () => ({ ok: true, reply: `the take is ready: ${url(MINTED)}` }),
    })
    gw.setStreamFn(streamingTurn(
      buildToolUseResponse(
        [{ name: 'project_call', arguments: { project: 'content', message: 'share the take' }, id: 'pc1' }],
        { input: 100, output: 20 },
      ),
      REPLY,
    ))

    await gw.start()
    try {
      const chunks: Array<Record<string, any>> = []
      const reply = await (gw as any).agentTurn('relay the take', 'sess-relay', false, undefined, {
        write: (chunk: Record<string, any>) => chunks.push(chunk),
      })

      // The token came from the relayed tool result, not from `share_file`.
      expect((gw as any).shareLinkTokensFor('sess-relay').has(MINTED)).toBe(true)

      // Live stream (LocalhostLinkRewriter)…
      const streamed = chunks
        .filter((c) => c.type === 'text-delta')
        .map((c) => String(c.delta ?? ''))
        .join('')
      expect(streamed).toBe(REPAIRED_REPLY)
      expect(streamed).not.toContain(MANGLED)

      // …the returned text, and the persisted assistant message.
      expect(reply).toBe(REPAIRED_REPLY)
      expect(assistantText(gw, 'sess-relay')).toBe(REPAIRED_REPLY)
    } finally {
      clearTrustForTests()
      try { await gw.stop() } catch {}
    }
  }, 60_000)
})

describe('harvestShareLinkTokens', () => {
  test('learns a token from any tool result shape', () => {
    const gw = new AgentGateway(makeWorkspace('host'), 'p-sho172-harvest')
    const harvest = (sessionId: string, result: unknown, isError: boolean) =>
      (gw as any).harvestShareLinkTokens(sessionId, result, isError)

    harvest('s-string', `relayed: ${url(MINTED)}`, false)
    harvest('s-object', { content: [{ type: 'text', text: JSON.stringify({ reply: url(MINTED) }) }] }, false)

    expect((gw as any).shareLinkTokensFor('s-string')).toEqual(new Set([MINTED]))
    expect((gw as any).shareLinkTokensFor('s-object')).toEqual(new Set([MINTED]))
  })

  test('ignores error results and results that carry no share link', () => {
    const gw = new AgentGateway(makeWorkspace('host-error'), 'p-sho172-harvest-error')
    const harvest = (sessionId: string, result: unknown, isError: boolean) =>
      (gw as any).harvestShareLinkTokens(sessionId, result, isError)

    harvest('s-error', `failed: ${url(MINTED)}`, true)
    harvest('s-none', 'Download complete.', false)

    expect((gw as any).shareLinkTokensFor('s-error').size).toBe(0)
    expect((gw as any).shareLinkTokensFor('s-none').size).toBe(0)
  })
})
