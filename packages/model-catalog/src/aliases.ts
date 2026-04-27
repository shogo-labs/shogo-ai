// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ModelId, AgentMode } from './models'

// ---------------------------------------------------------------------------
// Convenience aliases — map shorthand names to canonical model IDs
// ---------------------------------------------------------------------------

export const MODEL_ALIASES: Record<string, ModelId> = {
  // Current-generation Anthropic aliases
  'claude-opus': 'claude-opus-4-7',
  'claude-sonnet': 'claude-sonnet-4-6',
  'claude-haiku': 'claude-haiku-4-5-20251001',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',

  // Legacy Anthropic aliases
  'claude-sonnet-4-5': 'claude-sonnet-4-5-20250929',
  'claude-opus-4-5': 'claude-opus-4-5-20251101',
  'claude-opus-4-1': 'claude-opus-4-1-20250805',
  'claude-sonnet-4-0': 'claude-sonnet-4-20250514',
  'claude-sonnet-4': 'claude-sonnet-4-20250514',
  'claude-3-7-sonnet-latest': 'claude-3-7-sonnet-20250219',
  'claude-opus-4-0': 'claude-opus-4-20250514',
  'claude-opus-4': 'claude-opus-4-20250514',

  // Eval shorthand aliases
  'haiku': 'claude-haiku-4-5-20251001',
  'sonnet': 'claude-sonnet-4-6',
  'opus': 'claude-opus-4-7',
  'gpt54mini': 'gpt-5.4-mini',
}

// ---------------------------------------------------------------------------
// Agent mode defaults (basic / advanced → concrete model)
// ---------------------------------------------------------------------------

export const AGENT_MODE_DEFAULTS: Record<AgentMode, ModelId> = {
  basic: 'claude-haiku-4-5-20251001',
  advanced: 'claude-sonnet-4-6',
}

// Runtime overrides set by admin — checked before AGENT_MODE_DEFAULTS.
let _agentModeOverrides: Partial<Record<AgentMode, string>> = {}

export function setAgentModeOverrides(overrides: Partial<Record<AgentMode, string>>): void {
  _agentModeOverrides = { ...overrides }
}

export function getAgentModeOverrides(): Partial<Record<AgentMode, string>> {
  return { ..._agentModeOverrides }
}

export function resolveAgentModeDefault(mode: AgentMode): string {
  return _agentModeOverrides[mode] || AGENT_MODE_DEFAULTS[mode]
}
