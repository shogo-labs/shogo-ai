// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-556 acceptance, app side: the summarizer run is *visible* while it happens.
 *
 * Locks:
 *   - a live `data-context-summarizing` part renders "Summarizing earlier
 *     conversation…" (with "· N parts" when the head was cut up), and
 *   - it becomes the normal "Context summarized · 412k → 38k" divider when
 *     `data-context-summarized` arrives — one row, not two,
 *   - it is not shown when the turn is over, and never after a reload (the API
 *     does not persist the frame, so a persisted message cannot carry it).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import * as React from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { extractOrderedParts } from '../messageParts'
import { ContextCompactingRow, ContextCompactionDivider } from '../ContextCompactionDivider'

mock.module('lucide-react-native', () => ({
  Scissors: (props: Record<string, unknown>) => React.createElement('span', { 'data-icon': 'scissors', ...props }),
}))

function asMessage(parts: unknown[]): UIMessage {
  return { id: 'm1', role: 'assistant', parts } as unknown as UIMessage
}

const SUMMARIZING_PART = {
  type: 'data-context-summarizing',
  id: 'ctx-live',
  data: { trigger: 'mid-turn', tokensBefore: 348_000, chunks: 4 },
}

const SUMMARIZED_PART = {
  type: 'data-context-summarized',
  id: 'ctx-done',
  data: { trigger: 'auto', tokensBefore: 348_000, tokensAfter: 38_000, messagesBefore: 121, messagesAfter: 6 },
}

afterEach(cleanup)

describe('SHO-556 app: the compaction is visible while it runs', () => {
  test('a live summarizing part becomes a pending row, with its part count', () => {
    const parts = extractOrderedParts(
      asMessage([{ type: 'text', text: 'before', state: 'done' }, SUMMARIZING_PART]),
      undefined,
      { streaming: true },
    )
    expect(parts.map((p) => p.type)).toEqual(['text', 'compaction-pending'])
    expect(parts[1]).toMatchObject({ type: 'compaction-pending', chunks: 4 })
  })

  test('the row says what is happening, and how many calls are coming', () => {
    render(<ContextCompactingRow chunks={4} />)
    expect(screen.getByText(/Summarizing earlier conversation…/)).toBeTruthy()
    expect(screen.getByText(/· 4 parts/)).toBeTruthy()
  })

  test('one part is not announced as "4 parts"', () => {
    render(<ContextCompactingRow chunks={1} />)
    expect(screen.queryByText(/parts/)).toBeNull()
  })

  test('the resolved compaction replaces the pending row instead of stacking under it', () => {
    const parts = extractOrderedParts(
      asMessage([SUMMARIZING_PART, SUMMARIZED_PART]),
      undefined,
      { streaming: true },
    )
    expect(parts.map((p) => p.type)).toEqual(['compaction'])
    expect(parts[0]).toMatchObject({ tokensBefore: 348_000, tokensAfter: 38_000 })
  })

  test('it is not rendered once the turn is no longer streaming', () => {
    // A turn that errored or ended without a resolving frame must leave nothing
    // spinning: the row exists only while the stream is live.
    const parts = extractOrderedParts(asMessage([SUMMARIZING_PART]), undefined, { streaming: false })
    expect(parts).toEqual([])
  })

  test('a reloaded transcript (persisted parts only) has no pending row', () => {
    // The API persists `data-context-summarized` and never
    // `data-context-summarizing`, so what a reload hands the app is this.
    const parts = extractOrderedParts(asMessage([SUMMARIZED_PART]))
    expect(parts.map((p) => p.type)).toEqual(['compaction'])
  })

  test('the divider still states the numbers the runtime reported', () => {
    render(<ContextCompactionDivider part={SUMMARIZED_PART.data as never} />)
    expect(screen.getByText(/Context summarized/)).toBeTruthy()
    expect(screen.getByText(/348k/)).toBeTruthy()
    expect(screen.getByText(/38k/)).toBeTruthy()
  })
})
