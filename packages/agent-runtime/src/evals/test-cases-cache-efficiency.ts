// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cache-efficiency eval suite — "are we caching well?" as a number.
 *
 * Pinned to `hoshi-2-0` (DeepSeek-V4.1-Flash). DeepSeek caches implicitly and
 * gives us no breakpoint to set: it matches complete, persisted prefix units of
 * (tools, system, messages), best effort, with an hours-to-days TTL. So on
 * hoshi the only levers are LAYOUT (what sits in the cached zone, and in which
 * order) and PREFIX STABILITY (does a per-turn section leak into the cached
 * zone). These tests measure exactly those two things, per turn and per model
 * call, instead of only reporting a turn's aggregate token count.
 *
 * First measured runs (2026-10-20, one local worker, 10/10 on each):
 *
 *   model              prompt tok   cache read   overall   steady state
 *   hoshi-2-0 (DS)       3,466,230    3,283,072     94.7%   90-99.6%
 *   claude-haiku-5-5     2,080,793    1,912,124     91.9%   96-99.8%
 *   gpt-6-luna           1,359,792    1,200,718     85.7%   79-99.7%
 *
 * The overall figure is dragged down by the FIRST turn of each eval, which is
 * always cold (it reads only whatever prefix a previous session left behind:
 * 33-35% of it). Steady state — every turn after the first — is 90-99.8%.
 *
 * The providers do not behave alike and the suite is written to measure that,
 * not to flatten it: Anthropic caches at our explicit `cache_control`
 * breakpoints, so a mid-session MEMORY.md rewrite costs it ~0; DeepSeek and
 * OpenAI cache implicitly, so the same rewrite cost hoshi 99% -> 34% and luna
 * 100% -> 0% for one turn, then both re-warmed on the next turn.
 *
 * Floors are deliberately loose (phase A): DeepSeek's cache is async and
 * best-effort, so a single run can under-report hits and turn 1 mostly reflects
 * warm-up order. `--repeat N` runs one test N times (`test#t1`, `#t2`, …) and
 * `cache-baseline.json` stores the MEDIAN of those trials under the bare test
 * id, which is what the gate compares — but the committed file is currently one
 * run per model ("median of 1 run(s)"), so its 5-point tolerance rests on a
 * single sample. Re-record with `--repeat 3` when it is refreshed.
 *
 * A baseline is only comparable inside the pod that recorded it: a local eval
 * worker inherits the host env (attached projects, existing workspaces), so a
 * turn can loop or fan out differently there and the reading does not survive
 * the move.
 *
 * Test 6 is record-only in phase A: it reports what a MEMORY.md rewrite costs
 * instead of gating on it, and on a cold first turn it cannot show a drop at
 * all, so a pass there means "no cost observed", not "isolation proved".
 *
 * Tests:
 *   1. cache-stable-zone-identical  — no LLM: the cached zone is byte-stable across a tick
 *   2. cache-tool-schema-stable     — no LLM: the tool block is identical across two sessions
 *   3. cache-warm-repeat            — a repeat turn reads the cache (≥ 0.50)
 *   4. cache-multiturn-history      — history is reused turn over turn (≥ 0.60 by turn 4)
 *   5. cache-tool-loop              — the prefix isn't rebuilt per iteration
 *   6. cache-volatile-isolation     — what a MEMORY.md rewrite costs (record-only in phase A)
 *   7. cache-compaction-recovery    — a rewritten prefix recovers instead of resetting
 *   8. cache-subagent-fork          — a fork subagent rides the parent prefix (≥ 0.40)
 *   9. cache-accounting-identity    — per-call accounting adds up to the turn totals
 *  10. cache-regression-gate        — the gate itself fails on a hand-edited baseline
 */

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import type { AgentEval } from './types'
import {
  cacheProbe,
  finalTurnCacheRatio,
  forkCacheRatio,
  prefixTokens,
  recordedPrefixes,
  runCacheRatio,
  stablePrefixHeld,
  toolBlockHeld,
  toolLoopRewrite,
  totalInputTokens,
  turnCacheRatio,
} from './eval-helpers'
import {
  CACHE_GATE_RATIO_DROP_POINTS,
  CACHE_GATE_TURN_TOKEN_GROWTH,
  CACHE_RATIO_FLOORS,
  compareCacheBaseline,
  selectBaseline,
  type CacheBaseline,
  type CacheBaselineFile,
} from './cache-baseline'

