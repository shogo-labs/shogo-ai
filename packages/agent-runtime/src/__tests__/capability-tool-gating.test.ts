// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Verifies capability toggles gate the tools themselves — not just the
 * prompt. `filterDisabledCapabilityTools` is the shared chokepoint used by
 * both the main agent's tool list and the subagent parent-tool set
 * (`allToolsGetter`), so a disabled capability (image gen, heartbeat,
 * channels, integrations, …) is unreachable everywhere.
 */

import { describe, test, expect } from 'bun:test'
import { createTools, enabledSocialPlatforms, filterDisabledCapabilityTools, filterSubagentOnlyTools, type ToolContext } from '../gateway-tools'
import { disabledToolNamesForProfile } from '../capability-profiles'
import type { GatewayConfig } from '../gateway'

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    heartbeatToolsEnabled: true,
    channels: [],
    model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    ...overrides,
  }
}

function makeCtx(config: GatewayConfig): ToolContext {
  return {
    workspaceDir: '/tmp/test-capability-tool-gating',
    channels: new Map(),
    config,
    projectId: 'test',
  }
}

function personalNames(config: GatewayConfig): Set<string> {
  const ctx = { ...makeCtx(config), workspaceId: 'workspace-1' }
  return new Set(filterDisabledCapabilityTools(createTools(ctx), config).map(t => t.name))
}

function names(config: GatewayConfig): Set<string> {
  const ctx = makeCtx(config)
  const filtered = filterDisabledCapabilityTools(createTools(ctx), config)
  return new Set(filtered.map(t => t.name))
}

