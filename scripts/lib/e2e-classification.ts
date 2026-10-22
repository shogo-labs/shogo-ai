// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Pure classification helpers for a hosted e2e run (SHO-136).
//
// The critical-path suite fails for two very different reasons:
//
//   * `environment:` — the cluster could not carry the load. A node is out of
//     disk, the warm pool has no Ready ksvc, the api 5xxs, or a request times
//     out. This is a PLATFORM defect: the run has to say so out loud instead of
//     turning "green after a retry" into the accepted steady state.
//   * `product:` — the specs failed with an assertion, i.e. the deployed code
//     is wrong and a human needs to look at the diff.
//
// Everything here is a pure function of its inputs so `scripts/__tests__` can
// cover every branch without a cluster or a network call. `scripts/e2e-classify.ts`
// is the thin CI wrapper that feeds it a Playwright JSON report and the two
// capacity probes.

/** One failed spec from a Playwright JSON report. */
export interface FailedSpec {
  file: string
  title: string
  message: string
}

/**
 * The capacity assertions the preflight / post-run probes make on the target
 * cluster. `false` means the cluster was already unhealthy at that moment.
 */
export interface CapacityProbe {
  diskOk: boolean
  diskReason?: string
  warmPoolOk: boolean
  warmPoolReason?: string
  studioRevisionOk: boolean
  studioRevisionReason?: string
  healthOk: boolean
  healthReason?: string
}

/**
 * `unknown` exists because a red run that files no parseable report is not a
 * pass. It is treated exactly like `environment`: annotated, and filed as a
 * platform defect.
 */
export type Classification = 'clean' | 'environment' | 'product' | 'unknown'

export interface ClassifyInput {
  failures: FailedSpec[]
  /** Probe taken immediately before the suite started. */
  before?: CapacityProbe
  /** Probe taken with `if: always()` after the suite finished. */
  after?: CapacityProbe
  /**
   * The Playwright job's result (`success` / `failure` / `cancelled`). Required
   * to tell "nothing failed" from "nothing was reported": the JSON reporter only
   * writes at the end, so a job killed at its 60-minute timeout leaves `failures`
   * empty while the run was in fact red.
   */
  outcome?: string
}

export interface ClassifyResult {
  kind: Classification
  /** `environment: <reason>` / `product: <n> specs` / `''` when clean. */
  annotation: string
  /** Per-check breach descriptions, most useful first. */
  reasons: string[]
  /** Titles of the product failures, for the step summary. */
  productSpecs: string[]
}

