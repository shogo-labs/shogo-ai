// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Ratchet: a test that hard-codes a date must also pin the clock.
 *
 * Background (SHO-505). `qa-sho424-vm-compute-billing.acceptance.test.ts` seeded
 * rows dated 2026-11-18 and compared them against `Date.now()` two lines later.
 * It passed on the day it was written and went red for every commit on `main`
 * about 72 hours later — main was un-shippable and nothing in the suite had
 * changed. The suite had 163 files full of `new Date('20…')` and only 11 of them
 * froze the clock, so the next bomb was already armed somewhere else.
 *
 * The rule is deliberately a ratchet, not a repo-wide failure: most literals are
 * harmless (formatting a fixed timestamp, or passing `now` in explicitly), so
 * the files that are wrong today are baselined and only *new* ones fail.
 *
 *   bun scripts/check-test-clock.ts                 # check (CI)
 *   bun scripts/check-test-clock.ts --write-baseline # re-baseline after fixing files
 *
 * Fixing a finding is one of:
 *   - pin the clock next to the seed: `setSystemTime(new Date('…'))` in
 *     `beforeAll`, `setSystemTime(new Date())` + `useRealTimers()` in `afterAll`,
 *     and remove the entry from the baseline; or
 *   - derive the seed from the clock the assertion reads (`Date.now()`); or
 *   - for a literal that is only ever formatted — never compared against the
 *     current time — mark the file `// test-clock: format-only` and add it to
 *     the baseline's `allow` map with that reason.
 *
 * A baselined file that no longer offends is stale and must be removed, so the
 * list can only shrink.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { walkSourceFiles } from './lib/walk-source-files'

const REPO_ROOT = resolve(import.meta.dir, '..')
const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'test-clock-baseline.json')

/**
 * Date literals that mean "this test has a fixed idea of today".
 *
 * Only a *year-first* literal counts: `new Date('2026-11-18')`, `new Date(2026,
 * 10, 18)`, `Date.UTC(2026, 10, 18)`, `Date.parse('2026-11-18')`. A relative
 * literal (`new Date('11/18/2026')`) is rare enough not to be worth the false
 * positives, and `new Date(0)` / `new Date(86_400_000)` are durations.
 */