describe('filterDisabledCapabilityTools', () => {
  test('default config keeps capability tools available', () => {
    const n = names(makeConfig())
    expect(n.has('generate_image')).toBe(true)
    expect(n.has('heartbeat_configure')).toBe(true)
    expect(n.has('channel_connect')).toBe(true)
    expect(n.has('search_integrations')).toBe(true)
  })

  test('imageGenEnabled: false removes generate_image', () => {
    const n = names(makeConfig({ imageGenEnabled: false }))
    expect(n.has('generate_image')).toBe(false)
    // unrelated tools remain
    expect(n.has('read_file')).toBe(true)
  })

  test('heartbeatToolsEnabled: false removes heartbeat tools', () => {
    const n = names(makeConfig({ heartbeatToolsEnabled: false }))
    expect(n.has('heartbeat_configure')).toBe(false)
    expect(n.has('heartbeat_status')).toBe(false)
  })

  test('heartbeat tools stay visible when the flag is unset (default on)', () => {
    const n = names(makeConfig({ heartbeatToolsEnabled: undefined }))
    expect(n.has('heartbeat_configure')).toBe(true)
    expect(n.has('heartbeat_status')).toBe(true)
  })

  test('a disabled heartbeat SCHEDULE never hides the tools (schedule lives in the database)', () => {
    // Old configs carried `heartbeatEnabled: false` meaning "no heartbeat
    // running yet"; the loader maps that legacy key, the filter must not read it.
    const n = names(makeConfig({ heartbeatEnabled: false } as any))
    expect(n.has('heartbeat_configure')).toBe(true)
  })

  test('channelsEnabled: false removes channel + messaging tools', () => {
    const n = names(makeConfig({ channelsEnabled: false }))
    for (const t of ['channel_connect', 'channel_disconnect', 'channel_list', 'send_message']) {
      expect(n.has(t)).toBe(false)
    }
    // integrations untouched
    expect(n.has('search_integrations')).toBe(true)
  })

  test('integrationsEnabled: false removes integration tools', () => {
    const n = names(makeConfig({ integrationsEnabled: false }))
    for (const t of ['search_integrations', 'connect', 'disconnect']) {
      expect(n.has(t)).toBe(false)
    }
    // channels untouched
    expect(n.has('channel_connect')).toBe(true)
  })

  test('shell / web / memory / quick actions gate their tools', () => {
    const n = names(makeConfig({
      shellEnabled: false,
      webEnabled: false,
      memoryEnabled: false,
      quickActionsEnabled: false,
    }))
    expect(n.has('exec')).toBe(false)
    expect(n.has('exec_wait')).toBe(false)
    expect(n.has('web')).toBe(false)
    expect(n.has('memory_read')).toBe(false)
    expect(n.has('memory_search')).toBe(false)
    expect(n.has('quick_action')).toBe(false)
    // core file tools always survive
    expect(n.has('read_file')).toBe(true)
    expect(n.has('write_file')).toBe(true)
  })

  test('social_media is off unless the master switch is on', () => {
    expect(names(makeConfig()).has('social_media')).toBe(false)
    expect(names(makeConfig({ socialMediaEnabled: true })).has('social_media')).toBe(true)
  })

  test('social_media exists on the management opt-in alone, and lookups stay off', () => {
    const config = makeConfig({ socialManagementEnabled: true })
    expect(names(config).has('social_media')).toBe(true)
    // The management opt-in must not turn lookups on: no platform is enabled.
    expect(enabledSocialPlatforms(config)).toEqual([])
  })

  test('an inbox call is refused while social management is off', async () => {
    const tool = createTools(makeCtx(makeConfig({ socialMediaEnabled: true }))).find(
      (t) => t.name === 'social_media',
    )!
    const result = await tool.execute('call-1', { action: 'inbox', kind: 'dms' })
    expect(JSON.stringify(result)).toContain('Social management is off')
  })

  test('social_media is removed when every platform is off', () => {
    const n = names(makeConfig({
      socialMediaEnabled: true,
      socialInstagramEnabled: false,
      socialTiktokEnabled: false,
    }))
    expect(n.has('social_media')).toBe(false)
  })

  test('a disabled platform is left out of the tool schema', () => {
    const config = makeConfig({ socialMediaEnabled: true, socialTiktokEnabled: false })
    const tool = createTools(makeCtx(config)).find((t) => t.name === 'social_media')
    expect(tool).toBeTruthy()
    expect(enabledSocialPlatforms(config)).toEqual(['instagram'])
    const platform = (tool!.parameters as { properties?: { platform?: { const?: string; anyOf?: Array<{ const?: string }> } } }).properties?.platform
    const values = platform?.const
      ? [platform.const]
      : (platform?.anyOf ?? []).map((entry) => entry.const).filter((value): value is string => !!value)
    expect(values).toEqual(['instagram'])
    expect(tool!.description).toContain('instagram')
    expect(tool!.description).not.toContain('tiktok')
  })

  test('execute rejects a platform the config has turned off', async () => {
    const config = makeConfig({ socialMediaEnabled: true, socialInstagramEnabled: false })
    const tool = createTools(makeCtx(config)).find((t) => t.name === 'social_media')!
    const result = await tool.execute('call-1', {
      platform: 'instagram',
      action: 'profile',
      handle: 'nike',
    })
    expect(result.details.error).toContain('instagram')
    expect(result.details.error).toContain('not enabled')
  })

  test('capabilities_configure stays available when every capability is off', () => {
    const n = names(makeConfig({
      canvasEnabled: false,
      webEnabled: false,
      browserEnabled: false,
      shellEnabled: false,
      heartbeatToolsEnabled: false,
      imageGenEnabled: false,
      memoryEnabled: false,
      quickActionsEnabled: false,
      sdkGuideEnabled: false,
      integrationsEnabled: false,
      channelsEnabled: false,
      gitWorktreesEnabled: false,
      socialMediaEnabled: false,
      socialInstagramEnabled: false,
      socialTiktokEnabled: false,
    }))
    expect(n.has('capabilities_configure')).toBe(true)
    expect(n.has('exec')).toBe(false)
    expect(n.has('web')).toBe(false)
    expect(n.has('generate_image')).toBe(false)
  })

  test('returns the same array reference when nothing is disabled (no-op fast path)', () => {
    // EVERY opt-in has to be on or its tools are gated and the fast path is
    // skipped: worktrees, social, video, 3D, board admin, company ops, problems.
    // (The last three were already missing here, so this test failed on main.)
    const config = makeConfig({
      gitWorktreesEnabled: true,
      socialMediaEnabled: true,
      videoGenEnabled: true,
      threeDGenEnabled: true,
      boardAdminEnabled: true,
      companyOpsEnabled: true,
      problemsEnabled: true,
    })
    const tools = createTools(makeCtx(config))
    expect(filterDisabledCapabilityTools(tools, config)).toBe(tools)
  })

  test('orchestration / core tools are never gated', () => {
    const n = names(makeConfig({
      imageGenEnabled: false,
      heartbeatToolsEnabled: false,
      channelsEnabled: false,
      integrationsEnabled: false,
    }))
    for (const t of ['read_file', 'write_file', 'edit_file', 'agent_spawn', 'skill', 'todo_write']) {
      expect(n.has(t)).toBe(true)
    }
  })

  test('personal profile removes builder/shell/team tools and every project tool, but keeps goals', () => {
    const n = personalNames(makeConfig({ capabilityProfile: 'personal', gitWorktreesEnabled: true }))
    for (const tool of [
      'exec',
      'terminal_exec',
      'checkpoint',
      'publish',
      'create_plan',
      'project_attach',
      'project_detach',
      'system_apply',
      'agent_spawn',
      'team_create',
      'team_task_create',
      'list_projects',
      // SHO-221: a personal companion doesn't build software, so it has no
      // way to start a hidden builder project either.
      'project_list',
      'project_create',
      'project_configure',
      'project_call',
      'connect_project',
      'copy_to_project',
    ]) {
      expect(n.has(tool)).toBe(false)
    }
    for (const tool of [
      'read_file',
      'write_file',
      'edit_file',
      'capabilities_configure',
      'agent_profile_get',
      'agent_profile_set',
      'goal_create',
      'goal_update',
      'goal_log',
      'goal_list',
      'set_status',
    ]) {
      expect(n.has(tool)).toBe(true)
    }
  })

  test('team profile keeps all six project tools', () => {
    const n = names(makeConfig({ capabilityProfile: 'team' }))
    // `copy_to_project` only registers on a metal workspace runtime, so it is
    // asserted through the profile's disabled set, not the registered tools.
    for (const tool of ['project_list', 'project_create', 'project_configure', 'project_call', 'connect_project']) {
      expect(n.has(tool)).toBe(true)
    }
    expect(disabledToolNamesForProfile('team').has('copy_to_project')).toBe(false)
  })
})

