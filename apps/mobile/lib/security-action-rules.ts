// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-tool rules for what an agent may do without asking:
 * allow (just do it), ask (wait for a person), block (never).
 * Mirrors the agent runtime's `overrides.actions`.
 */
import type { SecurityPrefs } from './api'

export type ActionRule = 'allow' | 'ask' | 'block'

export const ACTION_RULES: readonly ActionRule[] = ['allow', 'ask', 'block']

export const RULE_LABEL: Record<ActionRule, string> = { allow: 'Allow', ask: 'Ask first', block: 'Block' }

/** Tools worth showing even before anyone sets a rule, with the rule they have by default. */
export const SUGGESTED_TOOLS: ReadonlyArray<{ tool: string; label: string; defaultRule: ActionRule }> = [
  { tool: 'github_merge_pr', label: 'Merge pull requests', defaultRule: 'ask' },
]

export function actionRules(prefs: Pick<SecurityPrefs, 'overrides'>): Record<string, ActionRule> {
  const raw = prefs.overrides?.actions
  const out: Record<string, ActionRule> = {}
  for (const [tool, rule] of Object.entries(raw ?? {})) {
    if (tool && (ACTION_RULES as readonly string[]).includes(rule)) out[tool] = rule as ActionRule
  }
  return out
}

/** Set a tool's rule, or clear it (back to the default) with `null`. */
export function withActionRule(prefs: SecurityPrefs, tool: string, rule: ActionRule | null): SecurityPrefs {
  const name = tool.trim()
  if (!name) return prefs
  const actions = actionRules(prefs)
  if (rule) actions[name] = rule
  else delete actions[name]
  return { ...prefs, overrides: { ...prefs.overrides, actions } }
}

/** The rule in force for a tool: what was set, else the built-in default, else none. */
export function effectiveRule(prefs: Pick<SecurityPrefs, 'overrides'>, tool: string): ActionRule | null {
  return actionRules(prefs)[tool] ?? SUGGESTED_TOOLS.find((t) => t.tool === tool)?.defaultRule ?? null
}
