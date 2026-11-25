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
import { isModelAccessibleForWorkspace } from '../lib/model-access'
import { getMergedModelEntrySync, resolveModelLabel, resolveModelLabelSync } from './model-registry.service'
import { recordAccessEvent, allowedAutoTiers, resolveRunModelFor } from './access-policy.service'
import {
  resolveInstanceAgentModelDefaults,
  type AgentModelEntry,
} from '../lib/runtime/agent-model-defaults'
import { getRbacMode } from '../lib/authz/mode'

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
    if (!(await isModelVisibleForWorkspace(workspaceId, model))) return AUTO_MODEL_ID
    return (await isModelAccessibleForWorkspace(workspaceId, model)) ? model : AUTO_MODEL_ID
  }
  // `db` is the untyped prisma handle, so a missing delegate (a partial test
  // mock, or a client generated before the model existed) throws on the
  // property access rather than returning a rejected promise — `.catch()` on
  // the call alone would not see it.
  const row = await Promise.resolve()
    .then(() => db.agentConfig.findUnique({ where: { projectId }, select: { modelName: true } }))
    .catch(() => null)
  const name = row?.modelName?.trim()
  if (!name || name === DEFAULT_AGENT_MODEL || name === AUTO_MODEL_ID) return AUTO_MODEL_ID
  // A model id that is no longer in the registry (an admin deleted it, or the
  // catalog renamed it) used to be handed straight to the proxy, which answered
  // `400 model_not_found` — surfaced to the person as the useless "rejected as
  // malformed" (the Odin incident, SHO-348). Running on Auto is the same ending
  // the inaccessible-model cap already gives, and it is loudly logged so the
  // stale `AgentConfig.modelName` gets found.
  if (!getMergedModelEntrySync(name)) {
    console.warn(
      `[agent-run-model] project ${projectId} model ${name} no longer exists — running on Auto`,
    )
    return AUTO_MODEL_ID
  }
  // The chat routes cap an inaccessible model to `auto` themselves, so the run
  // is fine without this — but the profile card reports what this returns, and
  // it must not name a model the run will never use (SHO-145, SHO-264).
  if (workspaceId && !(await isModelAccessibleForWorkspace(workspaceId, name))) return AUTO_MODEL_ID
  return name
}

export interface RunModelResolution {
  model: string
  /**
   * Set when the agent's configured model is outside the acting person's
   * effective set and the run was moved to their default model for this run
   * only (SHO-417, Russell 2026-11-18). The runtime states it in the reply.
   */
  downgrade: { from: string; to: string; fromLabel?: string; toLabel?: string } | null
  /**
   * The Auto tier map narrowed to this person, or `null` when the run is not on
   * Auto. The runtime's process-wide `AGENT_AUTO_TIER_MAP` is one map for the
   * whole workspace, so a per-person cap has to ride on the turn: with this
   * map, `resolveAutoDowngrade` can only walk models the person may use. Each
   * tier carries its provider so an opaque (cloud) id keeps its routing.
   */
  autoTiers: Record<string, AgentModelEntry> | null
}

/**
 * The model a run should use for one person, with the run-start downgrade
 * applied.
 *
 * A direct chat's per-message model pick is the starting point when it sends
 * one (SHO-497): that is the model the person chose for *this* turn, and the
 * agent's configured model is only the fallback. A channel run
 * (`conversation-agent-dispatcher`) passes nothing, so it keeps starting from
 * the agent's model.
 *
 * When the model the run would start with is outside the acting person's
 * effective set, the run uses that person's default model **for this run
 * only** — the agent's saved config is untouched. In `shadow` mode the run keeps
 * that model and only an audit row is written, so an admin can see what would
 * have happened before enforcing.
 *
 * `null` when the person has no allowed model at all: the caller fails the run
 * with `model_not_allowed` and "ask an admin".
 */
export async function resolveAgentRunModelFor(
  projectId: string | null,
  workspaceId: string | undefined,
  actingUserId: string | null | undefined,
  /** The model the person picked for this turn (`agentMode` on a direct chat). */
  requestedModel?: string | null,
): Promise<RunModelResolution | null> {
  // This runs on the chat hot path, so a resolution failure must not 500 the
  // turn: fall back to the requested-or-configured model with no downgrade and
  // let the proxy gate the request as it always did.
  try {
    return await resolveRunModelForActor(projectId, workspaceId, actingUserId, requestedModel)
  } catch (err) {
    console.warn('[rbac] run model resolution failed:', (err as Error)?.message ?? err)
    return {
      model: normalizeRequestedModel(requestedModel) ?? AUTO_MODEL_ID,
      downgrade: null,
      autoTiers: null,
    }
  }
}

function normalizeRequestedModel(requestedModel?: string | null): string | null {
  const trimmed = typeof requestedModel === 'string' ? requestedModel.trim() : ''
  return trimmed || null
}

