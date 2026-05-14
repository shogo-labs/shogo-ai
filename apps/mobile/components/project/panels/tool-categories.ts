// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { CapabilitySettings } from './CapabilitiesPanel'

/**
 * Maps resolved tool names back to the CapabilitySettings toggle that gates
 * them. Derived from the CAPABILITIES array in CapabilitiesPanel and the
 * TOOL_GROUP_MAP in agent-runtime gateway-tools.ts.
 *
 * Only tools that have a corresponding capability toggle are listed.
 * Tools like `write_file`, `read_file`, `search`, `canvas_*` are always
 * available and don't have a user-facing capability gate.
 */
const TOOL_TO_CAPABILITY: Record<string, { key: keyof CapabilitySettings; label: string }> = {
  web:                   { key: 'webEnabled',       label: 'Web Search' },
  browser:               { key: 'browserEnabled',   label: 'Browser Control' },
  exec:                  { key: 'shellEnabled',     label: 'Shell' },
  exec_wait:             { key: 'shellEnabled',     label: 'Shell' },
  heartbeat_configure:   { key: 'heartbeatEnabled', label: 'Heartbeat' },
  heartbeat_status:      { key: 'heartbeatEnabled', label: 'Heartbeat' },
  generate_image:        { key: 'imageGenEnabled',  label: 'Image Generation' },
  memory_read:           { key: 'memoryEnabled',    label: 'Memory' },
  memory_write:          { key: 'memoryEnabled',    label: 'Memory' },
  memory_search:         { key: 'memoryEnabled',    label: 'Memory' },
  quick_action:          { key: 'quickActionsEnabled', label: 'Quick Actions' },
}

/**
 * Given a skill's list of required tool names and the current capability
 * settings, returns an array of human-readable labels for capabilities
 * that the skill needs but the user has disabled.
 *
 * Returns an empty array when all required capabilities are enabled (or
 * when the skill only uses always-on tools like write_file / canvas_*).
 */
export function findDisabledCapabilities(
  tools: string[],
  capabilities: CapabilitySettings,
): string[] {
  const seen = new Set<string>()
  const disabled: string[] = []

  for (const tool of tools) {
    const mapping = TOOL_TO_CAPABILITY[tool]
    if (!mapping) continue
    if (seen.has(mapping.key)) continue
    seen.add(mapping.key)

    if (!capabilities[mapping.key]) {
      disabled.push(mapping.label)
    }
  }

  return disabled
}
