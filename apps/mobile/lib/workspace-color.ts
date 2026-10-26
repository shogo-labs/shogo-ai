// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A stable color for a workspace that has no logo. The same id always maps
 * to the same hue, so the rail tile and the switcher stay in sync.
 */

const WORKSPACE_COLORS = [
  '#C4652A',
  '#6D5BD0',
  '#2F6FED',
  '#0E8A6A',
  '#C43B5C',
  '#0E7490',
  '#B45309',
  '#4F46E5',
]

export function workspaceColor(id: string | null | undefined): string {
  if (!id) return WORKSPACE_COLORS[0]
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return WORKSPACE_COLORS[hash % WORKSPACE_COLORS.length]
}

export function workspaceInitial(name: string | null | undefined): string {
  const letter = name?.trim()?.[0]
  return letter ? letter.toUpperCase() : 'W'
}
