// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ProjectAgent service — resolves a project-scoped, named agent
 * record for both voice and chat callers.
 *
 * One row per `(projectId, name)`; the row carries the persona +
 * tool-allowlist shared between modalities, plus modality-specific
 * fields (voice: `voiceId`, `firstMessage`, `elevenlabsAgentId`;
 * chat: `model`).
 *
 * The `default` agent is special: it's what `agentName === undefined`
 * resolves to, and projects predating the `project_agents` table fall
 * back to the legacy `voice_project_configs.elevenlabsAgentId` column.
 */

import { ElevenLabsClient } from '@shogo-ai/sdk/voice'
import { prisma } from '../lib/prisma'
import { ensureProjectElevenLabsAgent } from '../routes/voice'

/**
 * Tool descriptor as seen by route handlers — manifest declares the
 * schema; the consumer's `clientTools` map provides the handler.
 * Matched by `name`.
 */
export interface ResolvedTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export type ResolvedTools = ReadonlyArray<ResolvedTool> | null

export interface ResolvedAgent {
  id: string
  name: string
  projectId: string
  workspaceId: string
  systemPrompt: string | null
  /** Full tool descriptors (canonical). */
  tools: ResolvedTools
  characterName: string | null
  displayName: string | null
  voiceId: string | null
  firstMessage: string | null
  elevenlabsAgentId: string | null
  model: string | null
}

/**
 * Decode and normalize the row's `tools` column. Falls back to the
 * legacy `toolsAllowlist` (string[]) for rows written before the
 * structured-tools migration ran.
 */
