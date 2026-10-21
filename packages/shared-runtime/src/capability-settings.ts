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
  'socialManagementEnabled',
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
    summary: 'Gates `generate_image` (and `list_media_models` while no other media capability is on).',
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
    summary: 'Opt-in. Gates the `social_media` lookups (profile and recent posts) and the paid lookups behind them.',
  },
  socialManagementEnabled: {
    label: 'Social management',
    summary: 'Opt-in. Gates the management half of `social_media`: the inbox, replies, comment replies and comment→DM automations. Independent of lookups, because managing connected accounts needs no paid lookup units.',
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
  'socialManagementEnabled',
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

/**
 * Which surface a capability toggle belongs to.
 *
 * - `project` — a project's own agent, stored on `Project.settings`.
 * - `workspace` — the workspace agent (the meta-agent in a workspace chat),
 *   stored on `Workspace.settings`. It is NOT the anchor project's config:
 *   a workspace runtime serves both surfaces, and the user's toggles for one
 *   must never gate the other.
 */
export type CapabilityScope = 'project' | 'workspace'

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
 * Resolve every capability toggle for one surface. `scope` is explicit rather
 * than inferred from boot env: one process serves both surfaces (a workspace
 * runtime pinned to an anchor project serves workspace chats AND that
 * project's chats), so "is this the workspace agent?" cannot be answered from
 * env alone.
 *
 * Unset keys use the surface's default: `workspace` applies
 * `WORKSPACE_AGENT_CAPABILITY_DEFAULTS` (board admin, company ops, problems)
 * so the workspace agent can set up and run the company; `project` leaves
 * them off unless stored.
 */
export function resolveCapabilities(
  config: Record<string, unknown> & { activeMode?: string },
  opts: { scope?: CapabilityScope } = {},
): CapabilitySettings {
  const caps = normalizeCapabilitySettings(config)
  if ((opts.scope ?? 'project') === 'workspace') {
    for (const [key, value] of Object.entries(WORKSPACE_AGENT_CAPABILITY_DEFAULTS) as Array<[CapabilityKey, boolean]>) {
      if (config[key] === undefined) caps[key] = value
    }
  }
  // Canvas mode and the canvas toggle are one state. A stale toggle (e.g. an
  // anchor project's `canvasEnabled: false` synced into a workspace runtime
  // that is in canvas mode) must not render as "Canvas — off" while the agent
  // is in fact composing a canvas. The runtime's mode is authoritative.
  const mode = typeof config.activeMode === 'string' ? config.activeMode : undefined
  if (mode) caps.canvasEnabled = mode !== 'none'
  return caps
}

/**
 * Read `Workspace.settings` as an object regardless of how it was stored
 * (a JSON string scalar on Postgres, an object on SQLite).
 */
export function parseWorkspaceSettings(settings: unknown): Record<string, unknown> {
  return asSettingsObject(settings)
}

/**
 * Merge a capability patch into a `Workspace.settings` object. Keys the patch
 * does not mention are preserved untouched, so a workspace's other settings
 * survive a toggle. `activeMode` rides along with `canvasEnabled`.
 *
 * Returns the whole settings object to persist plus `changed: false` when it
 * already matches.
 */
export function mergeCapabilitySettingsIntoWorkspaceSettings(
  settings: unknown,
  patch: Partial<CapabilitySettings> & { activeMode?: 'canvas' | 'none' },
): { settings: Record<string, unknown>; changed: boolean } {
  const current = asSettingsObject(settings)
  const next: Record<string, unknown> = { ...current }
  let changed = false
  for (const key of CAPABILITY_KEYS) {
    const value = patch[key]
    if (typeof value !== 'boolean') continue
    if (next[key] !== value) {
      next[key] = value
      changed = true
    }
  }
  if (patch.activeMode && next.activeMode !== patch.activeMode) {
    next.activeMode = patch.activeMode
    changed = true
  }
  return { settings: next, changed }
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
