// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tells the agent which capabilities are on, off, or locked by the workspace
 * profile, and that `capabilities_configure` can change the ones that are not
 * locked.
 *
 * There are two surfaces and the block is written for whichever one the turn
 * belongs to:
 *   - `project` — the project's own agent, toggles on `Project.settings`;
 *   - `workspace` — the workspace agent, toggles on `Workspace.settings`.
 *
 * A workspace runtime pinned to an anchor project serves BOTH, so the scope is
 * passed in per turn rather than derived from boot env (see `chatContext` on
 * the runtime message payload). Printing the anchor project's toggles as the
 * workspace agent's own was the bug this split fixes.
 */

import {
  CAPABILITY_INFO,
  CAPABILITY_KEYS,
  missingCapabilityRequirements,
  resolveCapabilities,
  type CapabilityKey,
  type CapabilityScope,
  type CapabilitySettings,
} from '@shogo/shared-runtime/capability-settings'
import { CAPABILITY_PROFILES, type CapabilityProfileName } from './capability-profiles'
import { isWorkspaceAgentRuntime } from './workspace-runtime-mode'

export { isWorkspaceAgentRuntime }
export type { CapabilityScope }

/** Personal workspaces have no team channels, so these stay off there. */
const PERSONAL_LOCKED_OFF: CapabilityKey[] = ['teamChatEnabled', 'boardAdminEnabled', 'companyOpsEnabled']

/** The scope a turn belongs to when the caller did not say. */
export function defaultCapabilityScope(env: NodeJS.ProcessEnv = process.env): CapabilityScope {
  return isWorkspaceAgentRuntime(env) ? 'workspace' : 'project'
}

/**
 * Capability toggles as this runtime applies them for one surface: stored
 * values (plus the workspace agent's opt-in defaults for workspace scope) and
 * profile locks.
 */
export function resolveCapabilitiesForScope(
  config: Record<string, unknown> & { capabilityProfile?: CapabilityProfileName },
  scope: CapabilityScope,
): CapabilitySettings {
  const caps = resolveCapabilities(config, { scope })
  for (const key of lockedCapabilityKeys(config.capabilityProfile)) {
    caps[key] = effectiveCapabilityValue(key, caps, config.capabilityProfile)
  }
  return caps
}

/**
 * Scope inferred from boot env. Kept for callers with no turn context (tool
 * registration, the boot-time capability sync); a turn must use
 * `resolveCapabilitiesForScope` with the surface it actually runs in.
 */
export function resolveRuntimeCapabilities(
  config: Record<string, unknown> & { capabilityProfile?: CapabilityProfileName },
  env: NodeJS.ProcessEnv = process.env,
): CapabilitySettings {
  return resolveCapabilitiesForScope(config, defaultCapabilityScope(env))
}

export interface CapabilityStateView {
  enabled: CapabilityKey[]
  disabled: CapabilityKey[]
  locked: CapabilityKey[]
}

/**
 * Keys a profile forces, so the agent must not try to flip them.
 * Personal workspaces cannot regain shell or canvas.
 */
export function lockedCapabilityKeys(profile: CapabilityProfileName | undefined): CapabilityKey[] {
  if (profile !== 'personal') return []
  const personal = CAPABILITY_PROFILES.personal
  const locked: CapabilityKey[] = []
  if (!personal.shellEnabled) locked.push('shellEnabled')
  if (!personal.allowedModes.includes('canvas')) locked.push('canvasEnabled')
  locked.push(...PERSONAL_LOCKED_OFF)
  return locked
}

/**
 * `config` is the runtime config, so it carries the capability toggles
 * themselves (`videoGenEnabled`, `threeDGenEnabled`, …) plus the profile.
 * `Partial` because an absent toggle means "use the default", not "disabled".
 */
export type CapabilityConfigInput = { capabilityProfile?: CapabilityProfileName } & Partial<CapabilitySettings>

