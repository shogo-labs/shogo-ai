// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useState } from "react"
import { Pressable, View } from "react-native"
import { Motion } from "@legendapp/motion"
import { ShogoLogoMark } from "../branding/ShogoLogoMark"
import { useIslandAccent } from "./island-accent"
import { IDLE_WING, IDLE_WING_HOVER, ISLAND_HOVER, NOTCH_WIDTH, islandMotion } from "./island-motion"
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
 * black wings just wider than the notch carrying the Shogo mark, so the
 * island is discoverable without covering menu items; elsewhere it is a
 * small accent handle under the menu bar. Both grow on hover to show the
 * island is about to open.
 */
export function IslandIdle({
  layout,
  reducedMotion,
  onExpand,
}: {
  layout: IslandLayout
  reducedMotion: boolean
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
        className="h-full w-full items-center justify-start pt-0.5"
      >
        <Motion.View
          animate={{ width: hovered ? 72 : 44, opacity: hovered ? 1 : 0.75 }}
          transition={transition}
          style={{ height: 4, borderRadius: 2, backgroundColor: accent }}
        />
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
            <ShogoLogoMark className="h-3.5 w-3.5" fill={accent} />
          </Motion.View>
        </View>
        <View style={{ width: NOTCH_WIDTH }} />
        <View className="items-center justify-center" style={{ width: wing, height }}>
          <Motion.View
            animate={{ opacity: hovered ? 1 : 0, scale: hovered ? 1 : 0.4 }}
            transition={transition}
            style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: accent }}
          />
        </View>
      </Motion.View>
    </Pressable>
  )
}
