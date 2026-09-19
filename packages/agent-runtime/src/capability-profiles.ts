// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Single source of truth for what a workspace's capability profile can do.
 *
 * Before this file existed, "what can a personal workspace do?" was answered
 * in four different places that could drift independently: `gateway.ts`'s
 * `loadConfig()` defaults/overrides, `gateway-tools.ts`'s
 * `PERSONAL_DISABLED_TOOL_NAMES` name-based deny-list, `workspace-defaults.ts`'s
 * `seedPersonalCompanionTemplate()` (which wrote the same policy keys into
 * `config.json`), and the `personal-companion` template's `config.json`
 * itself. A new tool added to `gateway-tools.ts` was silently ENABLED for
 * personal workspaces unless someone remembered to add it to the deny-list
 * by name.
 *
 * This module is the one place that answers both questions:
 *   - which TOOL GROUPS are off for a profile (`CAPABILITY_PROFILES`), and
 *   - which individual tool names exist and what group(s) they belong to,
 *     for PROFILE purposes (`PROFILE_TOOL_GROUPS`, `CORE_TOOL_NAMES`).
 *
 * `gateway-tools.ts` imports `disabledToolNamesForProfile` for profile-based
 * gating in `filterDisabledCapabilityTools`. `gateway.ts`'s `loadConfig()`
 * calls `applyCapabilityProfile` instead of re-deriving the same four
 * fields. `capability-tool-classification.test.ts` asserts every tool
 * `createTools()` can register is classified into `PROFILE_TOOL_GROUPS` or
 * `CORE_TOOL_NAMES`, so an unclassified new tool fails CI instead of
 * silently leaking into the personal profile.
 *
 * NOTE: this is deliberately a SEPARATE map from `gateway-tools.ts`'s
 * `TOOL_GROUP_MAP` (feature-flag groups like `web`/`shell`/`heartbeat`, used
 * for `webEnabled`/`shellEnabled`/... toggles AND validated elsewhere to be
 * a subset of `ALL_TOOL_NAMES`, the tool names skills may declare as
 * dependencies). Conflating the two would force privileged/internal tools
 * (`checkpoint`, `agent_spawn`, `system_apply`, ...) into the
 * skill-resolvable namespace just to satisfy that unrelated invariant.
 *
 * This file has NO imports from `gateway-tools.ts` / `project-tools.ts` /
 * `workspace-agent-tools.ts` — it is intentionally the lowest layer, so
 * those modules can depend on it without a cycle.
 */

export type CapabilityProfileName = 'team' | 'personal'

/**
 * Tool-group bundles used ONLY for capability-profile classification (see
 * module doc). A tool may appear in more than one group — groups are a
 * convenience for profile gating, not a strict partition.
 */
export const PROFILE_TOOL_GROUPS: Record<string, string[]> = {
  shell: ['exec', 'exec_wait', 'exec_list', 'terminal_exec', 'terminal_read'],
  // Deeper code-review/verification tools. Personal workspaces disable
  // these along with `builder` — there is no builder code of the
  // companion's own to review.
  code_review: ['impact_radius', 'detect_changes', 'review_context', 'read_lints', 'server_sync'],
  // Editing/running the agent's OWN runtime workspace: checkpoints,
  // publishing, plan mutation, canvas/system state. Personal workspaces
  // disable this whole bundle — they delegate real software work to the
  // `project_*` tools (a *hidden* builder project) instead of building in
  // their own runtime.
  builder: [
    'checkpoint', 'publish', 'create_plan', 'update_plan', 'system_apply',
    'canvas_create', 'canvas_update', 'canvas_delete', 'canvas_publish', 'canvas_preview',
  ],
  // Composing MULTIPLE projects into one workspace runtime (attach/detach,
  // mount-for-preview). `project_create` / `project_call` / `project_list` /
  // `project_configure` are deliberately NOT in this group — those stay
  // enabled for personal workspaces (one hidden builder project per goal,
  // delegated to rather than composed alongside).
  project_composition: [
    'project_attach', 'project_detach', 'list_projects', 'mount_project', 'unmount_project', 'preview_project',
  ],
  // Multi-agent orchestration: spawning subagents, teams, cross-agent tasks.
  orchestration: [
    'agent_create', 'agent_spawn', 'agent_status', 'agent_cancel', 'agent_result', 'agent_list',
    'team_create', 'team_delete', 'task_create', 'task_get', 'task_list', 'task_update', 'send_team_message',
  ],
  // Standard file/web/messaging/etc. tools every profile keeps; broken out
  // so the classification test can verify 100% coverage without lumping
  // everything into CORE_TOOL_NAMES.
  files: ['read_file', 'write_file', 'edit_file', 'delete_file', 'search'],
  web: ['web', 'browser'],
  memory: ['memory_read', 'memory_search'],
  messaging: ['send_message', 'channel_connect', 'channel_disconnect', 'channel_list'],
  heartbeat: ['heartbeat_configure', 'heartbeat_status'],
  integrations: ['search_integrations', 'connect', 'disconnect'],
  audio: ['transcribe_audio'],
  planning: ['todo_write'],
}

