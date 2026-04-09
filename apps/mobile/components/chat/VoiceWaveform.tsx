// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { Motion } from '@legendapp/motion'

const BAR_PHASES = [0, 1.2, 0.5, 1.8, 0.3]
const TICK_MS = 380
const BAR_HEIGHT = 16

export function VoiceWaveform() {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), TICK_MS)
    return () => clearInterval(id)
  }, [])

  return (
    <View className="flex-row items-center gap-0.5 h-4">
      {BAR_PHASES.map((offset, i) => {
        const h =
          (0.25 + 0.75 * Math.abs(Math.sin((tick * 0.9 + offset) * Math.PI))) *
          BAR_HEIGHT
        return (
          <Motion.View
            key={i}
            className="w-[3px] rounded-full bg-muted-foreground"
            animate={{ height: h }}
            transition={{ type: 'spring', damping: 15, stiffness: 200 }}
          />
        )
      })}
    </View>
  )
}
