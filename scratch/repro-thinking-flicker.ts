/**
 * Reproduces (and now demonstrates the fix for) the "thinking widget
 * rapidly expanding and closing while scrolling the whole screen" bug
 * observed during chat streaming.
 *
 * Run with:
 *   bun scratch/repro-thinking-flicker.ts            # post-fix (default)
 *   bun scratch/repro-thinking-flicker.ts --pre-fix  # pre-fix behaviour
 *
 * --------------------------------------------------------------------
 * Where the bug lives
 * --------------------------------------------------------------------
 *
 *   apps/mobile/components/chat/turns/ThinkingWidget.tsx     (per-block widget)
 *   apps/mobile/components/chat/turns/AssistantContent.tsx   (renders one widget per reasoning part)
 *   apps/mobile/components/chat/turns/messageParts.ts        (extract per-part isStreaming)
 *   apps/mobile/components/chat/ChatPanel.tsx                (parent ScrollView auto-scroll on contentSizeChange)
 *
 * --------------------------------------------------------------------
 * Why the visual effect happens
 * --------------------------------------------------------------------
 *
 * 1. Modern reasoning models (Claude with extended thinking, GPT-5 with
 *    interleaved reasoning, etc.) emit MULTIPLE reasoning-start/end blocks
 *    within a single assistant turn — one before each tool call, plus
 *    one before the final text. The AI SDK (`process-ui-message-stream.ts`,
 *    case `reasoning-start`) pushes a brand-new ReasoningUIPart for every
 *    `reasoning-start` chunk, so each block becomes its own
 *    `ThinkingWidget` keyed by `reasoning-${index}` in `messageParts.ts`.
 *
 * 2. Each widget runs an open/close height spring (~500ms,
 *    underdamped: damping=22, stiffness=260, mass=1, ζ ≈ 0.68). On mount
 *    it springs 0 → ~200px. After its own `state` flips to "done"
 *    (a07c6a07) the widget waits 3s, then springs ~200 → 0.
 *
 * 3. With N reasoning blocks per turn and tool calls between them, the
 *    timeline ends up being (roughly):
 *
 *       t=0.0  reasoning A start  → A opens
 *       t=0.5  A done             → A schedules close at t=3.5
 *       t=0.6  tool A             → ...
 *       t=1.5  reasoning B start  → B opens (A still open)
 *       t=2.0  B done             → B schedules close at t=5.0
 *       t=2.1  tool B             → ...
 *       t=3.0  reasoning C start  → C opens (A, B still open)
 *       t=3.5  A close fires      → A springs 200→0  ⟵ height jumps
 *       t=3.5  B done             → ...
 *       t=5.0  B close fires      → B springs 200→0  ⟵ height jumps
 *       …
 *
 *    Because each close is its own asynchronous timer, the chat-column
 *    height visibly bounces several times during a turn. That's the
 *    "rapidly expanding and closing".
 *
 * 4. `ChatPanel`'s outer ScrollView (line ~4207, `onContentSizeChange`)
 *    calls `throttledScrollToEnd()` every time the content height
 *    changes while `stickToBottomRef` is true. So every spring frame
 *    of every widget that is currently open or closing triggers an
 *    auto-scroll. That is the "scrolling the whole screen" half.
 *
 * 5. There's also a one-shot artefact on first paint of every widget:
 *    the hidden measurer reports a height X (no padding correction),
 *    then the visible ScrollView reports `Math.ceil(h + 20)` →
 *    different value → spring re-targets. The inner ScrollView ALSO
 *    `scrollToEnd({ animated: false })` on every contentSizeChange
 *    while streaming, which feeds the parent's contentSizeChange.
 *
 * --------------------------------------------------------------------
 * What this script does
 * --------------------------------------------------------------------
 *
 * Below is a faithful re-implementation of `ThinkingWidget`'s open/close
 * state machine (the parts of the React useEffect that drive `isOpen`
 * + the 3s auto-close timer) and a small scheduler that drives N of
 * them through a realistic interleaved-thinking turn. The output is a
 * timeline showing how many widgets are simultaneously animating
 * (open, opening, closing) at every 100ms tick. Look for ticks where
 * the count changes 2-3 times within ~600ms — those are the visual
 * jumps the user is reporting.
 *
 * Run with:   bun run scratch/repro-thinking-flicker.ts
 */

