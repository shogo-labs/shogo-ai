// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Builds the A2A `AgentCard` for a project — the shogo equivalent of
 * Odin's `services/a2a/card.py`.
 *
 * Built fresh on every request (not cached), so project edits show up
 * immediately — same posture as Odin. The v1.0 `AgentCard` type has more
 * REQUIRED fields than Odin's Python card builder needed (`protocolVersion`
 * and `tenant` on every `AgentInterface`, `capabilities.extensions`,
 * per-skill `examples`/`inputModes`/`outputModes`/`securityRequirements`,
 * `signatures`) — see the field-by-field notes inline below.
 *
 * Card metadata source, and what "the shogo agent" means here:
 *
 *   - `ProjectAgent` (prisma/schema.prisma) is a persona row backing
 *     `POST /api/chat/turn` and the voice stack — `displayName`,
 *     `characterName`, `systemPrompt`, `tools` descriptors.
 *   - The actual A2A-reachable agent is the runtime pod (`AgentGateway`,
 *     reached via `POST /agent/chat`), which has no notion of named
 *     personas — `POST /agent/chat` takes no `agentName` parameter.
 *
 * So `ProjectAgent` is used ONLY as card metadata (name/description, and
 * its `tools` as extra `AgentSkill`s when present) — never to select a
 * runtime agent. There's no `resolveProjectAgentOrLegacyDefault` helper
 * in this codebase (that name in the plan was aspirational); the
 * fallback to a project's bare name/description when no `ProjectAgent`
 * row exists is implemented directly in `resolveCardMetadata` below.
 */

import type { AgentCard, AgentSkill } from '@a2a-js/sdk'
import { prisma } from '../prisma'
import { resolveProjectAgent, type ResolvedAgent } from '../../services/projectAgent.service'
import { getFrontendUrl } from '../cloud-urls'

/** A2A protocol version this server implements. No implicit default —
 * `validateVersion()` in the SDK rejects any version not explicitly
 * declared on an `AgentInterface`. */
export const A2A_PROTOCOL_VERSION = '1.0'

const CHAT_SKILL: AgentSkill = {
  id: 'chat',
  name: 'Chat',
  description:
    'General-purpose coding-agent chat. Send a message and the agent reads/writes ' +
    "the project's files, runs commands, and answers using the full runtime tool set.",
  tags: ['shogo', 'chat', 'coding-agent'],
  examples: [
    'Add a dark mode toggle to the settings page',
    'Why is the build failing?',
  ],
  inputModes: ['text/plain'],
  outputModes: ['text/plain'],
  securityRequirements: [],
}

/**
 * Base URL A2A clients should use to reach this server. Priority:
 * `SHOGO_A2A_BASE_URL` (Odin's `BACKEND_ROOT_URL` equivalent) →
 * `getFrontendUrl()` (`APP_URL` → first `ALLOWED_ORIGINS` entry →
 * localhost). Trailing slash trimmed so callers can concat safely.
 */
export function getA2aBaseUrl(): string {
  const override = process.env.SHOGO_A2A_BASE_URL
  const base = override || getFrontendUrl()
  return base.replace(/\/$/, '')
}

interface CardMetadata {
  name: string
  description: string
  extraSkills: AgentSkill[]
}

/**
 * Resolve card metadata from the project's `default` `ProjectAgent` row,
 * falling back to the bare `Project` row when no agent row exists
 * (projects created before the `project_agents` table, or that never
 * configured a named agent). Never returns `null` — a project that
 * exists always has at least a name to show.
 */
async function resolveCardMetadata(projectId: string): Promise<CardMetadata | null> {
  const agent: ResolvedAgent | null = await resolveProjectAgent({ projectId })

  if (agent) {
    const name = agent.displayName || agent.characterName || 'Shogo Agent'
    const description =
      agent.systemPrompt?.trim().slice(0, 500) ||
      `Shogo coding agent for this project (agent: ${agent.name}).`
    const extraSkills: AgentSkill[] = (agent.tools ?? []).map((tool) => ({
      id: tool.name,
      name: tool.name,
      description: tool.description || `Tool: ${tool.name}`,
      tags: ['shogo', 'tool'],
      examples: [],
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    }))
    return { name, description, extraSkills }
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true, description: true },
  })
  if (!project) return null

  return {
    name: project.name || 'Shogo Agent',
    description: project.description || `Shogo coding agent for project ${project.name}.`,
    extraSkills: [],
  }
}

export interface BuildAgentCardOptions {
  projectId: string
  /** Override the computed base URL — mainly for tests. */
  baseUrl?: string
}

/**
 * Build the `AgentCard` for `projectId`. Returns `null` if the project
 * doesn't exist (caller should 404, not fabricate a card).
 */
export async function buildAgentCard(options: BuildAgentCardOptions): Promise<AgentCard | null> {
  const { projectId } = options
  const meta = await resolveCardMetadata(projectId)
  if (!meta) return null

  const base = options.baseUrl ?? getA2aBaseUrl()
  const rpcUrl = `${base}/a2a/projects/${projectId}/rpc`

  const card: AgentCard = {
    name: meta.name,
    description: meta.description,
    version: '1.0.0',
    provider: undefined,
    documentationUrl: `${base}/docs/a2a`,
    // First (and only) entry is preferred per `AgentInterface` doc comment.
    supportedInterfaces: [
      {
        url: rpcUrl,
        protocolBinding: 'JSONRPC',
        // Both mandatory in v1.0 — see module doc comment.
        protocolVersion: A2A_PROTOCOL_VERSION,
        tenant: projectId,
      },
    ],
    capabilities: {
      // The main departure from Odin (`capabilities.streaming=False`) —
      // shogo's runtime pod already streams rich events end to end.
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [CHAT_SKILL, ...meta.extraSkills],
    securitySchemes: {
      bearerAuth: {
        scheme: {
          $case: 'httpAuthSecurityScheme',
          value: {
            description: 'Project-scoped shogo_a2a_<keyId>.<secret> bearer key.',
            scheme: 'Bearer',
            bearerFormat: 'opaque',
          },
        },
      },
    },
    securityRequirements: [{ schemes: { bearerAuth: { list: [] } } }],
    signatures: [],
    iconUrl: undefined,
  }

  return card
}
