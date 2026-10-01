// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useLayoutEffect, useRef } from "react"
import { View } from "react-native"
import { BUDDY_ASPECT, type BuddyState } from "./engine"
import type { BuddyLook } from "./look"
import { ShogoBuddy, type ShogoBuddyHandle } from "./ShogoBuddy"

/** How the buddy arrives when its island mode mounts.
 * - `logo`: rest as the Shogo mark.
 * - `fold`: the character folds back into the mark (the island just closed).
 * - `unfold`: the mark unfolds into the character (the island just opened).
 * - `appear`: the character pops in with no mark to come from.
 * - `character`: already the character, no entrance. */
export type IslandBuddyEntrance = "logo" | "fold" | "unfold" | "appear" | "character"

/** The body is about two thirds of the canvas width. */
const BODY_OF_CANVAS = 0.66

/**
 * A Shogo buddy sized by its body diameter and centred in a box, for the
 * island's wings and header. The canvas is taller than the body (room for
 * the antenna and particles) and may spill out above the box.
 */
export function IslandBuddy({
  body,
  width,
  height,
  state,
  color,
  look,
  entrance,
  peek = false,
  followPointer = false,
  reducedMotion,
}: {
  /** Body diameter in px. */
  body: number
  width: number
  height: number
  state: BuddyState
  color: string
  look: BuddyLook
  /** Read once, when this buddy mounts. */
  entrance: IslandBuddyEntrance
  /** While true the resting mark ripples and turns toward the pointer. */
  peek?: boolean
  followPointer?: boolean
  reducedMotion: boolean
}) {
  const ref = useRef<ShogoBuddyHandle>(null)
  const size = Math.round(body / BODY_OF_CANVAS)
  const canvasHeight = size * BUDDY_ASPECT
  // The engine centres the body half a body-width above the canvas bottom.
  const top = height / 2 - (canvasHeight - size * 0.5)

  // Before the first paint, so the mark never flashes as the character.
  useLayoutEffect(() => {
    const buddy = ref.current
    if (!buddy) return
    switch (entrance) {
      case "logo":
        buddy.engine.showLogo(true)
        break
      case "fold":
        buddy.engine.showLogo(false)
        buddy.toLogo()
        break
      case "unfold":
        buddy.engine.showLogo(true)
        buddy.fromLogo()
        break
      case "appear":
        buddy.engine.showLogo(false)
        if (!reducedMotion) buddy.appear()
        break
      case "character":
        buddy.engine.showLogo(false)
        break
    }
    // Entrance only plays on mount.
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (peek) ref.current?.engine.logoPeek()
  }, [peek])

  return (
    <View pointerEvents="none" style={{ width, height }}>
      <View style={{ position: "absolute", left: (width - size) / 2, top }}>
        <ShogoBuddy
          ref={ref}
          size={size}
          state={state}
          color={color}
          look={look}
          logoStyle="mosaic"
          mini
          followPointer={followPointer}
          reducedMotion={reducedMotion}
        />
      </View>
    </View>
  )
}
