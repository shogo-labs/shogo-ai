// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The model an agent runs with, and its name as the app writes it.
 *
 * One source of truth: the channel dispatcher asks this for the `agentMode` a
 * turn is started with, and the agent profile card asks it what to display, so
 * the card can never claim a model the agent does not actually run.
 */

import { prisma } from '../lib/prisma'
import { getAgentDefaultModel } from './workspace-agent.service'
import { isModelVisibleForWorkspace } from './workspace-models.service'
import { getMergedModelEntrySync, resolveModelLabel } from './model-registry.service'

const db = prisma as any

/** Auto picks a tier per turn at runtime; there is no single model to name. */
export const AUTO_MODEL_ID = 'auto'

/** `AgentConfig.modelName` when nobody chose a model for the project. */
const DEFAULT_AGENT_MODEL = 'claude-haiku-4-5'

/**
 * The model a channel run asks for. Auto routing suits a general assistant, but a project whose
 * agent was given a model on purpose (a team template pins one for its builder, say) keeps it.
 * The workspace agent uses the admin-set workspace default, while that model is still allowed.
 */
export async function resolveAgentRunModel(projectId: string | null, workspaceId?: string): Promise<string> {
  if (!projectId) {
    if (!workspaceId) return AUTO_MODEL_ID
    const model = await getAgentDefaultModel(workspaceId).catch(() => null)
    if (!model || model === AUTO_MODEL_ID) return AUTO_MODEL_ID
    return (await isModelVisibleForWorkspace(workspaceId, model)) ? model : AUTO_MODEL_ID
  }
  const row = await db.agentConfig.findUnique({ where: { projectId }, select: { modelName: true } }).catch(() => null)
  const name = row?.modelName?.trim()
  return name && name !== DEFAULT_AGENT_MODEL && name !== AUTO_MODEL_ID ? name : AUTO_MODEL_ID
}

/**
 * `resolveAgentRunModel` plus the label the app shows for it, in the app's own
 * words: `Auto` stays `Auto` (it picks a tier per turn, so a concrete name would
 * be a lie), anything else is the model picker's name — `Claude Sonnet 4.6`,
 * never the shorter cost-table label and never a UUID.
 */
export async function resolveAgentRunModelLabel(
  projectId: string | null,
  workspaceId?: string,
): Promise<{ id: string; label: string }> {
  const id = await resolveAgentRunModel(projectId, workspaceId)
  if (!id || id === AUTO_MODEL_ID) return { id: AUTO_MODEL_ID, label: 'Auto' }
  return { id, label: await displayNameFor(id) }
}

/**
 * The registry name the person picked the model by. The sync lookup covers the
 * normal case; `resolveModelLabel` then refreshes a cold snapshot and reaches
 * rows kept out of it (an admin-disabled model) so the card still names it.
 */
async function displayNameFor(id: string): Promise<string> {
  const known = getMergedModelEntrySync(id)?.displayName
  if (known) return known
  const label = await resolveModelLabel(id)
  return getMergedModelEntrySync(id)?.displayName ?? label
}