describe('work capabilities', () => {
  function teamNames(config: GatewayConfig): Set<string> {
    const ctx = { ...makeCtx(config), workspaceId: 'workspace-1' }
    return new Set(filterDisabledCapabilityTools(createTools(ctx), config).map(t => t.name))
  }

  test('defaults: team chat, card work and triggers on; board structure and problems off', () => {
    const n = teamNames(makeConfig())
    for (const t of ['team_chat_post', 'board_list', 'work_item_create', 'work_item_get', 'trigger_create']) expect(n.has(t)).toBe(true)
    for (const t of ['board_create', 'column_delete', 'problem_report']) expect(n.has(t)).toBe(false)
  })

  test('opt-ins turn on board structure and problem tools', () => {
    const n = teamNames(makeConfig({ boardAdminEnabled: true, problemsEnabled: true }))
    for (const t of ['board_create', 'board_archive', 'column_create', 'problem_report', 'problem_occurrences']) expect(n.has(t)).toBe(true)
  })

  test('boardsEnabled: false removes every board tool, even with the opt-ins on', () => {
    const n = teamNames(makeConfig({ boardsEnabled: false, boardAdminEnabled: true, problemsEnabled: true }))
    expect([...n].some(t => t.startsWith('board_') || t.startsWith('work_item_') || t.startsWith('column_') || t.startsWith('problem_'))).toBe(false)
    expect(n.has('team_chat_post')).toBe(true)
  })

  test('teamChatEnabled: false removes team chat tools but not boards', () => {
    const n = teamNames(makeConfig({ teamChatEnabled: false }))
    expect([...n].some(t => t.startsWith('team_chat_'))).toBe(false)
    expect(n.has('team_directory')).toBe(false)
    expect(n.has('work_item_create')).toBe(true)
  })

  test('workTriggersEnabled: false keeps reading triggers but not changing them', () => {
    const n = teamNames(makeConfig({ workTriggersEnabled: false }))
    expect(n.has('trigger_list')).toBe(true)
    expect(n.has('trigger_types_list')).toBe(true)
    for (const t of ['trigger_create', 'trigger_update', 'trigger_delete', 'trigger_test']) expect(n.has(t)).toBe(false)
  })

  test('the workspace agent (workspace runtime with no anchor) gets the opt-ins by default', () => {
    const prev = { mode: process.env.WORKSPACE_RUNTIME, anchor: process.env.WORKSPACE_ANCHOR_PROJECT_ID }
    process.env.WORKSPACE_RUNTIME = 'true'
    delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
    try {
      const n = teamNames(makeConfig())
      expect(n.has('board_create')).toBe(true)
      expect(n.has('problem_report')).toBe(true)
      const off = teamNames(makeConfig({ boardAdminEnabled: false }))
      expect(off.has('board_create')).toBe(false)
    } finally {
      if (prev.mode === undefined) delete process.env.WORKSPACE_RUNTIME
      else process.env.WORKSPACE_RUNTIME = prev.mode
      if (prev.anchor !== undefined) process.env.WORKSPACE_ANCHOR_PROJECT_ID = prev.anchor
    }
  })
})

