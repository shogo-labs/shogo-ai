// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-82 acceptance — the cache gate as it is actually invoked.
 *
 * `cache-baseline.test.ts` pins the maths against `compareCacheBaseline()`.
 * This file drives the real entry point CI would call,
 * `scripts/cache-baseline.ts --check <results.json>`, because the properties
 * Russell asked for ("a number, and no silent regression") only hold if the
 * CLI reads the file `run-eval.ts` writes and refuses a tampered baseline.
 *
 * `run-eval --repeat N` reports its trials as `test#t1`, `test#t2`, … — the
 * documented re-record path — so both directions are pinned here: `--write`
 * must store the trials' MEDIAN under the bare id, and `--check` must compare a
 * trial-suffixed run against that bare id instead of reporting a pass for a
 * comparison that examined nothing.
 *
 * No model is called: each case writes a `results.json` in the shape
 * `run-eval.ts` emits and runs the script against it.
 */
import { describe, test, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  CACHE_RATIO_FLOORS,
  baselineFor,
  compareCacheBaseline,
  selectBaseline,
  type CacheBaselineFile,
} from './cache-baseline'

const REPO_ROOT = resolve(import.meta.dir, '../../../..')
const SCRIPT = join(REPO_ROOT, 'scripts/cache-baseline.ts')
const COMMITTED_BASELINE = resolve(import.meta.dir, 'cache-baseline.json')

interface TurnNumbers {
  input: number
  cacheRead: number
  output?: number
  cacheWrite?: number
}

/** A turn in the shape `runner.ts` produces (only the fields the gate reads). */
function turn(n: number, u: TurnNumbers) {
  return {
    turn: n,
    input: u.input,
    output: u.output ?? 1,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite ?? 0,
    iterations: 1,
    perCallUsage: [],
  }
}

