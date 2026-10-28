// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The production descriptions and parameter schemas of the board and team
 * chat tools, so a simulated run shows the agent exactly the tools it gets
 * in a team workspace (eval workers have no workspace, so the real tools are
 * not registered there).
 */
import { createHeartbeatConfigureTool, createHeartbeatStatusTool, type ToolContext } from '../../gateway-tools'
import { createBoardTools } from '../../board-tools'
import { createChannelTools } from '../../channel-tools'
import { createProjectCallTool, createProjectCreateTool } from '../../project-tools'
import { createScheduleCreateTool, createScheduleDeleteTool, createScheduleListTool, createScheduleUpdateTool } from '../../workspace-agent-tools'
import { ADMIN_SIM_TOOLS, BOARD_SIM_TOOLS, CHAT_SIM_TOOLS, TIMER_SIM_TOOLS } from './world'

export const TEMPLATE_SIM_TOOLS = ['work_template_list', 'work_template_add'] as const

export function simToolSchemas(): Record<string, { description: string; parameters: unknown }> {
  const ctx = { workspaceDir: '/tmp/company-sim', channels: new Map(), workspaceId: 'ws-sim', config: { channels: [] } } as unknown as ToolContext
  const wanted = new Set<string>([...BOARD_SIM_TOOLS, ...ADMIN_SIM_TOOLS, ...TEMPLATE_SIM_TOOLS, ...CHAT_SIM_TOOLS, ...TIMER_SIM_TOOLS, 'project_create', 'project_call'])
  const out: Record<string, { description: string; parameters: unknown }> = {}
  const timers = [createScheduleCreateTool, createScheduleUpdateTool, createScheduleListTool, createScheduleDeleteTool, createHeartbeatConfigureTool, createHeartbeatStatusTool].map((make) => make(ctx))
  for (const t of [...createBoardTools(ctx), ...createChannelTools(ctx), createProjectCreateTool(ctx), createProjectCallTool(ctx), ...timers]) {
    if (wanted.has(t.name)) out[t.name] = { description: t.description, parameters: t.parameters }
  }
  return out
}
