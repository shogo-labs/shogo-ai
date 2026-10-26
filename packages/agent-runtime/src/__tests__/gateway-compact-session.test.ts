// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-96 — the manual "Summarize now" path (`POST /agent/sessions/:id/compact`).
 *
 * The route must answer honestly, because the dock shows the answer verbatim:
 * `compacted` for a real summarize, `queued` when a turn is live (the request
 * that is already in flight cannot be un-sent), and `nothing-to-compact` when
 * there is nothing foldable — never a green 200 with an unchanged session.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, UserMessage } from '@mariozechner/pi-ai'
import { AgentGateway } from '../gateway'
import { SessionManager } from '../session-manager'

function user(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: Date.now() }
}

function bigTurn(prefix: string): Message[] {
  const messages: Message[] = [user(`${prefix} start`)]
  for (let i = 0; i < 12; i++) {
    messages.push({
      role: 'toolResult',
      toolCallId: `tc_${prefix}_${i}`,
      toolName: 'exec',
      content: [{ type: 'text', text: 'x'.repeat(20_000) }],
      isError: false,
      timestamp: Date.now(),
    } as any)
    messages.push(user(`${prefix} step ${i}`))
  }
  return messages
}

let workspace: string
let gateway: AgentGateway
let sessions: SessionManager

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'shogo-compact-gw-'))
  mkdirSync(join(workspace, '.shogo'), { recursive: true })
  gateway = new AgentGateway(workspace, 'proj_compact_test')
  sessions = gateway.getSessionManager()
  sessions.setSummarizeFn(async (_chunk, previousSummary) => `${previousSummary ?? 'SUMMARY'} folded`)
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('AgentGateway.compactSession', () => {
  test('an idle session is compacted now and reports the real before/after', async () => {
    sessions.addMessages('idle-big', ...bigTurn('a'))
    const before = sessions.getDetail('idle-big')!.estimatedTokens

    const result = await gateway.compactSession('idle-big')

    expect(result.status).toBe('compacted')
    expect(result.tokensBefore).toBe(before)
    expect(result.tokensAfter!).toBeLessThan(before)
    expect(result.messagesAfter!).toBeLessThan(result.messagesBefore!)
    expect(result.summaryChars!).toBeGreaterThan(0)
    expect(sessions.getDetail('idle-big')!.compactionCount).toBe(1)
    expect(sessions.getDetail('idle-big')!.compactedSummary).toContain('folded')
  })

  test('a session with nothing foldable says so instead of faking a success', async () => {
    sessions.addMessages('idle-small', user('just one message'))
    const result = await gateway.compactSession('idle-small')

    expect(result.status).toBe('nothing-to-compact')
    expect(result.reason).toBe('nothing to compact')
    expect(sessions.getDetail('idle-small')!.compactionCount).toBe(0)
  })

  test('an unknown session is a 404, not a silent no-op', async () => {
    const result = await gateway.compactSession('does-not-exist')
    expect(result.status).toBe('unknown-session')
  })

  test('a live turn queues the request for its next step', async () => {
    sessions.addMessages('live', ...bigTurn('b'))
    // Stand in for a turn in flight: the gateway keys live turns off this map.
    ;(gateway as any).turnAbortControllers.set('live', { signal: new AbortController().signal })

    const result = await gateway.compactSession('live')
    expect(result.status).toBe('queued')
    expect((gateway as any).manualCompactionRequests.has('live')).toBe(true)

    // The turn boundary must not summarize twice: the queued flag is consumed
    // by the next transformContext, and the session is untouched until then.
    expect(sessions.getDetail('live')!.compactionCount).toBe(0)
  })
})
