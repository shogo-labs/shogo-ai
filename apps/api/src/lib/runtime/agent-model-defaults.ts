// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Resolve the model defaults injected into agent-runtime processes.
 *
 * Cloud-connected local instances source these values from Shogo Cloud.
 * Cloud-hosted runtimes and offline/local instances resolve them from the
 * server's in-memory admin settings and apply the same entitlement guard.
 */

import {
  getAgentModeOverrides,
  getAutoTierOverrides,
  getModelTier,
  inferProviderFromModel,
  resolveAgentModeDefault,
} from '@shogo/model-catalog'
import * as billingService from '../../services/billing.service'
import { resolvePublicModelSync } from '../../services/public-models.service'
import { getMergedModelEntrySync } from '../../services/model-registry.service'
import { prisma } from '../prisma'
import { fetchCloudAgentModelDefaults } from '../federated-upstream'

export type AgentModelTier = 'economy' | 'standard' | 'premium'

export interface AgentModelEntry {
  id: string
  provider?: string
}

export interface AgentModelDefaults {
  basic: string
  advanced: string
  defaultMode: string | null
  autoTiers: Record<AgentModelTier, AgentModelEntry>
  hasAdvancedModelAccess: boolean
}

export interface AgentModelEnv {
  AGENT_BASIC_MODEL: string
  AGENT_ADVANCED_MODEL: string
  AGENT_AUTO_TIER_MAP: string
}

const AUTO_TIERS: AgentModelTier[] = ['economy', 'standard', 'premium']
const SAFE_BASIC_MODEL = 'claude-haiku-4-5-20251001'
const AUTO_MODEL_DEFAULTS: Record<AgentModelTier, string> = {
  economy: 'gpt-5.4-nano',
  standard: 'claude-haiku-4-5-20251001',
  premium: 'claude-sonnet-4-6',
}

function resolveModelTierForAccess(modelId: string): string {
  return getMergedModelEntrySync(modelId)?.tier ?? getModelTier(modelId)
}

function resolveModelEntry(raw: string): AgentModelEntry {
  const trimmed = raw.trim()
  const publicModel = resolvePublicModelSync(trimmed)
  const id = publicModel?.backingModelId?.trim() || trimmed
  return { id, provider: inferProviderFromModel(id, 'custom') }
}

/**
 * Keep this rule identical to public-api.ts's per-request tier gate.
 *
 * Economy, local, and OpenRouter models are available to every plan. Other
 * provider models require advanced model access. This function is also used
 * before Auto routing, so a local runtime never deliberately selects a model
 * that the connected cloud will reject.
 */
export async function isModelAccessibleForWorkspace(
  workspaceId: string,
  modelId: string,
): Promise<boolean> {
  const entry = resolveModelEntry(modelId)
  if (entry.provider === 'local' || entry.provider === 'openrouter') return true
  if (resolveModelTierForAccess(entry.id) === 'economy') return true
  return billingService.hasAdvancedModelAccess(workspaceId)
}

async function readDefaultMode(): Promise<string | null> {
  try {
    const row = await (prisma as any).platformSetting?.findUnique({
      where: { key: 'agent-model.default-mode' },
    })
    return typeof row?.value === 'string' && row.value.trim() ? row.value.trim() : null
  } catch {
    return null
  }
}

async function firstAccessible(
  workspaceId: string,
  candidates: AgentModelEntry[],
): Promise<AgentModelEntry> {
  for (const candidate of candidates) {
    if (await isModelAccessibleForWorkspace(workspaceId, candidate.id)) return candidate
  }
  return candidates[candidates.length - 1] ?? resolveModelEntry(SAFE_BASIC_MODEL)
}

/**
 * Resolve all model defaults and cap inaccessible choices to an accessible
 * fallback. All three Auto tiers are returned so agent-runtime never silently
 * falls back to its package-level hardcoded tier map.
 */
