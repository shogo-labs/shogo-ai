// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { readAgentStream } from '../services/conversation-agent-dispatcher'

function chunkedResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
}

const frame = (f: unknown) => `data: ${JSON.stringify(f)}\n\n`

describe('readAgentStream', () => {
  test('joins text segments, reports tool progress, and survives split frames', async () => {
    const wire = [
      frame({ type: 'text-start', id: 'a' }),
      frame({ type: 'text-delta', id: 'a', delta: 'Checking ' }),
      frame({ type: 'text-delta', id: 'a', delta: 'invoices.' }),
      frame({ type: 'tool-input-start', toolName: 'query_db' }),
      frame({ type: 'tool-output-available', toolCallId: 'x' }),
      frame({ type: 'text-start', id: 'b' }),
      frame({ type: 'text-delta', id: 'b', delta: 'Found 3 overdue.' }),
      frame({ type: 'finish' }),
    ].join('')
    const pieces = [wire.slice(0, 17), wire.slice(17, 90), wire.slice(90)]
    const progress: Array<{ text: string; tool: string | null }> = []
    const summary = await readAgentStream(chunkedResponse(pieces), (s) => progress.push({ ...s }))
    expect(summary).toMatchObject({ text: 'Checking invoices.\n\nFound 3 overdue.', finalText: 'Found 3 overdue.', toolCount: 1, failed: false, error: undefined })
    expect(progress.some((p) => p.tool === 'query_db')).toBe(true)
    expect(progress.at(-1)?.tool).toBeNull()
  })

  test('error frames and failed turns mark the run as failed', async () => {
    const errored = await readAgentStream(chunkedResponse([frame({ type: 'error', errorText: 'quota exceeded' })]), () => {})
    expect(errored).toMatchObject({ failed: true, error: 'quota exceeded' })
    const failedTurn = await readAgentStream(
      chunkedResponse([frame({ type: 'data-turn-complete', data: { status: 'failed' } })]),
      () => {},
    )
    expect(failedTurn.failed).toBe(true)
  })

  test('non-2xx responses surface the server error', async () => {
    const res = new Response(JSON.stringify({ error: { message: 'Project not found' } }), { status: 404 })
    expect(await readAgentStream(res, () => {})).toMatchObject({ failed: true, error: 'Project not found' })
  })
})
