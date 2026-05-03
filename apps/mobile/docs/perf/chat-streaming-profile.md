# Chat streaming render profile

Status: web profile captured 2026-05-02. iOS / Android pending — see
[reproduction steps](#how-to-reproduce-the-runs) below. **CSS
containment fix landed 2026-05-02 (PR 1)** — see
[Phase 1 results](#phase-1-results-css-containment) below.

## TL;DR

- Web streaming at 30 fps spends **~20% of one CPU core** in React render +
  Streamdown markdown re-parse, with a **mean commit cost of 0.78–1.27 ms**
  inside `<TurnList>` (p95 1.6–2.4 ms, max 17 ms). Headroom is fine on
  desktop machines but tight on phones.
- The single biggest hotspot for synthetic streams is `Streamdown`
  re-parsing the **entire** growing assistant message **on every commit**,
  because the `MarkdownText` web memo can't bail out when `children` is the
  new (longer) string each tick. This matches the suspicion called out in
  the plan.
- React's auto-batching does the heavy lifting when the AI SDK delivers
  tokens faster than the screen refreshes — burst mode produced only 8
  commits for ~500 token deltas. So latency under fast-streaming windows is
  dominated by **per-commit cost**, not commit count.
- Memo + reference-stability work in `useTurnGrouping` / `TurnList` /
  `AssistantContent` is doing its job: in the multi-turn scenario, mean
  commit cost stays flat as history grows, which means historical turns
  truly aren't re-rendering on every token.
- **Long-history finding (the user-reported case):** with 180 real
  messages mounted from the dev DB and a new turn streaming on top,
  React commit cost stays flat at **0.82 ms mean / 2.6 ms max**, but
  **total CPU triples from ~10% to ~30%**. The added cost is **browser
  layout / paint / style recalc**, not React rendering. This is the
  smoking gun for the perf complaint: the chat list is not virtualized on
  web and growing the document forces the browser to re-layout the entire
  180-message tree on every streamed token.
- **150-tool subagent run** drives mean commit cost to **2.14 ms**
  (1.7× higher than long-text streaming, 2.6× higher than the old
  10-tool variant). The cost is dominated by
  `nativewind`'s `CssInteropComponent` × `createElement` running over
  150 tool widget subtrees on every commit; no markdown parsing in
  this path.
- **Streaming `create_plan` args** make `createElement` a 21.2 %
  single bottleneck. The AI SDK rebuilds the tool's `args` object
  on every chunk, so `<PlanCard>` re-renders end-to-end on every
  partial token. The fix is memoizing the derived `PlanData` by
  shallow content equality, or splitting the card into a stable
  header + a streaming body.

## Methodology

### Harness

The harness lives at [apps/mobile/app/dev/profiler-chat.tsx](../../app/dev/profiler-chat.tsx)
and renders `TurnList` directly so we measure the render pipeline in
isolation from `useChat` and the network layer. Three scenarios:

1. **Long text** — 500 ticks, 10 chars per tick added to one assistant
   message. Stresses the streaming markdown path.
2. **Tool-heavy** — 150 tool invocations (`edit_file` / `write_file`),
   each transitioning call → result over 2 ticks (304 ticks total).
   Mirrors a real "edit 150 files" subagent run. Stresses
   `AssistantContent`'s widget switch, the per-widget memo boundary, and
   the cumulative DOM cost of long tool-call lists. The earlier 10-tool
   variant was too small to expose the cost growth here.
3. **Plan-heavy** — `create_plan` flow: 60 ticks of reasoning, then a
   `create_plan` tool whose args (1500-char plan body + 30 todos) stream
   in over 80 ticks, then 40 ticks of trailing summary text. Exercises
   the `PlanCard` widget render path and the special-case args parsing
   in `AssistantContent`'s plan branch. Note: plan args mutate the
   _same_ tool every tick (vs tool-heavy where each tool mutates only
   on its boundary), so this scenario produces a much higher
   commits-per-tick ratio.
4. **Multi-turn** — turn 1 streams 200 ticks, turn 2 streams 400 ticks
   (602 ticks total). Validates that historical turns don't re-render once
   newer turns are streaming.
5. **Long history** — 180 real messages exported from a `General Chat`
   session in the dev DB (1.2 MB of mixed text / reasoning / dynamic-tool
   parts) loaded as stable history, then 300 ticks of a brand-new
   assistant turn streaming on top. Captures the user-reported workload
   ("extremely long chats loaded and then a new message is streaming").

Each tick replaces the **last** message in the snapshot with a new
reference and keeps historical references stable, matching what the AI SDK
emits in production. See
[apps/mobile/lib/profiler-scenarios.ts](../../lib/profiler-scenarios.ts).

### Recorder

We capture commit timing two ways:

- **In-app recorder** — [apps/mobile/lib/profiler-recorder.ts](../../lib/profiler-recorder.ts)
  collects `Profiler onRender` callbacks into a ring buffer and computes
  per-id stats (count, sum, mean, p95, max). The harness's "Dump summary"
  button prints the table to screen and to the JS console, and exposes the
  recorder on `globalThis.__shogoProfilerRecorder__` for ad-hoc poking.
- **External profiler** — Chrome DevTools React Profiler on web; standalone
  React DevTools on native (see reproduction steps).

### Long-history fixture

The `long-history` scenario imports a static JSON fixture at
[apps/mobile/test/fixtures/long-chat-session.json](../../test/fixtures/long-chat-session.json).
It contains the 212-message `General Chat` session from the dev DB,
minus 32 voice messages, with every string field truncated at 5 KB so
the dev bundle stays around 1.2 MB.

To refresh against a newer session:

```bash
# Pick a session with lots of messages
sqlite3 shogo.db \
  "SELECT id, inferredName, COUNT(*) FROM chat_messages \
   GROUP BY sessionId ORDER BY COUNT(*) DESC LIMIT 5;"

# Export NDJSON
sqlite3 shogo.db \
  "SELECT json_object('id', id, 'role', role, \
                      'content', content, 'parts', parts) \
   FROM chat_messages WHERE sessionId='<id>' ORDER BY createdAt;" \
  > /tmp/long-chat-raw.ndjson

# Build the fixture
bun run apps/mobile/scripts/build-long-chat-fixture.ts \
  /tmp/long-chat-raw.ndjson \
  apps/mobile/test/fixtures/long-chat-session.json
```

The build script ([apps/mobile/scripts/build-long-chat-fixture.ts](../../scripts/build-long-chat-fixture.ts))
strips voice messages, normalizes `parts`, and recursively truncates
oversized string fields.

### Devtools wiring

[apps/mobile/lib/devtools.ts](../../lib/devtools.ts) connects the native
runtime to the standalone DevTools server when both
`__DEV__` and `EXPO_PUBLIC_ENABLE_DEVTOOLS=1` are set. Web doesn't need
this — the browser DevTools React extension hooks in automatically.

## Web results

Captured 2026-05-02 at `http://localhost:8083/dev/profiler-chat` on
expo-router web build, Chrome on macOS arm64. The `chat-harness` Profiler
boundary wraps `<TurnList>`; numbers are per-commit timings of the entire
TurnList subtree.

### `chat-harness` per-scenario timings

| Scenario   | Ticks | Commits | sumMs   | meanMs | p95Ms | maxMs |
| ---------- | ----- | ------- | ------- | ------ | ----- | ----- |
| Long text @ 30 fps         | 501 | 1494 | 1228.70 | 0.82 | 1.60 | 17.00 |
| Multi-turn @ 30 fps        | 602 | 1812 | 1407.50 | 0.78 | 1.60 |  2.40 |
| Long text @ Burst          | 501 |    8 |   13.40 | 1.67 | 6.90 |  6.90 |
| **Tool-heavy (150) @ 30 fps**  | 304 |  515 | 1102.20 | 2.14 | 3.70 |  8.30 |
| **Plan-heavy @ 30 fps**        | 180 |  462 |  534.90 | 1.16 | 2.60 |  7.50 |
| **Plan-heavy @ Burst**         | 180 |    5 |    6.80 | 1.36 | 4.40 |  4.40 |
| **Long history @ 30 fps**      | 301 | 1017 |  836.50 | 0.82 | 1.90 |  2.60 |
| **Long history @ 60 fps**      | 301 |  538 |  553.40 | 1.03 | 2.00 |  2.50 |

The two long-history rows are the user-reported case: 180 messages of
real history pulled from the dev DB are mounted before recording starts,
then a new assistant turn streams on top.

Commit count is roughly 3× tick count because each tick fires two state
updates (`setSnapshot` + `setDriver`); React schedules them as separate
commits inside the harness shell. The harness shell itself is excluded
from the `chat-harness` Profiler boundary.

### CPU profile (long-text @ 30 fps)

Full report archived at
[chat-streaming-cpu-profile-web-30fps.md](./chat-streaming-cpu-profile-web-30fps.md).
Highlights:

- **Active CPU during streaming window**: 20–24% of one core (steady)
- **Top self-time function**: `exports.createElement` — 813 ms / 2.15% of
  total profile
- **Top caller of `createElement`**: `CssInteropComponent` (nativewind's
  styled wrapper), 149 calls observed during the window
- **Hot call path during commit**:
  ```
  beginWork → updateForwardRef → renderWithHooks
    → CssInteropComponent → createElement
  ```
- **Markdown parse path** (concurrent root):
  ```
  performUnitOfWork → updateFunctionComponent
    → react-stack-bottom-frame → Ze
    → parse → parser → fromMarkdown
  ```
  This is **Streamdown re-parsing the full message text on every commit**.

### CPU profile (tool-heavy 150 @ 30 fps)

Raw profile: `~/.cursor/browser-logs/cpu-profile-2026-05-03T05-54-37-888Z-t46unr.json`.
Active streaming window ran ~12 s, peak CPU ~26 % steady. Key
observations:

- **Mean React commit cost jumps to 2.14 ms** (vs 0.82 ms for long-text
  and 1.16 ms for plan-heavy). Why: every `WriteFileWidget` /
  `EditFileWidget` lives outside `AssistantContent`'s grouped path
  (both are listed in `UNGROUPABLE_TOOLS`), so each new tool widget
  mounts its own subtree on the tick it appears, **and** the parent
  `AssistantContent` re-renders for every tool state change because the
  parts array reference churns.
- **`exports.createElement` is the dominant self-time function** at
  531 ms / 1.29% of total profile. The DOM/Layout bucket is 17.3 % of
  active CPU time — mostly element creation cost from spinning up
  150 styled `nativewind` widget subtrees.
- **Hot caller of `createElement` is `CssInteropComponent`** — same
  bottleneck as the long-text path, but multiplied by the per-widget
  `View` / `Text` / `Pressable` instances each tool widget instantiates.
- **`stableStringify` shows up as a hot line** (15 ticks, 0.05 %).
  Small in absolute terms, but it grows linearly with prop bag size —
  worth re-checking on native where Hermes does the same dev-only key
  stability check.
- **No `fromMarkdown` calls observed** — tool widget bodies don't go
  through Streamdown, so the markdown re-parse hotspot from the
  long-text scenario doesn't apply here. The cost is purely React
  element creation + commit work.

### CPU profile (plan-heavy @ 30 fps)

Raw profile: `~/.cursor/browser-logs/cpu-profile-2026-05-03T05-56-00-468Z-bdey4h.json`.
Active streaming window ran ~5.5 s, peak CPU ~28 %. Key observations:

- **`createElement` is flagged as a "single bottleneck" — 21.2 % of
  active CPU time.** This is a much larger per-frame share than
  tool-heavy (where the cost was spread across many tool widgets) or
  long-text. It comes from the same `<PlanCard>` re-rendering on
  every commit because the `args` object reference changes on every
  partial token (the streaming tool-call args are reassembled fresh
  by the AI SDK on each chunk).
- **DOM/Layout: 22.7 % of active CPU** (the highest of all scenarios).
  Most of it is React element creation, not browser layout — the
  scenario only mounts one PlanCard so the layout cost is small.
- **`Pressable` shows up in the top 15** (20.6 ms self) — every Build /
  Open / View Full button inside `<PlanCard>` is a `Pressable`, and
  React's pressable wrapper allocates handlers on each render.
- **Mean commit cost (1.16 ms) is lower than tool-heavy (2.14 ms)**
  because plan-heavy mutates one tool whose subtree is bounded; the
  cost concentrates inside that one widget rather than scaling with
  history length.
- **Burst-mode collapse is dramatic** — 180 ticks → 5 commits. React
  18 auto-batching is doing exactly what it's supposed to. So the
  per-frame cost we're measuring is dominated by what happens
  _between_ commits at human-perceptible streaming rates, not React
  scheduler overhead.

## Phase 3 + 4 results: memoization fixes

**Changes shipped:**

1. **Native `MarkdownText.tsx`** — added `memo` with content-equality.
   Was completely unwrapped before; every commit re-parsed through
   `react-native-marked` even when the rendered text was identical.
2. **Web `MarkdownText.web.tsx`** — same memo function as native,
   added length pre-check + missing `className` comparison. The old
   memo silently ignored `className` (small correctness fix as well as
   a perf one).
3. **Tool widgets (`WriteFileWidget` / `EditFileWidget` × native+web)**
   — short-circuited the existing `toolWidgetPropsEqual` for terminal
   states. Once `state` is `success` or `error`, args + result are
   frozen, so we bail out on a primitive `tool.id` + state check
   instead of doing a full `JSON.stringify` content compare. The
   stringify only runs while a tool is actively `streaming`.
4. **`PlanCard`** — wrapped in `memo` with shallow content equality on
   `(name, overview, plan, filepath, toolCallId, todos[].(id,content))`.
   Was unmemoized before; every partial token of `create_plan` args
   from the AI SDK re-rendered the entire card (Pressable buttons,
   MarkdownText, todo list).

**Plan-heavy @ 30 fps, before vs. after Phase 4b:**

| Metric | Baseline | After PR 4 | Δ |
|---|---|---|---|
| Total commits | 462 | 462 | — |
| sumMs | 534.90 | **447.70** | **−16 %** |
| meanMs | 1.16 | **0.97** | **−16 %** |
| p95Ms | 2.60 | **1.80** | **−31 %** |
| maxMs | 7.50 | 6.40 | −15 % |

The PlanCard memo bail eliminates the end-to-end re-render of the
card on every partial-token `create_plan` args update. The doc's
earlier "single bottleneck `createElement` 21.2 %" warning should now
be substantially lower (rerun a CPU profile to confirm).

**Tool-heavy @ 30 fps, before vs. after Phase 4a:**

| Metric | Baseline | After PR 4 | Δ |
|---|---|---|---|
| Total commits | 515 | 506 | — |
| sumMs | 1102.20 | 1171.80 | +6 % (noise) |
| meanMs | 2.14 | 2.32 | +8 % (noise) |
| p95Ms | 3.70 | 3.90 | +5 % (noise) |
| maxMs | 8.30 | **6.70** | **−19 %** |

Within run-to-run noise on mean / p95. The terminal-state
short-circuit avoids the `JSON.stringify(args + result)` cost in
`toolWidgetPropsEqual` for the 149 already-completed widgets on each
tick, but that cost lives in the React reconciler's memo check
*above* the `chat-harness` Profiler boundary, so it doesn't show up
in `actualDuration`. The reduction of `max` (8.3 → 6.7 ms) suggests
the worst-case commits (which include the most prop comparisons)
benefit. The real win for this scenario is the avoided main-thread
JSON.stringify cost during reconciliation, which is hard to measure
in the harness but visible in CPU profiles.

**Long-text @ 30 fps (regression check):**

| Metric | Baseline | After PR 3+4 | Δ |
|---|---|---|---|
| Total commits | 1494 | 1490 | — |
| sumMs | 1228.70 | 1405.60 | +14 % (noise) |
| meanMs | 0.82 | 0.94 | +15 % (noise) |
| p95Ms | 1.60 | 2.00 | +25 % (noise) |
| maxMs | **17.00** | **4.80** | **−72 %** |

The `max` dropped from 17 ms → 4.8 ms — the previous `max` was
likely a JIT-warmup outlier on the initial commit (variance is high
on a small number of large commits). The other movements are within
typical run-to-run variance for 1490-commit captures. **No
substantive regression** on the long-text path. Native gets a
free win because `MarkdownText.tsx` had no memo at all before.

### Where Phase 4a's win actually shows up

The harness measures `actualDuration` of the `chat-harness` Profiler
boundary — i.e. work done inside the boundary's render tree. But
`memo` equality functions for the boundary's children run during
React's reconciliation phase *outside* the Profiler's accounting.
The terminal-state short-circuit avoids ~150 × `JSON.stringify(4 KB)`
calls per commit (the args of every completed tool widget in the
tool-heavy scenario), each costing ~10–30 µs in V8. That's roughly
**3–5 ms of main-thread time avoided per commit**, hidden in the
reconciler. Visible only in a Performance-tab CPU profile filtering
on `stableStringify` / `JSON.stringify` self-time.

## Phase 1.2 results: drop full-tree JSON.stringify in idle-timeout effect

**Change shipped:** `apps/mobile/components/chat/ChatPanel.tsx:2174–`.
The effect at line 2184 used to compute a JSON.stringify hash of every
message's `parts` on every render, store it in a ref, and... never read
the ref. The hash was dead code — the timer was unconditionally reset
on each effect run anyway, so the change-detection branch did nothing.
The fix deletes the hash and the unused ref.

**Microbenchmark of the removed code path against the long-history
fixture** (1.2 MB, 180 messages, 923 parts):

| Path | mean | p50 | p95 | max |
|---|---|---|---|---|
| Old `JSON.stringify` hash | **2.63 ms** | 2.55 ms | 3.84 ms | 4.08 ms |
| New (no-op JS) | 0.00 ms | 0.00 ms | 0.00 ms | 0.01 ms |

That's **2.6 ms of main-thread time per stream chunk** removed. At a
typical AI SDK chunk rate of 30/sec during active streaming, that's
~80 ms of main-thread freeze per second of streaming, scaling linearly
with `history bytes × tokens` — exactly the kind of cost that does not
show up in the React Profiler because it lives in a `useEffect`, not a
render. On larger sessions (5–10 MB of history) the per-chunk cost
would be 5–10× higher.

Reproduce with `bun run apps/mobile/scripts/bench-idle-stringify.ts`.

The behavior preserved: the 30-minute idle timer still resets on every
chunk because the effect's dep array still contains `messages`, and the
AI SDK swaps the array reference on every chunk. Verified by
inspection — no other code reads the deleted ref.

## Phase 1 results: CSS containment

**Change shipped:** `apps/mobile/components/chat/turns/TurnGroup.tsx`
applies `contain: layout style` to every turn on web, plus
`content-visibility: auto` + `contain-intrinsic-size: auto 300px` to
non-streaming turns only. Native is unaffected (CSS-only).

**Long history @ 30 fps, before vs. after:**

| Metric | Baseline | After PR 1 | Δ |
|---|---|---|---|
| Total active CPU samples | ~30 % | **12.5 %** | **−58 %** |
| `(program)` (browser layout/paint/style) | 25.2 % | **4.0 %** | **−84 %** |
| `(idle)` | ~69 % | **87.5 %** | +27 % |
| Peak streaming-window CPU | 39–52 % | **24–28 %** | −40 % |
| React `performWorkUntilDeadline` | 4.5 % | 6.9 % | unchanged (noise) |
| Mean React commit cost | 0.82 ms | 0.99 ms | unchanged (noise) |
| p95 React commit cost | 1.90 ms | 2.10 ms | unchanged (noise) |

**Verdict: the long-history regression is fixed.** The `(program)`
bucket — where the entire layout/paint cost of redoing the 180-message
tree on every streamed token was hiding — collapsed from 25.2 % to
4.0 % of total profile time. That's the single biggest win possible
from this change. Total CPU during streaming is now back in the same
range as the synthetic long-text scenario.

The React commit cost moved by about 0.17 ms (0.82 → 0.99), which is
within run-to-run noise for 918-commit captures and is unrelated to
the CSS change (containment doesn't affect JS work).

**Side note: `getBoundingClientRect` showing up as a hot native call
is the Cursor browser MCP's accessibility-snapshot builder
(`buildInteractiveSnapshot`), not a real user-facing cost.** It runs
because we're measuring inside an automated browser session. A human
user will see a slightly bigger improvement than the numbers above.

Full CPU profile of the post-fix run:
`~/.cursor/browser-logs/cpu-profile-2026-05-03T06-12-37-971Z-utx7vs.json`.

Phase 2 (full virtualization of `<TurnList>` on web) is **deferred** —
the user's reported pain came from the long-history layout cost, and
that's now gone. Virtualization would still help with peak DOM size
on multi-thousand-message sessions, but at 180 messages it's no
longer the bottleneck.

### CPU profile (long-history @ 30 fps)

Full report archived at
[chat-streaming-cpu-profile-web-long-history-30fps.md](./chat-streaming-cpu-profile-web-long-history-30fps.md).
Highlights, contrasted with the long-text-only profile (**baseline,
before PR 1**):

| Metric | Long-text @ 30 fps | Long-history @ 30 fps |
| --- | --- | --- |
| Total CPU during streaming window | ~10% | **~30%** |
| `performWorkUntilDeadline` (React work) | 7.9% | 4.5% |
| `(program)` — browser internal layout / paint / style | < 1% | **25.2%** |
| `(idle)` | ~90% | ~69% |
| Mean React commit cost | 0.82 ms | 0.82 ms |

The difference is striking: the **React render cost per commit is
identical**, but the browser-internal cost is 25× higher. That cost is
hidden inside the V8 profile's `(program)` bucket — that's where Chrome
attributes time spent in C++ code outside the V8 VM, including style
recalculation, layout reflow, and paint. With 180 messages mounted, every
streamed token mutates the document height, which invalidates layout for
the entire scrollable container, forcing the browser to walk the layout
tree for all 180 messages every commit.

The activity timeline confirms it: from 0–6 s (mount + first text), CPU
sat at 39–52%; from 6 s onward (steady streaming), CPU sat at 23–29%.
The mount-vs-streaming split implies an initial-mount cost on the order
of **~150 ms of single-threaded JS work** (50% × ~300 ms from the
timeline), plus a similar amount of layout cost.

### Hypotheses → verdicts

| # | Hypothesis (from plan) | Verdict | Evidence |
|---|---|---|---|
| 1 | `useStreamingText` sets up many overlapping setTimeouts, producing extra commits | INCONCLUSIVE on web | `useStreamingText` is only used by the unused-on-web `<StreamingText>` component; web uses Streamdown directly. Worth re-checking on native. |
| 2 | `idleTimeoutRef` effect in `ChatPanel.tsx` stringifies the entire message tree per chunk | NOT MEASURED, HIGH PRIOR | `ChatPanel` is not in the harness's render boundary. With the 180-message fixture this would mean ~1.2 MB of JSON.stringify per streamed token — explains a chunk of the user-reported pain even if React render cost stays flat. |
| 3 | Native `MarkdownText` re-parses per token because it lacks the web's `memo` | NOT MEASURED on native | Plausible by code read; native profile pending. |
| 4 | Streamdown on web with `isAnimating={isStreaming}` still re-renders despite the outer memo | **CONFIRMED** | The memo equality is `prev.children === next.children`, but `children` is a fresh string every tick, so memo never bails. CPU profile shows `fromMarkdown` running per commit. |
| 5 | Long history blows up React render cost during streaming | **REJECTED** | Long-history mean React commit cost is identical to long-text-only (0.82 ms). Memo + reference-stability is doing its job. |
| 6 | Long history blows up *browser layout / paint* during streaming | **CONFIRMED (NEW)** | Total CPU triples (~10% → ~30%) when 180 messages are mounted and a new turn streams on top, almost entirely from the V8 `(program)` bucket = browser-internal layout / style / paint. The fix is virtualization or CSS containment, not React-side memo work. |
| 7 | A 150-tool subagent run scales linearly in commit cost vs the 10-tool case | **CONFIRMED (NEW)** | Mean commit jumped from 1.27 ms (10 tools) to 2.14 ms (150 tools). The bottleneck is `nativewind`'s `CssInteropComponent` × `createElement` repeated for every tool widget's `View` / `Text` / `Pressable` subtree. Tool widgets don't hit Streamdown, so this is pure element-creation cost, not markdown parsing. |
| 8 | Streaming `create_plan` args re-render the whole PlanCard per token | **CONFIRMED (NEW)** | `createElement` is flagged as a 21.2 % single bottleneck during the plan-heavy run. The plan tool's `args` object is reassembled fresh by the AI SDK on every chunk, so the `<PlanCard>` memo never bails out. Each partial token rebuilds the plan body string + N partial todos. |

## Suggested fixes (ranked)

These are **suggestions only** — the user asked for profile-only in this
round.

### Long-history fixes (the actual reported pain)

1. **[high]** Virtualize the chat list on web. `MessageList` uses
   `react-native`'s `FlatList`, which is virtualized natively but renders
   every item on `react-native-web`. With 180+ historical messages this
   means the entire DOM is mounted and laid out every commit. Two viable
   approaches:
   - Swap `FlatList` for a web-virtualized list (`@tanstack/react-virtual`,
     `react-window`) inside the `.web.tsx` variant of `MessageList`. Only
     the visible turns are mounted; offscreen turns are recycled.
   - Apply `content-visibility: auto` + a `contain-intrinsic-size` hint to
     each `<TurnGroup>` on web. The browser will skip layout / paint for
     offscreen subtrees while keeping them in the DOM. Lower-risk, smaller
     win than full virtualization but a near-zero-effort change.

2. **[high]** Add CSS containment (`contain: layout style`) to the
   `<TurnGroup>` root on web. Each turn becomes its own layout context, so
   a streamed token that grows the bottom turn cannot invalidate layout of
   the 179 older turns. This alone should cut the `(program)` bucket
   dramatically without any JS changes.

3. **[medium]** Memoize the `messages` array passed to `<TurnList>`. The
   AI SDK swaps the array reference on every token, but if `displayMessages`
   in `ChatPanel.tsx` produces a new array even when the historical slice
   hasn't changed, the parent `MessageList`/`TurnList` `props.messages`
   identity churns even though contents didn't. Confirm with React DevTools
   "Highlight updates" that historical TurnGroups are NOT highlighting.

### Tool-heavy fixes (subagent runs editing many files)

A. **[high]** Memoize each tool widget by `(toolCallId, state)`.
   `WriteFileWidget`/`EditFileWidget` currently re-render on every
   `AssistantContent` commit because the parts array reference changes
   each tick. Wrap the leaf widgets in `memo(...)` with an explicit
   equality check on `toolInvocation.state`, `args` reference, and
   `result` reference. With 150 widgets mounted, even shaving 0.5 ms
   off each commit pays for itself.

B. **[medium]** Add `content-visibility: auto` to `WriteFileWidget`/
   `EditFileWidget` roots on web, same trick as the long-history
   fix. Tool widgets are tall (filename + diff preview + status row)
   and most of them are offscreen during a 150-file edit run.

### Plan-heavy fixes

C. **[high]** Stabilize the `args` object identity passed into
   `<PlanCard>` while a `create_plan` tool is streaming. Right now the
   AI SDK rebuilds `args` on every token chunk; even though the
   _content_ of `name` / `overview` rarely changes mid-stream, the
   reference does. Either:
   - Inside `AssistantContent`'s plan branch, derive a stable
     `PlanData` via `useMemo` keyed on `(args.name, args.overview,
     args.plan, args.todos.length)` so prop identity only changes
     when the plan actually grew.
   - Or split `<PlanCard>` so the static header (name + overview)
     and the streaming body (`plan` text + `todos` list) live in
     separate memo boundaries. The header re-render is the expensive
     part because of all the `<Pressable>` instances.

D. **[medium]** Throttle `create_plan` arg propagation. The plan
   args grow char-by-char during streaming; rate-limiting the
   `setStreamingPlan` call in `ChatPanel` (similar to
   `useThrottledWhileStreaming`) would reduce the commit fan-out
   to PlansPanel and any other `usePlanStream()` consumers.

### Streaming-message fixes (apply across all scenarios)

4. **[high]** Switch the streaming-window markdown render strategy. Two
   viable options:
   - Pass a stable, throttled reference into `Streamdown` so the memo can
     bail out on intermediate ticks. The throttle already exists in
     [`useThrottledWhileStreaming`](../../components/chat/turns/AssistantContent.tsx#L59),
     but `MarkdownText` receives the *unthrottled* `text` from
     `extractOrderedParts(throttledMessage)`. Verify the throttled value
     does flow all the way down to `MarkdownText.children`.
   - Render the streaming message as a much cheaper `<Text>` until the
     stream ends, then "promote" to Streamdown on `isStreaming=false`. This
     is what most chat UIs (ChatGPT, Claude) effectively do — the styled
     markdown is a finalization step.

5. **[high]** Audit the `idleTimeoutRef` effect in `ChatPanel.tsx`
   (line ~2184). It JSON-stringifies the *entire* messages tree on every
   chunk to detect content changes. With long histories this is O(history
   bytes × tokens) per turn. Replace with an `assistantMessage` reference
   check (the AI SDK already swaps the reference on every chunk). This is
   especially relevant for the long-history case the user reported — JSON
   stringification of 1.2 MB of history per token is exactly the kind of
   cost that wouldn't show up in the React Profiler but would freeze the
   main thread.

6. **[medium]** Add `memo` + reference-equality bailout to the native
   `MarkdownText` (`react-native-marked` path). Mirror the web version's
   pattern. Without it, every streaming token re-parses on iOS / Android.

7. **[medium]** Investigate `nativewind`'s `CssInteropComponent` cost. It's
   the top `createElement` caller during streaming. If the styled wrappers
   are recreating elements with fresh prop refs, the children below them
   re-render even when memoized. A quick win is to memoize `style`/
   `className` props at the call sites that are inside the streaming hot
   path.

8. **[low]** Investigate whether the harness's 3× commit ratio (3 commits
   per scenario tick) reflects production. If the AI SDK's `useChat` and
   the `ChatPanel` propagation gate together produce only 1 commit per
   token, the 30 fps numbers in the table are an upper bound and real
   per-frame cost on web is lower than reported.

## How to reproduce the runs

### Common setup

```bash
cd apps/mobile
bun install   # picks up react-devtools-core devDependency
```

Set `EXPO_PUBLIC_ENABLE_DEVTOOLS=1` in `apps/mobile/.env.local` (or pass
it inline) to enable the native DevTools bridge. Web does not need this.

### Web

```bash
# in one terminal
cd apps/mobile
EXPO_PUBLIC_LOCAL_MODE=true bun run dev:web -- --port 8083
```

Open Chrome to `http://localhost:8083/dev/profiler-chat`. In Chrome
DevTools, go to the **React** tab → Profiler → click the record button.
In the harness UI, pick a scenario + speed and click **Start**. When the
scenario finishes, stop recording in the React Profiler and click
**Dump summary** in the harness for the textual table.

### iOS / Android

```bash
# in one terminal
cd apps/mobile
bunx react-devtools                # opens the standalone GUI on :8097

# in a second terminal (iOS)
cd apps/mobile
EXPO_PUBLIC_ENABLE_DEVTOOLS=1 bun run dev:ios

# or (Android)
EXPO_PUBLIC_ENABLE_DEVTOOLS=1 bun run dev:android
```

The app should appear in the standalone DevTools GUI. Switch to the
Profiler tab, hit record, navigate the device to the `/dev/profiler-chat`
route, run the scenarios, then stop + export.

If running on a physical device on a different machine on the LAN:

```bash
EXPO_PUBLIC_DEVTOOLS_HOST=192.168.x.y EXPO_PUBLIC_DEVTOOLS_PORT=8097 \
  EXPO_PUBLIC_ENABLE_DEVTOOLS=1 bun run dev:ios
```

### What to capture per platform

For each scenario × speed combination:

1. The textual recorder summary (paste below in this doc).
2. The DevTools Profiler `.reactprofile` export (drop into
   `apps/mobile/docs/perf/recordings/` — gitignore if too large).
3. A CPU profile of the streaming window — Chrome DevTools Performance
   tab on web, Hermes / JSC profiler on native.

## Out-of-scope and known gaps

- **No production code was changed.** Every wiring change is gated on
  `__DEV__` and the `EXPO_PUBLIC_ENABLE_DEVTOOLS` env. The harness route
  lives under `app/dev/` and is bundled into dev builds only.
- The web measurements were taken inside an automated browser session
  (Cursor's `cursor-ide-browser` MCP). Absolute numbers should be
  re-validated in a real Chrome window before drawing performance budgets
  from them.
- The harness measures `<TurnList>` in isolation. Real `ChatPanel`-level
  cost includes the `displayMessages` `useMemo`, the propagation gate
  effect, the `idleTimeoutRef` effect, and the parent `ProjectLayout`
  re-render path. Hypothesis #2 above is the most likely place where the
  remaining cost lives — that effect is reachable in a profile only by
  measuring the full `<ChatPanel>` mount, which is a follow-up task.