const DATE_LITERAL_PATTERNS: readonly RegExp[] = [
  /\bnew\s+Date\s*\(\s*(['"`])20\d{2}[-/]/g,
  /\bnew\s+Date\s*\(\s*20\d{2}\s*,/g,
  /\bDate\.UTC\s*\(\s*20\d{2}\s*,/g,
  /\bDate\.parse\s*\(\s*(['"`])20\d{2}[-/]/g,
]

/**
 * Anything that makes the test's idea of "now" explicit. `setSystemTime` and
 * `useFakeTimers` come from `bun:test` (Bun implements the jest timer API);
 * `mock.timers` is the same thing reached through `import { mock }`.
 */
const FROZEN_CLOCK_PATTERNS: readonly RegExp[] = [
  /\b(?:jest\.|mock\.)?setSystemTime\s*\(/,
  /\b(?:jest\.|mock\.)?useFakeTimers\s*\(/,
  /\bmock\.timers\b/,
]

const ALLOW_PATTERN = /\/\/\s*test-clock:\s*format-only/

export interface DateLiteralFinding {
  /** 1-based line number. */
  line: number
  /** The literal as it appears, trimmed to the line. */
  text: string
}

export interface TestClockBaseline {
  /** Repo-relative test file -> number of date literals, for files with no pinned clock. */
  files: Record<string, number>
  /** Repo-relative test file -> why its literals are allowed (see the header). */
  allow: Record<string, string>
}

export interface TestFileInput {
  file: string
  source: string
}

export interface TestClockReport {
  /** Findings that must be fixed or baselined: new files, and files that grew. */
  regressions: string[]
  /** Baseline entries for files that no longer offend (fixed, pinned or gone). */
  stale: string[]
  /** Baseline `allow` entries for files that no longer contain a literal. */
  staleAllow: string[]
  /** Total literals found in files with no pinned clock, for the summary line. */
  offenders: number
}

/** Every date literal in `source`, in file order. */
export function scanDateLiterals(source: string): DateLiteralFinding[] {
  const findings: DateLiteralFinding[] = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let hit = false
    for (const pattern of DATE_LITERAL_PATTERNS) {
      pattern.lastIndex = 0
      if (pattern.test(line)) {
        hit = true
        break
      }
    }
    if (hit) findings.push({ line: i + 1, text: line.trim() })
  }
  return findings
}

/** True when the file pins, fakes or otherwise takes control of the clock. */
export function hasFrozenClock(source: string): boolean {
  return FROZEN_CLOCK_PATTERNS.some((pattern) => pattern.test(source))
}

/** True when the file declares its literals format-only. */
export function isFormatOnly(source: string): boolean {
  return ALLOW_PATTERN.test(source)
}

function formatFindings(file: string, findings: DateLiteralFinding[]): string {
  const first = findings.slice(0, 3).map((finding) => `      ${file}:${finding.line}  ${finding.text}`)
  const more = findings.length > 3 ? [`      … ${findings.length - 3} more`] : []
  return [...first, ...more].join('\n')
}

/**
 * Compare the tree against the baseline. Pure: the CLI below is the only place
 * that touches the filesystem, which is what the fixture tests exercise.
 */
export function evaluateTestClock(files: readonly TestFileInput[], baseline: TestClockBaseline): TestClockReport {
  const regressions: string[] = []
  const offenders = new Set<string>()
  let offenderCount = 0

  for (const { file, source } of files) {
    const findings = scanDateLiterals(source)
    if (findings.length === 0) continue
    if (isFormatOnly(source)) continue
    if (hasFrozenClock(source)) continue
    offenders.add(file)
    offenderCount += findings.length

    const known = baseline.files[file]
    if (known === undefined) {
      regressions.push(`${file}: ${findings.length} date literal(s), no clock pin\n${formatFindings(file, findings)}`)
      continue
    }
    if (findings.length > known) {
      regressions.push(
        `${file}: ${findings.length} date literal(s) (+${findings.length - known} vs baseline), no clock pin\n${formatFindings(file, findings)}`,
      )
    }
  }

  const stale = Object.keys(baseline.files).filter((file) => !offenders.has(file))
  const staleAllow = Object.keys(baseline.allow).filter(
    (file) => !files.some((input) => input.file === file && scanDateLiterals(input.source).length > 0),
  )

  return { regressions, stale, staleAllow, offenders: offenderCount }
}

/** Drop entries that no longer apply, so `--write-baseline` locks in a fix. */
export function pruneBaseline(files: readonly TestFileInput[], baseline: TestClockBaseline): TestClockBaseline {
  const next: TestClockBaseline = { files: {}, allow: {} }
  for (const { file, source } of files) {
    const findings = scanDateLiterals(source)
    if (findings.length === 0) continue
    if (isFormatOnly(source)) {
      next.allow[file] = 'format-only'
      continue
    }
    if (hasFrozenClock(source)) continue
    next.files[file] = findings.length
  }
  return {
    files: Object.fromEntries(Object.entries(next.files).sort(([a], [b]) => a.localeCompare(b))),
    allow: Object.fromEntries(Object.entries(next.allow).sort(([a], [b]) => a.localeCompare(b))),
  }
}

/** Every test file in the repo: `*.test.ts(x)` and anything under `__tests__/`. */
export function collectTestFiles(root: string): string[] {
  const candidates = new Set(walkSourceFiles(root, { extensions: ['.ts', '.tsx'] }))
  return [...candidates]
    .filter((file) => file.endsWith('.test.ts') || file.endsWith('.test.tsx') || file.includes('/__tests__/'))
    .sort()
}

function readBaseline(): TestClockBaseline {
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as Partial<TestClockBaseline>
  return { files: parsed.files ?? {}, allow: parsed.allow ?? {} }
}

function main(): void {
  const writeBaseline = process.argv.includes('--write-baseline')
  const files: TestFileInput[] = collectTestFiles(REPO_ROOT).map((file) => ({
    file,
    source: readFileSync(join(REPO_ROOT, file), 'utf-8'),
  }))

  if (writeBaseline) {
    const baseline = pruneBaseline(files, existsSync(BASELINE_PATH) ? readBaseline() : { files: {}, allow: {} })
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n')
    const total = Object.values(baseline.files).reduce((sum, n) => sum + n, 0)
    console.log(
      `[test-clock] baseline written: ${Object.keys(baseline.files).length} file(s) / ${total} literal(s) without a pinned clock, ` +
        `${Object.keys(baseline.allow).length} format-only`,
    )
    return
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error('[test-clock] scripts/test-clock-baseline.json is missing. Run `bun scripts/check-test-clock.ts --write-baseline`.')
    process.exit(1)
  }

  const baseline = readBaseline()
  const report = evaluateTestClock(files, baseline)

  if (report.regressions.length > 0) {
    console.error(`[test-clock] ${report.regressions.length} test file(s) hard-code a date without pinning the clock:`)
    for (const line of report.regressions) console.error('  ' + line)
    console.error(
      '\nA test that seeds 2026-11-18 and compares against the current time passes today and fails in 72 hours — that is how main went red in SHO-505.\n' +
        'Pin the clock next to the seed (`setSystemTime` in beforeAll, restore in afterAll) or derive the seed from the clock the assertion reads.\n' +
        'A literal that is only ever formatted can be marked `// test-clock: format-only` and added to the baseline `allow` map.',
    )
  }

  if (report.stale.length > 0) {
    console.error(`[test-clock] ${report.stale.length} baseline entr(ies) are stale — the file was fixed, pinned or deleted:`)
    for (const file of report.stale) console.error(`  ${file}`)
    console.error('Remove them with `bun scripts/check-test-clock.ts --write-baseline` so the ratchet keeps shrinking.')
  }

  if (report.staleAllow.length > 0) {
    console.error(`[test-clock] ${report.staleAllow.length} \`allow\` entr(ies) are stale — the file no longer contains a date literal:`)
    for (const file of report.staleAllow) console.error(`  ${file}`)
    console.error('Remove them with `bun scripts/check-test-clock.ts --write-baseline`.')
  }

  if (report.regressions.length > 0 || report.stale.length > 0 || report.staleAllow.length > 0) process.exit(1)

  const known = Object.values(baseline.files).reduce((sum, n) => sum + n, 0)
  console.log(`[test-clock] ok: no new unpinned date literal (baselined: ${known} in ${Object.keys(baseline.files).length} file(s))`)
}

if (import.meta.main) main()
