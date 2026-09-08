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
 *
 * Horizontal padding matches `ChatInput`'s own outer padding (`px-3` web /
 * `px-2` native) so the dock's edges line up with the composer's visible
 * bordered box below it, rather than the wider positioning wrapper both
 * sit in.
 *
 * Each zone (status, blocking) renders as exactly ONE rounded card —
 * `rounded-xl` on all four corners, always, regardless of how many panels
 * are stacked inside or whether the status zone is mid-scroll — with
 * individual panels separated by hairline dividers (`DockPanel`'s
 * `isFirst`) rather than each being its own nested card.
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

// Matches ChatInput's own outer horizontal padding (`px-3` web / `px-2`
// native) — see the file header comment.
const HORIZONTAL_PADDING_CLASS = Platform.OS !== "web" ? "px-2" : "px-3"
// `rounded-xl` matches ChatInput's own bordered box directly below, so the
// dock reads as the same card language stacked on top of the composer.
const ZONE_CARD_CLASS = "overflow-hidden rounded-xl border border-border/60 bg-popover/95 shadow-md"

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
      className={cn("mb-1.5 w-full max-w-3xl self-center gap-1.5", HORIZONTAL_PADDING_CLASS, className)}
      pointerEvents="box-none"
      onLayout={handleLayout}
    >
      {statusPanels.length > 0 && (
        <View style={styles.relative} className={ZONE_CARD_CLASS}>
          <ScrollView
            style={{ maxHeight: maxStatusHeight }}
            contentContainerStyle={styles.scrollContent}
            nestedScrollEnabled
            showsVerticalScrollIndicator={false}
          >
            {statusPanels.map((panel, index) => {
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
                  isFirst={index === 0}
                >
                  {panel.render({ expanded })}
                </DockPanel>
              )
            })}
          </ScrollView>
          {Platform.OS !== "web" && statusPanels.length > 1 && (
            <LinearGradient colors={[fadeColor, fadeColorTransparent]} style={styles.topFade} />
          )}
        </View>
      )}

      {blockingPanels.length > 0 && (
        <View className={ZONE_CARD_CLASS}>
          {blockingPanels.map((panel, index) => (
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
              isFirst={index === 0}
            >
              {panel.render({ expanded: true })}
            </DockPanel>
          ))}
        </View>
      )}
    </View>
  )
}
