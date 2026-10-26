#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Deploy CI gate (deploy.yml → ci-gate).
 *
 * Blocks until the required aggregate check `Lint, Typecheck, Test` is green
 * for $SHA, proven by either run that can prove it:
 *   - the `merge_group` run, which tested this exact commit on the merge
 *     queue's temporary ref before it landed on main, or
 *   - the `push` (or `workflow_dispatch`) run on main.
 *
 * Both are re-read on every poll. A merge-queue commit can reach main while
 * its `merge_group` run is still finishing; looking at the queue only once at
 * t=0 missed that and left the gate polling the push run — which, for a
 * queue-verified commit, only warms caches and reports skipped jobs — for 30
 * minutes before failing with "Timed out waiting for CI to pass".
 *
 * Env: GH_TOKEN, REPOSITORY (owner/name), SHA, DRY_RUN,
 *      GATE_TIMEOUT_MS (default 30 min), GATE_POLL_MS (default 15s).
 */

/** Branch protection's required context; must match ci.yml's aggregator name. */
export const REQUIRED_JOB = 'Lint, Typecheck, Test'
/** Conclusions of the required job that mean the commit is known-bad. */
export const HARD_FAILURES = new Set(['failure', 'timed_out', 'startup_failure'])
export const PUSH_EVENTS = new Set(['push', 'workflow_dispatch'])

export type WorkflowRun = {
  id: number
  head_sha: string
  event: string
  status: string
  conclusion: string | null
  run_number: number
  html_url?: string
}

export type RunState = {
  id: number
  status: string
  conclusion: string | null
  /** Conclusion of the required aggregate job; null until it reports. */
  required: string | null
}

export type Decision =
  | { kind: 'pass'; message: string }
  | { kind: 'fail'; message: string }
  | { kind: 'wait'; message: string }

function describe(run: RunState, label: string): string {
  return `${label} ${run.id}: status=${run.status}, ${REQUIRED_JOB}=${run.required ?? 'not reported yet'}`
}

/**
 * `queue` is the newest merge_group run for this SHA, `push` the newest
 * push/workflow_dispatch run. Either one being green is enough: both test the
 * same commit, so whichever reports first settles it.
 */
export function decide(input: { queue: RunState | null; push: RunState | null }): Decision {
  const { queue, push } = input

  // Green from either source wins, even if the other one went red (a flake in
  // one run must not block a deploy the other run proved).
  if (queue?.required === 'success') {
    return { kind: 'pass', message: `merge-queue CI run ${queue.id} passed ${REQUIRED_JOB}` }
  }
  if (push?.required === 'success') {
    return { kind: 'pass', message: `CI run ${push.id} passed ${REQUIRED_JOB}` }
  }
  if (push?.status === 'completed' && push.conclusion === 'success') {
    return { kind: 'pass', message: `CI run ${push.id} is green` }
  }

  // Fail fast rather than burning the remaining poll budget: this commit's
  // required check already reported red.
  if (queue?.status === 'completed' && queue.required && HARD_FAILURES.has(queue.required)) {
    return {
      kind: 'fail',
      message: `merge-queue CI run ${queue.id} reports ${REQUIRED_JOB}=${queue.required} for this commit`,
    }
  }
  if (push && push.status === 'completed') {
    return {
      kind: 'fail',
      message: `CI run ${push.id} finished with conclusion=${push.conclusion} (required job: ${push.required ?? 'missing'})`,
    }
  }

  if (!queue && !push) {
    return { kind: 'wait', message: 'no CI run for this commit yet; waiting for it to start' }
  }

  const parts: string[] = []
  if (queue) parts.push(describe(queue, 'merge-queue run'))
  if (push) parts.push(describe(push, 'CI run'))
  return { kind: 'wait', message: parts.join('; ') }
}

async function gh<T>(path: string): Promise<T> {
  const base = process.env.GITHUB_API_URL ?? 'https://api.github.com'
  const res = await fetch(`${base}/${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

/** `--paginate` in the shell version; a CI run has ~10 jobs, so one page does. */
async function runState(repo: string, run: WorkflowRun): Promise<RunState> {
  const jobs = await gh<{ jobs: { name: string; conclusion: string | null }[] }>(
    `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
  )
  const required = jobs.jobs.filter((j) => j.name === REQUIRED_JOB).at(-1)?.conclusion ?? null
  return { id: run.id, status: run.status, conclusion: run.conclusion, required }
}

function newest(runs: WorkflowRun[], matches: (event: string) => boolean): WorkflowRun | null {
  const candidates = runs.filter((r) => matches(r.event)).sort((a, b) => b.run_number - a.run_number)
  return candidates[0] ?? null
}

async function main() {
  const repo = process.env.REPOSITORY
  const sha = process.env.SHA
  if (!repo || !sha) throw new Error('REPOSITORY and SHA are required')

  if (process.env.DRY_RUN === 'true') {
    console.log('Dry run changes nothing; not waiting for CI.')
    return
  }

  const timeoutMs = Number(process.env.GATE_TIMEOUT_MS ?? 30 * 60 * 1000)
  const pollMs = Number(process.env.GATE_POLL_MS ?? 15_000)
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    const { workflow_runs: all } = await gh<{ workflow_runs: WorkflowRun[] }>(
      `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=50`,
    )
    // The API filters by head_sha, but a merge_group run's head_sha is the
    // queue's merge commit — match it explicitly, exactly as the previous
    // gate did, rather than trusting the query.
    const forSha = all.filter((r) => r.head_sha === sha)
    const queueRun = newest(forSha, (e) => e === 'merge_group')
    const pushRun = newest(forSha, (e) => PUSH_EVENTS.has(e))

    const decision = decide({
      queue: queueRun ? await runState(repo, queueRun) : null,
      push: pushRun ? await runState(repo, pushRun) : null,
    })

    if (decision.kind === 'pass') {
      console.log(`${decision.message} for ${sha}.`)
      return
    }
    if (decision.kind === 'fail') {
      console.log(`::error::${decision.message}`)
      process.exit(1)
    }
    console.log(`${decision.message}; retrying in ${pollMs / 1000}s...`)
    await Bun.sleep(pollMs)
  }

  console.log(`::error::Timed out waiting for CI to pass for ${sha}.`)
  process.exit(1)
}

if (import.meta.main) {
  main().catch((err) => {
    console.log(`::error::${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