/** An eval result with `turns`; the ratio the gate reads is the LAST turn's. */
function evalResult(id: string, turns: TurnNumbers[]) {
  const perTurnUsage = turns.map((u, i) => turn(i + 1, u))
  return {
    eval: { id, category: 'cache-efficiency' },
    perTurnUsage,
    perCallUsage: [],
    metrics: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
}

/** A `results.json` as `run-eval.ts` writes it, with one test at `ratio`. */
function resultsFile(model: string, perTest: Record<string, number>) {
  return {
    name: 'cache-efficiency',
    timestamp: '2026-10-20T00:00:00.000Z',
    model,
    results: Object.entries(perTest).map(([id, ratio]) => {
      // Two turns: a cold first turn, then `ratio` of the prompt served from cache.
      const prompt = 100_000
      return evalResult(id, [
        { input: prompt, cacheRead: 0 },
        { input: Math.round(prompt * (1 - ratio)), cacheRead: Math.round(prompt * ratio) },
      ])
    }),
    summary: {},
    byCategory: {},
    cost: {},
  }
}

interface CliRun {
  status: number | null
  stdout: string
  stderr: string
}

function runCli(args: string[]): CliRun {
  const res = spawnSync('bun', [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf-8' })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** A scratch dir per case; the script writes nothing outside `--out`. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'sho82-cache-gate-'))
}

function baselineFile(perTest: Record<string, number>, model = 'hoshi-2-0'): CacheBaselineFile {
  return {
    models: {
      [model]: {
        model,
        date: '2026-10-20T00:00:00.000Z',
        perTest: Object.fromEntries(
          Object.entries(perTest).map(([id, ratio]) => [
            id,
            { ratio, firstTurnRatio: ratio, turnTokens: 100_000, prefixTokens: 90_000, turns: 2 },
          ]),
        ),
      },
    },
  }
}

describe('cache gate CLI (scripts/cache-baseline.ts --check)', () => {
  test('a run identical to its baseline passes', () => {
    const dir = scratch()
    try {
      const ratios = { 'cache-warm-repeat': 0.9, 'cache-multiturn-history': 0.9 }
      writeFileSync(join(dir, 'results.json'), JSON.stringify(resultsFile('hoshi-2-0', ratios)))
      const out = join(dir, 'baseline.json')
      writeFileSync(out, JSON.stringify(baselineFile(ratios)))

      const run = runCli(['--check', '--out', out, join(dir, 'results.json')])
      expect(run.stderr).not.toContain('Cache regressions')
      expect(run.status).toBe(0)
      expect(run.stdout).toContain('Cache gate: PASS')
      expect(run.stdout).toContain('2 test(s) compared')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a 6-point ratio drop fails, names the test, and exits 1', () => {
    const dir = scratch()
    try {
      writeFileSync(
        join(dir, 'results.json'),
        JSON.stringify(resultsFile('hoshi-2-0', { 'cache-warm-repeat': 0.84 })),
      )
      const out = join(dir, 'baseline.json')
      writeFileSync(out, JSON.stringify(baselineFile({ 'cache-warm-repeat': 0.9 })))

      const run = runCli(['--check', '--out', out, join(dir, 'results.json')])
      expect(run.status).toBe(1)
      expect(run.stderr).toContain('cache-warm-repeat')
      expect(run.stderr).toContain('cache-hit ratio')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a 4-point drop is inside the tolerance and passes', () => {
    const dir = scratch()
    try {
      writeFileSync(
        join(dir, 'results.json'),
        JSON.stringify(resultsFile('hoshi-2-0', { 'cache-warm-repeat': 0.86 })),
      )
      const out = join(dir, 'baseline.json')
      writeFileSync(out, JSON.stringify(baselineFile({ 'cache-warm-repeat': 0.9 })))

      const run = runCli(['--check', '--out', out, join(dir, 'results.json')])
      expect(run.status).toBe(0)
      expect(run.stdout).toContain('Cache gate: PASS')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a baseline hand-edited below the documented floor is refused even when the run matches it', () => {
    const dir = scratch()
    try {
      // The run matches the doctored baseline exactly — the only reason to
      // fail is that no working cache can measure 20% on this test.
      writeFileSync(
        join(dir, 'results.json'),
        JSON.stringify(resultsFile('hoshi-2-0', { 'cache-warm-repeat': 0.2 })),
      )
      const out = join(dir, 'baseline.json')
      writeFileSync(out, JSON.stringify(baselineFile({ 'cache-warm-repeat': 0.2 })))

      const run = runCli(['--check', '--out', out, join(dir, 'results.json')])
      expect(run.status).toBe(1)
      expect(run.stderr).toContain('floor')
      expect(run.stderr).toContain('edited baseline')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a file with no baselines at all is a recording run, not a failure', () => {
    const dir = scratch()
    try {
      writeFileSync(
        join(dir, 'results.json'),
        JSON.stringify(resultsFile('gpt-6-luna', { 'cache-warm-repeat': 0.91 })),
      )
      const out = join(dir, 'baseline.json')
      writeFileSync(out, JSON.stringify({ models: {} }))

      const run = runCli(['--check', '--out', out, join(dir, 'results.json')])
      expect(run.status).toBe(0)
      expect(run.stdout).toContain('No baseline recorded yet')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  /**
   * The gate keys on the `--model` string the run reported, and both
   * `--model luna` and `--model gpt-6-luna` are accepted by the runner. With
   * other models recorded, an unmatched id is a mismatch, not a first run:
   * passing there would print a green gate over zero comparisons.
   */
  test('a model id that does not match the recorded one fails loudly and lists what is recorded', () => {
    const dir = scratch()
    try {
      writeFileSync(
        join(dir, 'results.json'),
        JSON.stringify(resultsFile('gpt-6-luna', { 'cache-warm-repeat': 0.91 })),
      )
      const out = join(dir, 'baseline.json')
      writeFileSync(out, JSON.stringify(baselineFile({ 'cache-warm-repeat': 0.9 }, 'luna')))

      const run = runCli(['--check', '--out', out, join(dir, 'results.json')])
      expect(run.status).toBe(1)
      expect(run.stderr).toContain('No baseline for "gpt-6-luna"')
      expect(run.stderr).toContain('Recorded: luna')
      expect(run.stdout).not.toContain('Cache gate: PASS')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a turn-1 prompt 15% larger than the baseline fails', () => {
    const dir = scratch()
    try {
      const grew = resultsFile('hoshi-2-0', { 'cache-warm-repeat': 0.9 })
      for (const r of grew.results) {
        for (const t of r.perTurnUsage) {
          t.input = Math.round(t.input * 1.15)
          t.cacheRead = Math.round(t.cacheRead * 1.15)
        }
      }
      writeFileSync(join(dir, 'results.json'), JSON.stringify(grew))
      const out = join(dir, 'baseline.json')
      writeFileSync(out, JSON.stringify(baselineFile({ 'cache-warm-repeat': 0.9 })))

      const run = runCli(['--check', '--out', out, join(dir, 'results.json')])
      expect(run.status).toBe(1)
      expect(run.stderr).toContain('turn-1 prompt')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('the committed baseline is gateable', () => {
  const file = JSON.parse(readFileSync(COMMITTED_BASELINE, 'utf-8')) as CacheBaselineFile

  /**
   * The gate picks a baseline by the model string `run-eval.ts` reports, which
   * is the `--model` value it was given — so the file must hold an entry under
   * the id a caller types. `gpt-6-luna` is the catalog id used everywhere else
   * in the repo (`packages/agent/src/model-catalog/models.ts`); the committed
   * file records it as `luna`, and `--model gpt-6-luna` is accepted by the
   * runner, so a check with the catalog id is a mismatch the gate has to report
   * rather than pass over.
   */
  test('a check with the catalog id of a recorded model is answered, not passed', () => {
    expect(selectBaseline(file, 'hoshi-2-0')).not.toBeNull()
    expect(selectBaseline(file, 'claude-haiku-5-5')).not.toBeNull()
    // Either the file records `gpt-6-luna` directly, or the OpenAI baseline is
    // recorded under another spelling and `baselineFor` reports the mismatch.
    if (!selectBaseline(file, 'gpt-6-luna')) {
      const lookup = baselineFor(file, 'gpt-6-luna')
      expect(lookup.status).toBe('model-missing')
      expect(lookup.status === 'model-missing' && lookup.recorded.length).toBeGreaterThanOrEqual(3)
    }
  })

  test('every gated test is recorded at or above its floor, on every model', () => {
    for (const [model, baseline] of Object.entries(file.models)) {
      for (const [id, floor] of Object.entries(CACHE_RATIO_FLOORS)) {
        const entry = baseline.perTest[id]
        expect(entry, `${model} is missing a baseline for ${id}`).toBeDefined()
        expect(entry.ratio, `${model}/${id} sits below the ${floor} floor`).toBeGreaterThanOrEqual(floor)
      }
    }
  })

  /**
   * The floor check keys on the bare test id. A baseline recorded through
   * `run-eval --repeat N` (its trials are ids `test#t1`, `test#t2`, …) would
   * still compare, but every floor lookup would miss and the anti-tamper
   * protection would silently stop applying — so the checked-in ids must stay
   * bare.
   */
  test('no baseline entry carries a --repeat trial suffix', () => {
    for (const [model, baseline] of Object.entries(file.models)) {
      for (const id of Object.keys(baseline.perTest)) {
        expect(id, `${model} recorded a trial-suffixed baseline id`).not.toMatch(/#t\d+$/)
      }
    }
  })
})

describe('a repeat-recorded baseline is still floor-checked', () => {
  /**
   * `run-eval --repeat N` writes trials as `test#t1`, `test#t2`, … and the
   * script's own instructions pass that single `results.json` to `--write`.
   * A 2% ratio on `cache-warm-repeat` cannot be a measurement of a working
   * cache, so the gate must refuse it whether the id carries a trial suffix or
   * not — otherwise re-recording with `--repeat` silently disables the
   * hand-edited-baseline protection.
   */
  test('an impossible ratio on a trial id is refused', () => {
    const id = 'cache-warm-repeat#t1'
    const doctored = {
      models: {
        'hoshi-2-0': {
          model: 'hoshi-2-0',
          date: '2026-10-20T00:00:00.000Z',
          perTest: {
            [id]: { ratio: 0.02, firstTurnRatio: 0.02, turnTokens: 100_000, prefixTokens: 90_000, turns: 2 },
          },
        },
      },
    } as CacheBaselineFile
    const baseline = selectBaseline(doctored, 'hoshi-2-0')!

    const gate = compareCacheBaseline({ ...baseline.perTest }, baseline)
    expect(gate.regressions.some((r) => r.metric === 'baselineFloor')).toBe(true)
  })
})

describe('the --repeat re-record path through the CLI', () => {
  /** `run-eval --repeat 3` writes one result per trial: `test#t1`, `#t2`, `#t3`. */
  const trials = { 'cache-warm-repeat#t1': 0.5, 'cache-warm-repeat#t2': 0.75, 'cache-warm-repeat#t3': 0.9 }

  test('--write stores the trials\' median under the bare test id', () => {
    const dir = scratch()
    try {
      writeFileSync(join(dir, 'results.json'), JSON.stringify(resultsFile('hoshi-2-0', trials)))
      const out = join(dir, 'baseline.json')

      const run = runCli(['--write', '--out', out, join(dir, 'results.json')])
      expect(run.stderr).toBe('')
      expect(run.status).toBe(0)

      const written = JSON.parse(readFileSync(out, 'utf-8')) as CacheBaselineFile
      const perTest = written.models['hoshi-2-0'].perTest
      expect(Object.keys(perTest)).toEqual(['cache-warm-repeat'])
      expect(perTest['cache-warm-repeat'].ratio).toBeCloseTo(0.75, 6)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('--check compares a trial-suffixed run against the bare-id baseline', () => {
    const dir = scratch()
    try {
      const out = join(dir, 'baseline.json')
      writeFileSync(out, JSON.stringify(baselineFile({ 'cache-warm-repeat': 0.75 })))

      // Same trials as recorded: medians match, one test is actually compared.
      writeFileSync(join(dir, 'same.json'), JSON.stringify(resultsFile('hoshi-2-0', trials)))
      const same = runCli(['--check', '--out', out, join(dir, 'same.json')])
      expect(same.stdout).toContain('1 test(s) compared')
      expect(same.status).toBe(0)

      // A 15-point drop on the same shape must fail, not "no test in common".
      const dropped = { 'cache-warm-repeat#t1': 0.6, 'cache-warm-repeat#t2': 0.6, 'cache-warm-repeat#t3': 0.6 }
      writeFileSync(join(dir, 'dropped.json'), JSON.stringify(resultsFile('hoshi-2-0', dropped)))
      const worse = runCli(['--check', '--out', out, join(dir, 'dropped.json')])
      expect(worse.stdout).toContain('1 test(s) compared')
      expect(worse.stderr).toContain('cache-warm-repeat')
      expect(worse.status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)
})
