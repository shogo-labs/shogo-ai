// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Plan entitlement check for a single chat model.
 *
 * Kept free of the heavier runtime-defaults imports so chat routes can gate
 * per-request model picks without pulling in the Auto-tier resolver.
 */

import { getModelTier, inferProviderFromModel } from '@shogo/model-catalog'
// The seam, not billing.service: this also runs in the desktop's local
// bundle, which must not pull in the Stripe-backed billing service.
import * as billingService from '../services/billing-runtime'
import { resolvePublicModelSync } from '../services/public-models.service'
import { getMergedModelEntrySync } from '../services/model-registry.service'

/**
 * Economy, local, and OpenRouter models are available to every plan. Other
 * provider models require advanced model access. Public ids (e.g. `hoshi-2-0`)
 * resolve to their backing model, and DB-defined tiers win over the static
 * catalog so admin-managed models are classified correctly.
 */
export async function isModelAccessibleForWorkspace(
  workspaceId: string,
  modelId: string,
  /**
   * Cached entitlement for a caller gating a whole list. `hasAdvancedModelAccess`
   * is workspace-wide, so `GET /ai/v1/models` resolves it once and passes the
   * value — or the resolver — for every model in the list. It is a thunk, and
   * only consulted for a model that actually needs the entitlement, so listing
   * economy/local/OpenRouter models never touches billing.
   */
  known?: { advancedAccess?: boolean; resolveAdvancedAccess?: () => Promise<boolean> },
): Promise<boolean> {
  const trimmed = modelId.trim()
  const id = resolvePublicModelSync(trimmed)?.backingModelId?.trim() || trimmed
  const entry = getMergedModelEntrySync(id)
  const provider = entry?.provider ?? inferProviderFromModel(id, 'custom')
  if (provider === 'local' || provider === 'openrouter') return true
  if ((entry?.tier ?? getModelTier(id)) === 'economy') return true
  if (known?.advancedAccess !== undefined) return known.advancedAccess
  if (known?.resolveAdvancedAccess) return known.resolveAdvancedAccess()
  return billingService.hasAdvancedModelAccess(workspaceId)
}
