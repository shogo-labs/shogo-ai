// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One runtime serves two surfaces. The workspace agent's capability toggles
 * live on `Workspace.settings`; a project's live on `Project.settings`. These
 * tests pin the per-turn resolution: a workspace turn reads the workspace's
 * toggles (with the workspace-agent defaults), a project turn reads its own,
 * and neither gates the other on the next turn.
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentGateway } from '../gateway'
import { filterDisabledCapabilityTools, type ToolContext } from '../gateway-tools'

const ENV_KEYS = [
  'PROJECT_ID',
  'WORKSPACE_ID',
  'WORKSPACE_RUNTIME',
  'WORKSPACE_KIND',
  'WORKSPACE_ANCHOR_PROJECT_ID',
  'RUNTIME_AUTH_SECRET',
] as const

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'capability-scope-'))
}

/** A runtime pinned to `anchor`, serving workspace chats and that project's chats. */
function pinnedRuntime(dir: string, anchor = 'proj-anchor'): AgentGateway {
  process.env.WORKSPACE_RUNTIME = 'true'
  process.env.WORKSPACE_KIND = 'team'
  process.env.WORKSPACE_ID = 'ws-1'
  process.env.WORKSPACE_ANCHOR_PROJECT_ID = anchor
  process.env.PROJECT_ID = anchor
  return new AgentGateway(dir, anchor)
}

const tools = (names: string[]) => names.map((name) => ({ name }) as never)

describe('configForTurn', () => {
  test('a workspace turn resolves the workspace agent defaults, a project turn does not', () => {
    const gw = pinnedRuntime(workspace())

    const project = gw.configForTurn('s1', 'project')
    expect(project.boardAdminEnabled).toBeUndefined()

    const workspaceCfg = gw.configForTurn('s1', 'workspace')
    expect(workspaceCfg.boardAdminEnabled).toBe(true)
    expect(workspaceCfg.companyOpsEnabled).toBe(true)
    expect(workspaceCfg.problemsEnabled).toBe(true)
    // Everything that is not a capability stays the runtime's.
    const runtimeConfig = (gw as unknown as { config: { model: { provider: string; name: string } } }).config
    expect(workspaceCfg.model).toEqual(runtimeConfig.model)
  })

  test('the session remembers its surface when the turn does not restate it', () => {
    const gw = pinnedRuntime(workspace())
    gw.rememberChatContext('ws-session', 'workspace')
    expect(gw.configForTurn('ws-session').boardAdminEnabled).toBe(true)
    gw.rememberChatContext('proj-session', 'project')
    expect(gw.configForTurn('proj-session').boardAdminEnabled).toBeUndefined()
  })
})

describe('an unlabelled turn on a pinned runtime', () => {
  test('defaults to the project surface, never the workspace one', () => {
    // The runtime serves both, so a turn that did not say (a channel message,
    // a heartbeat) must not inherit the workspace agent's toggles.
    const gw = pinnedRuntime(workspace())
    expect(gw.resolveChatContext('unlabelled')).toBe('project')
  })

  test('a runtime with no anchor is unambiguously the workspace agent', () => {
    process.env.WORKSPACE_RUNTIME = 'true'
    process.env.WORKSPACE_KIND = 'team'
    delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
    delete process.env.PROJECT_ID
    const gw = new AgentGateway(workspace(), 'ws:ws-1')
    expect(gw.resolveChatContext('unlabelled')).toBe('workspace')
  })
})

