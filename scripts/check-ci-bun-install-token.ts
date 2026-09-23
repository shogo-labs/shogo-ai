// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Guard every GitHub Actions workflow's `bun install` steps against the
 * "@vscode/ripgrep 403" flake.
 *
 * Background
 * ----------
 * `packages/agent-runtime` depends on `@vscode/ripgrep`, whose postinstall
 * script (`ripgrep-prebuilt`) downloads a prebuilt `rg` binary from
 * `api.github.com/repos/microsoft/ripgrep-prebuilt/releases/...`. Because
 * `packages/agent-runtime` is part of the root bun workspace, ANY
 * `bun install` run at (or above) the repo root that doesn't pass
 * `--ignore-scripts` triggers this postinstall.
 *
 * Unauthenticated requests to api.github.com share a 60-requests/hour quota
 * PER RUNNER IP, and GitHub-hosted runner IPs are drawn from a shared pool —
 * so in practice that quota is shared with unrelated CI runs on OTHER
 * repos too. The result is an intermittent `Request failed: 403` that has
 * nothing to do with the PR being built (this is what caused the flaky
 * v1.7.14 Windows desktop release, see desktop-release-windows.yml).
 *
 * The fix — already applied to the desktop release / perf-smoke / iOS
 * workflows below — is to set `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`
 * as an env var reachable by the `bun install` step.
 * `@vscode/ripgrep/lib/postinstall.js` reads `process.env['GITHUB_TOKEN']`
 * (that exact name only — NOT `GH_TOKEN`, NOT `github.token` as an env var
 * name) and forwards it as a bearer token to the release lookup, which gets
 * its own per-token 5000/hour quota instead of the shared anonymous one.
 *
 * This script makes that fix permanent instead of tribal knowledge: it
 * scans every workflow for a `bun install` step that can run postinstall
 * scripts, and fails if `GITHUB_TOKEN` isn't set to `secrets.GITHUB_TOKEN`
 * (or `github.token`, same underlying token) at the step, job, or workflow
 * level. It runs in CI on every PR, so a new workflow (or a copy-pasted
 * step that drops the `env:`) gets caught before it ships, instead of
 * discovered the next time GitHub's shared anonymous quota happens to be
 * exhausted.
 *
 * Usage
 * -----
 *   bun scripts/check-ci-bun-install-token.ts
 *
 * Exit code is 0 on success, 1 on any violation.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'

const REPO_ROOT = resolve(import.meta.dir, '..')
const WORKFLOWS_DIR = resolve(REPO_ROOT, '.github/workflows')

// Matches either `${{ secrets.GITHUB_TOKEN }}` or `${{ github.token }}` —
// both resolve to the same job-scoped Actions token.
const TOKEN_VALUE_RE = /secrets\.GITHUB_TOKEN|github\.token/

interface Violation {
  file: string
  message: string
}

function needsToken(run: unknown): boolean {
  if (typeof run !== 'string') return false
  if (!/\bbun install\b/.test(run)) return false
  // `--ignore-scripts` skips postinstall entirely, so ripgrep-prebuilt
  // never runs and there's nothing to authenticate.
  if (/--ignore-scripts/.test(run)) return false
  return true
}

function envHasToken(env: unknown): boolean {
  if (env == null || typeof env !== 'object') return false
  const value = (env as Record<string, unknown>).GITHUB_TOKEN
  return typeof value === 'string' && TOKEN_VALUE_RE.test(value)
}

function checkWorkflow(file: string, src: string): Violation[] {
  const violations: Violation[] = []

  let doc: unknown
  try {
    doc = parse(src)
  } catch (err) {
    violations.push({ file, message: `Failed to parse YAML: ${(err as Error).message}` })
    return violations
  }

  const root = doc as Record<string, unknown> | null
  const workflowEnvOk = envHasToken(root?.env)
  const jobs = (root?.jobs ?? {}) as Record<string, Record<string, unknown>>

  for (const [jobName, job] of Object.entries(jobs)) {
    const jobEnvOk = workflowEnvOk || envHasToken(job?.env)
    const steps = Array.isArray(job?.steps) ? (job.steps as Record<string, unknown>[]) : []

    for (const step of steps) {
      if (!needsToken(step?.run)) continue
      if (jobEnvOk || envHasToken(step?.env)) continue

      const stepName = typeof step?.name === 'string' ? step.name : '(unnamed step)'
      violations.push({
        file,
        message:
          `job "${jobName}", step "${stepName}": \`bun install\` can run ` +
          `postinstall scripts but no GITHUB_TOKEN env (secrets.GITHUB_TOKEN ` +
          `or github.token) is set at the step, job, or workflow level. ` +
          `This risks the @vscode/ripgrep 403 flake — see this script's ` +
          `header, or add \`--ignore-scripts\` if this install genuinely ` +
          `doesn't need postinstall scripts.`,
      })
    }
  }

  return violations
}

function main(): number {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  const violations: Violation[] = []

  for (const f of files) {
    const abs = resolve(WORKFLOWS_DIR, f)
    const src = readFileSync(abs, 'utf-8')
    violations.push(...checkWorkflow(`.github/workflows/${f}`, src))
  }

  if (violations.length === 0) {
    console.log(
      `[check-ci-bun-install-token] OK — every \`bun install\` step across ` +
        `${files.length} workflows either skips scripts or authenticates via GITHUB_TOKEN.`
    )
    return 0
  }

  console.error('[check-ci-bun-install-token] FAIL')
  for (const v of violations) {
    console.error(`  ${v.file}: ${v.message}`)
  }
  console.error(
    '\nFix: add (at the step, or once at the job/workflow level) —\n' +
      '  env:\n' +
      '    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n'
  )
  return 1
}

process.exit(main())
