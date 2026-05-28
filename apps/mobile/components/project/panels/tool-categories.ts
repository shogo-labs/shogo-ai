// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

export interface ToolCategory {
  id: string
  label: string
  /** Tailwind color name, e.g. "purple" → text-purple-400, bg-purple-500/15 */
  color: string
  tools: readonly string[]
}

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  {
    id: 'web',
    label: 'Web',
    color: 'blue',
    tools: ['web'],
  },
  {
    id: 'browser',
    label: 'Browser',
    color: 'cyan',
    tools: ['browser'],
  },
  {
    id: 'shell',
    label: 'Shell',
    color: 'orange',
    tools: ['exec', 'exec_wait'],
  },
  {
    id: 'memory',
    label: 'Memory',
    color: 'emerald',
    tools: ['memory_read', 'memory_write', 'memory_search'],
  },
  {
    id: 'messaging',
    label: 'Messaging',
    color: 'sky',
    tools: ['send_message', 'channel_connect', 'channel_disconnect', 'channel_list'],
  },
  {
    id: 'discovery',
    label: 'Discovery',
    color: 'amber',
    tools: [
      'search_integrations',
      'connect',
      'disconnect',
      // Legacy names retained so historical chat turns render with the same badge
      'tool_search',
      'tool_install',
      'tool_uninstall',
      'mcp_search',
      'mcp_install',
      'mcp_uninstall',
    ],
  },
  {
    id: 'files',
    label: 'Files',
    color: 'zinc',
    tools: [
      'read_file',
      'write_file',
      'edit_file',
      'delete_file',
      'search',
      'read_lints',
      'impact_radius',
      'detect_changes',
      'review_context',
    ],
  },
  {
    id: 'heartbeat',
    label: 'Heartbeat',
    color: 'rose',
    tools: ['heartbeat_configure', 'heartbeat_status'],
  },
  {
    id: 'planning',
    label: 'Planning',
    color: 'indigo',
    tools: ['todo_write'],
  },
  {
    id: 'other',
    label: 'Other',
    color: 'zinc',
    tools: [],
  },
] as const

const TOOL_TO_CATEGORY = new Map<string, ToolCategory>()
for (const category of TOOL_CATEGORIES) {
  if (category.id === 'other') continue
  for (const tool of category.tools) {
    TOOL_TO_CATEGORY.set(tool, category)
  }
}

const OTHER_CATEGORY = TOOL_CATEGORIES.find((c) => c.id === 'other')!

export interface GroupedTools {
  category: ToolCategory
  tools: string[]
}

/** Group tool names by category; unknown tools land in Other. */
export function groupToolsByCategory(tools: string[]): GroupedTools[] {
  if (!tools.length) return []

  const buckets = new Map<string, string[]>()
  const order: string[] = []

  for (const tool of tools) {
    const category = TOOL_TO_CATEGORY.get(tool) ?? OTHER_CATEGORY
    if (!buckets.has(category.id)) {
      buckets.set(category.id, [])
      order.push(category.id)
    }
    buckets.get(category.id)!.push(tool)
  }

  return order.map((id) => {
    const category = TOOL_CATEGORIES.find((c) => c.id === id) ?? OTHER_CATEGORY
    return { category, tools: buckets.get(id)! }
  })
}

export function categoryTextClass(color: string): string {
  switch (color) {
    case 'purple':
      return 'text-purple-400'
    case 'blue':
      return 'text-blue-400'
    case 'cyan':
      return 'text-cyan-400'
    case 'orange':
      return 'text-orange-400'
    case 'emerald':
      return 'text-emerald-400'
    case 'sky':
      return 'text-sky-400'
    case 'amber':
      return 'text-amber-400'
    case 'rose':
      return 'text-rose-400'
    case 'indigo':
      return 'text-indigo-400'
    default:
      return 'text-muted-foreground'
  }
}

export function categoryBgClass(color: string): string {
  switch (color) {
    case 'purple':
      return 'bg-purple-500/15'
    case 'blue':
      return 'bg-blue-500/15'
    case 'cyan':
      return 'bg-cyan-500/15'
    case 'orange':
      return 'bg-orange-500/15'
    case 'emerald':
      return 'bg-emerald-500/15'
    case 'sky':
      return 'bg-sky-500/15'
    case 'amber':
      return 'bg-amber-500/15'
    case 'rose':
      return 'bg-rose-500/15'
    case 'indigo':
      return 'bg-indigo-500/15'
    default:
      return 'bg-muted'
  }
}
