// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The production descriptions and parameter schemas of the board and team
 * chat tools, so a simulated run shows the agent exactly the tools it gets
 * in a team workspace (eval workers have no workspace, so the real tools are
 * not registered there).
 */
import type { ToolContext } from '../../gateway-tools'
import { createBoardTools } from '../../board-tools'
import { createChannelTools } from '../../channel-tools'
import { ADMIN_SIM_TOOLS, BOARD_SIM_TOOLS, CHAT_SIM_TOOLS } from './world'

export const TEMPLATE_SIM_TOOLS = ['work_template_list', 'work_template_add'] as const

export function simToolSchemas(): Record<string, { description: string; parameters: unknown }> {
  const ctx = { workspaceDir: '/tmp/company-sim', channels: new Map(), workspaceId: 'ws-sim', config: { channels: [] } } as unknown as ToolContext
  const wanted = new Set<string>([...BOARD_SIM_TOOLS, ...ADMIN_SIM_TOOLS, ...TEMPLATE_SIM_TOOLS, ...CHAT_SIM_TOOLS])
  const out: Record<string, { description: string; parameters: unknown }> = {}
  for (const t of [...createBoardTools(ctx), ...createChannelTools(ctx)]) {
    if (wanted.has(t.name)) out[t.name] = { description: t.description, parameters: t.parameters }
  }
  return out
}