describe('syncCapabilitiesFromApi in a workspace runtime', () => {
  test('pulls Workspace.settings even with no project id (no anchor)', async () => {
    const dir = workspace()
    process.env.WORKSPACE_RUNTIME = 'true'
    process.env.WORKSPACE_KIND = 'team'
    process.env.WORKSPACE_ID = 'ws-1'
    delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
    delete process.env.PROJECT_ID
    const gw = new AgentGateway(dir, 'ws:ws-1')

    const applied = await gw.syncCapabilitiesFromApi(undefined, async (workspaceId) => {
      expect(workspaceId).toBe('ws-1')
      return { ok: true, data: { settings: { boardAdminEnabled: false, shellEnabled: false } } }
    })

    expect(applied).toBe(true)
    const file = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'))
    expect(file.workspaceCapabilities).toEqual({ boardAdminEnabled: false, shellEnabled: false })
    // Workspace toggles do not leak into the project cache (the flat keys).
    expect(file.shellEnabled).toBeUndefined()
    expect(gw.configForTurn('s', 'workspace').boardAdminEnabled).toBe(false)
  })

  test('keeps the workspace defaults when the workspace settings are empty', async () => {
    const dir = workspace()
    process.env.WORKSPACE_RUNTIME = 'true'
    process.env.WORKSPACE_KIND = 'team'
    process.env.WORKSPACE_ID = 'ws-1'
    delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
    delete process.env.PROJECT_ID
    const gw = new AgentGateway(dir, 'ws:ws-1')

    await gw.syncCapabilitiesFromApi(undefined, async () => ({ ok: true, data: { settings: {} } }))
    expect(gw.configForTurn('s', 'workspace').boardAdminEnabled).toBe(true)
  })

  test('a failed workspace read leaves the cached toggles alone', async () => {
    const dir = workspace()
    process.env.WORKSPACE_RUNTIME = 'true'
    process.env.WORKSPACE_KIND = 'team'
    process.env.WORKSPACE_ID = 'ws-1'
    delete process.env.PROJECT_ID
    delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
    const gw = new AgentGateway(dir, 'ws:ws-1')

    const applied = await gw.syncCapabilitiesFromApi(undefined, async () => ({ ok: false }))
    expect(applied).toBe(false)
  })
})

describe('next-turn tool gating per surface', () => {
  test('workspace toggles remove and restore board tools in the workspace turn only', async () => {
    const dir = workspace()
    const gw = pinnedRuntime(dir)
    const toolList = tools(['board_create', 'column_create', 'exec'])

    // The anchor project keeps board admin off; the workspace agent is opted in.
    ;(gw as unknown as { config: { boardAdminEnabled?: boolean } }).config.boardAdminEnabled = false
    const projectTurn = gw.configForTurn('p', 'project')
    const workspaceTurn = gw.configForTurn('w', 'workspace')

    expect(filterDisabledCapabilityTools(toolList, projectTurn).map((t) => t.name)).not.toContain('board_create')
    expect(filterDisabledCapabilityTools(toolList, workspaceTurn).map((t) => t.name)).toContain('board_create')

    // Turn it off for the workspace: the workspace turn loses the tools, the
    // project turn is unchanged.
    await gw.syncCapabilitiesFromApi(
      async () => ({ ok: true, data: { settings: { boardAdminEnabled: false } } }),
      async () => ({ ok: true, data: { settings: { boardAdminEnabled: false } } }),
    )
    const workspaceOff = gw.configForTurn('w', 'workspace')
    expect(filterDisabledCapabilityTools(toolList, workspaceOff).map((t) => t.name)).not.toContain('board_create')

    // And back on.
    await gw.syncCapabilitiesFromApi(
      async () => ({ ok: true, data: { settings: { boardAdminEnabled: false } } }),
      async () => ({ ok: true, data: { settings: { boardAdminEnabled: true } } }),
    )
    const workspaceOn = gw.configForTurn('w', 'workspace')
    expect(filterDisabledCapabilityTools(toolList, workspaceOn).map((t) => t.name)).toContain('board_create')
    // The anchor project's toggles were never touched.
    expect(gw.configForTurn('p', 'project').boardAdminEnabled).toBe(false)
  })

  test('the capabilities tool context carries both surfaces', () => {
    const gw = pinnedRuntime(workspace())
    const ctx = { capabilityScope: 'workspace' } as ToolContext
    expect(ctx.capabilityScope).toBe('workspace')
    expect(gw.configForTurn('s', 'project').boardAdminEnabled).toBeUndefined()
    expect(gw.configForTurn('s', 'workspace').boardAdminEnabled).toBe(true)
  })
})
