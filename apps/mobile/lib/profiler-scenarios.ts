// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Synthetic message scenarios for the chat-streaming profiler harness.
 *
 * Each scenario is a generator that yields a sequence of UIMessage[] snapshots.
 * The contract matches what the AI SDK produces in real life:
 *
 *   1. Historical messages keep stable object references across snapshots.
 *      This is what lets `useTurnGrouping` reuse turns and `React.memo` bail
 *      out of the historical TurnGroup chain.
 *   2. Only the LAST message in the array is replaced with a new reference
 *      per tick. Its `parts` array is also a new reference, but earlier
 *      parts inside it are reused where possible.
 *
 * If we accidentally produced new references for historical messages, we'd
 * be measuring a different (and more pessimistic) workload than what the
 * real AI SDK emits.
 */
import type { UIMessage } from '@ai-sdk/react'
import longChatFixture from '../test/fixtures/long-chat-session.json'

const LOREM = (
  'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. ' +
  'Sphinx of black quartz judge my vow. How vexingly quick daft zebras jump. ' +
  'Bright vixens jump dozy fowl quack. Cwm fjord bank glyphs vext quiz. ' +
  'Junk MTV quiz graced by fox whelps. Watch Jeopardy! Alex Trebek fan club. ' +
  'A wizard\u2019s job is to vex chumps quickly in fog. Heavy boxes perform quick waltzes and jigs.'
).repeat(20)

function tokensFromText(text: string, count: number): string {
  if (count <= 0) return ''
  return text.slice(0, count)
}

function userMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
  } as unknown as UIMessage
}

function assistantText(id: string, text: string): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', text }],
  } as unknown as UIMessage
}

function toolInvocation(
  toolCallId: string,
  toolName: string,
  state: 'streaming' | 'result' | 'error',
  args: Record<string, unknown> = {},
  result: unknown = null,
): unknown {
  return {
    type: 'tool-invocation',
    toolInvocation: {
      toolCallId,
      toolName,
      state: state === 'result' ? 'result' : state === 'error' ? 'error' : 'call',
      args,
      ...(state === 'result' ? { result } : {}),
    },
  }
}

export interface Scenario {
  id: string
  title: string
  /** Total ticks (snapshots) the scenario produces. */
  steps: number
  /**
   * Build the messages for `step` (0..steps-1). Implementations MUST keep
   * historical message references stable; only the last message should be
   * a fresh object on each call.
   */
  build(step: number): { messages: UIMessage[]; isStreaming: boolean }
}

/**
 * Long-text scenario:
 * one user message + one assistant message that grows by ~10 chars/tick for
 * 500 ticks, ending with a final isStreaming=false snapshot.
 *
 * Stresses: useStreamingText, useThrottledWhileStreaming, MarkdownText, the
 * assistant-content memo chain.
 */
export function longTextScenario(): Scenario {
  const u = userMessage('u-long', 'Tell me a long story.')
  const TOKEN_PER_STEP = 10
  const STEPS = 500

  return {
    id: 'long-text',
    title: 'Long text (500 ticks, 10 chars per tick)',
    steps: STEPS + 1,
    build(step) {
      const isFinal = step === STEPS
      const tokens = Math.min((isFinal ? STEPS : step) * TOKEN_PER_STEP, LOREM.length)
      const text = tokensFromText(LOREM, tokens)
      const a = assistantText('a-long', text)
      return {
        messages: [u, a],
        isStreaming: !isFinal,
      }
    },
  }
}

/**
 * Tool-heavy scenario:
 * 150 tool invocations interleaved with text. Each tool transitions
 * call -> result over 2 ticks (call appears, then result lands). With
 * UNGROUPABLE_TOOLS including `write_file`/`edit_file`, every one of these
 * tools renders its own styled `WriteFileWidget`/`EditFileWidget`, so this
 * scenario stresses the widget switch in `AssistantContent`, the message
 * parts ordering pass, and the per-commit memoization of all 150 widgets.
 *
 * Stresses: AssistantContent groupedParts pipeline, the per-widget memo
 * boundary, and the cumulative DOM cost of long tool-call lists. Mirrors
 * a real "edit 150 files" subagent run.
 */