describe('filterSubagentOnlyTools', () => {
  // Media tools are called directly by the project's own agent (SHO-49).
  // `browser` stays delegated to its subagent; `server_sync` is a main-agent
  // tool on every profile (SHO-184). The image
  // tools' gate is the capability flag, applied by
  // filterDisabledCapabilityTools — not the subagent-only set.
  function mainAgentTools(config: GatewayConfig): Set<string> {
    const ctx = makeCtx(config)
    const tools = filterDisabledCapabilityTools(createTools(ctx), config)
    return new Set(filterSubagentOnlyTools(tools, config).map(t => t.name))
  }

  test('team profile keeps the media tools and server_sync on the main agent and still strips browser', () => {
    const n = mainAgentTools(makeConfig())
    expect(n.has('generate_image')).toBe(true)
    expect(n.has('list_media_models')).toBe(true)
    expect(n.has('transcribe_audio')).toBe(true)
    expect(n.has('browser')).toBe(false)
    expect(n.has('server_sync')).toBe(true)
  })

  test('server_sync is a direct main-agent tool on project and workspace-agent runtimes; heartbeat tools on every profile', () => {
    const prevRuntime = process.env.WORKSPACE_RUNTIME
    const prevAnchor = process.env.WORKSPACE_ANCHOR_PROJECT_ID
    try {
      const team = mainAgentTools(makeConfig())
      expect(team.has('server_sync')).toBe(true)
      expect(team.has('heartbeat_configure')).toBe(true)
      expect(team.has('heartbeat_status')).toBe(true)
      // Personal workspaces build in a hidden builder project, not their own
      // runtime, so the profile's `code_review` group (not the subagent
      // filter) keeps server_sync off there. Heartbeat stays direct.
      const personal = mainAgentTools(makeConfig({ capabilityProfile: 'personal' }))
      expect(personal.has('server_sync')).toBe(false)
      expect(personal.has('heartbeat_configure')).toBe(true)
      expect(personal.has('heartbeat_status')).toBe(true)
      process.env.WORKSPACE_RUNTIME = '1'
      process.env.WORKSPACE_ANCHOR_PROJECT_ID = 'p1'
      const ws = mainAgentTools(makeConfig())
      expect(ws.has('server_sync')).toBe(true)
      expect(ws.has('heartbeat_configure')).toBe(true)
    } finally {
      if (prevRuntime === undefined) delete process.env.WORKSPACE_RUNTIME
      else process.env.WORKSPACE_RUNTIME = prevRuntime
      if (prevAnchor === undefined) delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
      else process.env.WORKSPACE_ANCHOR_PROJECT_ID = prevAnchor
    }
  })

  test('main agent repairs a dead project server itself: server_sync from its own tool list returns the route table', async () => {
    const config = makeConfig()
    const ctx = makeCtx(config)
    ctx.skillServerManager = {
      sync: async () => ({ ok: true, phase: 'healthy' }),
      getActiveRoutes: () => ['leads', 'notes'],
      getSchemaModels: () => ['Lead', 'Note'],
      url: 'http://localhost:0',
      phase: 'healthy',
    } as any
    const tools = filterSubagentOnlyTools(filterDisabledCapabilityTools(createTools(ctx), config), config)
    const sync = tools.find(t => t.name === 'server_sync')!
    const r: any = (await sync.execute('c1', {} as any)).details
    expect(r.ok).toBe(true)
    expect(r.activeRoutes).toEqual(['/api/leads', '/api/notes'])
    expect(r.schemaModels).toEqual(['Lead', 'Note'])
  })

  test('imageGenEnabled: false still removes the image tools from the main agent', () => {
    const n = mainAgentTools(makeConfig({ imageGenEnabled: false }))
    expect(n.has('generate_image')).toBe(false)
    // Nothing to list once image, video and 3D are all off.
    expect(n.has('list_media_models')).toBe(false)
  })

  test('generate_video appears only with videoGenEnabled: true', () => {
    expect(mainAgentTools(makeConfig()).has('generate_video')).toBe(false)
    expect(mainAgentTools(makeConfig({ videoGenEnabled: true })).has('generate_video')).toBe(true)
  })

  test('the 3D tools appear only with threeDGenEnabled: true', () => {
    const off = mainAgentTools(makeConfig())
    expect(off.has('generate_3d_model')).toBe(false)
    expect(off.has('edit_3d_model')).toBe(false)
    const on = mainAgentTools(makeConfig({ threeDGenEnabled: true }))
    expect(on.has('generate_3d_model')).toBe(true)
    expect(on.has('edit_3d_model')).toBe(true)
  })

  test('personal profile is unchanged: media tools direct, browser delegated-only', () => {
    const config = makeConfig({ capabilityProfile: 'personal' })
    const n = mainAgentTools(config)
    expect(n.has('generate_image')).toBe(true)
    expect(n.has('transcribe_audio')).toBe(true)
    expect(n.has('list_media_models')).toBe(true)
    expect(n.has('browser')).toBe(false)
    // Off by the personal profile's code_review group, not by the subagent filter.
    expect(n.has('server_sync')).toBe(false)
  })
})
