// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useState } from "react"
import { Pressable, View } from "react-native"
import { Motion } from "@legendapp/motion"
import type { BuddyState } from "./buddy/engine"
import { IslandBuddy, type IslandBuddyEntrance } from "./buddy/IslandBuddy"
import type { BuddyLook } from "./buddy/look"
import { useIslandAccent } from "./island-accent"
import {
  IDLE_TAB_HEIGHT,
  IDLE_TAB_HOVER_WIDTH,
  IDLE_TAB_WIDTH,
  IDLE_WING,
  IDLE_WING_HOVER,
  ISLAND_HOVER,
  NOTCH_WIDTH,
  islandMotion,
} from "./island-motion"
import { ISLAND_TRIGGER_PROPS, type IslandLayout } from "./types"

/** The whole overlay window is the hover target, so "hovered" is simply
 * "the pointer is inside the window". */
function useWindowHovered(): boolean {
  const [hovered, setHovered] = useState(false)
  useEffect(() => {
    if (typeof document === "undefined") return
    const enter = () => setHovered(true)
    const leave = () => setHovered(false)
    document.addEventListener("mousemove", enter)
    document.addEventListener("mouseleave", leave)
    return () => {
      document.removeEventListener("mousemove", enter)
      document.removeEventListener("mouseleave", leave)
    }
  }, [])
  return hovered
}

/**
 * Resting island with nothing to report. On a notched Mac it is a pair of
 * black wings just wider than the notch carrying the Shogo mark (the buddy
 * folded up), so the island is discoverable without covering menu items;
 * elsewhere it is a black virtual-notch tab carrying the same mark. Both
 * grow on hover to show the island is about to open.
 */
export function IslandIdle({
  layout,
  reducedMotion,
  look,
  buddyState,
  entrance,
  onExpand,
}: {
  layout: IslandLayout
  reducedMotion: boolean
  look: BuddyLook
  buddyState: BuddyState
  entrance: Extract<IslandBuddyEntrance, "logo" | "fold">
  onExpand: () => void
}) {
  const hovered = useWindowHovered()
  const accent = useIslandAccent()
  const transition = islandMotion(reducedMotion, ISLAND_HOVER)

  if (!layout.notched) {
    return (
      <Pressable
        onPress={onExpand}
        {...ISLAND_TRIGGER_PROPS}
        accessibilityRole="button"
        accessibilityLabel="Open Shogo island"
        className="h-full w-full items-center"
      >
        <Motion.View
          animate={{ width: hovered ? IDLE_TAB_HOVER_WIDTH : IDLE_TAB_WIDTH }}
          transition={transition}
          style={{
            height: IDLE_TAB_HEIGHT,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 16,
            backgroundColor: "#000",
            borderBottomLeftRadius: 12,
            borderBottomRightRadius: 12,
          }}
        >
          <Motion.View animate={{ scale: hovered ? 1.15 : 1 }} transition={transition}>
            <IslandBuddy
              body={16}
              width={28}
              height={IDLE_TAB_HEIGHT}
              state={buddyState}
              color={accent}
              look={look}
              entrance={entrance}
              peek={hovered}
              reducedMotion={reducedMotion}
            />
          </Motion.View>
          <Motion.View
            animate={{ opacity: hovered ? 1 : 0, scale: hovered ? 1 : 0.4 }}
            transition={transition}
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: accent,
            }}
          />
        </Motion.View>
      </Pressable>
    )
  }

  const wing = hovered ? IDLE_WING_HOVER : IDLE_WING
  // Fixed to the menu-bar height: the window grows before the card mounts,
  // and a full-height shape would flash as a tall black slab.
  const height = layout.topInset
  return (
    <Pressable
      onPress={onExpand}
      {...ISLAND_TRIGGER_PROPS}
      accessibilityRole="button"
      accessibilityLabel="Open Shogo island"
      className="h-full w-full items-center"
    >
      <Motion.View
        animate={{ width: NOTCH_WIDTH + wing * 2 }}
        transition={transition}
        style={{
          height,
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: "#000",
          borderBottomLeftRadius: 12,
          borderBottomRightRadius: 12,
        }}
      >
        <View className="items-center justify-center" style={{ width: wing, height }}>
          <Motion.View animate={{ scale: hovered ? 1.15 : 1 }} transition={transition}>
            <IslandBuddy
              body={15}
              width={IDLE_WING}
              height={height}
              state={buddyState}
              color={accent}
              look={look}
              entrance={entrance}
              peek={hovered}
              reducedMotion={reducedMotion}
            />
          </Motion.View>
        </View>
        <View style={{ width: NOTCH_WIDTH }} />
        <View className="items-center justify-center" style={{ width: wing, height }}>
          <Motion.View
            animate={{ opacity: hovered ? 1 : 0, scale: hovered ? 1 : 0.4 }}
            transition={transition}
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: accent,
            }}
          />
        </View>
      </Motion.View>
    </Pressable>
  )
}
