// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat-streaming profiler harness.
 *
 * Drives `TurnList` (the heart of the chat render pipeline) through a set of
 * deterministic scenarios at controllable speeds, wrapped in `React.Profiler`
 * so React DevTools can record per-commit timing.
 *
 * Why the harness exists in `app/dev/` and not in tests: streaming perf is a
 * scheduler / commit / paint problem and must be measured against real React
 * + the real component tree on the actual device. Bun:test renders to JSDOM,
 * which is fine for behaviour assertions but doesn't reflect the cost of the
 * native bridge or web layout.
 *
 * Usage:
 *   1. (native) `bunx react-devtools` then `bun run dev:ios|dev:android`
 *      from `apps/mobile`. EXPO_PUBLIC_ENABLE_DEVTOOLS=1 must be set.
 *   2. (web) `bun run dev:web`, open the page, open Chrome DevTools React
 *      Profiler.
 *   3. Navigate to `/dev/profiler-chat`, pick a scenario + speed, hit Start
 *      Recording in the React Profiler, hit Run in the harness, then Stop
 *      in the Profiler and export.
 */
import { useCallback, useEffect, useMemo, useRef, useState, Profiler } from 'react'
import { View, Text, Pressable, ScrollView, Platform } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { UIMessage } from '@ai-sdk/react'
import { TurnList } from '@/components/chat/turns/TurnList'
import {
  longTextScenario,
  toolHeavyScenario,
  planHeavyScenario,
  multiTurnScenario,
  longHistoryScenario,
  type Scenario,
} from '../../lib/profiler-scenarios'
import { profilerRecorder } from '../../lib/profiler-recorder'

declare const __DEV__: boolean

const SCENARIOS: Scenario[] = [
  longTextScenario(),
  toolHeavyScenario(),
  planHeavyScenario(),
  multiTurnScenario(),
  longHistoryScenario(),
]

const SPEEDS: { label: string; ms: number }[] = [
  { label: '60 fps (16ms)', ms: 16 },
  { label: '30 fps (33ms)', ms: 33 },
  { label: '15 fps (66ms)', ms: 66 },
  { label: '5 fps (200ms)', ms: 200 },
  { label: 'Burst (0ms)', ms: 0 },
]

interface DriverState {
  scenarioId: string
  step: number
  running: boolean
}

export default function ProfilerChat() {
  if (!__DEV__) {
    return (
      <SafeAreaView className="flex-1 bg-background items-center justify-center">
        <Text className="text-foreground text-base">
          Profiler harness is only available in development builds.
        </Text>
      </SafeAreaView>
    )
  }

  return <ProfilerHarness />
}