/**
 * Individual tool names always classified regardless of profile — the
 * conversation plumbing, universal workspace-agent primitives (profile /
 * goals), and the project-delegation subset every profile keeps. Existing
 * per-capability feature flags (`imageGenEnabled`, `memoryEnabled`, …) can
 * still remove these; `CAPABILITY_PROFILES` never does.
 */
export const CORE_TOOL_NAMES = [
  'ask_user', 'notify_user_error', 'skill', 'quick_action', 'generate_image',
  'search_history', 'read_history', 'read_guide', 'worktree_list',
  'project_list', 'project_create', 'project_call', 'project_configure',
  'agent_profile_get', 'agent_profile_set', 'goal_create', 'goal_update', 'goal_log', 'goal_list', 'set_status',
]

export interface CapabilityProfile {
  /** Tool GROUPS (keys of `PROFILE_TOOL_GROUPS`) unavailable in this profile. */
  disabledToolGroups: string[]
  /** Individual tool names unavailable in this profile, beyond the disabled groups. */
  disabledToolNames: string[]
  activeMode: 'canvas' | 'none'
  allowedModes: Array<'canvas' | 'none'>
  shellEnabled: boolean
}

export const CAPABILITY_PROFILES: Record<CapabilityProfileName, CapabilityProfile> = {
  team: {
    disabledToolGroups: [],
    disabledToolNames: [],
    activeMode: 'canvas',
    allowedModes: ['canvas', 'none'],
    shellEnabled: true,
  },
  personal: {
    disabledToolGroups: ['shell', 'code_review', 'builder', 'project_composition', 'orchestration'],
    disabledToolNames: [],
    activeMode: 'none',
    allowedModes: ['none'],
    shellEnabled: false,
  },
}

/** Resolve a profile's disabled groups + names to a flat set of tool names. */
export function disabledToolNamesForProfile(profile: CapabilityProfileName): Set<string> {
  const config = CAPABILITY_PROFILES[profile]
  const names = new Set<string>(config.disabledToolNames)
  for (const group of config.disabledToolGroups) {
    for (const name of PROFILE_TOOL_GROUPS[group] ?? []) names.add(name)
  }
  return names
}

/**
 * Apply a capability profile's mode/shell policy on top of an already
 * user-merged raw config. Team workspaces keep whatever the raw config (or
 * its own defaults) already resolved to; personal workspaces are FORCED to
 * the personal profile's values so a `config.json` edit can never regain
 * builder tools or a visual mode. This is `gateway.ts loadConfig()`'s single
 * call site for "what does this profile force?" — see that function for the
 * merge order with `raw`/`defaults`.
 */
export function applyCapabilityProfile<
  T extends {
    capabilityProfile?: CapabilityProfileName
    activeMode?: string
    allowedModes?: string[]
    shellEnabled?: boolean
  },
>(raw: T, profile: CapabilityProfileName): T {
  if (profile !== 'personal') return raw
  const p = CAPABILITY_PROFILES.personal
  return {
    ...raw,
    capabilityProfile: 'personal',
    activeMode: p.activeMode,
    allowedModes: p.allowedModes,
    shellEnabled: p.shellEnabled,
  }
}
