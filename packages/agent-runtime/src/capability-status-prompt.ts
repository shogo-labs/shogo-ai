// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tells the agent which project capabilities are on, off, or locked by the
 * workspace profile, and that `capabilities_configure` can change the ones
 * that are not locked.
 */

import {
  CAPABILITY_INFO,
  CAPABILITY_KEYS,
  WORKSPACE_AGENT_CAPABILITY_DEFAULTS,
  missingCapabilityRequirements,
  normalizeCapabilitySettings,
  type CapabilityKey,
  type CapabilitySettings,
} from '@shogo/shared-runtime/capability-settings'
import { CAPABILITY_PROFILES, type CapabilityProfileName } from './capability-profiles'
import { isWorkspaceRuntimeMode } from './workspace-runtime-mode'

/** Personal workspaces have no team channels, so these stay off there. */
const PERSONAL_LOCKED_OFF: CapabilityKey[] = ['teamChatEnabled', 'boardAdminEnabled', 'companyOpsEnabled']

/** The workspace agent: a workspace runtime not anchored on a project. */
export function isWorkspaceAgentRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return isWorkspaceRuntimeMode(env) && !env.WORKSPACE_ANCHOR_PROJECT_ID
}

/**
 * Capability toggles as this runtime applies them: stored values, the
 * workspace agent's opt-in defaults when nothing is stored, and profile locks.
 */
export function resolveRuntimeCapabilities(
  config: Record<string, unknown> & { capabilityProfile?: CapabilityProfileName },
  env: NodeJS.ProcessEnv = process.env,
): CapabilitySettings {
  const caps = normalizeCapabilitySettings(config)
  if (isWorkspaceAgentRuntime(env)) {
    for (const [key, value] of Object.entries(WORKSPACE_AGENT_CAPABILITY_DEFAULTS) as Array<[CapabilityKey, boolean]>) {
      if (config[key] === undefined) caps[key] = value
    }
  }
  for (const key of lockedCapabilityKeys(config.capabilityProfile)) {
    caps[key] = effectiveCapabilityValue(key, caps, config.capabilityProfile)
  }
  return caps
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

export function capabilityState(config: { capabilityProfile?: CapabilityProfileName }): CapabilityStateView {
  const caps = resolveRuntimeCapabilities(config as Record<string, unknown>)
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

/** Stable prompt block. Changes only when a capability toggle changes. */
export function buildCapabilityStatusSection(config: { capabilityProfile?: CapabilityProfileName }): string {
  const caps = resolveRuntimeCapabilities(config as Record<string, unknown>)
  const { enabled, disabled, locked } = capabilityState(config)
  const lines = [
    '## Project Capabilities',
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
    'You can turn these on or off for this project with `capabilities_configure`. Changes apply from your next turn. Turn on a disabled capability when the user\'s task needs it, rather than telling them it is unavailable. Do not change a locked capability.',
  )
  return lines.join('\n')
}