export async function resolveEffectiveAgentModelDefaults(
  workspaceId: string,
): Promise<AgentModelDefaults> {
  const modeOverrides = getAgentModeOverrides()
  const autoOverrides = getAutoTierOverrides()
  const configuredTiers: Record<AgentModelTier, string> = {
    ...AUTO_MODEL_DEFAULTS,
    ...(autoOverrides.economy ? { economy: autoOverrides.economy } : {}),
    ...(autoOverrides.standard ? { standard: autoOverrides.standard } : {}),
    ...(autoOverrides.premium ? { premium: autoOverrides.premium } : {}),
  }
  const configuredAuto: Record<AgentModelTier, AgentModelEntry> = {
    economy: resolveModelEntry(configuredTiers.economy),
    standard: resolveModelEntry(configuredTiers.standard),
    premium: resolveModelEntry(configuredTiers.premium),
  }
  const configuredBasic = resolveModelEntry(
    modeOverrides.basic || resolveAgentModeDefault('basic'),
  )
  const configuredAdvanced = resolveModelEntry(
    modeOverrides.advanced || resolveAgentModeDefault('advanced'),
  )
  const safeBasic = resolveModelEntry(SAFE_BASIC_MODEL)

  // The fallback order is deliberate: prefer the configured economy tier,
  // then the configured basic model, then the known economy-safe model.
  const fallback = await firstAccessible(workspaceId, [
    configuredAuto.economy,
    configuredBasic,
    safeBasic,
  ])

  const autoTiers = {} as Record<AgentModelTier, AgentModelEntry>
  for (const tier of AUTO_TIERS) {
    autoTiers[tier] = (await isModelAccessibleForWorkspace(workspaceId, configuredAuto[tier].id))
      ? configuredAuto[tier]
      : fallback
  }

  const basic = (await isModelAccessibleForWorkspace(workspaceId, configuredBasic.id))
    ? configuredBasic
    : fallback
  const advanced = (await isModelAccessibleForWorkspace(workspaceId, configuredAdvanced.id))
    ? configuredAdvanced
    : fallback

  return {
    basic: basic.id,
    advanced: advanced.id,
    defaultMode: await readDefaultMode(),
    autoTiers,
    hasAdvancedModelAccess: await billingService.hasAdvancedModelAccess(workspaceId),
  }
}

export function serializeAutoTierMapEnv(
  autoTiers: Partial<Record<AgentModelTier, AgentModelEntry>>,
): string | undefined {
  const out: Partial<Record<AgentModelTier, AgentModelEntry>> = {}
  for (const tier of AUTO_TIERS) {
    const entry = autoTiers[tier]
    if (!entry?.id?.trim()) continue
    out[tier] = {
      id: entry.id.trim(),
      ...(entry.provider ? { provider: entry.provider } : {}),
    }
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : undefined
}

/**
 * Resolve the env for a newly spawned runtime.
 *
 * In local cloud-forwarding mode, the connected cloud is authoritative. If
 * it cannot be reached, retain the local settings as a safe availability
 * fallback so a transient outage does not prevent runtime startup.
 */
export async function resolveAgentModelEnv(workspaceId = 'local-dev'): Promise<AgentModelEnv> {
  const cloudDefaults = await fetchCloudAgentModelDefaults()
  if (cloudDefaults) {
    const autoTierMap = serializeAutoTierMapEnv(cloudDefaults.autoTiers)
    if (autoTierMap) {
      return {
        AGENT_BASIC_MODEL: cloudDefaults.basic,
        AGENT_ADVANCED_MODEL: cloudDefaults.advanced,
        AGENT_AUTO_TIER_MAP: autoTierMap,
      }
    }
  }

  const localDefaults = await resolveEffectiveAgentModelDefaults(workspaceId)
  return {
    AGENT_BASIC_MODEL: localDefaults.basic,
    AGENT_ADVANCED_MODEL: localDefaults.advanced,
    AGENT_AUTO_TIER_MAP: serializeAutoTierMapEnv(localDefaults.autoTiers) as string,
  }
}
