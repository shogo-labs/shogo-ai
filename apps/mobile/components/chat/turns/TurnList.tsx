// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TurnList Component (React Native)
 *
 * Container that uses useTurnGrouping and renders TurnGroup components.
 *
 * While a past message is open in the in-place editor (SHO-263) every turn
 * below it is dimmed and non-interactive, under a "N messages below will be
 * replaced" divider, so the user can see exactly what the resend will drop.
 */

import { memo, useLayoutEffect, useRef, type ReactNode } from "react"
import { Platform, Text, View } from "react-native"
import type { LayoutChangeEvent } from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import type { UIMessage } from "@ai-sdk/react"
import { useTurnGrouping } from "./useTurnGrouping"
import { TurnGroup } from "./TurnGroup"
import { RejoinRow } from "./RejoinRow"
import { useMessageEditContext } from "./MessageEditContext"
import { firstDimmedTurnIndex, replacedTurnsLabel } from "./editResend"
import { useTurnWindow, TURN_WINDOW_ROW_GAP } from "./useTurnWindow"
import type { TranscriptScrollSignal } from "./transcript-scroll"
import type { ToolCallData } from "../tools/types"

export interface TurnListProps {
  messages: UIMessage[]
  isStreaming?: boolean
  /**
   * This window believes the turn is live but has not attached to it yet
   * (SHO-297, SHO-366). The reply received so far stays on screen and this
   * draws the "Rejoining live reply…" row under it — the last thing in the
   * transcript.
   */
  rejoining?: boolean
  phase?: string | null
  subagentToolCalls?: ToolCallData[]
  className?: string
  /**
   * Where the transcript ScrollView is (SHO-354). Without it the list still
   * windows to the tail, it just can't mount older turns again on scroll.
   */
  scrollSignal?: TranscriptScrollSignal | null
  /**
   * Scroll the transcript by `dy` px when content above the visible turns
   * changed height (a window expansion, or an estimate turning into a real
   * measurement). The caller must ignore it while following the bottom.
   */
  onContentShift?: (dy: number) => void
  /** Resets the mounted window — a different chat was opened. */
  resetKey?: string | null
}

/**
 * One mounted turn row.
 *
 * On web `onLayout` is driven by a `ResizeObserver` and deferred through
 * `setTimeout(0)`, so a click that lands in the same task as the mount can beat
 * the first measurement. The row's own growth — a work group opening — is then
 * folded into the mount correction and the transcript scrolls out from under
 * the click (SHO-359: the header jumped 190 px, exactly the group body).
 * Measuring the DOM node in a layout effect closes that window: it runs before
 * paint, so no input can arrive first. Native keeps `onLayout` alone.
 */
const TurnRow = function TurnRow({
  turnId,
  onLayout,
  children,
}: {
  turnId: string
  onLayout: (event: LayoutChangeEvent) => void
  children: ReactNode
}) {
  const ref = useRef<View>(null)
  useLayoutEffect(() => {
    if (Platform.OS !== "web") return
    const node = ref.current as unknown as { getBoundingClientRect?: () => DOMRect } | null
    const height = node?.getBoundingClientRect?.().height
    if (!height || height <= 0) return
    onLayout({
      nativeEvent: { layout: { x: 0, y: 0, width: 0, height } },
    } as LayoutChangeEvent)
    // Mount only: later size changes are what `onLayout` is for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <View ref={ref} testID={`turn-row-${turnId}`} className="gap-2" onLayout={onLayout}>
      {children}
    </View>
  )
}

/**
 * Memoized so sibling ChatPanel re-renders (e.g. tab-switch re-renders of the
 * parent, which cascade into every open panel) don't re-run the full
 * TurnGroup / AssistantContent / Markdown render pipeline when the message
 * list itself hasn't changed. Callers MUST pass a referentially stable
 * `subagentToolCalls` (use useMemo) — otherwise memo bails out on every
 * render.
 *
 * The edit-dimming state comes from context, which re-renders this component
 * even when the memo bails out on props.
 *
 * Only a bounded window of turns is mounted (SHO-354): the newest
 * `TURN_WINDOW_SIZE` turns, grown upwards as the person scrolls back through
 * history that is already in memory. Everything older collapses into a single
 * spacer, so a 500-turn chat costs the same to render and lay out as a 30-turn
 * one.
 */
export const TurnList = memo(
  function TurnList({
    messages,
    isStreaming = false,
    rejoining = false,
    phase,
    subagentToolCalls,
    className,
    scrollSignal,
    onContentShift,
    resetKey,
  }: TurnListProps) {
    const turns = useTurnGrouping(messages, isStreaming, subagentToolCalls)
    const ctx = useMessageEditContext()
    const editingMessageId = ctx?.editingMessageId ?? null
    const dimFrom = firstDimmedTurnIndex(turns, editingMessageId)
    const replacedCount =
      ctx && editingMessageId ? ctx.countMessagesAfter(editingMessageId) : 0

    // The divider has to stay on screen while an editor is open, so the turn
    // that owns it (and the one it dims from) are always mounted.
    const turnWindow = useTurnWindow({
      turns,
      resetKey,
      editingIndex: dimFrom >= 0 ? Math.max(0, dimFrom - 1) : undefined,
      scrollSignal,
      onContentShift,
    })
    const { start, spacerHeight, onTurnLayout } = turnWindow

    return (
      // The gap is a style, not a class, so the value the spacer reserves
      // (`TURN_WINDOW_ROW_GAP`) is literally the same number the layout uses.
      <View testID="turn-list" className={cn(className)} style={{ gap: TURN_WINDOW_ROW_GAP }}>
        {start > 0 ? (
          <View testID="turn-window-spacer" style={{ height: spacerHeight }} />
        ) : null}
        {turns.map((turn, index) => {
          if (index < start) return null
          const dimmed = dimFrom >= 0 && index >= dimFrom
          const dimTail = dimFrom > 0 && index === dimFrom - 1
          return (
            <TurnRow key={turn.id} turnId={turn.id} onLayout={onTurnLayout(turn.id)}>
              {dimmed && index === dimFrom ? (
                <View className="flex-row items-center gap-2 py-1">
                  <View className="h-px flex-1 bg-border/60" />
                  <Text className="text-[11px] text-muted-foreground">
                    {replacedTurnsLabel(replacedCount)}
                  </Text>
                  <View className="h-px flex-1 bg-border/60" />
                </View>
              ) : null}
              {/* Only the live turn needs the current phase: it colours the
                  turn being written. Handing it to history would re-render
                  every past turn whenever the phase changes. */}
              <TurnGroup
                turn={turn}
                phase={index === turns.length - 1 ? phase : undefined}
                summaryCard={index === turns.length - 1}
                dimmed={dimmed}
                dimTail={dimTail}
                rejoining={rejoining && index === turns.length - 1}
              />
            </TurnRow>
          )
        })}
        {rejoining ? <RejoinRow /> : null}
      </View>
    )
  },
  (prev, next) =>
    prev.messages === next.messages &&
    prev.isStreaming === next.isStreaming &&
    prev.rejoining === next.rejoining &&
    prev.phase === next.phase &&
    prev.subagentToolCalls === next.subagentToolCalls &&
    prev.className === next.className &&
    prev.scrollSignal === next.scrollSignal &&
    prev.onContentShift === next.onContentShift &&
    prev.resetKey === next.resetKey,
)

export default TurnList
