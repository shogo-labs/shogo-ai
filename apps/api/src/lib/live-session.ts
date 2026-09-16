// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ProxyTokenPayload } from './ai-proxy-token'
import { getMergedModelEntrySync } from '../services/model-registry.service'
import {
  isModelProviderConfigured,
  resolveVisibleModelsForWorkspace,
} from '../services/visible-models.service'
import { isModelVisibleForWorkspace } from '../services/workspace-models.service'
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
  entries: Array<{ id: string }>,
  modelId: string,
): boolean {
  const entry = getMergedModelEntrySync(modelId)
  if (!entry) return false
  return entries.some((candidate) => candidate.id === entry.id || candidate.id === modelId)
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
  if (!visibleEntry(visible.catalogModels, modelId)) {
    return {
      ok: false,
      status: 403,
      code: 'model_not_visible',
      message: `Live model '${modelId}' is not available for this workspace.`,
    }
  }
  if (!await isModelVisibleForWorkspace(tokenPayload.workspaceId, modelId)) {
    return {
      ok: false,
      status: 403,
      code: 'model_not_visible',
      message: `Live model '${modelId}' is not available for this workspace.`,
    }
  }

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
    if (!visibleEntry(visible.catalogModels, backendModelId) ||
        !await isModelVisibleForWorkspace(tokenPayload.workspaceId, backendModelId)) {
      return {
        ok: false,
        status: 403,
        code: 'backend_model_not_visible',
        message: `Backend model '${backendModelId}' is not available for this workspace.`,
      }
    }
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
