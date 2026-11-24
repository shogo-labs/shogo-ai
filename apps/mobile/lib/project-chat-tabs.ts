// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Open chat tabs for a project page: restore the saved list, keep the
 * active session mounted, and persist changes.
 *
 * The chat panel only mounts sessions in `openChatTabIds`. A deep link
 * (Activity, sidebar) sets the active session before AsyncStorage returns,
 * so the restore has to keep that session or the panel renders blank.
 */
import { useEffect, useRef, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { setStorageJson } from './storage'
import type { ViewStyle } from 'react-native'

export type TabsHydration =
  | 'loading'
  | 'restored-with-tabs'
  | 'restored-empty'
  | 'fresh'

/**
 * Style for a chat tab that is mounted but not the active one. The panel
 * stays mounted so its stream and scroll position survive a switch, but the
 * person must not be able to reach it. `opacity: 0` alone is not enough on
 * web: the hidden composer stays focusable, readable by screen readers and
 * visible to hit-testing, and inactive tabs can render before the active one
 * (a cold load restores the saved tabs, then appends the `?chatSessionId=`
 * one), so Tab or "the first composer on the page" lands in a chat nobody can
 * see. `visibility: hidden` removes it from focus order, the a11y tree and
 * hit-testing while keeping its layout, so nothing re-measures on a switch.
 */
export function inactiveChatTabStyle(platformOS: string): ViewStyle {
  return {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0,
    // Web-only CSS property react-native-web passes through; not in ViewStyle.
    ...(platformOS === 'web' ? ({ visibility: 'hidden' } as ViewStyle) : {}),
  }
}

export function chatTabsStorageKey(projectId: string): string {
  return `shogo:chatTabs:${projectId}`
}

/**
 * Restored tabs first, then any tabs opened before the restore finished
 * (the deep-linked session). Duplicates from the in-memory list are dropped.
 */
export function mergeRestoredChatTabs(restored: string[], current: string[]): string[] {
  return [...restored, ...current.filter((id) => !restored.includes(id))]
}

export interface ProjectChatTabsInput {
  projectId: string | null | undefined
  chatSessionId: string | null
  /**
   * Skip the storage read and treat the visit as fresh. The project page
   * does this when the pinned workspace session owns tab selection and
   * there is no explicit deep link.
   */
  skipRestore: boolean
  /** An explicit empty tab list means "fresh" on a phone, "user closed everything" elsewhere. */
  nativePhone: boolean
}

export function useProjectChatTabs({
  projectId,
  chatSessionId,
  skipRestore,
  nativePhone,
}: ProjectChatTabsInput) {
  const [openChatTabIds, setOpenChatTabIds] = useState<string[]>([])
  const [tabsHydration, setTabsHydration] = useState<TabsHydration>('loading')
  const openTabsRestoredRef = useRef(false)

  useEffect(() => {
    if (!projectId || openTabsRestoredRef.current) return
    if (skipRestore) {
      openTabsRestoredRef.current = true
      setTabsHydration('fresh')
      return
    }
    AsyncStorage.getItem(chatTabsStorageKey(projectId))
      .then((raw) => {
        if (raw === null) {
          openTabsRestoredRef.current = true
          setTabsHydration('fresh')
          return
        }
        try {
          const ids = JSON.parse(raw)
          if (Array.isArray(ids)) {
            if (ids.length > 0) {
              setOpenChatTabIds((prev) => mergeRestoredChatTabs(ids, prev))
              openTabsRestoredRef.current = true
              setTabsHydration('restored-with-tabs')
              return
            }
            openTabsRestoredRef.current = true
            setTabsHydration(nativePhone ? 'fresh' : 'restored-empty')
            return
          }
        } catch {
          /* ignore malformed data */
        }
        openTabsRestoredRef.current = true
        setTabsHydration('fresh')
      })
      .catch(() => {
        openTabsRestoredRef.current = true
        setTabsHydration('fresh')
      })
  }, [projectId, nativePhone, skipRestore])

  useEffect(() => {
    if (!projectId || tabsHydration === 'loading') return
    setStorageJson(chatTabsStorageKey(projectId), openChatTabIds).catch(() => {})
  }, [projectId, openChatTabIds, tabsHydration])

  useEffect(() => {
    if (!chatSessionId) return
    setOpenChatTabIds((prev) => {
      if (prev.includes(chatSessionId)) return prev
      return [...prev, chatSessionId]
    })
  }, [chatSessionId, openChatTabIds])

  return { openChatTabIds, setOpenChatTabIds, tabsHydration }
}
