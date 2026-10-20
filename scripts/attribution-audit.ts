// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Report-only audit of agent commit attribution on `main`.
 *
 * Attribution must never hold a card (channel doc, Russell 2026-10-19), so this
 * is a signal, not a gate: it runs on `push: main` and manual dispatch only,
 * never on `pull_request`, and is not part of the required
 * "Lint, Typecheck, Test" aggregate.
 *
 * The baseline is the commit that introduced `.githooks/commit-msg`: everything
 * reachable from it predates enforcement and is reported as legacy (the wrong
 * identities already on `main` are history — nothing rewrites them). Only
 * commits after it can turn the run red:
 *
 *   - an author/committer that is a Shogo identity but not the canonical one
 *   - a `Co-authored-by:` naming a Shogo identity that is not canonical (the
 *     gray-avatar class)
 *   - an agent-authored commit with no canonical co-author at all
 *
 * Repeated canonical lines are just a squash merge folding one trailer per
 * branch commit; they are counted, not failed.
 *
 *   bun scripts/attribution-audit.ts [--limit <n>] [--sha <cutoff>]
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import {
  inspectAgentAttribution,
  isCanonicalShogoAgentIdentity,
  isShogoAgentIdentity,
} from '../packages/shared-runtime/src/agent-attribution'

const DEFAULT_LIMIT = 200
const LEGACY_WINDOW = 400

interface Commit {
  sha: string
  author: { name: string; email: string }
  committer: { name: string; email: string }
  message: string
}

interface Finding {
  sha: string
  subject: string
  reasons: string[]
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024 })
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index > 0 ? process.argv[index + 1] : undefined
}

function readCommits(range: string[], limit: number): Commit[] {
  const format = '%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e'
  const raw = git(['log', ...range, `--max-count=${limit}`, `--format=${format}`])
  return raw
    .split('\x1e')
    .map((record) => record.replace(/^\n+/, ''))
    .filter(Boolean)
    .map((record) => {
      const [sha, authorName, authorEmail, committerName, committerEmail, message] = record.split('\x1f')
      return {
        sha: sha!,
        author: { name: authorName ?? '', email: authorEmail ?? '' },
        committer: { name: committerName ?? '', email: committerEmail ?? '' },
        message: message ?? '',
      }
    })
}

/** Commits that predate the tracked hook: reported, never failed. */
function enforcementSha(): string | null {
  const pinned = arg('--sha')
  if (pinned) return pinned
  try {
    const sha = git(['log', '--diff-filter=A', '--format=%H', '-1', '--', '.githooks/commit-msg']).trim()
    return sha || null
  } catch {
    return null
  }
}

function audit(commits: Commit[]): Finding[] {
  const findings: Finding[] = []
  for (const commit of commits) {
    const reasons: string[] = []
    if (isShogoAgentIdentity(commit.author.name, commit.author.email) && !isCanonicalShogoAgentIdentity(commit.author.name, commit.author.email)) {
      reasons.push(`author ${commit.author.name} <${commit.author.email}>`)
    }
    if (isShogoAgentIdentity(commit.committer.name, commit.committer.email) && !isCanonicalShogoAgentIdentity(commit.committer.name, commit.committer.email)) {
      reasons.push(`committer ${commit.committer.name} <${commit.committer.email}>`)
    }

    const report = inspectAgentAttribution(commit.message)
    if (report.nonCanonical.length > 0) reasons.push(`co-author ${report.nonCanonical.join(', ')}`)
    if (report.canonical === 0 && isCanonicalShogoAgentIdentity(commit.author.name, commit.author.email)) {
      reasons.push('agent-authored commit with no co-author trailer')
    }

    if (reasons.length > 0) {
      findings.push({ sha: commit.sha, subject: subjectOf(commit.message), reasons })
    }
  }
  return findings
}

function subjectOf(message: string): string {
  return (message.trim().split('\n')[0] ?? '').slice(0, 90)
}

const MAX_LINES_PER_REPORT = 20

function render(title: string, findings: Finding[]): string[] {
  if (findings.length === 0) return [`${title}: none`]
  const shown = findings
    .slice(0, MAX_LINES_PER_REPORT)
    .map((finding) => `  ${finding.sha.slice(0, 9)}  ${finding.reasons.join('; ')} — ${finding.subject}`)
  const hidden = findings.length - shown.length
  return [
    `${title}: ${findings.length}`,
    ...shown,
    ...(hidden > 0 ? [`  … and ${hidden} more`] : []),
  ]
}

function main(): number {
  const limit = Number(arg('--limit') ?? DEFAULT_LIMIT) || DEFAULT_LIMIT
  const cutoff = enforcementSha()

  const enforced = cutoff ? readCommits([`${cutoff}..HEAD`], limit) : readCommits(['HEAD'], limit)
  const legacy = cutoff ? audit(readCommits([cutoff], LEGACY_WINDOW)) : []
  const findings = audit(enforced)
  const duplicates = enforced
    .map((commit) => ({ sha: commit.sha, count: inspectAgentAttribution(commit.message).canonical }))
    .filter((entry) => entry.count > 1)

  const lines = [
    `Agent attribution audit — ${enforced.length} commit(s) since ${cutoff ? cutoff.slice(0, 9) : 'HEAD'}`,
    ...render('Non-canonical attribution', findings),
    ...render(`Legacy baseline (before ${cutoff ? cutoff.slice(0, 9) : 'enforcement'}, reported only)`, legacy),
    `Squashed commits carrying several canonical co-author lines: ${duplicates.length}`,
  ]
  const report = lines.join('\n')
  console.log(report)

  const summaryFile = process.env.GITHUB_STEP_SUMMARY
  if (summaryFile) {
    appendFileSync(summaryFile, `## Agent attribution audit\n\n\`\`\`\n${report}\n\`\`\`\n`)
  }

  return findings.length > 0 ? 1 : 0
}

process.exit(main())
