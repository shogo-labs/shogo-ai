// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared helpers for the issue-pipeline eval ladder (docs/issue-pipeline/PLAN.md,
 * Phase 4). Two kinds of interaction, matching the two ways the real system is
 * driven:
 *
 *   1. GitHub — L0/L1/L4 don't talk to the agent runtime directly at all. A
 *      human (or the harness, standing in for one) opens an issue and posts
 *      comments on a real, disposable GitHub repo; the GitHub App webhook
 *      (Phase 2) is what wakes the pipeline. These helpers wrap `gh`.
 *   2. WebChat — L2/L3 hand the anchor/module project a one-off prose
 *      instruction ("here is the plan, build it" / "here are three security
 *      findings") that has no natural GitHub event. These helpers delegate to
 *      `../channels/helpers.ts`, the same WebChat client the channel
 *      integration tests use.
 *
 * Environment variables (see README.md for the full table):
 *   GITHUB_TEST_REPO   — "<owner>/<repo>" of a disposable repo connected to a
 *                         Shogo project via the GitHub App. Required for
 *                         L0/L1/L4.
 *   FIXTURE_DIR         — Path to the fixture to push. Defaults to
 *                         `fixtures/target-repo` next to this file.
 *   AGENT_URL           — Base URL of the anchor (or solo) project's agent
 *                         runtime. Required for L2/L3. Same shape as
 *                         `e2e/channels/helpers.ts`.
 *   PIPELINE_POLL_MS    — Poll interval while waiting on GitHub state
 *                         (default 5000).
 *   PIPELINE_TIMEOUT_MS — Max wait for a full pipeline run (default 1800000
 *                         = 30 min; these are real multi-turn capable-model
 *                         agent runs, not chat replies).
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export { agentFetch, collectSSEEvents, getTestEnv, waitForAgent } from '../channels/helpers'
export type { TestEnv } from '../channels/helpers'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// ── Env ──────────────────────────────────────────────────────────────────

export interface PipelineEnv {
  githubTestRepo: string
  fixtureDir: string
  pollMs: number
  timeoutMs: number
}

export function getPipelineEnv(): PipelineEnv {
  const githubTestRepo = process.env.GITHUB_TEST_REPO
  if (!githubTestRepo) {
    throw new Error(
      'GITHUB_TEST_REPO is required, e.g. "shogo-ai-evals/issue-pipeline-fixture".\n' +
        'It must be a disposable repo connected to a Shogo project (or the\n' +
        'issue-pipeline-solo project, for L0) via the GitHub App.'
    )
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(githubTestRepo)) {
    throw new Error(`GITHUB_TEST_REPO must look like "<owner>/<repo>", got "${githubTestRepo}"`)
  }
  return {
    githubTestRepo,
    fixtureDir: process.env.FIXTURE_DIR || join(__dirname, 'fixtures', 'target-repo'),
    pollMs: parseInt(process.env.PIPELINE_POLL_MS || '5000', 10),
    timeoutMs: parseInt(process.env.PIPELINE_TIMEOUT_MS || '1800000', 10),
  }
}

// ── Process helper ───────────────────────────────────────────────────────

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export function run(cmd: string, args: string[], cwd?: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

async function runOk(cmd: string, args: string[], cwd?: string): Promise<string> {
  const res = await run(cmd, args, cwd)
  if (res.code !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.code}):\n${res.stderr || res.stdout}`)
  }
  return res.stdout.trim()
}

// ── GitHub / `gh` wrappers ───────────────────────────────────────────────
// Mirrors the exact commands documented in
// templates/issue-pipeline/intake/.shogo/skills/task-source-github-issues/SKILL.md
// so the eval drives the pipeline the same way a real human/webhook would.

const RUN_ID_MARKER_RE = /<!--\s*shogo:runId=([a-zA-Z0-9_-]+)\s*-->/

export function extractRunId(text: string | null | undefined): string | undefined {
  if (!text) return undefined
  return RUN_ID_MARKER_RE.exec(text)?.[1] ?? undefined
}

/**
 * Force-pushes `env.fixtureDir` to `env.githubTestRepo`'s default branch so
 * every eval run starts from the same clean, buggy baseline (see
 * fixtures/target-repo/README.md). Destructive by design — this repo must
 * be disposable.
 */
export async function resetFixtureRepo(env: PipelineEnv): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'issue-pipeline-fixture-'))
  try {
    await runOk('cp', ['-R', `${env.fixtureDir}/.`, tmp])
    await runOk('git', ['init', '-q'], tmp)
    await runOk('git', ['checkout', '-q', '-b', 'main'], tmp)
    await runOk('git', ['add', '-A'], tmp)
    await runOk('git', ['-c', 'user.email=eval@shogo.ai', '-c', 'user.name=Issue Pipeline Eval', 'commit', '-q', '-m', 'reset: clean fixture baseline'], tmp)
    await runOk('git', ['remote', 'add', 'origin', `https://github.com/${env.githubTestRepo}.git`], tmp)
    await runOk('git', ['push', '-f', 'origin', 'main'], tmp)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

export interface GhIssue {
  number: number
  title: string
  body: string
  url: string
  state: string
  comments: Array<{ body: string; author: { login: string } }>
}

export async function openFixtureIssue(env: PipelineEnv, title: string, body: string): Promise<number> {
  const url = await runOk('gh', ['issue', 'create', '--repo', env.githubTestRepo, '--title', title, '--body', body])
  const match = /\/issues\/(\d+)/.exec(url)
  if (!match) throw new Error(`Could not parse issue number from "gh issue create" output: ${url}`)
  return parseInt(match[1], 10)
}

export async function getIssue(env: PipelineEnv, number: number): Promise<GhIssue> {
  const out = await runOk('gh', [
    'issue', 'view', String(number),
    '--repo', env.githubTestRepo,
    '--json', 'number,title,body,url,state,comments',
  ])
  return JSON.parse(out) as GhIssue
}

export async function postIssueComment(env: PipelineEnv, number: number, body: string): Promise<void> {
  await runOk('gh', ['issue', 'comment', String(number), '--repo', env.githubTestRepo, '--body', body])
}

/**
 * The runId can land on either the issue body (intake edits it in once a
 * run starts) or one of intake's own comments (see
 * `task-source-github-issues/SKILL.md`'s `comment(ref, body, runId)`) —
 * mirrors the `extractRunId(issue.body) ?? extractRunId(comment.body)`
 * fallback in `apps/api/src/services/github.service.ts`.
 */
export async function getRunIdForIssue(env: PipelineEnv, number: number): Promise<string | undefined> {
  const issue = await getIssue(env, number)
  const fromBody = extractRunId(issue.body)
  if (fromBody) return fromBody
  for (const comment of issue.comments) {
    const found = extractRunId(comment.body)
    if (found) return found
  }
  return undefined
}

/** GitHub Apps post as `<slug>[bot]` — this is how intake's comments are told apart from a human's. */
export function botComments(issue: GhIssue): Array<{ body: string; author: { login: string } }> {
  return issue.comments.filter((c) => /\[bot\]$/i.test(c.author?.login ?? ''))
}

export interface GhPullRequest {
  number: number
  title: string
  body: string
  url: string
  state: string
  headRefName: string
  baseRefName: string
  files: Array<{ path: string }>
}

/** Lists open PRs on the fixture repo, optionally filtered to ones carrying `runId` in their body. */
export async function listPullRequests(env: PipelineEnv, opts: { runId?: string; state?: 'open' | 'closed' | 'merged' | 'all' } = {}): Promise<GhPullRequest[]> {
  const out = await runOk('gh', [
    'pr', 'list',
    '--repo', env.githubTestRepo,
    '--state', opts.state ?? 'open',
    '--json', 'number,title,body,url,state,headRefName,baseRefName,files',
  ])
  const prs = JSON.parse(out) as GhPullRequest[]
  return opts.runId ? prs.filter((pr) => extractRunId(pr.body) === opts.runId) : prs
}

/** Checks out a PR's head branch into a fresh temp dir; caller is responsible for cleanup. */
export async function checkoutPullRequest(env: PipelineEnv, pr: GhPullRequest): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), `issue-pipeline-pr-${pr.number}-`))
  await runOk('gh', ['repo', 'clone', env.githubTestRepo, tmp, '--', '-q'])
  await runOk('git', ['fetch', '-q', 'origin', pr.headRefName], tmp)
  await runOk('git', ['checkout', '-q', pr.headRefName], tmp)
  return tmp
}

