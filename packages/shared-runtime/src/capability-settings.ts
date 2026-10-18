// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Capability toggles stored on `Project.settings` and mirrored into the
 * agent runtime's `config.json`.
 *
 * `Project.settings` is the source of truth. The runtime pulls these keys
 * and writes them into `config.json` as a last-known cache. Most toggles
 * are on unless explicitly false; the keys in `OPT_IN_KEYS` are off unless
 * explicitly true. `heartbeatEnabled` is the pre-split name of
 * `heartbeatToolsEnabled`.
 */

export const CAPABILITY_KEYS = [
  'canvasEnabled',
  'webEnabled',
  'browserEnabled',
  'shellEnabled',
  'heartbeatToolsEnabled',
  'imageGenEnabled',
  'videoGenEnabled',
  'threeDGenEnabled',
  'memoryEnabled',
  'quickActionsEnabled',
  'sdkGuideEnabled',
  'integrationsEnabled',
  'channelsEnabled',
  'gitWorktreesEnabled',
  'socialMediaEnabled',
  'socialInstagramEnabled',
  'socialTiktokEnabled',
  'teamChatEnabled',
  'boardsEnabled',
  'boardAdminEnabled',
  'workTriggersEnabled',
  'companyOpsEnabled',
  'problemsEnabled',
] as const

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number]

export type CapabilitySettings = Record<CapabilityKey, boolean>

/** Human label and the tools (or prompt section) a toggle controls. */
export const CAPABILITY_INFO: Record<CapabilityKey, { label: string; summary: string }> = {
  canvasEnabled: {
    label: 'Canvas',
    summary: 'Visual canvas mode and the canvas prompt guide. Turning this off sets activeMode to "none"; turning it on sets activeMode to "canvas".',
  },
  webEnabled: {
    label: 'Web search',
    summary: 'Gates the `web` tool.',
  },
  browserEnabled: {
    label: 'Browser control',
    summary: 'Gates the `browser` tool and the browser guide.',
  },
  shellEnabled: {
    label: 'Shell',
    summary: 'Gates `exec` and `exec_wait`.',
  },
  heartbeatToolsEnabled: {
    label: 'Heartbeat',
    summary: 'Gates `heartbeat_configure` and `heartbeat_status`.',
  },
  imageGenEnabled: {
    label: 'Image generation',
    summary: 'Gates `generate_image`, `upscale_image`, and `remove_background`.',
  },
  videoGenEnabled: {
    label: 'Video generation',
    summary: 'Opt-in. Gates `generate_video`. Video is billed per second of output.',
  },
  threeDGenEnabled: {
    label: '3D generation',
    summary:
      'Opt-in. Gates `generate_3d_model` and `edit_3d_model` (text/image/multiview → GLB, plus texture, convert, retopology, rig and animation). Each task is billed, roughly $0.10-$0.60.',
  },
  memoryEnabled: {
    label: 'Memory',
    summary: 'Gates `memory_read` and `memory_search`.',
  },
  quickActionsEnabled: {
    label: 'Quick actions',
    summary: 'Gates `quick_action` and the quick-action guide.',
  },
  sdkGuideEnabled: {
    label: 'Shogo SDK guide',
    summary: 'Prompt-only. Includes the `@shogo-ai/sdk` reference. No tool is removed.',
  },
  integrationsEnabled: {
    label: 'Integrations',
    summary: 'Gates `search_integrations`, `connect`, and `disconnect`.',
  },
  channelsEnabled: {
    label: 'Channels',
    summary: 'Gates `channel_connect`, `channel_disconnect`, `channel_list`, and `send_message`.',
  },
  gitWorktreesEnabled: {
    label: 'Git worktrees',
    summary: 'Opt-in. Gates `worktree_list` and per-chat git worktrees.',
  },
  socialMediaEnabled: {
    label: 'Social media',
    summary: 'Opt-in. Gates the `social_media` tool.',
  },
  socialInstagramEnabled: {
    label: 'Instagram',
    summary: 'When social media is on, allows Instagram lookups through `social_media`.',
  },
  socialTiktokEnabled: {
    label: 'TikTok',
    summary: 'When social media is on, allows TikTok lookups through `social_media`.',
  },
  teamChatEnabled: {
    label: 'Team chat',
    summary: 'Gates the `team_chat_*` tools, `team_directory`, `member_activity`, and `fetch_chat_files`.',
  },
  boardsEnabled: {
    label: 'Boards',
    summary: 'Gates working cards: `board_list`, `board_summary`, `board_health`, and the `work_item_*` tools. When off, the agent cannot be a card assignee or column agent.',
  },
  boardAdminEnabled: {
    label: 'Board management',
    summary: 'Opt-in. Gates board structure: `board_create`, `board_update`, `board_archive`, `board_reorder`, and `column_*`. Also lets `system_apply` change `boards`.',
  },
  workTriggersEnabled: {
    label: 'Triggers',
    summary: 'Gates `trigger_create`, `trigger_update`, `trigger_delete`, and `trigger_test`, including the work item target. `trigger_list` and `trigger_types_list` stay available.',
  },
  companyOpsEnabled: {
    label: 'Company operations',
    summary: 'Opt-in. Board sweeps, digests and escalation on heartbeat (the company-ops skill). Needs Heartbeat and Boards on.',
  },
  problemsEnabled: {
    label: 'Problems',
    summary: 'Opt-in. Gates `problem_occurrences` and `problem_report`, and the problem lifecycle on problem boards.',
  },
}