const AUTO_CLOSE_DELAY_MS = 3000      // ThinkingWidget.tsx
const SPRING_DURATION_MS  = 500       // approximate spring settle time
const TICK_MS             = 50

// Post-fix mode is the default. Pass --pre-fix to see the cascade.
const PRE_FIX = process.argv.includes('--pre-fix')

interface Widget {
  id: string
  isStreaming: boolean
  // ThinkingWidget state
  isOpen: boolean
  // Animation phase. The visible height comes from a spring; we model
  // the "user-visible movement" as a window of `SPRING_DURATION_MS`
  // after every isOpen transition.
  lastTransitionAt: number
  closeTimerAt: number | null
  // history for the timeline
  events: Array<{ t: number; kind: 'mount' | 'open' | 'close' | 'end' }>
}

function newWidget(id: string, t: number, isStreaming: boolean): Widget {
  // useState(isStreaming): widget mounts with isOpen = isStreaming.
  // The mount-effect then re-asserts the same.
  return {
    id,
    isStreaming,
    isOpen: isStreaming,
    lastTransitionAt: t,
    closeTimerAt: null,
    events: [{ t, kind: 'mount' }],
  }
}

/** Faithful translation of ThinkingWidget's useEffect on isStreaming. */
function setStreaming(w: Widget, t: number, streaming: boolean) {
  if (w.isStreaming === streaming) return
  w.isStreaming = streaming
  if (streaming) {
    w.closeTimerAt = null
    if (!w.isOpen) {
      w.isOpen = true
      w.lastTransitionAt = t
      w.events.push({ t, kind: 'open' })
    }
  } else {
    w.closeTimerAt = t + AUTO_CLOSE_DELAY_MS
    w.events.push({ t, kind: 'end' })
  }
}

function tickCloseTimer(w: Widget, t: number) {
  if (w.closeTimerAt !== null && t >= w.closeTimerAt) {
    w.closeTimerAt = null
    if (w.isOpen) {
      w.isOpen = false
      w.lastTransitionAt = t
      w.events.push({ t, kind: 'close' })
    }
  }
}

/** A widget is "visually animating" for SPRING_DURATION_MS after a transition. */
function isAnimating(w: Widget, t: number): boolean {
  return t - w.lastTransitionAt < SPRING_DURATION_MS
}

// --------------------------------------------------------------------
// Scenario: a single assistant turn with 5 interleaved reasoning blocks
// (typical for Claude extended-thinking or GPT-5 with reasoning).
// --------------------------------------------------------------------

interface Event {
  t: number
  kind: 'reasoning-start' | 'reasoning-end'
  partId: string
}

const turn: Event[] = [
  // A realistic short-burst pattern: model thinks for ~400ms, fires a
  // fast tool (~250ms locally cached read), thinks for ~400ms, etc.
  // Five reasoning bursts within ~3s of streaming.
  { t:    0, kind: 'reasoning-start', partId: 'r0' },
  { t:  400, kind: 'reasoning-end',   partId: 'r0' },
  { t:  650, kind: 'reasoning-start', partId: 'r1' },
  { t: 1050, kind: 'reasoning-end',   partId: 'r1' },
  { t: 1300, kind: 'reasoning-start', partId: 'r2' },
  { t: 1700, kind: 'reasoning-end',   partId: 'r2' },
  { t: 1950, kind: 'reasoning-start', partId: 'r3' },
  { t: 2350, kind: 'reasoning-end',   partId: 'r3' },
  { t: 2600, kind: 'reasoning-start', partId: 'r4' },
  { t: 3000, kind: 'reasoning-end',   partId: 'r4' },
]

const SIM_END_MS = 8_000  // long enough for all close timers to fire

const widgets = new Map<string, Widget>()

/**
 * Post-fix coalescing: consecutive reasoning bursts (no other part
 * type between them) all map to the same widget. We model that here
 * by mapping every partId to "merged" when --pre-fix is NOT set.
 *
 * In `messageParts.ts` `extractOrderedParts`, the merged widget's id
 * is `reasoning-${firstIndexInRun}` and remains stable as later
 * bursts get appended into it. `isStreaming` on the merged widget is
 * `true` whenever ANY sub-burst is streaming, which is what we
 * emulate below by counting active bursts.
 */
function widgetIdFor(partId: string): string {
  return PRE_FIX ? partId : 'merged'
}

const activeBurstCount: { [partId: string]: number } = {}