export async function checkoutBaseBranch(env: PipelineEnv, pr: GhPullRequest): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), `issue-pipeline-base-${pr.number}-`))
  await runOk('gh', ['repo', 'clone', env.githubTestRepo, tmp, '--', '-q'])
  await runOk('git', ['checkout', '-q', pr.baseRefName], tmp)
  return tmp
}

// ── Assertions used across levels ───────────────────────────────────────

/**
 * The plan requires "exactly five options" in the tracker comment where the
 * pipeline posts its analysis. Options are expected as a numbered list
 * ("1. ...", "2. ...", ... or "Option 1:" etc.) — this counts top-level
 * numbered entries 1-9 at the start of a line, which tolerates either style
 * without being so loose it double-counts sub-bullets.
 */
export function countNumberedOptions(commentBody: string): number {
  const matches = commentBody.match(/^\s*(?:option\s*)?[1-9][.):]\s+\S/gim)
  return matches ? matches.length : 0
}

/**
 * Runs `bun test <file>` inside `dir` and reports pass/fail without
 * throwing, so callers can assert on both the base and PR checkouts.
 */
export async function runTestFile(dir: string, relFile: string): Promise<{ passed: boolean; output: string }> {
  const res = await run('bun', ['test', relFile], dir)
  return { passed: res.code === 0, output: res.stdout + res.stderr }
}

