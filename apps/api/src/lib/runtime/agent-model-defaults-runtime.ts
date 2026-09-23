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
  const cloud = await import(new URL('./agent-model-defaults.ts', import.meta.url).href)
  cloudResolver = cloud.resolveAgentModelEnv
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

export async function resolveAgentModelEnv(workspaceId = 'local-dev'): Promise<AgentModelEnv> {
  return cloudResolver?.(workspaceId) ?? localModelEnv()
}
