// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
// The tool guard lets the runtime refuse every tool of a given MCP server
// (used to enforce the "computer use" setting) without restarting servers.
import { describe, expect, mock, test } from 'bun:test'
import { MCPClientManager } from '../mcp-client'

function fakeTool(name: string) {
  return {
    name,
    label: name,
    description: name,
    parameters: {},
    execute: mock(async () => ({ content: [{ type: 'text', text: `ran ${name}` }], details: {} })),
  } as any
}

function managerWith(servers: Record<string, any[]>, remote: Record<string, any[]> = {}) {
  const m = new MCPClientManager() as any
  for (const [name, tools] of Object.entries(servers)) m.servers.set(name, { name, tools })
  for (const [name, tools] of Object.entries(remote)) m.remoteServers.set(name, { name, tools })
  return m as MCPClientManager
}

describe('MCPClientManager tool guard', () => {
  test('without a guard tools are returned untouched', () => {
    const tool = fakeTool('screenshot')
    const m = managerWith({ 'computer-use': [tool] })
    expect(m.getTools()[0]).toBe(tool)
  })

  test('a denial blocks execution and explains why', async () => {
    const tool = fakeTool('screenshot')
    const m = managerWith({ 'computer-use': [tool] })
    m.setToolGuard((server) =>
      server === 'computer-use' ? { reason: 'Computer use is turned off', guidance: 'Enable it in Settings' } : null,
    )

    const [guarded] = m.getTools()
    const res: any = await guarded.execute('id', {})
    expect(tool.execute).not.toHaveBeenCalled()
    expect(res.details.error).toBe('Permission denied: Computer use is turned off')
    expect(res.details.instruction).toBe('Enable it in Settings')
    expect(JSON.parse(res.content[0].text).error).toContain('Computer use is turned off')
  })

  test('other servers are unaffected, and remote servers are guarded too', async () => {
    const other = fakeTool('search')
    const remoteTool = fakeTool('click')
    const m = managerWith({ web: [other] }, { 'computer-use': [remoteTool] })
    m.setToolGuard((server) => (server === 'computer-use' ? { reason: 'off' } : null))

    const tools = m.getTools()
    const search = tools.find((t) => t.name === 'search')!
    const click = tools.find((t) => t.name === 'click')!
    await search.execute('id', {})
    expect(other.execute).toHaveBeenCalledTimes(1)
    const res: any = await click.execute('id', {})
    expect(remoteTool.execute).not.toHaveBeenCalled()
    expect(res.details.error).toContain('off')
  })

  test('the guard is evaluated per call, so toggling takes effect without refetching tools', async () => {
    const tool = fakeTool('screenshot')
    const m = managerWith({ 'computer-use': [tool] })
    let blocked = true
    m.setToolGuard(() => (blocked ? { reason: 'off' } : null))
    const [guarded] = m.getTools()

    await guarded.execute('id', {})
    expect(tool.execute).not.toHaveBeenCalled()
    blocked = false
    await guarded.execute('id', {})
    expect(tool.execute).toHaveBeenCalledTimes(1)
  })

  test('wrapped tools are cached so repeated getTools returns stable instances', () => {
    const m = managerWith({ 'computer-use': [fakeTool('screenshot')] })
    m.setToolGuard(() => null)
    expect(m.getTools()[0]).toBe(m.getTools()[0])
  })

  test('clearing the guard returns the original tools', () => {
    const tool = fakeTool('screenshot')
    const m = managerWith({ 'computer-use': [tool] })
    m.setToolGuard(() => ({ reason: 'off' }))
    m.setToolGuard(null)
    expect(m.getTools()[0]).toBe(tool)
  })
})
