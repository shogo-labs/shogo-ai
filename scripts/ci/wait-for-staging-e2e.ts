#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Production deploy gate (deploy.yml → staging-e2e-gate).
 *
 * Blocks until the `e2e/staging-critical` commit status for $SHA — published
 * by the staging deploy's critical-path e2e job (e2e-hosted.yml) — is green.
 * Fails on a red status, and fails fast when no main-branch staging deploy
 * for $SHA exists or is still running (nothing will ever publish the status),
 * matching the run id with the recovery the release actually needs. A status
 * left `pending` by a run that has since finished is the same dead end and
 * fails the same way instead of waiting out the timeout.
 *
 * Env: GH_TOKEN, REPOSITORY (owner/name), SHA, SKIP ("true" to bypass),
 *      GATE_TIMEOUT_MS (default 110 min), GATE_POLL_MS (default 30s).
 */

export const STATUS_CONTEXT = 'e2e/staging-critical'
/** A tag push and its main push start together; give the main run time to register. */
export const REGISTRATION_GRACE_MS = 3 * 60 * 1000

export type CommitStatus = { context: string; state: string; target_url?: string | null; description?: string | null }
export type WorkflowRun = { id: number; head_branch: string | null; event: string; status: string; conclusion: string | null; html_url?: string }

export type Decision =
  | { kind: 'pass'; message: string }
  | { kind: 'fail'; message: string }
  | { kind: 'wait'; message: string }

/** Run id behind a status's target_url (`…/actions/runs/<id>`), or null. */
export function runIdFromUrl(url?: string | null): number | null {
  const match = url?.match(/\/actions\/runs\/(\d+)/)
  return match ? Number(match[1]) : null
}

/**
 * What a release tag stuck behind a dead staging run has to do next. The tag
 * run cannot manufacture the missing status or tags itself — only a staging
 * rollout publishes them — so the recovery is always "re-run staging, then
 * re-run this tag run".
 */
export function recoveryLine(runId: number | null): string {
  const rerun = runId ? `gh run rerun ${runId} --failed` : 'gh run rerun <staging run id> --failed'
  return `Recovery: run \`${rerun}\` to re-run the staging run, then re-run this release's tag run.`
}

export function decide(input: {
  statuses: CommitStatus[]
  mainDeployRuns: WorkflowRun[]
  /** The run behind a `pending` status's target_url, when it could be read. */
  statusRun?: WorkflowRun | null
  elapsedMs: number
}): Decision {
  const status = input.statuses.find((s) => s.context === STATUS_CONTEXT)
  if (status?.state === 'success') {
    return { kind: 'pass', message: `${STATUS_CONTEXT} is green` }
  }
  if (status && (status.state === 'failure' || status.state === 'error')) {
    return {
      kind: 'fail',
      message: `${STATUS_CONTEXT} is ${status.state}: ${status.description ?? ''} ${status.target_url ?? ''}`.trim(),
    }
  }
  if (status?.state === 'pending') {
    const run = input.statusRun
    if (run && run.status === 'completed' && run.conclusion !== 'success') {
      return {
        kind: 'fail',
        message:
          `${STATUS_CONTEXT} is still pending, but the run that set it (${run.id}) already finished (${run.conclusion}) without publishing a result: ` +
          `${run.html_url ?? status.target_url ?? 'no run URL'} — nothing will ever resolve that status, so waiting on it only burns the gate timeout. ` +
          recoveryLine(run.id),
      }
    }
    return { kind: 'wait', message: `${STATUS_CONTEXT} is pending (${status.target_url ?? 'running'})` }
  }

  const running = input.mainDeployRuns.filter((r) => r.status !== 'completed')
  if (running.length > 0) {
    return { kind: 'wait', message: `staging deploy run ${running[0].id} for this commit is ${running[0].status}` }
  }
  if (input.mainDeployRuns.length === 0) {
    if (input.elapsedMs < REGISTRATION_GRACE_MS) {
      return { kind: 'wait', message: 'no staging deploy for this commit yet; waiting for it to register' }
    }
    return {
      kind: 'fail',
      message:
        'no main-branch staging deploy exists for this commit (superseded in the deploy queue?). ' +
        'Tag a commit that deployed to staging, or re-run its staging deploy.',
    }
  }
  const last = input.mainDeployRuns[0]
  return {
    kind: 'fail',
    message: `staging deploy run ${last.id} finished (${last.conclusion}) without publishing ${STATUS_CONTEXT} ${last.html_url ?? ''} — only a staging rollout can publish it, so this tag run will never see it. ${recoveryLine(last.id)}`.trim(),
  }
}

async function gh<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

async function main() {
  const repo = process.env.REPOSITORY
  const sha = process.env.SHA
  if (!repo || !sha) throw new Error('REPOSITORY and SHA are required')

  if (process.env.SKIP === 'true') {
    console.log(`::warning::Skipping the staging e2e gate for ${sha} (skip_staging_e2e_gate=true).`)
    return
  }

  const timeoutMs = Number(process.env.GATE_TIMEOUT_MS ?? 110 * 60 * 1000)
  const pollMs = Number(process.env.GATE_POLL_MS ?? 30_000)
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    const [combined, runs] = await Promise.all([
      gh<{ statuses: CommitStatus[] }>(`repos/${repo}/commits/${sha}/status`),
      gh<{ workflow_runs: WorkflowRun[] }>(
        `repos/${repo}/actions/workflows/deploy.yml/runs?head_sha=${sha}&per_page=50`,
      ),
    ])
    const mainDeployRuns = runs.workflow_runs.filter((r) => r.head_branch === 'main' && r.event === 'push')
    const pending = combined.statuses.find((s) => s.context === STATUS_CONTEXT && s.state === 'pending')
    const pendingRunId = pending ? runIdFromUrl(pending.target_url) : null
    const statusRun = pendingRunId
      ? await gh<WorkflowRun>(`repos/${repo}/actions/runs/${pendingRunId}`).catch(() => null)
      : null
    const d = decide({ statuses: combined.statuses, mainDeployRuns, statusRun, elapsedMs: Date.now() - started })
    if (d.kind === 'pass') {
      console.log(`${d.message} for ${sha}.`)
      return
    }
    if (d.kind === 'fail') {
      console.log(`::error::${d.message}`)
      process.exit(1)
    }
    console.log(`${d.message}; retrying in ${pollMs / 1000}s...`)
    await Bun.sleep(pollMs)
  }
  console.log(`::error::Timed out waiting for ${STATUS_CONTEXT} on ${sha}.`)
  process.exit(1)
}

if (import.meta.main) {
  main().catch((err) => {
    console.log(`::error::${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
