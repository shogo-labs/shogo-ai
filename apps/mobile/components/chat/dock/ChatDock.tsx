// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Floating container above the chat composer. Reads the panel registry
 * from `ChatDockStore` and renders two zones:
 *
 *  - a scrollable, height-capped "status" zone for collapsible panels
 *    (plan, changed files, checklist, browser, running, queue, context
 *    usage);
 *  - a pinned "blocking" zone directly above the composer for prompts
 *    that park the agent turn (permission approval, pending question,
 *    an active connectivity wait) — these never collapse.
 *
 * Positioned `absolute bottom-full` so it floats over the message list
 * without pushing layout; `pointerEvents="box-none"` lets taps land on the
 * scroll view underneath everywhere the dock itself has no content.
 * `ChatPanel` reads `store.getHeight()` (reported here via `onLayout`) to
 * pad the message list so the dock never permanently hides the newest
 * message.
 */

import { useCallback, useSyncExternalStore } from "react"
import { View, StyleSheet, ScrollView, Platform, useColorScheme, type LayoutChangeEvent } from "react-native"
import { LinearGradient } from "expo-linear-gradient"
import { cn } from "@shogo/shared-ui/primitives"
import { useChatDockStore } from "../../../lib/chat-dock-store"
import { DockPanel } from "./DockPanel"

const MAX_STATUS_HEIGHT = 420
const MAX_STATUS_HEIGHT_RATIO = 0.45
const FADE_HEIGHT = 16

const styles = StyleSheet.create({
  container: { position: "absolute", bottom: "100%", left: 0, right: 0 },
  relative: { position: "relative" },
  topFade: { position: "absolute", top: 0, left: 0, right: 0, height: FADE_HEIGHT, pointerEvents: "none" },
  scrollContent: { paddingTop: 2, paddingBottom: 2 },
})

export interface ChatDockProps {
  /** Available height above the composer, used to cap the status zone at ~45%. */
  availableHeight?: number
  className?: string
}

export function ChatDock({ availableHeight, className }: ChatDockProps) {
  const store = useChatDockStore()
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  const colorScheme = useColorScheme()

  const statusPanels = store.getPanels("status")
  const blockingPanels = store.getPanels("blocking")
  const hasContent = statusPanels.length > 0 || blockingPanels.length > 0

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      store.setHeight(e.nativeEvent.layout.height)
    },
    [store],
  )

  if (!hasContent) {
    // Nothing to show — relax the message list's reserved padding back to zero.
    if (store.getHeight() !== 0) store.setHeight(0)
    return null
  }

  const maxStatusHeight = Math.min(
    MAX_STATUS_HEIGHT,
    availableHeight ? Math.round(availableHeight * MAX_STATUS_HEIGHT_RATIO) : MAX_STATUS_HEIGHT,
  )

  const fadeColor = colorScheme === "dark" ? "rgba(9,9,11,1)" : "rgba(255,255,255,1)"
  const fadeColorTransparent = colorScheme === "dark" ? "rgba(9,9,11,0)" : "rgba(255,255,255,0)"

  return (
    <View
      style={styles.container}
      className={cn("mb-1.5 w-full max-w-3xl self-center gap-1.5", className)}
      pointerEvents="box-none"
      onLayout={handleLayout}
    >
      {statusPanels.length > 0 && (
        <View style={styles.relative}>
          <ScrollView
            style={{ maxHeight: maxStatusHeight }}
            contentContainerStyle={styles.scrollContent}
            nestedScrollEnabled
            showsVerticalScrollIndicator={false}
          >
            <View className="gap-1.5">
              {statusPanels.map((panel) => {
                const expanded = store.isExpanded(panel.id)
                return (
                  <DockPanel
                    key={panel.id}
                    title={panel.title}
                    icon={panel.icon}
                    summary={panel.summary}
                    accent={panel.accent}
                    headerActions={panel.headerActions}
                    onDismiss={panel.onDismiss}
                    expanded={expanded}
                    collapsible
                    onToggle={() => store.toggle(panel.id)}
                  >
                    {panel.render({ expanded })}
                  </DockPanel>
                )
              })}
            </View>
          </ScrollView>
          {Platform.OS !== "web" && statusPanels.length > 1 && (
            <LinearGradient colors={[fadeColor, fadeColorTransparent]} style={styles.topFade} />
          )}
        </View>
      )}

      {blockingPanels.length > 0 && (
        <View className="gap-1.5">
          {blockingPanels.map((panel) => (
            <DockPanel
              key={panel.id}
              title={panel.title}
              icon={panel.icon}
              summary={panel.summary}
              accent={panel.accent}
              headerActions={panel.headerActions}
              expanded
              collapsible={false}
              onToggle={() => {}}
            >
              {panel.render({ expanded: true })}
            </DockPanel>
          ))}
        </View>
      )}
    </View>
  )
}