function ProfilerHarness() {
  const [scenarioIdx, setScenarioIdx] = useState(0)
  const [speedIdx, setSpeedIdx] = useState(1)
  const [driver, setDriver] = useState<DriverState>({
    scenarioId: SCENARIOS[0].id,
    step: 0,
    running: false,
  })
  const [snapshot, setSnapshot] = useState<{ messages: UIMessage[]; isStreaming: boolean }>(
    SCENARIOS[0].build(0),
  )
  const [summaryText, setSummaryText] = useState<string>('')

  const scenario = SCENARIOS[scenarioIdx]
  const speedMs = SPEEDS[speedIdx].ms

  const tickRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stepRef = useRef(driver.step)
  stepRef.current = driver.step
  const runningRef = useRef(driver.running)
  runningRef.current = driver.running

  const stopTicker = useCallback(() => {
    if (tickRef.current) {
      clearTimeout(tickRef.current)
      tickRef.current = null
    }
  }, [])

  const advance = useCallback(
    (sc: Scenario, nextStep: number) => {
      const next = sc.build(nextStep)
      setSnapshot(next)
    },
    [],
  )

  const runTicker = useCallback(() => {
    stopTicker()
    if (!runningRef.current) return
    if (stepRef.current >= scenario.steps - 1) {
      // Done — emit the final snapshot, stop, and pause.
      runningRef.current = false
      setDriver((d) => ({ ...d, running: false }))
      return
    }

    const advanceOne = () => {
      const nextStep = stepRef.current + 1
      stepRef.current = nextStep
      advance(scenario, nextStep)
      setDriver((d) => ({ ...d, step: nextStep }))

      if (nextStep >= scenario.steps - 1) {
        runningRef.current = false
        setDriver((d) => ({ ...d, running: false }))
        return false
      }
      return true
    }

    if (speedMs === 0) {
      // Burst: chain microtasks so React still gets a chance to render between
      // ticks but we don't wait for setTimeout's 4ms minimum.
      const burst = () => {
        if (!runningRef.current) return
        if (!advanceOne()) return
        if (runningRef.current) queueMicrotask(burst)
      }
      queueMicrotask(burst)
    } else {
      const fire = () => {
        if (!runningRef.current) return
        if (!advanceOne()) return
        if (runningRef.current) tickRef.current = setTimeout(fire, speedMs)
      }
      tickRef.current = setTimeout(fire, speedMs)
    }
  }, [scenario, speedMs, advance, stopTicker])

  useEffect(() => () => stopTicker(), [stopTicker])

  // When the user picks a different scenario, reset to step 0.
  useEffect(() => {
    stopTicker()
    runningRef.current = false
    stepRef.current = 0
    setSnapshot(scenario.build(0))
    setDriver({ scenarioId: scenario.id, step: 0, running: false })
  }, [scenario, stopTicker])

  const handleStart = useCallback(() => {
    profilerRecorder.start()
    setSummaryText('')
    runningRef.current = true
    setDriver((d) => ({ ...d, running: true }))
    runTicker()
  }, [runTicker])

  const handlePause = useCallback(() => {
    runningRef.current = false
    stopTicker()
    setDriver((d) => ({ ...d, running: false }))
  }, [stopTicker])

  const handleReset = useCallback(() => {
    runningRef.current = false
    stopTicker()
    profilerRecorder.reset()
    profilerRecorder.stop()
    stepRef.current = 0
    setSnapshot(scenario.build(0))
    setDriver({ scenarioId: scenario.id, step: 0, running: false })
    setSummaryText('')
  }, [scenario, stopTicker])

  const handleDump = useCallback(() => {
    const summary = profilerRecorder.summarize()
    const text = formatSummary(summary)
    setSummaryText(text)
    // eslint-disable-next-line no-console
    console.log('[profiler-harness] summary:\n' + text)
    // eslint-disable-next-line no-console
    console.log('[profiler-harness] raw commits:', profilerRecorder.all())
  }, [])

  const isAtEnd = driver.step >= scenario.steps - 1

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 32 }}>
        <View className="p-4 gap-3 border-b border-border">
          <Text className="text-foreground text-xl font-bold">
            Chat streaming profiler
          </Text>
          <Text className="text-muted-foreground text-xs">
            Platform: {Platform.OS} · DevTools host:{' '}
            {process.env.EXPO_PUBLIC_DEVTOOLS_HOST ?? 'localhost'}:
            {process.env.EXPO_PUBLIC_DEVTOOLS_PORT ?? '8097'}
          </Text>

          <View className="gap-1">
            <Text className="text-foreground text-sm font-semibold">Scenario</Text>
            <View className="flex-row flex-wrap gap-2">
              {SCENARIOS.map((sc, i) => (
                <Toggle
                  key={sc.id}
                  label={sc.title}
                  active={i === scenarioIdx}
                  onPress={() => setScenarioIdx(i)}
                  testID={`scenario-${sc.id}`}
                />
              ))}
            </View>
          </View>

          <View className="gap-1">
            <Text className="text-foreground text-sm font-semibold">Tick speed</Text>
            <View className="flex-row flex-wrap gap-2">
              {SPEEDS.map((s, i) => (
                <Toggle
                  key={s.label}
                  label={s.label}
                  active={i === speedIdx}
                  onPress={() => setSpeedIdx(i)}
                  testID={`speed-${i}`}
                />
              ))}
            </View>
          </View>

          <View className="flex-row gap-2 mt-2">
            <Action
              label={driver.running ? 'Running\u2026' : isAtEnd ? 'Replay' : 'Start'}
              disabled={driver.running}
              onPress={() => {
                if (isAtEnd) handleReset()
                handleStart()
              }}
              testID="start"
            />
            <Action
              label="Pause"
              disabled={!driver.running}
              onPress={handlePause}
              testID="pause"
            />
            <Action label="Reset" onPress={handleReset} testID="reset" />
            <Action label="Dump summary" onPress={handleDump} testID="dump" />
          </View>

          <Text className="text-muted-foreground text-xs">
            Step {driver.step} / {scenario.steps - 1} · Recorder:{' '}
            {profilerRecorder.isRecording() ? 'on' : 'off'}
          </Text>
        </View>

        {summaryText ? (
          <View className="p-4 border-b border-border">
            <Text className="text-foreground text-sm font-semibold mb-1">
              Recorder summary
            </Text>
            <Text className="text-foreground text-[11px] font-mono" selectable>
              {summaryText}
            </Text>
          </View>
        ) : null}

        <View className="p-4">
          <Profiler id="chat-harness" onRender={profilerRecorder.record}>
            <MemoizedTurnList
              messages={snapshot.messages}
              isStreaming={snapshot.isStreaming}
            />
          </Profiler>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