// Checked in next to the gate, NOT under `bench-results/` (which is
// gitignored): a baseline nobody can commit is a gate nobody can run in CI.
const BASELINE_PATH = resolve(import.meta.dir, 'cache-baseline.json')

function readBaselineFile(): CacheBaselineFile | null {
  if (!existsSync(BASELINE_PATH)) return null
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as CacheBaselineFile
    return parsed && typeof parsed === 'object' && parsed.models ? parsed : null
  } catch {
    return null
  }
}

/** Baselines recorded so far, one per model (hoshi, haiku, luna, …). */
function recordedBaselines(): CacheBaseline[] {
  const file = readBaselineFile()
  return file ? Object.values(file.models).filter((b) => b && typeof b.perTest === 'object') : []
}

/**
 * A baseline built from the documented phase-A floors, so the gate's own
 * behaviour is testable before anyone has recorded real numbers.
 */
function syntheticBaseline(): CacheBaseline {
  return {
    model: 'hoshi-2-0',
    date: '1970-01-01T00:00:00.000Z',
    perTest: Object.fromEntries(
      Object.entries(CACHE_RATIO_FLOORS).map(([id, ratio]) => [
        id,
        { ratio, firstTurnRatio: 0, turnTokens: 12_000, prefixTokens: 10_000, turns: 3 },
      ]),
    ),
  }
}