export function toolHeavyScenario(): Scenario {
  const u = userMessage('u-tools', 'Refactor the auth module across 150 files.')
  const TOOL_COUNT = 150
  const TICKS_PER_TOOL = 2 // tick 0: call appears; tick 1: result lands
  const STEPS = TOOL_COUNT * TICKS_PER_TOOL + 4 // small text-tail at the end

  return {
    id: 'tool-heavy',
    title: `Tool-heavy (${TOOL_COUNT} tools, ${TICKS_PER_TOOL} ticks each)`,
    steps: STEPS + 1,
    build(step) {
      const parts: unknown[] = [{ type: 'text', text: 'Working on it.\n' }]

      for (let t = 0; t < TOOL_COUNT; t++) {
        const toolStart = t * TICKS_PER_TOOL
        if (step < toolStart) break

        const ticksIntoTool = step - toolStart
        const isResult =
          ticksIntoTool >= TICKS_PER_TOOL - 1 || step > TOOL_COUNT * TICKS_PER_TOOL
        parts.push(
          toolInvocation(
            `tc-${t}`,
            t % 2 === 0 ? 'edit_file' : 'write_file',
            isResult ? 'result' : 'streaming',
            { filepath: `src/auth/file-${t}.ts`, content: 'new content' },
            isResult ? { ok: true, bytesWritten: 1234 + t } : null,
          ),
        )

        if (isResult && t % 25 === 24) {
          // Sprinkle in occasional progress text so we exercise the
          // text/tool interleave in `AssistantContent` rather than rendering
          // a homogeneous widget list.
          parts.push({ type: 'text', text: `Done with batch ending at file ${t}.\n` })
        }
      }

      const isFinal = step >= STEPS
      const a = {
        id: 'a-tools',
        role: 'assistant' as const,
        parts,
      } as unknown as UIMessage

      return {
        messages: [u, a],
        isStreaming: !isFinal,
      }
    },
  }
}

/**
 * Plan-heavy scenario:
 * Reasoning streams, then a `create_plan` tool fires with a substantial
 * plan body and 30 todos, then a final text summary streams. Exercises the
 * `PlanCard` widget render path and the special-case args parsing in
 * `AssistantContent`'s plan branch.
 *
 * Mirrors what plan-mode submissions produce: a single big tool call whose
 * args are large enough that streaming-time parsing matters.
 */
export function planHeavyScenario(): Scenario {
  const u = userMessage(
    'u-plan',
    'Plan a migration of our auth stack from Auth0 to BetterAuth.',
  )
  const TODO_COUNT = 30
  const REASONING_TICKS = 60
  const PLAN_BODY_TICKS = 80 // tool args stream in over this window
  const TAIL_TICKS = 40
  const STEPS = REASONING_TICKS + PLAN_BODY_TICKS + TAIL_TICKS

  const todos = Array.from({ length: TODO_COUNT }, (_, i) => ({
    id: `todo-${i}`,
    content:
      `Step ${i + 1}: ` +
      [
        'Audit current auth0 usage',
        'Map session shape to BetterAuth',
        'Migrate identity providers',
        'Rewrite middleware',
        'Backfill user records',
      ][i % 5] +
      ' ' +
      tokensFromText(LOREM, 20 + (i % 5) * 10),
  }))

  const PLAN_BODY = (
    'Migrate the authentication stack from Auth0 to BetterAuth in three ' +
    'phases. Each phase isolates a layer of the stack so we can ship in ' +
    'parallel without a long-lived feature flag fan-out.\n\n' +
    LOREM.slice(0, 1500)
  )

  return {
    id: 'plan-heavy',
    title: `Plan-heavy (reasoning + create_plan with ${TODO_COUNT} todos)`,
    steps: STEPS + 1,
    build(step) {
      const isFinal = step >= STEPS
      const parts: unknown[] = []

      // Phase 1: reasoning streams
      const reasoningTokens = Math.min(step, REASONING_TICKS) * 25
      parts.push({
        type: 'reasoning',
        reasoning: tokensFromText(LOREM, reasoningTokens),
      })

      // Phase 2: create_plan tool appears once reasoning is done.
      if (step >= REASONING_TICKS) {
        const planTick = Math.min(
          step - REASONING_TICKS,
          PLAN_BODY_TICKS,
        )
        const ratio = planTick / PLAN_BODY_TICKS
        // Stream the plan body progressively until ratio hits 1.
        const partialPlan = PLAN_BODY.slice(
          0,
          Math.floor(PLAN_BODY.length * ratio),
        )
        // Reveal todos progressively (chunk-by-chunk) so we exercise the
        // todos array growing during the tool's "streaming" phase.
        const todosShown = Math.floor(TODO_COUNT * ratio)
        const isPlanComplete = ratio >= 1

        parts.push(
          toolInvocation(
            'tc-plan',
            'create_plan',
            isPlanComplete ? 'result' : 'streaming',
            {
              name: 'Auth0 \u2192 BetterAuth migration',
              overview:
                'Three-phase migration plan. Each phase is independently ' +
                'shippable so we don\u2019t need a long-lived feature flag.',
              plan: partialPlan,
              todos: todos.slice(0, todosShown),
            },
            isPlanComplete
              ? { ok: true, planId: 'plan-1', toolCallId: 'tc-plan' }
              : null,
          ),
        )
      }

      // Phase 3: trailing text summary streams after the plan
      if (step > REASONING_TICKS + PLAN_BODY_TICKS) {
        const tailTokens =
          (step - REASONING_TICKS - PLAN_BODY_TICKS) * 12
        parts.push({
          type: 'text',
          text:
            'Plan ready. Hit Build to start phase 1 — the auth0 audit. ' +
            tokensFromText(LOREM, tailTokens),
        })
      }

      const a = {
        id: 'a-plan',
        role: 'assistant' as const,
        parts,
      } as unknown as UIMessage

      return { messages: [u, a], isStreaming: !isFinal }
    },
  }
}

