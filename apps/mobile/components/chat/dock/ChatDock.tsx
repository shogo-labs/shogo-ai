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
 * Web: `absolute` + `bottom: "100%"` so the dock floats over the message
 * list without pushing layout. The overlay spans the composer wrapper;
 * an inner `max-w-3xl` column is centered so Error / Changed files /
 * Queue cards line up with the transcript (and the intended composer
 * column). NativeWind stays off the overlay View so css-interop cannot
 * drop `position` / `bottom`.
 *
 * Native: the dock is a normal column sibling of the composer pill.
 * Yoga cannot resolve percentage `bottom`, so an overlay parks the card
 * on top of the input. Layout styles live on a View with NO `className`
 * so NativeWind cannot replace `marginBottom` / `flexShrink`. Native
 * reports height 0 so `ChatPanel` does not also pad the transcript.
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

import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from "react"
import { View, StyleSheet, ScrollView, Platform, useColorScheme, useWindowDimensions, type LayoutChangeEvent } from "react-native"
import { LinearGradient } from "expo-linear-gradient"
import { cn } from "@shogo/shared-ui/primitives"
import { useChatDockStore } from "../../../lib/chat-dock-store"
import {
  isNativePlatform,
  nativePhoneDockBlockingBodyMaxHeight,
  nativePhoneDockFadeColors,
  nativePhoneDockStatusMaxHeight,
  NATIVE_PHONE_DOCK_COMPOSER_GAP,
} from "../../../lib/native-phone-layout"
import { CappedContentScroll } from "./CappedContentScroll"
import { DockPanel } from "./DockPanel"

const MAX_STATUS_HEIGHT = 420
const MAX_STATUS_HEIGHT_RATIO = 0.45
const FADE_HEIGHT = 16
const WEB_DOCK_COMPOSER_GAP = 6

const styles = StyleSheet.create({
  // Style-only: never put NativeWind `className` on this View. css-interop
  // replaces `style` when both are set, which dropped in-flow layout and
  // let banners paint over the composer pill.
  nativeContainer: {
    width: "100%",
    marginBottom: NATIVE_PHONE_DOCK_COMPOSER_GAP,
    flexShrink: 0,
  },
  webContainer: {
    position: "absolute",
    bottom: "100%",
    left: 0,
    right: 0,
    paddingBottom: WEB_DOCK_COMPOSER_GAP,
    // `left` + `right` stretch this overlay to the composer wrapper.
    // Without centering, `max-w-3xl` on the same node pins the card to
    // the left while the transcript sits in the centered column.
    alignItems: "center",
  },
  relative: { position: "relative" },
  statusScroll: {
    flexGrow: 0,
  },
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
  testID?: string
}

export function ChatDock({ availableHeight, className, testID }: ChatDockProps) {
  const store = useChatDockStore()
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  const colorScheme = useColorScheme()

  const statusPanels = store.getPanels("status")
  const blockingPanels = store.getPanels("blocking")
  const hasContent = statusPanels.length > 0 || blockingPanels.length > 0

  useEffect(() => {
    if (hasContent || store.getHeight() === 0) return
    store.setHeight(0)
  }, [hasContent, store])

  const native = isNativePlatform()
  const { height: windowHeight } = useWindowDimensions()
  // Native dock is in the composer column, so the messages-area height
  // shrinks when this card grows. Capping against that measurement made
  // maxHeight and the flex sibling chase each other (the card "vibrates").
  // Window height is stable across that layout.
  const nativeCapHeight = windowHeight || undefined

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      // Native dock is in-flow above the composer, so the message list
      // already yields. Reporting height would double-pad the transcript.
      store.setHeight(native ? 0 : e.nativeEvent.layout.height)
    },
    [native, store],
  )

  if (!hasContent) {
    return null
  }

  const statusCapSource = native ? nativeCapHeight : availableHeight
  const maxStatusHeight = native
    ? nativePhoneDockStatusMaxHeight(nativeCapHeight)
    : Math.min(
        MAX_STATUS_HEIGHT,
        statusCapSource ? Math.round(statusCapSource * MAX_STATUS_HEIGHT_RATIO) : MAX_STATUS_HEIGHT,
      )
  const blockingBodyMaxHeight = native
    ? nativePhoneDockBlockingBodyMaxHeight(nativeCapHeight)
    : undefined
  const blockingContent = blockingPanels.map((panel, index) => (
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
      {panel.render({ expanded: true, bodyMaxHeight: blockingBodyMaxHeight })}
    </DockPanel>
  ))

  const fadeColors = nativePhoneDockFadeColors(colorScheme === "dark")
  const statusList = statusPanels.map((panel, index) => {
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
  })
  const statusZone = statusPanels.length > 0 && (
    <View style={styles.relative} className={ZONE_CARD_CLASS}>
      {native ? (
        <CappedContentScroll maxHeight={maxStatusHeight}>
          {statusList}
        </CappedContentScroll>
      ) : (
        <ScrollView
          style={[styles.statusScroll, { maxHeight: maxStatusHeight }]}
          contentContainerStyle={styles.scrollContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
        >
          {statusList}
        </ScrollView>
      )}
      {native && statusPanels.length > 1 && (
        <LinearGradient colors={[fadeColors[2], fadeColors[0]]} style={styles.topFade} />
      )}
    </View>
  )

  const body: ReactNode = (
    <>
      {statusZone}
      {blockingPanels.length > 0 && (
        <View className={ZONE_CARD_CLASS}>{blockingContent}</View>
      )}
    </>
  )

  if (native) {
    return (
      <View
        collapsable={false}
        style={styles.nativeContainer}
        testID={testID}
        pointerEvents="box-none"
        onLayout={handleLayout}
      >
        <View className={cn("w-full max-w-3xl self-center gap-1.5", HORIZONTAL_PADDING_CLASS, className)}>
          {body}
        </View>
      </View>
    )
  }

  return (
    <View
      style={styles.webContainer}
      testID={testID}
      pointerEvents="box-none"
      onLayout={handleLayout}
    >
      <View className={cn("w-full max-w-3xl gap-1.5", HORIZONTAL_PADDING_CLASS, className)}>
        {body}
      </View>
    </View>
  )
}
