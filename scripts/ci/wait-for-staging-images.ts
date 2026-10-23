#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Production deploy gate (deploy.yml → promote-images).
 *
 * Blocks until this commit's staging rollout has written the complete
 * `staging-<sha>` tag set promote-images re-tags as `production-<sha>`.
 *
 * The tag set is written by the staging *rollout* (deploy-staging.yml's
 * "Complete staging release tag set"), minutes after the commit's image
 * builds: the repos a rollout carries forward instead of building only get
 * their tag then. A `v*` tag pushed while that rollout is still running
 * therefore used to fail promotion 1.5 s before the tags appeared (v2.3.7,
 * run 39567961829). Waiting on the invariant — the tags themselves — is the
 * only ordering that holds under `skip_staging_e2e_gate`,
 * `force_rebuild_production` and the deploy queue.
 *
 * Env: GH_TOKEN, REPOSITORY (owner/name), SHA, OCIR_REGISTRY,
 *      IMAGE_GATE_TIMEOUT_MS (default 60 min), IMAGE_GATE_POLL_MS (default 30s).
 * Requires an authenticated `docker buildx` (the job logs in to OCIR first).
 */

/** Repos promote-images re-tags. Keep in sync with the re-tag loop in
 *  deploy.yml, .github/scripts/resolve-release-images.sh and
 *  .github/scripts/plan-production-deploy.sh. */
export const REPOS = ['shogo-api', 'shogo-web', 'shogo-docs', 'shogo-runtime'] as const

/** A tag push and its main push start together; give the main run time to register. */
export const REGISTRATION_GRACE_MS = 3 * 60 * 1000
export const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000
export const DEFAULT_POLL_MS = 30_000

export type WorkflowRun = {
  id: number
  head_branch: string | null
  event: string
  status: string
  conclusion: string | null
  html_url?: string
}

export type Decision =
  | { kind: 'pass'; message: string }
  | { kind: 'fail'; message: string }
  | { kind: 'wait'; message: string }

/** The escape hatch every failure names; the first remedy differs per branch. */
const FORCE_REBUILD = 're-run this release with force_rebuild_production=true to rebuild the images'

export function stagingTag(sha: string): string {
  return `staging-${sha}`
}

export function imageRef(registry: string, repo: string, sha: string): string {
  return `${registry}/shogo/${repo}:${stagingTag(sha)}`
}

export function decide(input: { missing: string[]; stagingRuns: WorkflowRun[]; sha: string; elapsedMs: number }): Decision {
  const tag = stagingTag(input.sha)
  if (input.missing.length === 0) {
    return { kind: 'pass', message: `${tag} exists for every promoted repo` }
  }
  const missingList = input.missing.join(' ')

  const running = input.stagingRuns.filter((r) => r.status !== 'completed')
  if (running.length > 0) {
    const run = running[0]
    return {
      kind: 'wait',
      message: `no ${tag} yet for: ${missingList} — staging rollout run ${run.id} for this commit is ${run.status} and writes the tag set when it finishes (${run.html_url ?? 'running'})`,
    }
  }

  if (input.stagingRuns.length === 0) {
    if (input.elapsedMs < REGISTRATION_GRACE_MS) {
      return { kind: 'wait', message: `no ${tag} yet for: ${missingList}, and no staging rollout for this commit has registered yet` }
    }
    return {
      kind: 'fail',
      message:
        `no ${tag} for: ${missingList}, and no main-branch staging rollout of ${input.sha} ever started within ${Math.round(REGISTRATION_GRACE_MS / 60000)} min. ` +
        `The tag set is written by this commit's staging rollout, so a commit that never rolled out to staging cannot be promoted. ` +
        `Re-run this commit's main-branch staging deploy, or ${FORCE_REBUILD}.`,
    }
  }

  const last = input.stagingRuns[0]
  return {
    kind: 'fail',
    message:
      `no ${tag} for: ${missingList}, and this commit's staging rollout run ${last.id} already finished (${last.conclusion}) without writing them: ${last.html_url ?? 'no run URL'}. ` +
      `The staging rollout is what writes ${tag}, so a finished rollout means it will never appear for these repos. ` +
      `Its "Complete staging release tag set" step warns for each repo it had nothing to carry forward; ${FORCE_REBUILD}.`,
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

/** Read-only manifest probe; `false` means the tag does not exist in the registry. */
export async function tagExists(ref: string): Promise<boolean> {
  const proc = Bun.spawn(['docker', 'buildx', 'imagetools', 'inspect', ref], { stdout: 'ignore', stderr: 'ignore' })
  return (await proc.exited) === 0
}

export async function probeMissing(registry: string, sha: string, repos: readonly string[] = REPOS): Promise<string[]> {
  const present = await Promise.all(repos.map(async (repo) => [repo, await tagExists(imageRef(registry, repo, sha))] as const))
  return present.filter(([, exists]) => !exists).map(([repo]) => repo)
}

function stagingRolloutRuns(repo: string, sha: string) {
  return gh<{ workflow_runs: WorkflowRun[] }>(`repos/${repo}/actions/workflows/deploy.yml/runs?head_sha=${sha}&per_page=50`)
}

async function main() {
  const repo = process.env.REPOSITORY
  const sha = process.env.SHA
  const registry = process.env.OCIR_REGISTRY
  if (!repo || !sha || !registry) throw new Error('REPOSITORY, SHA and OCIR_REGISTRY are required')

  const timeoutMs = Number(process.env.IMAGE_GATE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
  const pollMs = Number(process.env.IMAGE_GATE_POLL_MS ?? DEFAULT_POLL_MS)
  const started = Date.now()
  let lastMissing: string[] = [...REPOS]
  let lastRuns: WorkflowRun[] = []

  while (Date.now() - started < timeoutMs) {
    const [missing, runs] = await Promise.all([probeMissing(registry, sha), stagingRolloutRuns(repo, sha)])
    lastMissing = missing
    lastRuns = runs.workflow_runs.filter((r) => r.head_branch === 'main' && r.event === 'push')
    const d = decide({ missing, stagingRuns: lastRuns, sha, elapsedMs: Date.now() - started })
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

  const run = lastRuns[0]
  console.log(
    `::error::Timed out after ${Math.round(timeoutMs / 60000)} min waiting for ${stagingTag(sha)}: still missing ${lastMissing.join(' ') || '(none)'}. ` +
      `Staging rollout: ${run ? `run ${run.id} (${run.status}${run.conclusion ? `/${run.conclusion}` : ''}) ${run.html_url ?? ''}` : 'none found for this commit'} — check that run (a normal one finishes ~20 min after the tag push), or ${FORCE_REBUILD}.`,
  )
  process.exit(1)
}

if (import.meta.main) {
  main().catch((err) => {
    console.log(`::error::${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
