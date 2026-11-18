// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ProxyTokenPayload } from './ai-proxy-token'
import { getMergedModelEntrySync } from '../services/model-registry.service'
import {
  isModelProviderConfigured,
  resolveVisibleModelsForWorkspace,
} from '../services/visible-models.service'
import { checkModelAccess } from '../services/access-policy.service'
import type { ModelEntry } from '@shogo/model-catalog'

export interface LiveSessionStart {
  model?: string
  instructions?: string
  audio?: Record<string, unknown>
  input?: unknown
  store?: boolean
  delegation?: {
    type?: 'responses' | 'client'
    responses?: {
      model?: string
      instructions?: string
      tools?: unknown[]
      tool_choice?: unknown
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  [key: string]: unknown
}

export type LiveValidation = {
  ok: true
  model: ModelEntry
  backendModel?: string
  upstreamModel: string
  upstreamBackendModel?: string
} | {
  ok: false
  status: 400 | 403 | 503
  code: string
  message: string
}

function visibleEntry(
  entries: Array<{ id: string; provider?: string; kind?: string }>,
  model: ModelEntry,
): boolean {
  return entries.some((candidate) => {
    if (candidate.id === model.id) return true
    // Cloud-forwarding mode: a cloud-connected desktop's visible-models list
    // is sourced from the connected cloud's picker payload, which keys
    // entries by an opaque DB id rather than the code-shipped catalog slug
    // (e.g. `gpt-live-1`). That payload doesn't carry `apiModel`/aliases, so
    // a locally-resolved slug entry can never id-match a cloud-sourced one.
    // Unlike chat models — whose id always round-trips unchanged from a
    // picker selection — Live model ids are caller-supplied slugs per the
    // SDK contract, so fall back to kind+provider matching. Safe while each
    // provider has at most one live model.
    if (model.kind === 'live' && candidate.kind === 'live' && candidate.provider === model.provider) return true
    return false
  })
}

/**
 * The per-member model gate for a live session, or `null` when it may start.
 *
 * Live sessions used to check only the workspace ceiling, so a member narrowed
 * to economy could start a premium live model (SHO-417, §3/§5). The acting
 * person comes from the proxy token the same way the chat routes resolve it.
 */
async function liveModelAccess(
  tokenPayload: ProxyTokenPayload,
  modelId: string,
  code: 'model_not_visible' | 'backend_model_not_visible' = 'model_not_visible',
): Promise<LiveValidation | null> {
  const userId = tokenPayload.actingUserId || tokenPayload.userId
  if (!userId) return null
  const decision = await checkModelAccess(tokenPayload.workspaceId, userId, modelId, {
    projectId: tokenPayload.projectId,
    actorUserId: tokenPayload.userId ?? null,
  })
  if (decision.allowed) return null
  return {
    ok: false,
    status: 403,
    code,
    message: `Live model '${modelId}' is not available for this workspace.`,
  }
}

/** Validate a Live session before any audio or provider request is started. */
export async function validateLiveSessionStart(
  tokenPayload: ProxyTokenPayload,
  session: LiveSessionStart,
  options: { allowCloudForwarding?: boolean } = {},
): Promise<LiveValidation> {
  const modelId = typeof session.model === 'string' ? session.model : ''
  const model = modelId ? getMergedModelEntrySync(modelId) : undefined
  if (!model || model.kind !== 'live') {
    return {
      ok: false,
      status: 400,
      code: 'model_not_found',
      message: `Live model '${modelId || '(missing)'}' is not available.`,
    }
  }
  const cloudConfigured =
    options.allowCloudForwarding &&
    process.env.SHOGO_LOCAL_MODE === 'true' &&
    !!process.env.SHOGO_API_KEY
  if (model.provider !== 'openai' || (!isModelProviderConfigured(model.provider) && !cloudConfigured)) {
    return {
      ok: false,
      status: 503,
      code: 'provider_not_configured',
      message: 'The OpenAI provider is not configured for Live Sessions.',
    }
  }

  const visible = await resolveVisibleModelsForWorkspace(tokenPayload.workspaceId, { includeLive: true })
  if (!visibleEntry(visible.catalogModels, model)) {
    return {
      ok: false,
      status: 403,
      code: 'model_not_visible',
      message: `Live model '${modelId}' is not available for this workspace.`,
    }
  }
  // The per-member gate, not just the workspace ceiling: a member whose role is
  // narrowed to economy must not start a premium live session (SHO-417, §3/§5).
  const liveAccess = await liveModelAccess(tokenPayload, modelId)
  if (liveAccess) return liveAccess

  const delegation = session.delegation
  if (delegation?.type === 'responses') {
    const backendModelId = delegation.responses?.model
    if (!backendModelId || typeof backendModelId !== 'string') {
      return {
        ok: false,
        status: 400,
        code: 'backend_model_required',
        message: 'Responses delegation requires delegation.responses.model.',
      }
    }
    const backend = getMergedModelEntrySync(backendModelId)
    if (!backend || backend.kind === 'live' || backend.provider !== 'openai') {
      return {
        ok: false,
        status: 400,
        code: 'backend_model_not_supported',
        message: `Backend model '${backendModelId}' must be a visible OpenAI chat model.`,
      }
    }
    if (!visibleEntry(visible.catalogModels, backend)) {
      return {
        ok: false,
        status: 403,
        code: 'backend_model_not_visible',
        message: `Backend model '${backendModelId}' is not available for this workspace.`,
      }
    }
    const backendAccess = await liveModelAccess(tokenPayload, backendModelId, 'backend_model_not_visible')
    if (backendAccess) return backendAccess
    return {
      ok: true,
      model,
      backendModel: backendModelId,
      upstreamModel: model.apiModel,
      upstreamBackendModel: backend.apiModel,
    }
  }

  if (delegation?.type && delegation.type !== 'client') {
    return {
      ok: false,
      status: 400,
      code: 'invalid_delegation',
      message: `Unsupported delegation type '${delegation.type}'. Use 'responses' or 'client'.`,
    }
  }

  return { ok: true, model, upstreamModel: model.apiModel }
}