export async function runAllTests(dir: string): Promise<{ passed: boolean; output: string }> {
  const res = await run('bun', ['test'], dir)
  return { passed: res.code === 0, output: res.stdout + res.stderr }
}

/** Polls `check` until it resolves truthy or `timeoutMs` elapses. */
export async function waitUntil<T>(
  check: () => Promise<T | undefined | null | false>,
  opts: { timeoutMs: number; pollMs: number; label: string }
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < opts.timeoutMs) {
    const result = await check()
    if (result) return result
    await new Promise((r) => setTimeout(r, opts.pollMs))
  }
  throw new Error(`Timed out after ${opts.timeoutMs}ms waiting for: ${opts.label}`)
}

// ── Project workspace git inspection (for L3) ───────────────────────────
// Local dev mode keeps each project's on-disk workspace under
// `<repoRoot>/workspaces/<projectId>/` (see `workspaces/` at the repo root);
// checkpoints are ordinary git commits there. These helpers let L3 verify
// "only ## Learned changed, checkpoint message cites three runIds" directly
// against that git history instead of re-deriving it from an API.

export function projectWorkspaceDir(projectId: string): string {
  const override = process.env[`PROJECT_WORKSPACE_DIR_${projectId}`]
  if (override) return override
  const root = process.env.WORKSPACES_ROOT || join(__dirname, '..', '..', 'workspaces')
  return join(root, projectId)
}

/** Most recent commit (SHA + message) touching `relFile`, or undefined if none. */
export async function latestCommitTouching(dir: string, relFile: string): Promise<{ sha: string; message: string } | undefined> {
  const res = await run('git', ['log', '-1', '--format=%H%x1f%B', '--', relFile], dir)
  if (res.code !== 0 || !res.stdout.trim()) return undefined
  const [sha, ...rest] = res.stdout.split('\x1f')
  return { sha: sha.trim(), message: rest.join('\x1f').trim() }
}

/** The file's content just BEFORE `sha` (i.e. at `sha^`), or '' if `sha` had no parent. */
export async function fileBeforeRevision(dir: string, sha: string, relFile: string): Promise<string> {
  try {
    return await runOk('git', ['show', `${sha}~1:${relFile}`], dir)
  } catch {
    return ''
  }
}

export async function fileAtHead(dir: string, sha: string, relFile: string): Promise<string> {
  return runOk('git', ['show', `${sha}:${relFile}`], dir)
}

/** Every runId (`run_...`) mentioned in a commit message. */
export function runIdsInText(text: string): string[] {
  const matches = text.match(/\brun_[a-zA-Z0-9_-]+\b/g)
  return matches ? [...new Set(matches)] : []
}

// ── Prompt-file "## Learned" diffing (for L3) ───────────────────────────

/** Extracts the contents of a `## Learned` markdown section, if present. */
export function extractLearnedSection(markdown: string): string | undefined {
  const match = /^##\s+Learned\s*$([\s\S]*?)(?=^##\s+|\z)/im.exec(markdown)
  return match?.[1]?.trim()
}

/**
 * Given the full text of two versions of an AGENTS.md (or a custom
 * subagent .md), asserts only the `## Learned` section differs. Returns the
 * list of section headers that changed outside `## Learned`, which should
 * be empty.
 */
export function sectionsChangedOutsideLearned(before: string, after: string): string[] {
  const split = (text: string) => {
    const sections = new Map<string, string>()
    const re = /^##\s+(.+?)\s*$([\s\S]*?)(?=^##\s+|\z)/gim
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) sections.set(m[1].trim().toLowerCase(), m[2].trim())
    return sections
  }
  const b = split(before)
  const a = split(after)
  const changed: string[] = []
  const keys = new Set([...b.keys(), ...a.keys()])
  for (const key of keys) {
    if (key === 'learned') continue
    if (b.get(key) !== a.get(key)) changed.push(key)
  }
  return changed
}