/** Off unless the stored value is exactly `true`. */
export const OPT_IN_KEYS: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>([
  'videoGenEnabled',
  'threeDGenEnabled',
  'gitWorktreesEnabled',
  'socialMediaEnabled',
  'boardAdminEnabled',
  'companyOpsEnabled',
  'problemsEnabled',
])

/** Opt-ins the workspace agent's anchor project starts with, so it can set up and run the company. */
export const WORKSPACE_AGENT_CAPABILITY_DEFAULTS: Partial<CapabilitySettings> = {
  boardAdminEnabled: true,
  companyOpsEnabled: true,
  problemsEnabled: true,
}

/** Capabilities that only do anything when these others are on too. */
export const CAPABILITY_REQUIRES: Partial<Record<CapabilityKey, CapabilityKey[]>> = {
  boardAdminEnabled: ['boardsEnabled'],
  companyOpsEnabled: ['heartbeatToolsEnabled', 'boardsEnabled'],
  problemsEnabled: ['boardsEnabled'],
}

/** Required capabilities that are off, per enabled key that needs them. */
export function missingCapabilityRequirements(caps: CapabilitySettings): Array<{ key: CapabilityKey; missing: CapabilityKey[] }> {
  const out: Array<{ key: CapabilityKey; missing: CapabilityKey[] }> = []
  for (const [key, needs] of Object.entries(CAPABILITY_REQUIRES) as Array<[CapabilityKey, CapabilityKey[]]>) {
    if (!caps[key]) continue
    const missing = needs.filter((n) => !caps[n])
    if (missing.length) out.push({ key, missing })
  }
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `Project.settings` is sometimes stored as a JSON string (a jsonb string
 * scalar) rather than an object. Unwrap that before reading keys.
 */
function asSettingsObject(settings: unknown): Record<string, unknown> {
  let value = settings
  for (let depth = 0; typeof value === 'string' && depth < 5; depth++) {
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  return isPlainObject(value) ? value : {}
}

/**
 * Resolve every capability toggle from a `Project.settings` value.
 * Missing, unparseable, or non-object values fall through to the defaults.
 */
export function normalizeCapabilitySettings(settings: unknown): CapabilitySettings {
  const raw = asSettingsObject(settings)
  const out = {} as CapabilitySettings
  for (const key of CAPABILITY_KEYS) {
    if (key === 'heartbeatToolsEnabled') {
      const value = raw.heartbeatToolsEnabled ?? raw.heartbeatEnabled
      out[key] = value !== false
      continue
    }
    out[key] = OPT_IN_KEYS.has(key) ? raw[key] === true : raw[key] !== false
  }
  return out
}

/**
 * Overlay the normalized capability toggles onto a `config.json` object.
 * Only `CAPABILITY_KEYS` change; everything else is preserved. Returns
 * `changed: false` when the cache already matches.
 */
export function mergeCapabilitySettingsIntoConfig(
  fileConfig: Record<string, unknown>,
  settings: unknown,
): { config: Record<string, unknown>; changed: boolean } {
  const caps = normalizeCapabilitySettings(settings)
  const next: Record<string, unknown> = { ...fileConfig }
  let changed = false
  for (const key of CAPABILITY_KEYS) {
    if (next[key] !== caps[key]) {
      next[key] = caps[key]
      changed = true
    }
  }
  return { config: next, changed }
}
