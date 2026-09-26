// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { PipelineCallRegistry } from '../pipeline-call-registry'

describe('PipelineCallRegistry', () => {
  it('returns running before a detached call completes, then its reply', async () => {
    const registry = new PipelineCallRegistry()
    let resolve!: (value: { reply: string; sessionId: string }) => void
    const deferred = new Promise<{ reply: string; sessionId: string }>(r => { resolve = r })
    const started = registry.start(() => deferred, { runId: 'run-1', sessionId: 'run:run-1' })

    expect(started.status).toBe('running')
    const running = await registry.get(started.callId)
    expect(running?.status).toBe('running')

    resolve({ reply: 'done', sessionId: 'run:run-1' })
    const completed = await registry.get(started.callId, 100)
    expect(completed?.status).toBe('completed')
    expect(completed?.reply).toBe('done')
  })

  it('records failures without rejecting the polling request', async () => {
    const registry = new PipelineCallRegistry()
    const started = registry.start(async () => { throw new Error('target failed') }, { sessionId: 'pipeline' })
    const result = await registry.get(started.callId, 100)
    expect(result?.status).toBe('failed')
    expect(result?.error).toBe('target failed')
  })
})
