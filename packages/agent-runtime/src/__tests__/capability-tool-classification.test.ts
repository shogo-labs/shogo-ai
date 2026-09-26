// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Guards the "allow-list, not deny-list" property of the personal capability
 * profile: every tool `createTools()` can register must be classified in
 * `PROFILE_TOOL_GROUPS` or `CORE_TOOL_NAMES` (`capability-profiles.ts`).
 *
 * Before `capability-profiles.ts` existed, personal-workspace gating was a
 * hand-maintained deny-list (`PERSONAL_DISABLED_TOOL_NAMES`) — a new tool
 * added to `gateway-tools.ts` was silently ENABLED for personal workspaces
 * unless someone remembered to add it to the deny-list by name. This test
 * turns that into a CI failure instead: an unclassified tool fails here,
 * forcing an explicit decision about which profiles it belongs to.
 */

import { describe, expect, test } from 'bun:test'
import { createTools, type ToolContext } from '../gateway-tools'
import { CORE_TOOL_NAMES, PROFILE_TOOL_GROUPS, disabledToolNamesForProfile } from '../capability-profiles'

function fullFlagCtx(): ToolContext {
  return {
    workspaceDir: '/tmp/capability-tool-classification',
    channels: new Map(),
    workspaceId: 'workspace-1',
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: true,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      gitWorktreesEnabled: true,
    } as any,
    projectId: 'test',
  }
}

describe('capability tool classification', () => {
  test('every tool createTools() can register is classified (allow-list, not deny-list)', () => {
    const prevWorkspaceRuntime = process.env.WORKSPACE_RUNTIME
    const prevSearchEnabled = process.env.SHOGO_SEARCH_ENABLED
    process.env.WORKSPACE_RUNTIME = 'true'
    process.env.SHOGO_SEARCH_ENABLED = '1'
    try {
      const tools = createTools(fullFlagCtx())
      const classified = new Set<string>(CORE_TOOL_NAMES)
      for (const names of Object.values(PROFILE_TOOL_GROUPS)) {
        for (const n of names) classified.add(n)
      }

      const unclassified = tools.map((t) => t.name).filter((n) => !classified.has(n))
      expect(
        unclassified,
        `These tools are not classified in CORE_TOOL_NAMES or PROFILE_TOOL_GROUPS ` +
          `(capability-profiles.ts) — add them to a group or CORE_TOOL_NAMES so the ` +
          `personal profile makes an explicit decision about them: ${unclassified.join(', ')}`,
      ).toEqual([])
    } finally {
      if (prevWorkspaceRuntime === undefined) delete process.env.WORKSPACE_RUNTIME
      else process.env.WORKSPACE_RUNTIME = prevWorkspaceRuntime
      if (prevSearchEnabled === undefined) delete process.env.SHOGO_SEARCH_ENABLED
      else process.env.SHOGO_SEARCH_ENABLED = prevSearchEnabled
    }
  })

  test('personal profile keeps project delegation + workspace-agent tools enabled', () => {
    const disabled = disabledToolNamesForProfile('personal')
    for (const kept of [
      'project_list', 'project_create', 'project_call', 'project_configure',
      'agent_profile_get', 'agent_profile_set', 'goal_create', 'goal_update', 'goal_log', 'goal_list', 'set_status',
      'ask_user', 'read_file', 'write_file', 'edit_file', 'web', 'memory_read',
      // `send_message` shares the `messaging` group with the channel tools and
      // must survive the personal boundary — only the byo channel lifecycle is
      // removed (issue #1045).
      'send_message',
    ]) {
      expect(disabled.has(kept)).toBe(false)
    }
  })

  test('personal profile disables builder, shell, orchestration, and project composition', () => {
    const disabled = disabledToolNamesForProfile('personal')
    for (const removed of [
      'exec', 'exec_list', 'terminal_exec', 'checkpoint', 'publish', 'create_plan', 'system_apply',
      'project_attach', 'project_detach', 'list_projects', 'mount_project',
      'agent_spawn', 'team_create', 'task_create',
      'impact_radius', 'detect_changes', 'review_context', 'read_lints', 'server_sync',
      // Personal workspaces reach channels via Shogo-managed connections, so
      // the byo channel lifecycle tools are removed by name (issue #1045)
      // while `send_message` (same group) stays enabled.
      'channel_connect', 'channel_disconnect', 'channel_list',
    ]) {
      expect(disabled.has(removed)).toBe(true)
    }
  })

  test('team profile disables nothing', () => {
    expect(disabledToolNamesForProfile('team').size).toBe(0)
  })
})
