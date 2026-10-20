// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-96 criterion 9 — a *resumed* session must be under the cap on its first
 * request.
 *
 * Production says the boundary check was not seeing the wire: on `claude-opus-5-5`
 * per-call context is p50 162k / p75 234k / max 854k with **no clustering at the
 * threshold**, i.e. sessions hydrated above the cap stayed there. So the contract
 * is asserted on the request the provider receives (`streamFn` boundary), not on
 * the stored session estimate: hydrate 250k tokens of history, run one turn, and
 * the first request must be ≤ the cap.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, UserMessage } from '@mariozechner/pi-ai'
import { AgentGateway } from '../gateway'
import { DEFAULT_AUTOCOMPACT_TOKENS, estimateMessageTokens } from '../session-manager'
import { createMockStreamFn, buildTextResponse } from './helpers/mock-anthropic'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

function user(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: Date.now() }
}

/**
 * ~250k tokens of history that survives the cheap layers.
 *
 * Tool results alone do not get there: `checkpointOldToolResults` clears them to
 * a budget, which is exactly why production sessions sit at p50 162k with raw
 * transcripts above 200k. Assistant text is what the cheap layers leave alone,
 * so that is what a resumed session has to be summarized out of.
 */
function hydratedHistory(): Message[] {
  const messages: Message[] = [user('resume: continue the migration where we left off')]
  for (let i = 0; i < 12; i++) {
    messages.push(user(`step ${i} request: ` + 'q'.repeat(80_000)))
    messages.push({ role: 'assistant', content: `step ${i} done`, timestamp: Date.now() } as any)
  }
  return messages
}

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'shogo-sho96-hydrated-'))
  mkdirSync(join(workspace, '.shogo'), { recursive: true })
  mkdirSync(join(workspace, 'memory'), { recursive: true })
  writeFileSync(join(workspace, 'AGENTS.md'), '# Identity\nhydrated resume test\n')
  writeFileSync(join(workspace, 'MEMORY.md'), '# Memory\n- nothing yet\n')
})

afterEach(() => {
  clearTrustForTests()
  rmSync(workspace, { recursive: true, force: true })
})

describe('a resumed session is compacted before its first request goes out', () => {
  test('hydrated 250k history: first request on the wire is under the cap', async () => {
    trustWorkspaceForTests(workspace)
    const gw = new AgentGateway(workspace, 'proj_sho96_hydrated')
    const sessions = gw.getSessionManager()
    sessions.setSummarizeFn(async (_chunk, previousSummary) => `${previousSummary ?? 'SUMMARY'} folded`)

    const history = hydratedHistory()
    const hydratedTokens = history.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
    expect(hydratedTokens).toBeGreaterThan(DEFAULT_AUTOCOMPACT_TOKENS)

    sessions.addMessages('sess-resumed', ...history)
    const before = sessions.getDetail('sess-resumed')!.estimatedTokens

    const onWire: number[] = []
    const wireMessages: Message[][] = []
    gw.setStreamFn(
      createMockStreamFn([buildTextResponse('resumed and continuing')], (_i: number, messages: Message[]) => {
        onWire.push(messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0))
        wireMessages.push(messages)
      }),
    )

    await gw.start()
    try {
      await (gw as any).agentTurn('continue', 'sess-resumed', false)
    } finally {
      await gw.stop?.()
    }

    expect(onWire.length).toBeGreaterThan(0)
    const firstRequest = wireMessages[0]
    // The first thing the provider sees is already summarized, not the 250k head.
    expect(onWire[0]).toBeLessThanOrEqual(DEFAULT_AUTOCOMPACT_TOKENS)
    expect(onWire[0]).toBeLessThan(before)
    // It is a summary, not silent pruning: the request opens with the folded
    // summary message, so the 240k head became text the model can still use.
    expect(typeof firstRequest[0]?.content).toBe('string')
    expect(firstRequest[0]!.content as string).toContain('[Previous conversation summary]')
  }, 60_000)
})