function processEvent(e: Event) {
  const wid = widgetIdFor(e.partId)
  if (e.kind === 'reasoning-start') {
    activeBurstCount[wid] = (activeBurstCount[wid] ?? 0) + 1
    if (!widgets.has(wid)) {
      widgets.set(wid, newWidget(wid, e.t, true))
    } else {
      setStreaming(widgets.get(wid)!, e.t, true)
    }
  } else {
    activeBurstCount[wid] = Math.max(0, (activeBurstCount[wid] ?? 0) - 1)
    if (activeBurstCount[wid] === 0) {
      setStreaming(widgets.get(wid)!, e.t, false)
    }
  }
}

const eventsByT = new Map<number, Event[]>()
for (const e of turn) {
  if (!eventsByT.has(e.t)) eventsByT.set(e.t, [])
  eventsByT.get(e.t)!.push(e)
}

// Drive the simulation in TICK_MS slices.
const timeline: Array<{
  t: number
  open: number
  animating: number
  changedThisTick: string[]
}> = []

let prevOpen = 0
const widgetIdsBeforeTick = new Set<string>()

for (let t = 0; t <= SIM_END_MS; t += TICK_MS) {
  // 1. Fire scheduled events (reasoning-start / reasoning-end) for this tick.
  for (const e of eventsByT.get(t) ?? []) processEvent(e)
  // 2. Fire any close timers that should have elapsed by now.
  for (const w of widgets.values()) tickCloseTimer(w, t)

  // 3. Snapshot.
  let open = 0
  let animating = 0
  const changed: string[] = []
  for (const w of widgets.values()) {
    if (w.isOpen) open++
    if (isAnimating(w, t)) animating++
    // Detect a transition that just happened on this tick
    const lastEvent = w.events[w.events.length - 1]
    if (lastEvent && Math.abs(lastEvent.t - t) < TICK_MS / 2) {
      changed.push(`${w.id}:${lastEvent.kind}`)
    }
  }
  timeline.push({ t, open, animating, changedThisTick: changed })
  prevOpen = open
}

// --------------------------------------------------------------------
// Print the timeline. Look for clusters where `animating` jumps to ≥2
// — those are the moments the user perceives as "rapid expand/close".
// --------------------------------------------------------------------

console.log(`mode: ${PRE_FIX ? 'pre-fix (one widget per reasoning-start)' : 'post-fix (consecutive bursts coalesced into one widget)'}`)
console.log('time(ms)  open animating  events')
console.log('--------  ---- ---------  ------')
let prevAnimating = -1
let prevOpenLine = -1
let suppressed = 0
for (const row of timeline) {
  const interesting =
    row.changedThisTick.length > 0 ||
    row.animating !== prevAnimating ||
    row.open !== prevOpenLine
  if (!interesting) {
    suppressed++
    continue
  }
  if (suppressed > 0) {
    console.log(`     ...   (${suppressed} unchanging ticks)`)
    suppressed = 0
  }
  console.log(
    String(row.t).padStart(7) +
    '  ' +
    String(row.open).padStart(4) +
    '  ' +
    String(row.animating).padStart(8) +
    '   ' +
    row.changedThisTick.join(' ')
  )
  prevAnimating = row.animating
  prevOpenLine = row.open
}
if (suppressed > 0) {
  console.log(`     ...   (${suppressed} unchanging ticks)`)
}

console.log('')
console.log('Summary:')
console.log(`  ${widgets.size} ThinkingWidget instances over ${SIM_END_MS} ms`)
const allTransitions = [...widgets.values()]
  .flatMap((w) =>
    w.events
      .filter((e) => e.kind === 'mount' || e.kind === 'close')
      .map((e) => ({ t: e.t, kind: e.kind, id: w.id })),
  )
  .sort((a, b) => a.t - b.t)
const transitionsIn600ms = allTransitions.filter((t, i) =>
  allTransitions.slice(i + 1).some((t2) => t2.t - t.t < 600),
).length
console.log(
  `  ${allTransitions.length} widget mount+close transitions; ` +
  `${transitionsIn600ms} of them are followed by another transition within 600ms`,
)
console.log(`  → these clusters are what the user sees as "expanding and closing rapidly".`)
console.log(`  Each transition is also a content-size change, which ChatPanel.tsx (~line 4207)`)
console.log(`  forwards to throttledScrollToEnd → "scrolling the whole screen".`)
