// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `find` on the orchestration proxy must delegate to the input list's own
 * `find`. The gateway passes a Proxy whose `find` also resolves dispatch-only
 * stubs (e.g. "exec is not available in Plan mode") that are hidden from
 * iteration; rebuilding the list via iteration loses them and the model sees
 * "Tool exec not found" instead.
 */
import { describe, test, expect } from 'bun:test'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { wrapToolsWithOrchestration } from '../tool-orchestration'

function makeTool(name: string, text = `result:${name}`): AgentTool {
  return {
    name,
    description: `Mock ${name}`,
    label: name,
    parameters: { type: 'object', properties: {} } as any,
    execute: async () => ({ content: [{ type: 'text' as const, text }], details: { name } }),
  }
}

/** Mimics the gateway's tools Proxy: stubs reachable via find only. */
function makeStubAwareList(visible: AgentTool[], stubs: AgentTool[]): AgentTool[] {
  return new Proxy(visible, {
    get(target, prop, receiver) {
      if (prop === 'find') {
        return (predicate: any, thisArg?: any) =>
          target.find(predicate, thisArg) ?? stubs.find(predicate, thisArg)
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

describe('wrapToolsWithOrchestration find delegation', () => {
  test('find resolves stubs hidden from iteration', async () => {
    const stub = makeTool('exec', 'exec is not available in Plan mode.')
    const list = makeStubAwareList([makeTool('read_file')], [stub])
    const { tools } = wrapToolsWithOrchestration(list)

    expect(tools.length).toBe(1)
    expect([...tools].map(t => t.name)).toEqual(['read_file'])

    const hit = tools.find(t => t.name === 'exec')
    expect(hit).toBeDefined()
    const result = await hit!.execute('call-1', {})
    expect((result.content[0] as any).text).toContain('not available in Plan mode')
  })

  test('find returns a wrapped (orchestrated) visible tool and undefined for unknown names', () => {
    const list = makeStubAwareList([makeTool('read_file')], [])
    const { tools } = wrapToolsWithOrchestration(list)
    const hit = tools.find(t => t.name === 'read_file')
    expect(hit).toBeDefined()
    expect(hit).toBe(tools[0])
    expect(tools.find(t => t.name === 'nope')).toBeUndefined()
  })

  test('find on a plain array still works', () => {
    const { tools } = wrapToolsWithOrchestration([makeTool('a'), makeTool('b')])
    expect(tools.find(t => t.name === 'b')?.name).toBe('b')
  })
})