/**
 * Wrap TurnList so we can hand a stable component reference to <Profiler>
 * and useMemo the prop bag. This isolates the harness's own re-render cost
 * from what we're measuring.
 */
function MemoizedTurnList({
  messages,
  isStreaming,
}: {
  messages: UIMessage[]
  isStreaming: boolean
}) {
  const props = useMemo(
    () => ({ messages, isStreaming }),
    [messages, isStreaming],
  )
  return <TurnList {...props} />
}

function Toggle({
  label,
  active,
  onPress,
  testID,
}: {
  label: string
  active: boolean
  onPress: () => void
  testID?: string
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      className={
        active
          ? 'rounded-md bg-primary px-3 py-2'
          : 'rounded-md bg-muted px-3 py-2'
      }
    >
      <Text className={active ? 'text-primary-foreground text-xs' : 'text-foreground text-xs'}>
        {label}
      </Text>
    </Pressable>
  )
}

function Action({
  label,
  onPress,
  disabled,
  testID,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  testID?: string
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      testID={testID}
      className={
        disabled
          ? 'rounded-md bg-muted px-4 py-2 opacity-60'
          : 'rounded-md bg-primary px-4 py-2'
      }
    >
      <Text className={disabled ? 'text-foreground text-xs' : 'text-primary-foreground text-xs'}>
        {label}
      </Text>
    </Pressable>
  )
}

function formatSummary(summary: ReturnType<typeof profilerRecorder.summarize>): string {
  const lines: string[] = []
  lines.push(`Total commits: ${summary.totalCommits}`)
  lines.push('')
  lines.push('id'.padEnd(20) + 'count'.padStart(7) + 'sumMs'.padStart(10) + 'meanMs'.padStart(9) + 'p95Ms'.padStart(8) + 'maxMs'.padStart(8))
  for (const [id, s] of Object.entries(summary.perId).sort(
    (a, b) => b[1].actualMs.sum - a[1].actualMs.sum,
  )) {
    lines.push(
      id.padEnd(20) +
        String(s.commitCount).padStart(7) +
        s.actualMs.sum.toFixed(2).padStart(10) +
        s.actualMs.mean.toFixed(2).padStart(9) +
        s.actualMs.p95.toFixed(2).padStart(8) +
        s.actualMs.max.toFixed(2).padStart(8),
    )
  }
  return lines.join('\n')
}
