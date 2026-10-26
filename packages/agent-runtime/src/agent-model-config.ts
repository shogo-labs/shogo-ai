// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `AgentConfig.modelName` → this runtime's `config.json` `model.name`.
 *
 * The database owns a project's model: `PATCH /api/internal/projects/:id/config`
 * writes `AgentConfig.modelName`, and the channel dispatcher reads it per turn
 * (`resolveAgentRunModel`). Pipeline (`project_call`), heartbeat, schedule and
 * webhook turns have no dispatcher — they take their model from `config.json`,
 * which used to be written once at spawn and never re-synced, so a model change
 * only landed after a restart (SHO-145). `syncCapabilitiesFromApi` now merges
 * this snapshot alongside the capability toggles it already pulls.
 */

/** `AgentConfig.modelName` when nobody chose a model for the project. Mirrors
 *  `DEFAULT_AGENT_MODEL` in apps/api/src/services/agent-run-model.service.ts:
 *  a project that still carries it runs on Auto, so caching it as a concrete
 *  model would pin the runtime to a model the app never chose. */
const LEGACY_DEFAULT_AGENT_MODEL = 'claude-haiku-4-5'

const AUTO_MODEL = 'auto'

/** The model fields the API returns for a project's agent. */
export interface AgentModelSnapshot {
  modelName?: string | null
  modelProvider?: string | null
}

/**
 * The alias `config.json` should carry for a stored `AgentConfig.modelName`.
 * Null means "the value expresses no choice" — a missing or blank column, which
 * the caller must not treat as a model called `""`.
 */
export function agentModelAliasForConfig(modelName: unknown): string | null {
  if (typeof modelName !== 'string') return null
  const name = modelName.trim()
  if (!name) return null
  return name === AUTO_MODEL || name === LEGACY_DEFAULT_AGENT_MODEL ? AUTO_MODEL : name
}

/**
 * Merge the DB's model into a `config.json`-shaped object, keeping every other
 * key (including `model.thinkingLevel`) untouched. Returns the input object
 * unchanged when it already agrees, so a sync with nothing to say never
 * rewrites the file.
 */
export function mergeAgentModelIntoConfig<T extends Record<string, any>>(
  fileConfig: T,
  agent: AgentModelSnapshot | null | undefined,
): { config: T; changed: boolean } {
  const name = agentModelAliasForConfig(agent?.modelName)
  const provider = typeof agent?.modelProvider === 'string' && agent.modelProvider.trim()
    ? agent.modelProvider.trim()
    : null
  if (name === null && provider === null) return { config: fileConfig, changed: false }

  const current = (fileConfig.model ?? {}) as Record<string, unknown>
  if (current.name === (name ?? current.name) && current.provider === (provider ?? current.provider)) {
    return { config: fileConfig, changed: false }
  }
  return {
    config: {
      ...fileConfig,
      model: {
        ...current,
        ...(name !== null ? { name } : {}),
        ...(provider !== null ? { provider } : {}),
      },
    },
    changed: true,
  }
}
