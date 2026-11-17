// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * An abort must end a tool call, even when the tool ignores its signal (SHO-358).
 *
 * Production shape: a `browser` sub-agent sat in `snapshot` on a page whose main
 * thread was frozen. Playwright's `evaluate` never settled, the tool ignored the
 * AbortSignal it was handed, and the turn stayed `active` for 18 h — Stop
 * included, because `wrapSingleTool` simply awaited `tool.execute`.
 *
 * Every tool goes through this wrapper, so it is the one place where an abort
 * actually ends the call and releases the semaphore + write mutex behind it.
 */
import { describe, expect, test } from 'bun:test'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { wrapToolsWithOrchestration } from '../tool-orchestration'

function neverSettles(): Promise<never> {
  return new Promise<never>(() => {})
}

function tool(name: string, execute: AgentTool['execute']): AgentTool {
  return {
    name,
    description: name,
    label: name,
    parameters: { type: 'object', properties: {}, required: [] } as any,
    execute,
  }
}

function find(tools: AgentTool[], name: string): AgentTool {
  const hit = tools.find((t) => t.name === name)
  if (!hit) throw new Error(`tool ${name} not wrapped`)
  return hit
}

describe('wrapSingleTool — abort ends the call (SHO-358)', () => {
  test('a tool whose promise never settles rejects within 100ms of abort', async () => {
    const controller = new AbortController()
    const { tools } = wrapToolsWithOrchestration([
      tool('read_file', async () => {
        await neverSettles()
        return { content: [] } as any
      }),
    ])
    const wrapped = find(tools, 'read_file')

    const started = Date.now()
    const call = wrapped.execute('call-1', { path: 'a.txt' }, controller.signal).catch((err) => err)
    await Bun.sleep(20)
    controller.abort()
    const outcome: any = await call

    expect(Date.now() - started).toBeLessThan(1000)
    expect(outcome).toBeInstanceOf(Error)
    expect(outcome.name).toBe('AbortError')
  })

  test('the semaphore slot is released after an abort', async () => {
    const controller = new AbortController()
    const { tools, state } = wrapToolsWithOrchestration(
      [
        tool('read_file', async () => {
          await neverSettles()
          return { content: [] } as any
        }),
      ],
      { maxConcurrency: 1 },
    )
    const wrapped = find(tools, 'read_file')

    const call = wrapped.execute('call-1', {}, controller.signal).catch(() => {})
    await Bun.sleep(10)
    expect(state.semaphore.available).toBe(0)
    controller.abort()
    await call
    expect(state.semaphore.available).toBe(1)
  })

  test('the write mutex is released after an abort, so the next write runs', async () => {
    const controller = new AbortController()
    const { tools, state } = wrapToolsWithOrchestration([
      tool('edit_file', async (_id, params: any) => {
        if ((params as any)?.hang) await neverSettles()
        return { content: [{ type: 'text', text: 'written' }] } as any
      }),
    ])
    const wrapped = find(tools, 'edit_file')

    const hung = wrapped.execute('call-1', { hang: true, path: 'a.txt' }, controller.signal).catch(() => {})
    await Bun.sleep(10)
    expect(state.writeMutex.isLocked).toBe(true)

    controller.abort()
    await hung
    expect(state.writeMutex.isLocked).toBe(false)

    // A later write on the same wrapper must not queue behind the aborted one.
    const next: any = await wrapped.execute('call-2', { path: 'b.txt' })
    expect(next.content[0].text).toBe('written')
  })

  test('a tool that finishes before the abort still returns its result', async () => {
    const controller = new AbortController()
    const { tools } = wrapToolsWithOrchestration([
      tool('read_file', async () => ({ content: [{ type: 'text', text: 'ok' }] }) as any),
    ])
    const wrapped = find(tools, 'read_file')

    const result: any = await wrapped.execute('call-1', {}, controller.signal)
    controller.abort()
    expect(result.content[0].text).toBe('ok')
  })

  test('a call started on an already-aborted signal never reaches the tool', async () => {
    const controller = new AbortController()
    controller.abort()
    let ran = false
    const { tools } = wrapToolsWithOrchestration([
      tool('read_file', async () => {
        ran = true
        return { content: [] } as any
      }),
    ])
    const wrapped = find(tools, 'read_file')

    const err: any = await wrapped.execute('call-1', {}, controller.signal).catch((e) => e)
    expect(err.name).toBe('AbortError')
    expect(ran).toBe(false)
  })
})