/**
 * Multi-turn scenario:
 * turn 1 (200 char stream) ends, turn 2 starts and streams 400 chars. The
 * critical observation we want from the profile is that turn 1's TurnGroup
 * does NOT re-render once turn 2 is streaming — that's the whole point of
 * the `useTurnGrouping` reference-stability work and the TurnList memo
 * equality check.
 */
export function multiTurnScenario(): Scenario {
  const u1 = userMessage('u-mt-1', 'First question.')
  const u2 = userMessage('u-mt-2', 'Second question.')
  const TURN1_STEPS = 200
  const TURN2_STEPS = 400
  // Steps:
  //   0..TURN1_STEPS-1   : turn 1 streaming
  //   TURN1_STEPS        : turn 1 done (isStreaming false snapshot)
  //   +1                 : user 2 appears
  //   +1..+TURN2_STEPS   : turn 2 streaming
  //   +1                 : final snapshot
  const STEPS = TURN1_STEPS + 1 + 1 + TURN2_STEPS + 1

  // Cache stable references for completed history.
  let cachedA1: UIMessage | null = null

  return {
    id: 'multi-turn',
    title: 'Multi-turn (200 + 400 ticks across 2 turns)',
    steps: STEPS,
    build(step) {
      // Phase 1: turn 1 streaming
      if (step < TURN1_STEPS) {
        const a1 = assistantText('a-mt-1', tokensFromText(LOREM, step * 8))
        return { messages: [u1, a1], isStreaming: true }
      }
      // Phase 2: turn 1 finalized
      if (step === TURN1_STEPS) {
        cachedA1 = assistantText('a-mt-1', tokensFromText(LOREM, TURN1_STEPS * 8))
        return { messages: [u1, cachedA1], isStreaming: false }
      }
      // Phase 3: turn 2 user message appears (turn 1 history must be stable)
      if (step === TURN1_STEPS + 1) {
        return { messages: [u1, cachedA1!, u2], isStreaming: false }
      }
      // Phase 4: turn 2 streaming
      const turn2Step = step - (TURN1_STEPS + 2)
      if (turn2Step < TURN2_STEPS) {
        const a2 = assistantText('a-mt-2', tokensFromText(LOREM, turn2Step * 8))
        return { messages: [u1, cachedA1!, u2, a2], isStreaming: true }
      }
      // Phase 5: final
      const a2Final = assistantText('a-mt-2', tokensFromText(LOREM, TURN2_STEPS * 8))
      return { messages: [u1, cachedA1!, u2, a2Final], isStreaming: false }
    },
  }
}

/**
 * Long-history scenario:
 * Loads a real, exported chat session (180 messages, ~1.2 MB of parts)
 * pulled from the dev DB as the stable history, then streams a brand-new
 * assistant turn on top. This is the workload the user reported as slow:
 * "long chats loaded and then a new message is streaming".
 *
 * What we measure:
 *   - Initial mount cost of the entire historical TurnList (step 0).
 *   - Per-token render cost while history is already mounted (steps 1+).
 *
 * The whole point: historical messages should keep stable references and
 * memoized turns should bail out — proving they actually do under a real
 * 180-message tree is the test.
 */
export function longHistoryScenario(): Scenario {
  // Coerce the fixture into the UIMessage shape lazily and cache the
  // result. We do NOT clone the message objects across steps — each
  // historical message is the SAME reference throughout the run, which is
  // what `useTurnGrouping`'s reuse cache requires to bail.
  const history = (longChatFixture as { messages: unknown[] }).messages.map(
    (m) => m as unknown as UIMessage,
  )
  const newUser = userMessage('u-long-history-prompt', 'Continue the conversation.')
  const TOKEN_PER_STEP = 10
  const STREAM_STEPS = 300

  return {
    id: 'long-history',
    title: `Long history (${history.length} hist + ${STREAM_STEPS} ticks)`,
    steps: STREAM_STEPS + 2,
    build(step) {
      // Step 0: render history alone (no streaming) so we measure the
      // mount cost as its own commit.
      if (step === 0) {
        return { messages: history, isStreaming: false }
      }
      // Step 1: user appends a new prompt.
      if (step === 1) {
        return { messages: [...history, newUser], isStreaming: false }
      }
      // Step 2..: assistant streams.
      const tokens = Math.min((step - 2) * TOKEN_PER_STEP, LOREM.length)
      const isFinal = step === STREAM_STEPS + 1
      const a = assistantText('a-long-history-stream', tokensFromText(LOREM, tokens))
      return { messages: [...history, newUser, a], isStreaming: !isFinal }
    },
  }
}

export const ALL_SCENARIOS = [
  longTextScenario,
  toolHeavyScenario,
  planHeavyScenario,
  multiTurnScenario,
  longHistoryScenario,
] as const
