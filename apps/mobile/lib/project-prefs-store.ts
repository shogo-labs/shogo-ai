// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'
import { safeGetItem, safeSetItem } from './safe-storage'

/**
 * Device-local preferences for the sidebar projects list:
 *  - which projects the user has pinned (pinned float to the top and stay
 *    visible regardless of the 5-item cap)
 *  - the projects-list filter (sort order + scope)
 *
 * Intentionally local-only (no backend), mirroring `workspace-store.ts`: pins
 * and filters are a per-device browsing convenience. On web we persist to
 * localStorage via safe-storage; on native we keep them in memory for the
 * session.
 */

const PINNED_KEY = 'shogo:pinned-projects'
const FILTER_KEY = 'shogo:project-filter'

export type ProjectSort = 'recent' | 'name'
export type ProjectScope = 'all' | 'mine'
export interface ProjectFilter {
  sort: ProjectSort
  scope: ProjectScope
}

export const DEFAULT_PROJECT_FILTER: ProjectFilter = { sort: 'recent', scope: 'all' }

const isWeb = Platform.OS === 'web' && typeof window !== 'undefined'

// Native session fallbacks (safe-storage already falls back to memory on web).
let nativePinned: string[] = []
let nativeFilter: ProjectFilter = { ...DEFAULT_PROJECT_FILTER }

export function getPinnedProjectIds(): string[] {
  if (!isWeb) return nativePinned
  const raw = safeGetItem(PINNED_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : []
  } catch {
    return []
  }
}

export function setPinnedProjectIds(ids: string[]): void {
  const unique = Array.from(new Set(ids))
  if (!isWeb) {
    nativePinned = unique
    return
  }
  safeSetItem(PINNED_KEY, JSON.stringify(unique))
}

export function getProjectFilter(): ProjectFilter {
  if (!isWeb) return { ...nativeFilter }
  const raw = safeGetItem(FILTER_KEY)
  if (!raw) return { ...DEFAULT_PROJECT_FILTER }
  try {
    const parsed = JSON.parse(raw)
    const sort: ProjectSort = parsed?.sort === 'name' ? 'name' : 'recent'
    const scope: ProjectScope = parsed?.scope === 'mine' ? 'mine' : 'all'
    return { sort, scope }
  } catch {
    return { ...DEFAULT_PROJECT_FILTER }
  }
}

export function setProjectFilter(filter: ProjectFilter): void {
  if (!isWeb) {
    nativeFilter = { ...filter }
    return
  }
  safeSetItem(FILTER_KEY, JSON.stringify(filter))
}