export function capabilityState(
  config: CapabilityConfigInput,
  scope: CapabilityScope = defaultCapabilityScope(),
): CapabilityStateView {
  const caps = resolveCapabilitiesForScope(config as Record<string, unknown>, scope)
  const locked = new Set(lockedCapabilityKeys(config.capabilityProfile))
  const enabled: CapabilityKey[] = []
  const disabled: CapabilityKey[] = []
  const lockedKeys: CapabilityKey[] = []
  for (const key of CAPABILITY_KEYS) {
    if (locked.has(key)) lockedKeys.push(key)
    else if (caps[key]) enabled.push(key)
    else disabled.push(key)
  }
  return { enabled, disabled, locked: lockedKeys }
}

function formatCapability(key: CapabilityKey, on?: boolean): string {
  const label = `${CAPABILITY_INFO[key].label} (\`${key}\`)`
  return on === undefined ? label : `${label} — ${on ? 'on' : 'off'}`
}

/** Value the profile forces for a locked key. Unlocked keys use the stored toggle. */
export function effectiveCapabilityValue(
  key: CapabilityKey,
  caps: CapabilitySettings,
  profile: CapabilityProfileName | undefined,
): boolean {
  if (profile === 'personal') {
    if (key === 'shellEnabled') return CAPABILITY_PROFILES.personal.shellEnabled
    if (key === 'canvasEnabled') return CAPABILITY_PROFILES.personal.allowedModes.includes('canvas')
    if (PERSONAL_LOCKED_OFF.includes(key)) return false
  }
  return caps[key]
}

export interface CapabilityStatusOptions {
  /** Surface these toggles belong to. Defaults to the boot-env scope. */
  scope?: CapabilityScope
  /** Project whose toggles these are (project scope), for the title. */
  projectName?: string
  /**
   * The anchor project a workspace runtime is pinned to. Named in a separate,
   * clearly-labelled line so its toggles are never read as the workspace
   * agent's own.
   */
  anchorProjectName?: string
}

/** Stable prompt block. Changes only when a capability toggle changes. */
export function buildCapabilityStatusSection(
  config: CapabilityConfigInput,
  opts: CapabilityStatusOptions = {},
): string {
  const scope = opts.scope ?? defaultCapabilityScope()
  const caps = resolveCapabilitiesForScope(config as Record<string, unknown>, scope)
  const { enabled, disabled, locked } = capabilityState(config, scope)

  const title =
    scope === 'workspace'
      ? '## Workspace capabilities'
      : `## Project capabilities${opts.projectName ? ` (${opts.projectName})` : ''}`

  const lines = [
    title,
    '',
    `These are ${scope === 'workspace' ? "the workspace agent's own toggles, stored on the workspace." : "this project's toggles."}`,
    '',
    `Enabled: ${enabled.length > 0 ? enabled.map((key) => formatCapability(key)).join(', ') : 'none'}`,
    `Disabled: ${disabled.length > 0 ? disabled.map((key) => formatCapability(key)).join(', ') : 'none'}`,
  ]
  if (locked.length > 0) {
    lines.push(
      `Locked by the ${config.capabilityProfile} workspace profile: ${locked.map((key) => formatCapability(key, effectiveCapabilityValue(key, caps, config.capabilityProfile))).join(', ')}`,
    )
  }
  const unmet = missingCapabilityRequirements(caps)
  if (unmet.length > 0) {
    lines.push(`Needs another capability to work: ${unmet.map((u) => `${formatCapability(u.key)} needs ${u.missing.map((m) => formatCapability(m)).join(' and ')}`).join('; ')}`)
  }
  lines.push(
    '',
    scope === 'workspace'
      ? 'You can turn these on or off for the workspace with `capabilities_configure` (it uses the workspace scope here by default; pass `scope: "project"` to change a project\'s). Changes apply from your next turn. Turn on a disabled capability when the user\'s task needs it, rather than telling them it is unavailable. Do not change a locked capability.'
      : 'You can turn these on or off for this project with `capabilities_configure`. Changes apply from your next turn. Turn on a disabled capability when the user\'s task needs it, rather than telling them it is unavailable. Do not change a locked capability.',
  )
  if (scope === 'workspace' && opts.anchorProjectName) {
    lines.push(
      '',
      `Project chats run with their own toggles — the open project is **${opts.anchorProjectName}**; its capabilities are managed separately and are not the list above.`,
    )
  }
  return lines.join('\n')
}