const ENVIRONMENT_PATTERNS: RegExp[] = [
  // Playwright's own timeouts, including the `waitForAgentResponse` helper that
  // wraps an agent turn: a saturated api simply never answers in time.
  /TimeoutError/i,
  /Test timeout of \d+\s*ms exceeded/i,
  /waitForAgentResponse/i,
  /waiting for (?:locator|selector|function)/i,
  // Connection-level aborts — the browser or the runner never reached the api.
  /net::ERR_/i,
  /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN/i,
  /\bsocket hang up\b/i,
  /Navigation failed/i,
  // A saturated api answers 5xx instead of taking the write.
  /\b(?:status|HTTP|response(?: code)?)\D{0,24}(5\d\d)\b/i,
  // Bare 5xx codes, but not "500ms" / "5030ms" style durations.
  /\b5\d\d\b(?!\s*ms)/,
  // The runner's browser image is missing its binary or its shared libraries.
  // Playwright reports these at the top level of the report, and they can never
  // be caused by the product under test.
  /Executable (?:doesn't|doesn’t) exist/i,
  /Host system is missing dependencies/i,
]

/** True when an error message looks like the environment failed, not the code. */
export function isEnvironmentFailure(message: string): boolean {
  if (!message) return false
  return ENVIRONMENT_PATTERNS.some((re) => re.test(message))
}

function breaches(probe: CapacityProbe | undefined): string[] {
  if (!probe) return []
  const out: string[] = []
  if (!probe.diskOk) out.push(probe.diskReason || 'node disk over threshold')
  if (!probe.warmPoolOk) out.push(probe.warmPoolReason || 'warm pool not ready')
  if (!probe.studioRevisionOk) out.push(probe.studioRevisionReason || 'studio spans more than one Ready revision')
  if (!probe.healthOk) out.push(probe.healthReason || 'api health check not 200')
  return out
}

/**
 * Decide whether a run's red is the platform or the product.
 *
 * Cluster evidence wins over the shape of the error messages: if a probe
 * caught a breach, the run is `environment:` no matter what the specs said.
 * Only when the cluster was verifiably fine do we trust the messages to
 * separate "everything timed out" from "three specs asserted the wrong value".
 */
export function classifyE2eRun(input: ClassifyInput): ClassifyResult {
  const { failures, before, after, outcome } = input

  // Nothing failed and the job succeeded: a green run is never attributed, even
  // if a probe caught the cluster above a threshold on the way past.
  if (failures.length === 0 && (!outcome || outcome === 'success')) {
    return { kind: 'clean', annotation: '', reasons: [], productSpecs: [] }
  }

  const beforeBreaches = breaches(before)
  const afterBreaches = breaches(after)

  if (beforeBreaches.length > 0 || afterBreaches.length > 0) {
    const reasons: string[] = []
    if (beforeBreaches.length > 0) reasons.push(`started on a degraded cluster: ${beforeBreaches.join('; ')}`)
    if (afterBreaches.length > 0) reasons.push(`cluster degraded during the run: ${afterBreaches.join('; ')}`)
    return {
      kind: 'environment',
      annotation: `environment: ${reasons[0]}`,
      reasons,
      productSpecs: [],
    }
  }

  // A measured breach is worth more than "we could not read the report", so this
  // sits after the probe check: red, nothing parseable, cluster verifiably fine.
  if (failures.length === 0) {
    return {
      kind: 'unknown',
      annotation: `unknown: ${outcome ?? 'failure'} with no parseable report`,
      reasons: ['the Playwright report was missing, unreadable, or listed no specs'],
      productSpecs: [],
    }
  }

  const environmentShaped = failures.filter((f) => isEnvironmentFailure(f.message))
  if (environmentShaped.length === failures.length) {
    const timeouts = environmentShaped.filter((f) => /timeout/i.test(f.message)).length
    // "timeout" only when every failure was one; anything else (5xx, a broken
    // browser image, a dropped socket) is environment-shaped but not a timeout.
    const allTimeouts = timeouts === environmentShaped.length
    const shape = allTimeouts ? 'timeout' : 'environment-shaped'
    return {
      kind: 'environment',
      annotation: `environment: ${failures.length} ${shape} failure${failures.length === 1 ? '' : 's'} with a healthy cluster`,
      reasons: [`${failures.length}/${failures.length} failures were ${allTimeouts ? 'timeout-shaped' : 'environment-shaped'}`],
      productSpecs: [],
    }
  }

  const productSpecs = failures.map((f) => `${f.file} › ${f.title}`)
  return {
    kind: 'product',
    annotation: `product: ${failures.length} spec${failures.length === 1 ? '' : 's'}`,
    reasons: [`${failures.length - environmentShaped.length}/${failures.length} failures were assertions`],
    productSpecs,
  }
}

/**
 * A retry is never a clean green: the deploy summary has to keep saying that
 * the first attempt was red and why. `previous` is the classification of that
 * first attempt when it could be read, otherwise `unknown`.
 */
export function degradedRetryNote(previous: string | undefined): string {
  const first = previous && previous !== 'clean' ? previous : 'unknown'
  return `degraded: first attempt was ${first}`
}

interface PlaywrightSpec {
  title?: string
  ok?: boolean
  tests?: { status?: string; results?: { status?: string; error?: { message?: string } }[] }[]
}

interface PlaywrightSuite {
  title?: string
  file?: string
  suites?: PlaywrightSuite[]
  specs?: PlaywrightSpec[]
}

interface PlaywrightReport {
  suites?: PlaywrightSuite[]
  /**
   * Playwright's own top-level failures — globalSetup/globalTeardown, a browser
   * that never launched, a reporter that died. They carry no spec, which is why
   * dropping them made such a run look `clean`.
   */
  errors?: { message?: string; location?: { file?: string } }[]
}

function walkSuites(suites: PlaywrightSuite[] | undefined, file: string, out: FailedSpec[]): void {
  for (const suite of suites ?? []) {
    const currentFile = suite.file ?? file
    for (const spec of suite.specs ?? []) {
      if (spec.ok) continue
      const messages = (spec.tests ?? []).flatMap((test) =>
        (test.results ?? []).map((result) => result.error?.message ?? ''),
      )
      const message = messages.find((m) => m.length > 0) ?? 'failed without an error message'
      out.push({ file: currentFile, title: spec.title ?? '(untitled)', message })
    }
    walkSuites(suite.suites, currentFile, out)
  }
}

/** Flatten a Playwright JSON report down to its failures (skipped ≠ failed). */
export function collectFailedSpecs(report: PlaywrightReport | undefined): FailedSpec[] {
  const out: FailedSpec[] = []
  for (const error of report?.errors ?? []) {
    out.push({
      file: error.location?.file ?? '(report)',
      title: 'top-level error',
      message: error.message ?? 'report-level error without a message',
    })
  }
  walkSuites(report?.suites, '', out)
  return out
}

/**
 * `environment` and `unknown` both mean "the platform could not tell us this
 * run passed", so both must annotate and file a platform issue. Only `clean`
 * and `product` are the product's problem.
 */
export function isPlatformClassification(kind: Classification): boolean {
  return kind === 'environment' || kind === 'unknown'
}