function normalizeTools(rawTools: unknown, rawAllowlist: unknown): ResolvedTools {
  const decode = (raw: unknown): unknown => {
    if (raw == null) return null
    if (typeof raw !== 'string') return raw
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  const fromTools = decode(rawTools)
  if (Array.isArray(fromTools)) {
    const out: ResolvedTool[] = []
    for (const v of fromTools) {
      if (typeof v === 'string' && v.length > 0) {
        out.push({ name: v })
        continue
      }
      if (v == null || typeof v !== 'object' || Array.isArray(v)) continue
      const obj = v as Record<string, unknown>
      if (typeof obj.name !== 'string' || obj.name.length === 0) continue
      const tool: ResolvedTool = { name: obj.name }
      if (typeof obj.description === 'string') tool.description = obj.description
      if (
        obj.inputSchema !== null &&
        typeof obj.inputSchema === 'object' &&
        !Array.isArray(obj.inputSchema)
      ) {
        tool.inputSchema = obj.inputSchema as Record<string, unknown>
      }
      out.push(tool)
    }
    return out.length > 0 ? out : null
  }
  // Legacy fallback — bare string[].
  const fromAllowlist = decode(rawAllowlist)
  if (!Array.isArray(fromAllowlist)) return null
  const out: ResolvedTool[] = []
  for (const v of fromAllowlist) {
    if (typeof v === 'string' && v.length > 0) out.push({ name: v })
  }
  return out.length > 0 ? out : null
}

function rowToResolved(row: {
  id: string
  projectId: string
  workspaceId: string
  name: string
  systemPrompt: string | null
  toolsAllowlist: unknown
  tools: unknown
  characterName: string | null
  displayName: string | null
  voiceId: string | null
  firstMessage: string | null
  elevenlabsAgentId: string | null
  model: string | null
}): ResolvedAgent {
  return {
    id: row.id,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    name: row.name,
    systemPrompt: row.systemPrompt,
    tools: normalizeTools(row.tools, row.toolsAllowlist),
    characterName: row.characterName,
    displayName: row.displayName,
    voiceId: row.voiceId,
    firstMessage: row.firstMessage,
    elevenlabsAgentId: row.elevenlabsAgentId,
    model: row.model,
  }
}

/**
 * Resolve a project-scoped agent row by name, returning `null` when no
 * row exists. Caller decides whether the lookup should fall back to a
 * legacy default (see {@link resolveProjectAgentOrLegacyDefault}).
 */
export async function resolveProjectAgent(params: {
  projectId: string
  agentName?: string
}): Promise<ResolvedAgent | null> {
  const name = params.agentName ?? 'default'
  const row = await prisma.projectAgent.findUnique({
    where: { projectId_name: { projectId: params.projectId, name } },
  })
  if (!row) return null
  return rowToResolved(row)
}

/**
 * List all named agents on a project. Used by the resolver's 404
 * response so consumers can debug typos quickly.
 */
export async function listProjectAgentNames(
  projectId: string,
): Promise<string[]> {
  const rows = await prisma.projectAgent.findMany({
    where: { projectId },
    select: { name: true },
    orderBy: { name: 'asc' },
  })
  return rows.map((r) => r.name)
}

/**
 * Voice-side: ensure the resolved agent has a usable
 * `elevenlabsAgentId`. Lazily provisions one when the row has a
 * `voiceId` but no agent id yet — this is the path that turns a
 * chat-only agent into a voice-capable one once a `voiceId` has been
 * deployed.
 *
 * Throws when the agent has no `voiceId` (i.e. is chat-only); voice
 * routes should treat that as a 404 with a clear error for the
 * caller.
 */
export async function ensureVoiceAgentId(params: {
  agent: ResolvedAgent
  client: ElevenLabsClient
}): Promise<string> {
  if (params.agent.elevenlabsAgentId) return params.agent.elevenlabsAgentId
  if (!params.agent.voiceId) {
    throw new Error(
      `Agent '${params.agent.name}' is not voice-capable (no voiceId configured)`,
    )
  }

  const agentId = await params.client.createAgent({
    displayName:
      params.agent.displayName ??
      `shogo-project-${params.agent.projectId.slice(0, 8)}`,
    characterName: params.agent.characterName ?? 'Shogo',
    voiceId: params.agent.voiceId,
    systemPrompt: params.agent.systemPrompt ?? '',
    firstMessage: params.agent.firstMessage ?? '',
    memoryBlock: null,
    language: 'en',
  })

  await prisma.projectAgent.update({
    where: { id: params.agent.id },
    data: { elevenlabsAgentId: agentId },
  })

  return agentId
}

/**
 * Voice-side resolver with legacy fallback.
 *
 * 1. Try `(projectId, name)` lookup; if hit, ensure the EL agent id
 *    is populated and return it.
 * 2. If no row matches AND the requested name is `default`, fall back
 *    to the existing `voice_project_configs.elevenlabsAgentId`
 *    column via {@link ensureProjectElevenLabsAgent}. This keeps
 *    pre-migration projects working without forcing a deploy.
 * 3. Otherwise return `null` so the caller can 404 with the list of
 *    known agent names.
 */
export async function resolveVoiceAgentForSignedUrl(params: {
  projectId: string
  workspaceId: string
  agentName?: string
  client: ElevenLabsClient
}): Promise<{ agentId: string; agentName: string } | null> {
  const requestedName = params.agentName ?? 'default'
  const agent = await resolveProjectAgent({
    projectId: params.projectId,
    agentName: requestedName,
  })

  if (agent) {
    if (!agent.voiceId && !agent.elevenlabsAgentId) {
      // Chat-only agent — caller asked for it by name but it has no
      // voice configured. Treat as a 404 for the voice path; the
      // chat route handles the same row just fine.
      return null
    }
    const agentId = await ensureVoiceAgentId({
      agent,
      client: params.client,
    })
    return { agentId, agentName: agent.name }
  }

  if (requestedName === 'default') {
    const agentId = await ensureProjectElevenLabsAgent({
      projectId: params.projectId,
      workspaceId: params.workspaceId,
      client: params.client,
    })
    return { agentId, agentName: 'default' }
  }

  return null
}
