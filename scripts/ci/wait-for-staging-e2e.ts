#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Production deploy gate (deploy.yml → staging-e2e-gate).
 *
 * Blocks until the `e2e/staging-critical` commit status for $SHA — published
 * by the staging deploy's critical-path e2e job (e2e-hosted.yml) — is green.
 * Fails on a red status, and fails fast when no main-branch staging deploy
 * for $SHA exists or is still running (nothing will ever publish the status).
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

export function decide(input: {
  statuses: CommitStatus[]
  mainDeployRuns: WorkflowRun[]
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
    return { kind: 'wait', message: `${STATUS_CONTEXT} is pending (${status.target_url ?? 'running'})` }
  }

  const running = input.mainDeployRuns.filter((r) => r.status !== 'completed')
  if (running.length > 0) {
    return { kind: 'wait', message: `staging deploy run ${running[0].id} for this commit is ${running[0].status}` }
  }
  if (input.elapsedMs < REGISTRATION_GRACE_MS) {
    return { kind: 'wait', message: 'no staging deploy for this commit yet; waiting for it to register' }
  }
  if (input.mainDeployRuns.length === 0) {
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
    message: `staging deploy run ${last.id} finished (${last.conclusion}) without publishing ${STATUS_CONTEXT} ${last.html_url ?? ''}`.trim(),
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
    const d = decide({ statuses: combined.statuses, mainDeployRuns, elapsedMs: Date.now() - started })
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
