// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  DEFAULT_ISLAND_LAYOUT,
  EMPTY_ISLAND_MEETING_STATE,
  EMPTY_ISLAND_SNAPSHOT,
  getIslandBridge,
  type IslandLayout,
  type IslandMeetingState,
  type IslandMode,
  type IslandSnapshot,
} from "./types"

export function useIslandBridge() {
  const bridge = useMemo(() => getIslandBridge(), [])
  const [snapshot, setSnapshot] = useState<IslandSnapshot>(EMPTY_ISLAND_SNAPSHOT)
  const [layout, setLayout] = useState<IslandLayout>(DEFAULT_ISLAND_LAYOUT)
  const [meeting, setMeeting] = useState<IslandMeetingState>(EMPTY_ISLAND_MEETING_STATE)

  useEffect(() => {
    if (!bridge) return
    const offSnapshot = bridge.onSnapshot(setSnapshot)
    const offLayout = bridge.onLayout(setLayout)
    const offMeeting = bridge.onMeeting?.(setMeeting)
    // The main process pushed state before this route finished booting.
    bridge.requestState()
    return () => {
      offSnapshot()
      offLayout()
      offMeeting?.()
    }
  }, [bridge])

  const requestMode = useCallback(
    (mode: IslandMode) => {
      if (!bridge) return
      setLayout((current) => (current.mode === mode ? current : { ...current, mode }))
      bridge.setMode(mode)
    },
    [bridge],
  )

  return { bridge, snapshot, layout, meeting, requestMode }
}
