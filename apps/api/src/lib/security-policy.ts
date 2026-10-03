// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Security policy handed to an agent runtime (`SECURITY_POLICY`, base64 JSON).
 *
 * Local mode merges the user's preference with the project's override. Cloud
 * runtimes only enforce the project's per-tool action rules and deny lists:
 * "ask before merging", "never run this tool".
 */

export type ActionRule = 'allow' | 'ask' | 'block'

const RANK: Record<ActionRule, number> = { allow: 0, ask: 1, block: 2 }
const TIER_RANK: Record<string, number> = { strict: 0, balanced: 1, full_autonomy: 2 }

/** People have this long to answer an approval card in a channel. */
export const CLOUD_APPROVAL_TIMEOUT_SECONDS = 900

export function normalizeActions(value: unknown): Record<string, ActionRule> {
  const out: Record<string, ActionRule> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [tool, rule] of Object.entries(value as Record<string, unknown>)) {
    if (tool && (rule === 'allow' || rule === 'ask' || rule === 'block')) out[tool] = rule
  }
  return out
}

/** Union of two rule sets; the stricter rule wins where both name a tool. */
export function mergeActions(a: unknown, b: unknown): Record<string, ActionRule> {
  const out = normalizeActions(a)
  for (const [tool, rule] of Object.entries(normalizeActions(b))) {
    const have = out[tool]
    out[tool] = have && RANK[have] >= RANK[rule] ? have : rule
  }
  return out
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : []

export function encodePolicy(policy: unknown): string {
  return Buffer.from(JSON.stringify(policy)).toString('base64')
}

/**
 * The effective policy for a local runtime. Mode and shell deny lists follow
 * the existing rule (a project can only lower the mode, and only when it sets
 * one); per-tool action rules always combine, stricter wins.
 */
export function composeLocalPolicy(userPref: any, projectSecurity: any): any {
  let effective = userPref
  if (projectSecurity?.mode) {
    const projRank = TIER_RANK[projectSecurity.mode] ?? 1
    const userRank = TIER_RANK[userPref.mode] ?? 1
    effective = { ...userPref, mode: projRank <= userRank ? projectSecurity.mode : userPref.mode }
    if (projectSecurity.overrides) {
      const deny = [...new Set([...strings(userPref.overrides?.shellCommands?.deny), ...strings(projectSecurity.overrides?.shellCommands?.deny)])]
      effective = {
        ...effective,
        overrides: {
          ...userPref.overrides,
          shellCommands: { ...userPref.overrides?.shellCommands, deny },
        },
      }
    }
  }
  const actions = mergeActions(userPref.overrides?.actions, projectSecurity?.overrides?.actions)
  if (Object.keys(actions).length) {
    effective = { ...effective, overrides: { ...effective.overrides, actions } }
  }
  return effective
}

/**
 * Policy for a cloud runtime, or null when the project configured nothing
 * (the runtime then applies only its built-in defaults).
 */
export function composeCloudPolicy(projectSecurity: any): string | null {
  const actions = normalizeActions(projectSecurity?.overrides?.actions)
  const shellDeny = strings(projectSecurity?.overrides?.shellCommands?.deny)
  const fileDeny = strings(projectSecurity?.overrides?.fileAccess?.deny)
  if (!Object.keys(actions).length && !shellDeny.length && !fileDeny.length) return null
  return encodePolicy({
    mode: 'full_autonomy',
    approvalTimeoutSeconds: CLOUD_APPROVAL_TIMEOUT_SECONDS,
    overrides: {
      ...(Object.keys(actions).length ? { actions } : {}),
      ...(shellDeny.length ? { shellCommands: { deny: shellDeny } } : {}),
      ...(fileDeny.length ? { fileAccess: { deny: fileDeny } } : {}),
    },
  })
}
