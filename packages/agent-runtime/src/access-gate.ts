// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace RBAC at the tool layer (SHO-417).
 *
 * The server is the real gate: every internal route behind a tool checks the
 * same permission for the acting person. This module only saves turns — a
 * denied tool is hidden from the model, and a direct call to it answers
 * `ability_not_allowed` with the permission to ask an admin for.
 *
 * The ability set comes from the workspace access route
 * (`GET /api/internal/workspaces/:workspaceId/access/effective`), fetched
 * once per turn with the requester ticket. When the call fails (no API, a
 * network blip, a runtime with no ticket) the gate fails **open**: the server
 * still refuses the call, and a runtime that cannot reach the API must not
 * lose every tool.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core'
import { deriveApiUrl, getInternalHeaders, hasInternalApiCredentials } from './internal-api'

/** Tools whose use needs a workspace ability. Unmapped tools are always allowed. */
export const TOOL_ABILITIES: Readonly<Record<string, string>> = {
  exec: 'agent.exec:use',
  browser: 'agent.browser:use',
  generate_image: 'agent.media:generate',
  generate_video: 'agent.media:generate',
  generate_music: 'agent.media:generate',
  generate_3d: 'agent.media:generate',
  send_message: 'agent.channels:send',
  channel_connect: 'agent.channels:send',
  social_media: 'agent.social:post',
  agent_create: 'agent:create',
  schedule_create: 'schedule:manage',
  schedule_update: 'schedule:manage',
  schedule_delete: 'schedule:manage',
  trigger_create: 'trigger:manage',
  trigger_update: 'trigger:manage',
  trigger_delete: 'trigger:manage',
  system_apply: 'system:apply',
  publish: 'project:publish',
  share_file: 'project.files:share_public',
  connect: 'integrations:connect',
  member_activity: 'members.activity:read',
  board_create: 'boards:manage',
  board_update: 'boards:manage',
  board_archive: 'boards:manage',
  board_reorder: 'boards:manage',
  column_create: 'boards:manage',
  column_update: 'boards:manage',
  column_delete: 'boards:manage',
}

/** The ability a tool needs, or null when it needs none. */
export function abilityForTool(name: string): string | null {
  return TOOL_ABILITIES[name] ?? null
}

/**
 * The ability that gates a capability toggle, for `capabilities_configure`'s
 * member read mode. A key absent here is not gated by an ability at all, so the
 * agent can say "that is a workspace setting" rather than "ask an admin".
 */
export const CAPABILITY_ABILITIES: Readonly<Record<string, string>> = {
  shellEnabled: 'agent.exec:use',
  browserEnabled: 'agent.browser:use',
  imageGenEnabled: 'agent.media:generate',
  videoGenEnabled: 'agent.media:generate',
  musicGenEnabled: 'agent.media:generate',
  threeDGenEnabled: 'agent.media:generate',
  channelsEnabled: 'agent.channels:send',
  socialMediaEnabled: 'agent.social:post',
  socialManagementEnabled: 'agent.social:post',
  socialInstagramEnabled: 'agent.social:post',
  socialTiktokEnabled: 'agent.social:post',
  integrationsEnabled: 'integrations:connect',
  boardAdminEnabled: 'boards:manage',
  workTriggersEnabled: 'trigger:manage',
}

/**
 * The acting person's abilities for this turn, or `null` when the runtime
 * cannot ask (no API configured, no credentials, a failed call). `null` means
 * "unknown" and the gate lets everything through.
 *
 * `ticket` is the turn's requester ticket. It is passed explicitly because the
 * turn starts outside the tool-call credential scope that
 * `getInternalHeaders()` reads.
 */
export async function fetchEffectiveAbilities(ticket?: string): Promise<Set<string> | null> {
  const apiUrl = deriveApiUrl()
  const workspaceId = process.env.WORKSPACE_ID
  if (!apiUrl || !workspaceId || !hasInternalApiCredentials()) return null
  try {
    const res = await fetch(
      `${apiUrl}/api/internal/workspaces/${encodeURIComponent(workspaceId)}/access/effective`,
      {
        method: 'GET',
        headers: {
          ...getInternalHeaders(),
          ...(ticket ? { 'X-Requester-Ticket': ticket } : {}),
        },
        signal: AbortSignal.timeout(5_000),
      },
    )
    if (!res.ok) return null
    const body = (await res.json()) as { abilities?: unknown }
    if (!Array.isArray(body?.abilities)) return null
    return new Set(body.abilities.filter((a): a is string => typeof a === 'string'))
  } catch {
    return null
  }
}

/** True when the tool may be used. Unknown ability sets allow everything. */
export function isToolAllowed(name: string, abilities: ReadonlySet<string> | null): boolean {
  if (!abilities) return true
  const ability = abilityForTool(name)
  return !ability || abilities.has(ability)
}

/**
 * Wrap a tool so a call that slipped past the filter still answers with the
 * permission to ask for, instead of running.
 */
export function withAbilityGate(tool: AgentTool, abilities: ReadonlySet<string> | null): AgentTool {
  if (!abilities) return tool
  const ability = abilityForTool(tool.name)
  if (!ability || abilities.has(ability)) return tool
  return {
    ...tool,
    async execute(_toolCallId: string, _params: any, _signal?: AbortSignal, _onUpdate?: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'ability_not_allowed',
              permission: ability,
              message: `Ask a workspace admin for ${ability}.`,
            }),
          },
        ],
        details: { error: 'ability_not_allowed', permission: ability },
      } as any
    },
  } as AgentTool
}

/**
 * Hide the tools this person may not use and gate the rest. Applied to the
 * whole list in `createTools`, so a subagent's parent tool set is filtered the
 * same way the main agent's is.
 */
export function applyAbilityGate(tools: AgentTool[], abilities: ReadonlySet<string> | null): AgentTool[] {
  if (!abilities) return tools
  return tools
    .filter((tool) => isToolAllowed(tool.name, abilities))
    .map((tool) => withAbilityGate(tool, abilities))
}