export const CACHE_EFFICIENCY_EVALS: AgentEval[] = [
  // -------------------------------------------------------------------------
  // 1. Nothing volatile in the cached zone
  // -------------------------------------------------------------------------
  {
    id: 'cache-stable-zone-identical',
    name: 'Cache: the stable zone is byte-identical across two builds',
    category: 'cache-efficiency',
    level: 1,
    input: 'structural probe — no model call',
    noLlm: true,
    maxScore: 100,
    tags: ['no-llm', 'structural'],
    validationCriteria: [
      {
        id: 'probe-ran',
        description: 'The runtime returned a prefix probe with two independent builds',
        points: 30,
        phase: 'execution',
        validate: (r) => {
          const probe = cacheProbe(r, 'chat')
          return !!probe && probe.builds.length === 2
        },
      },
      {
        id: 'stable-zone-identical',
        description: 'Both builds produced a byte-identical cached zone (any drift names the section)',
        points: 40,
        phase: 'execution',
        validate: (r) => {
          const probe = cacheProbe(r, 'chat')
          return !!probe && probe.identical === true && probe.drift === null
        },
      },
      {
        id: 'stable-zone-substantial',
        description: 'The cached zone holds at least 2k tokens (~8k chars) of the prompt',
        points: 30,
        phase: 'execution',
        validate: (r) => {
          const probe = cacheProbe(r, 'chat')
          return !!probe && (probe.builds[0]?.stableChars ?? 0) >= 8_000
        },
      },
    ],
  },

  // -------------------------------------------------------------------------
  // 2. The tool block cannot silently invalidate the cache
  // -------------------------------------------------------------------------
  {
    id: 'cache-tool-schema-stable',
    name: 'Cache: the tool block is identical across two sessions',
    category: 'cache-efficiency',
    level: 1,
    input: 'structural probe — no model call',
    noLlm: true,
    cacheProbeSessions: ['chat', 'cache-probe-b'],
    maxScore: 100,
    tags: ['no-llm', 'structural'],
    validationCriteria: [
      {
        id: 'both-sessions-probed',
        description: 'Both sessions returned a probe',
        points: 30,
        phase: 'execution',
        validate: (r) => !!cacheProbe(r, 'chat') && !!cacheProbe(r, 'cache-probe-b'),
      },
      {
        id: 'tools-hash-equal',
        description: 'Ordered tool definitions hash identically across sessions',
        points: 50,
        phase: 'execution',
        validate: (r) => {
          const a = cacheProbe(r, 'chat')?.builds[0]?.toolsHash
          const b = cacheProbe(r, 'cache-probe-b')?.builds[0]?.toolsHash
          return !!a && !!b && a === b && a !== '------'
        },
      },
      {
        id: 'tool-count-sane',
        description: 'At least 8 tools are advertised (a gutted tool set would cache trivially)',
        points: 20,
        phase: 'execution',
        validate: (r) => (cacheProbe(r, 'chat')?.builds[0]?.toolCount ?? 0) >= 8,
      },
    ],
  },

  // -------------------------------------------------------------------------
  // 3. Caching works on hoshi at all
  // -------------------------------------------------------------------------
  {
    id: 'cache-warm-repeat',
    name: 'Cache: a repeated turn reads the cache (ratio >= 0.50 by turn 3)',
    category: 'cache-efficiency',
    level: 1,
    input: 'hi',
    // Three turns, not two. DeepSeek caches implicitly and persists asynchronously:
    // the first call of a fresh session only reads whatever prefix a previous
    // session left behind (measured 35% on this runtime on turn 1, 99% from turn 2
    // once the turn-1 prompt had been persisted). Asserting a 2-turn ratio
    // measured the warm-up order, not the system.
    conversationHistory: [
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'hi again' },
    ],
    maxScore: 100,
    tags: ['hoshi', 'ratio'],
    validationCriteria: [
      {
        id: 'warm-ratio-floor',
        description: 'Turn 3 cache-hit ratio >= 0.50',
        points: 50,
        phase: 'execution',
        validate: (r) => (turnCacheRatio(r, 3) ?? 0) >= 0.5,
      },
      {
        id: 'prefix-held',
        description: 'Cached zone AND tool block hash identically on every turn (a moving prefix makes the ratio meaningless)',
        points: 30,
        phase: 'execution',
        validate: (r) => stablePrefixHeld(r, 3) && toolBlockHeld(r, 3),
      },
      {
        id: 'usage-measured',
        description: 'Turn 3 reported prompt tokens',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const turns = r.perTurnUsage ?? []
          return turns.length >= 3 && totalInputTokens(turns[2]) > 0
        },
      },
    ],
  },

  // -------------------------------------------------------------------------
  // 4. History is reused turn over turn
  // -------------------------------------------------------------------------
  {
    id: 'cache-multiturn-history',
    name: 'Cache: five turns reuse the growing history (ratio >= 0.60 by turn 4)',
    category: 'cache-efficiency',
    level: 2,
    input: 'and now?',
    conversationHistory: [
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'still here' },
      { role: 'user', content: 'ok' },
      { role: 'user', content: 'go on' },
    ],
    maxScore: 100,
    tags: ['hoshi', 'ratio', 'multiturn'],
    validationCriteria: [
      {
        id: 'turn4-ratio-floor',
        description: 'Turn 4 cache-hit ratio >= 0.60',
        points: 40,
        phase: 'execution',
        validate: (r) => (turnCacheRatio(r, 4) ?? 0) >= 0.6,
      },
      {
        id: 'turn5-ratio-floor',
        description: 'Final turn cache-hit ratio >= 0.60',
        points: 30,
        phase: 'execution',
        validate: (r) => (finalTurnCacheRatio(r) ?? 0) >= 0.6,
      },
      {
        // Turn 1 is whatever the previous session left in the provider's cache
        // (99.6% in one run, 35% in another) — it says nothing about this chat.
        // What must hold is that a long history never falls out of the cache.
        id: 'warm-ratio-never-collapses',
        description: 'Turns 2-5 all stay >= 0.60 (history is reused, not re-sent)',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const ratios = [2, 3, 4, 5].map((n) => turnCacheRatio(r, n))
          return ratios.every((x) => x !== null && x >= 0.6)
        },
      },
      {
        id: 'prefix-held',
        description: 'The cached zone hash is identical on every turn',
        points: 10,
        phase: 'execution',
        validate: (r) => stablePrefixHeld(r, 5),
      },
    ],
  },

  // -------------------------------------------------------------------------
  // 5. The prefix is not rebuilt per tool-use iteration
  // -------------------------------------------------------------------------
  {
    id: 'cache-tool-loop',
    name: 'Cache: a tool loop does not rebuild the prefix per iteration',
    category: 'cache-efficiency',
    level: 2,
    // `exec cat` rather than `read_file`: the permission engine resolves
    // relative paths against the project's allowed roots, and a relative path in
    // an eval workspace is refused before the tool ever runs (six failed calls
    // inflated the error penalty on the first measured run). The point of the
    // test is the tool LOOP, so use the tool that cannot be path-blocked.
    input:
      'Run six separate exec calls, one per file, no parallel calls: ' +
      '`cat README.md`, `cat package.json`, `cat tsconfig.base.json`, `cat AGENTS.md`, ' +
      '`cat .github/PULL_REQUEST_TEMPLATE.md`, then `ls -1`. ' +
      'Finish with one sentence on what this project is.',
    maxScore: 100,
    tags: ['hoshi', 'ratio', 'tool-loop'],
    validationCriteria: [
      {
        id: 'loop-ran',
        description: 'At least 5 tool calls in one turn (a real tool loop)',
        points: 20,
        phase: 'execution',
        validate: (r) => r.metrics.toolCallCount >= 5,
      },
      {
        id: 'write-under-half-of-read',
        description: 'After the first call, median cache-write <= 0.5 x median cache-read',
        points: 50,
        phase: 'execution',
        validate: (r) => {
          const loop = toolLoopRewrite(r)
          return loop.calls >= 3 && loop.medianRead > 0 && loop.ratio <= 0.5
        },
      },
      {
        id: 'reads-cache-in-loop',
        description: 'At least one call after the first read a non-zero number of cached tokens',
        points: 30,
        phase: 'execution',
        validate: (r) => {
          const calls = (r.perCallUsage ?? []).filter((c) => !c.discarded).slice(1)
          return calls.some((c) => c.cacheRead > 0)
        },
      },
    ],
  },

  // -------------------------------------------------------------------------
  // 6. Volatile edits do not kill the cached prefix
  // -------------------------------------------------------------------------
  {
    id: 'cache-volatile-isolation',
    name: 'Cache: a MEMORY.md rewrite costs one turn, not the session',
    category: 'cache-efficiency',
    level: 2,
    input: 'and now?',
    // Measured cost of the rewrite on the following turn (2026-10-20):
    //   haiku-5-5 (Anthropic, explicit breakpoints)  96% -> 96%   (no cost)
    //   hoshi-2-0 (DeepSeek, implicit)               99% -> 34%   (tail lost)
    //   gpt-6-luna (OpenAI, implicit)               100% ->  0%   (all of it)
    // The price differs by provider, but one property holds for all three: the
    // NEXT turn re-warms. That is what this asserts; the layout card is what
    // can make the price itself cheap.
    conversationHistory: [
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'ok thanks' },
      { role: 'user', content: 'one more' },
    ],
    betweenTurns: [
      {
        afterTurn: 2,
        writeFiles: {
          'MEMORY.md': '# Memory\n\n- Written by the cache-volatile-isolation eval between turns.\n- Today the team switched the deploy window.\n',
        },
      },
    ],
    maxScore: 100,
    tags: ['hoshi', 'ratio', 'volatile'],
    validationCriteria: [
      {
        id: 'stable-zone-untouched',
        description: 'The cached-zone hash is identical on all four turns despite the MEMORY.md rewrite',
        points: 40,
        phase: 'execution',
        validate: (r) => stablePrefixHeld(r, 4),
      },
      {
        id: 'edit-landed-in-dynamic-zone',
        description: 'The dynamic zone changed between turn 2 and turn 3 (the edit was seen, just not in the cached zone)',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const prefixes = recordedPrefixes(r)
          if (prefixes.length < 3) return false
          return prefixes[2].dynamicChars !== prefixes[1].dynamicChars
        },
      },
      {
        id: 'recovers-after-edit',
        description: 'The turn after the cold one is >= 0.60 again (the rewrite cost a turn, not the session)',
        points: 40,
        phase: 'execution',
        validate: (r) => (turnCacheRatio(r, 4) ?? 0) >= 0.6,
      },
    ],
  },

  // -------------------------------------------------------------------------
  // 7. Compaction is not a permanent cache reset
  // -------------------------------------------------------------------------
  {
    id: 'cache-compaction-recovery',
    name: 'Cache: the turn after a compaction still reads the cache (ratio >= 0.50)',
    category: 'cache-efficiency',
    level: 3,
    input: 'one more thing please',
    conversationHistory: [
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'what time is it for you?' },
    ],
    betweenTurns: [{ afterTurn: 2, compact: true }],
    maxScore: 100,
    tags: ['hoshi', 'ratio', 'compaction'],
    validationCriteria: [
      {
        id: 'compaction-ran',
        description: 'The forced compaction actually rewrote the transcript',
        points: 30,
        phase: 'execution',
        validate: (r) => {
          const failed = (r.errors ?? []).some((e) => e.startsWith('betweenTurns compact'))
          return !failed && (r.perTurnUsage ?? []).length >= 3
        },
      },
      {
        id: 'recovery-floor',
        description: 'The post-compaction turn cache-hit ratio >= 0.50',
        points: 40,
        phase: 'execution',
        validate: (r) => (turnCacheRatio(r, 3) ?? 0) >= 0.5,
      },
      {
        id: 'no-collapse-vs-baseline',
        description: 'The post-compaction turn keeps >= 80% of the pre-compaction turn ratio',
        points: 30,
        phase: 'execution',
        validate: (r) => {
          const before = turnCacheRatio(r, 2)
          const after = turnCacheRatio(r, 3)
          return before !== null && after !== null && before > 0 && after >= before * 0.8
        },
      },
    ],
  },

  // -------------------------------------------------------------------------
  // 8. A fork subagent rides the parent prefix
  // -------------------------------------------------------------------------
  {
    id: 'cache-subagent-fork',
    name: 'Cache: a fork subagent reads the parent prefix (first-call ratio >= 0.40)',
    category: 'cache-efficiency',
    level: 3,
    input:
      'Spawn one fork subagent (agent_spawn with mode "fork") and ask it to write a one-line haiku about prompt ' +
      'caching into .tmp/haiku.txt, then read the file back and repeat the haiku here.',
    maxScore: 100,
    tags: ['hoshi', 'ratio', 'subagent'],
    validationCriteria: [
      {
        id: 'fork-ran',
        description: 'A fork subagent reported usage',
        points: 30,
        phase: 'execution',
        validate: (r) => forkCacheRatio(r) !== null,
      },
      {
        id: 'fork-ratio-floor',
        description: 'Fork cache-hit ratio >= 0.40',
        points: 50,
        phase: 'execution',
        validate: (r) => (forkCacheRatio(r) ?? 0) >= 0.4,
      },
      {
        id: 'parent-turn-measured',
        description: 'The parent turn reported prompt tokens of its own',
        points: 20,
        phase: 'execution',
        validate: (r) => runCacheRatio(r) > 0,
      },
    ],
  },

  // -------------------------------------------------------------------------
  // 9. The metric is not lying
  // -------------------------------------------------------------------------
  {
    id: 'cache-accounting-identity',
    name: 'Cache: per-call usage adds up to the turn totals',
    category: 'cache-efficiency',
    level: 1,
    input: 'reply with the single word: ok',
    maxScore: 100,
    tags: ['hoshi', 'accounting'],
    validationCriteria: [
      {
        id: 'prefix-recorded',
        description: 'The turn reported a prompt-cache prefix',
        points: 30,
        phase: 'execution',
        validate: (r) => recordedPrefixes(r).length >= 1,
      },
      {
        id: 'per-call-sums-to-turn',
        description: 'Summed per-call prompt tokens equal the turn totals (no drop, no double count)',
        points: 40,
        phase: 'execution',
        validate: (r) => {
          const turns = r.perTurnUsage ?? []
          if (turns.length === 0) return false
          const perCall = r.perCallUsage ?? []
          if (perCall.length === 0) return false
          const sumIn = perCall.reduce((s, c) => s + c.input + c.cacheRead + c.cacheWrite, 0)
          const sumOut = perCall.reduce((s, c) => s + c.output, 0)
          const t = r.metrics.tokens
          return sumIn === t.input + t.cacheRead + t.cacheWrite && sumOut === t.output
        },
      },
      {
        id: 'one-entry-per-iteration',
        description: 'Live (non-discarded) per-call entries match the reported iteration count',
        points: 30,
        phase: 'execution',
        validate: (r) => {
          const turn = (r.perTurnUsage ?? [])[0]
          if (!turn || turn.iterations === 0) return false
          const live = turn.perCallUsage.filter((c) => !c.discarded).length
          return live === turn.iterations
        },
      },
    ],
  },

  // -------------------------------------------------------------------------
  // 10. The gate fails when the baseline is hand-edited downward
  // -------------------------------------------------------------------------
  {
    id: 'cache-regression-gate',
    name: 'Cache: the non-regression gate trips on a degraded baseline',
    category: 'cache-efficiency',
    level: 1,
    input: 'gate self-test — no model call',
    noLlm: true,
    maxScore: 100,
    tags: ['no-llm', 'gate'],
    validationCriteria: [
      {
        id: 'baseline-present',
        description: 'The checked-in baseline (evals/cache-baseline.json) exists, parses and has at least one model recorded',
        points: 25,
        phase: 'execution',
        validate: () => recordedBaselines().length > 0,
      },
      {
        id: 'thresholds-documented',
        description: 'The gate fails at 5 points of ratio loss or 10% of turn-1 prompt growth',
        points: 10,
        phase: 'execution',
        validate: () => CACHE_GATE_RATIO_DROP_POINTS === 5 && CACHE_GATE_TURN_TOKEN_GROWTH === 0.1,
      },
      {
        id: 'recorded-baselines-meet-their-floors',
        description: 'Every recorded model baseline sits at or above the documented floor for its tests',
        points: 20,
        phase: 'execution',
        validate: () => {
          const baselines = recordedBaselines()
          if (baselines.length === 0) return false
          return baselines.every((b) =>
            Object.entries(CACHE_RATIO_FLOORS).every(([id, floor]) => {
              const entry = b.perTest[id]
              return !entry || entry.ratio + 1e-9 >= floor
            }),
          )
        },
      },
      {
        id: 'gate-passes-unchanged-run',
        description: 'A run identical to its baseline passes the gate on every floor',
        points: 15,
        phase: 'execution',
        validate: () => {
          const baseline = syntheticBaseline()
          const gate = compareCacheBaseline({ ...baseline.perTest }, baseline)
          return gate.ok && gate.checked === Object.keys(CACHE_RATIO_FLOORS).length
        },
      },
      {
        id: 'gate-fails-degraded-run',
        description: 'A run 20 points worse than the recorded baseline fails, naming the ratio regression',
        points: 30,
        phase: 'execution',
        validate: () => {
          const baseline = syntheticBaseline()
          const worse = Object.fromEntries(
            Object.entries(baseline.perTest).map(([id, entry]) => [
              id,
              { ...entry, ratio: Math.max(0, entry.ratio - 0.2) },
            ]),
          )
          const gate = compareCacheBaseline(worse, baseline)
          return !gate.ok && gate.regressions.some((r) => r.metric === 'ratio')
        },
      },
    ],
  },
]
