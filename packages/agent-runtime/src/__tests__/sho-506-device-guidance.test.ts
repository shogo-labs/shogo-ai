// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-506: a host wake that ends in `device_offline` / `device_connecting` is
 * only useful if the model knows what those codes mean. The guidance the model
 * reads — the "Your devices" prompt block and the `device` / `workspace`
 * parameter descriptions — is asserted here so a behaviour change can't land
 * while the wording still says "retry".
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { createTools, type ToolContext } from '../gateway-tools'
import { renderDevicesContext, type PairedDeviceSummary } from '../gateway'
import { withCrossWorkspaceParam } from '../cross-workspace'

const ENV_KEYS = ['WORKSPACE_RUNTIME', 'WORKSPACE_ANCHOR_PROJECT_ID', 'PROJECT_ID', 'WORKSPACE_ID', 'SHOGO_API_URL']
let saved: Record<string, string | undefined> = {}

const DEVICES: PairedDeviceSummary[] = [
  { id: 'inst-mac', name: "Russell's MacBook", os: 'darwin', online: true, lastSeenAt: '2026-11-04T00:00:00.000Z' },
  { id: 'inst-win', name: 'Samsara', os: 'win32', online: false, lastSeenAt: '2026-11-03T20:00:00.000Z' },
]

function toolCtx(): ToolContext {
  return { workspaceDir: '/tmp/sho-506-guidance', channels: new Map(), config: {} as any, projectId: 'proj', workspaceId: 'ws' }
}

function toolNamed(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`tool ${name} not registered`)
  return tool
}

function paramDescription(tool: AgentTool, key: string): string {
  const properties = (tool.parameters as { properties?: Record<string, { description?: string }> }).properties
  return properties?.[key]?.description ?? ''
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.PROJECT_ID = 'proj'
  process.env.WORKSPACE_ID = 'ws'
  process.env.SHOGO_API_URL = 'http://api.test'
  delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('"Your devices" prompt block', () => {
  test('states both wake codes, and that an offline device is not retried', () => {
    const block = renderDevicesContext(DEVICES)
    expect(block).toContain('## Your devices')
    expect(block).toContain('**Samsara** (offline, last seen 2026-11-03T20:00:00.000Z)')
    expect(block).toContain('**Russell\'s MacBook** (online)')
    expect(block).toContain('`device_offline`')
    expect(block).toContain('do not retry it')
    expect(block).toContain('`device_connecting`')
    expect(block).toContain('`retryAfterSeconds`')
  })

  test('renders a device with no known last-seen time without inventing one', () => {
    const block = renderDevicesContext([{ id: 'i', name: 'Ghost', os: null, online: false, lastSeenAt: null }])
    expect(block).toContain('- **Ghost** (offline)')
    expect(block).not.toContain('last seen')
  })
})

describe('device parameter guidance', () => {
  test('a remote-capable tool tells the model to stop on offline and wait on connecting', () => {
    const read = toolNamed(createTools(toolCtx()), 'read_file')
    const description = paramDescription(read, 'device')
    expect(description).toContain('`device_offline`')
    expect(description).toContain('last-seen')
    expect(description).toContain('do not retry')
    expect(description).toContain('`device_connecting`')
    expect(description).toContain('`retryAfterSeconds`')
  })
})

describe('cross-workspace workspace parameter guidance', () => {
  test('mentions both wake codes when cross-workspace is available', () => {
    process.env.WORKSPACE_RUNTIME = 'true'
    const list = toolNamed(createTools(toolCtx()), 'work_item_list')
    const decorated = withCrossWorkspaceParam(list, { ...toolCtx(), config: { capabilityProfile: 'personal' } as any })
    const description = paramDescription(decorated, 'workspace')
    expect(description).toContain('`device_connecting`')
    expect(description).toContain('`retryAfterSeconds`')
    expect(description).toContain('`device_offline`')
    expect(description).toContain('do not retry')
  })

  test('adds nothing when cross-workspace is off', () => {
    delete process.env.WORKSPACE_RUNTIME
    const list = toolNamed(createTools(toolCtx()), 'work_item_list')
    const decorated = withCrossWorkspaceParam(list, { ...toolCtx(), config: { capabilityProfile: 'personal' } as any })
    expect(paramDescription(decorated, 'workspace')).toBe('')
  })
})
