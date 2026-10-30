// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The model a heartbeat tick runs on (SHO-178 Part 2).
 *
 * A heartbeat used to take whatever `session.modelOverride || config.model.name`
 * happened to be, and `config.model.name` defaults to `auto` — so the Auto
 * router scored a tick like any other turn and, once the shared `heartbeat`
 * transcript had grown for a few days, scored it as premium. A tick that reads
 * a checklist and answers "HEARTBEAT_OK" was billing at Sonnet prices.
 *
 * So a tick now picks its model on purpose, from an explicit ladder:
 *
 *   1. `agent_configs.modelName` — the model a person chose for this project.
 *   2. `config.json`'s `model` — the runtime's cached choice, for runtimes with
 *      no API to ask (local/offline) or a project whose row has no model yet.
 *   3. the platform default — the admin-configured cheap tier (Hoshi 2.0 in
 *      production). NEVER `auto`: Auto is exactly what escalated ticks.
 *
 * The resolved model and which rung it came from are logged on every tick, so
 * "why is this project's heartbeat on that model" is observable rather than
 * inferred from a bill.
 */

import { agentModelAliasForConfig } from './agent-model-config'

/** Where a tick's model came from. Logged on every tick. */
export type HeartbeatModelSource = 'agent_config' | 'runtime_config' | 'platform_default'

export interface HeartbeatModelChoice {
  /** A concrete model id — never `auto`. */
  id: string
  /** Provider for `id`; '' when nothing could infer one (the caller infers). */
  provider?: string
  source: HeartbeatModelSource
}

/**
 * The platform default when the runtime was told no Auto tier map at all.
 * Hoshi 2.0's public alias — the same id `DEFAULT_ASSISTANT_MODEL` uses in the
 * API. In practice `AGENT_AUTO_TIER_MAP` is always injected and its economy
 * tier wins, so this is the offline/local fallback.
 */
export const PLATFORM_DEFAULT_HEARTBEAT_MODEL = 'hoshi-2-0'

export interface ResolveHeartbeatModelInput {
  /** `AgentConfig.modelName` for the project this tick is for. */
  agentModelName?: string | null
  /** `AgentConfig.modelProvider`, paired with `agentModelName`. */
  agentModelProvider?: string | null
  /** The runtime's cached `config.json` model. */
  runtimeModel?: { name?: string | null; provider?: string | null } | null
  /**
   * The admin-configured Auto *economy* tier — the platform's cheap model, with
   * the provider hint the API resolved for it. Absent on a runtime that was
   * given no tier map.
   */
  economyTier?: { id: string; provider?: string } | null
}

/**
 * A stored `modelName` only expresses a choice when it names a concrete model:
 * a blank column, `auto` and the legacy `claude-haiku-4-5` default all mean
 * "nobody chose", and `agentModelAliasForConfig` already encodes that.
 */
function concreteAlias(modelName: unknown): string | null {
  const alias = agentModelAliasForConfig(modelName)
  return alias && alias !== 'auto' ? alias : null
}

function concreteProvider(provider: unknown): string | undefined {
  return typeof provider === 'string' && provider.trim() ? provider.trim() : undefined
}

export function resolveHeartbeatModel(input: ResolveHeartbeatModelInput): HeartbeatModelChoice {
  const configured = concreteAlias(input.agentModelName)
  if (configured) {
    return { id: configured, provider: concreteProvider(input.agentModelProvider), source: 'agent_config' }
  }

  const runtime = concreteAlias(input.runtimeModel?.name)
  if (runtime) {
    return { id: runtime, provider: concreteProvider(input.runtimeModel?.provider), source: 'runtime_config' }
  }

  const economy = input.economyTier?.id?.trim()
  if (economy) {
    return {
      id: economy,
      provider: concreteProvider(input.economyTier?.provider),
      source: 'platform_default',
    }
  }

  return { id: PLATFORM_DEFAULT_HEARTBEAT_MODEL, source: 'platform_default' }
}

/** One-line log for a tick's model decision. */
export function formatHeartbeatModelLog(choice: HeartbeatModelChoice): string {
  const provider = choice.provider ? ` provider=${choice.provider}` : ''
  return `Heartbeat model: ${choice.id} (source=${choice.source})${provider}`
}
