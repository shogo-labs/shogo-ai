// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

export type AgentModelEnv = {
  AGENT_BASIC_MODEL: string
  AGENT_ADVANCED_MODEL: string
  AGENT_AUTO_TIER_MAP: string
  AGENT_DEEPSEEK_MODEL_IDS?: string
}

type CloudResolver = (workspaceId?: string) => Promise<AgentModelEnv>
let cloudResolver: CloudResolver | null = null
if (process.env.SHOGO_LOCAL_MODE !== 'true') {
  const cloud = await import('./agent-model-defaults')
  cloudResolver = cloud.resolveAgentModelEnv
}

/** An explicit local LLM is authoritative — never override it with cloud ids. */
function hasLocalLlmOverride(): boolean {
  return Boolean(process.env.LOCAL_LLM_BASE_URL && process.env.LOCAL_LLM_BASIC_MODEL?.trim())
}

function localModelEnv(): AgentModelEnv {
  const basic = process.env.LOCAL_LLM_BASIC_MODEL?.trim() || process.env.AGENT_BASIC_MODEL || 'claude-haiku-4-5-20251001'
  const advanced =
    process.env.LOCAL_LLM_ADVANCED_MODEL?.trim() ||
    process.env.AGENT_ADVANCED_MODEL ||
    basic
  const provider = process.env.LOCAL_LLM_BASE_URL ? 'local' : undefined
  const autoTierMap = JSON.stringify({
    economy: { id: basic, ...(provider ? { provider } : {}) },
    standard: { id: advanced, ...(provider ? { provider } : {}) },
    premium: { id: advanced, ...(provider ? { provider } : {}) },
  })
  return {
    AGENT_BASIC_MODEL: basic,
    AGENT_ADVANCED_MODEL: advanced,
    AGENT_AUTO_TIER_MAP: autoTierMap,
  }
}

/**
 * Local mode still has a cloud account on cloud-proxy desktop installs, and
 * that account is authoritative for Auto tier models.
 *
 * `fetchCloudAgentModelDefaults()` is itself local-mode-only (`if (!isLocalMode())
 * return null`), so it cannot live behind the `cloudResolver` branch above —
 * that branch only runs when we are NOT in local mode, which made the two
 * conditions mutually exclusive and left desktop pinned to the hardcoded
 * `localModelEnv()` id for every tier.
 *
 * `lib/federated-upstream` imports only `prisma` + `cloud-urls`, so pulling it
 * in keeps the slim local bundle guardrail in `scripts/check-api-local-bundle.ts`
 * intact (`agent-model-defaults.ts` stays out — it reaches Stripe via
 * `billing.service`).
 */
async function cloudConfiguredModelEnv(): Promise<AgentModelEnv | null> {
  try {
    const { fetchCloudAgentModelDefaults } = await import('../federated-upstream')
    const defaults = await fetchCloudAgentModelDefaults()
    if (!defaults?.basic || !defaults.advanced || !defaults.autoTiers) return null
    const { economy, standard, premium } = defaults.autoTiers
    if (!economy?.id || !standard?.id || !premium?.id) return null
    return {
      AGENT_BASIC_MODEL: defaults.basic,
      AGENT_ADVANCED_MODEL: defaults.advanced,
      AGENT_AUTO_TIER_MAP: JSON.stringify({ economy, standard, premium }),
      ...(defaults.deepseekModelIds?.length
        ? { AGENT_DEEPSEEK_MODEL_IDS: defaults.deepseekModelIds.join(',') }
        : {}),
    }
  } catch {
    // Cloud unreachable / not signed in — fall back to the static local env
    // rather than blocking runtime startup.
    return null
  }
}

export async function resolveAgentModelEnv(workspaceId = 'local-dev'): Promise<AgentModelEnv> {
  if (cloudResolver) return cloudResolver(workspaceId)
  if (hasLocalLlmOverride()) return localModelEnv()
  return (await cloudConfiguredModelEnv()) ?? localModelEnv()
}