async function resolveRunModelForActor(
  projectId: string | null,
  workspaceId: string | undefined,
  actingUserId: string | null | undefined,
  requestedModel?: string | null,
): Promise<RunModelResolution | null> {
  const configured = await resolveAgentRunModel(projectId, workspaceId)
  // The person's pick for this turn wins; the agent's configured model is the
  // fallback for a surface with no picker (a channel run) or a body with no
  // `agentMode`. An alias or old slug resolves to the id the catalog and the
  // proxy know, so a pick saved before a rename still runs on that model.
  const requested = normalizeRequestedModel(requestedModel)
  const requestedEntry =
    requested && requested !== AUTO_MODEL_ID ? getMergedModelEntrySync(requested) : undefined
  const target = requestedEntry?.id ?? requested ?? configured
  if (!workspaceId || !actingUserId) return { model: target, downgrade: null, autoTiers: null }

  // A pick this instance's catalog does not know at all is passed through
  // untouched, the rule `allowedAutoTiers` already follows for a cloud tier: a
  // desktop resolves its picker from Shogo Cloud, and a cloud model id may not
  // be mirrored into the local registry yet, so the local catalog cannot judge
  // it. The cloud already capped it to the key holder's grant and the proxy
  // still enforces it; substituting the person's default here would silently run
  // a different model than the one they picked (the SHO-481 lesson).
  if (requested && requested !== AUTO_MODEL_ID && !requestedEntry) {
    return { model: requested, downgrade: null, autoTiers: null }
  }

  const autoTiers = await autoTiersFor(workspaceId, actingUserId, target)
  const resolved = await resolveRunModelFor(workspaceId, actingUserId, target)
  if (!resolved) return null
  if (!resolved.downgrade) return { model: resolved.model, downgrade: null, autoTiers }

  const mode = await getRbacMode()
  await recordAccessEvent({
    workspaceId,
    kind: mode === 'on' ? 'model.downgraded' : 'shadow_denied',
    onBehalfOfUserId: actingUserId,
    modelId: resolved.downgrade.from,
    detail: {
      from: resolved.downgrade.from,
      to: resolved.downgrade.to,
      projectId,
      mode,
      reason: 'agent_model_above_actor',
    },
  })
  if (mode !== 'on') {
    console.warn('[rbac] shadow-deny run model', {
      workspaceId,
      userId: actingUserId,
      from: resolved.downgrade.from,
      to: resolved.downgrade.to,
    })
    return { model: target, downgrade: null, autoTiers }
  }
  return { model: resolved.model, downgrade: withLabels(resolved.downgrade), autoTiers }
}

/**
 * Name the models in the downgrade so the reply's first line reads
 * "Ran on Claude Haiku 4.5 because your role can't use Claude Opus 4.5" rather
 * than two raw ids. A model missing from the catalog keeps its id.
 */
function withLabels(downgrade: { from: string; to: string }): {
  from: string
  to: string
  fromLabel?: string
  toLabel?: string
} {
  const fromLabel = resolveModelLabelSync(downgrade.from)
  const toLabel = resolveModelLabelSync(downgrade.to)
  return {
    ...downgrade,
    ...(fromLabel && fromLabel !== downgrade.from ? { fromLabel } : {}),
    ...(toLabel && toLabel !== downgrade.to ? { toLabel } : {}),
  }
}

/**
 * The Auto tier map for this person, or `null` when the run is not on Auto.
 * Resolved from the *instance's* defaults — the connected cloud's on a desktop
 * (SHO-481: the local map used to win and send complex straight to Sonnet) —
 * and every tier maps to a model they may use, so an Auto fallback cannot land
 * outside their set (AC3).
 */
async function autoTiersFor(
  workspaceId: string,
  actingUserId: string,
  configured: string,
): Promise<Record<string, AgentModelEntry> | null> {
  if (configured !== AUTO_MODEL_ID) return null
  const defaults = await resolveInstanceAgentModelDefaults(workspaceId).catch(() => null)
  if (!defaults) return null
  const configuredTiers: Record<string, string> = {}
  for (const [tier, entry] of Object.entries(defaults.autoTiers)) {
    if (entry?.id) configuredTiers[tier] = entry.id
  }
  const narrowed = await allowedAutoTiers(workspaceId, actingUserId, configuredTiers)
  if (!narrowed) return null
  const out: Record<string, AgentModelEntry> = {}
  for (const [tier, id] of Object.entries(narrowed)) {
    const source = (defaults.autoTiers as Record<string, AgentModelEntry | undefined>)[tier]
    out[tier] = source?.id === id
      ? {
          id,
          ...(source.provider ? { provider: source.provider } : {}),
          ...(source.upstream ? { upstream: source.upstream } : {}),
        }
      : { id }
  }
  return out
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
