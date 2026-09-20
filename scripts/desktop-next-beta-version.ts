#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Resolves the desktop app's release `version` + update `channel` for the
 * `desktop-release-macos.yml` / `desktop-release-windows.yml` workflows,
 * and appends both to `$GITHUB_OUTPUT`.
 *
 *   - Tag push (refs/tags/vX.Y.Z[-...]):  version = X.Y.Z[-...], channel = stable
 *   - workflow_dispatch:                  version = inputs.version,
 *                                         channel = inputs.channel || stable
 *   - Push to main:                       version = <next patch of the
 *                                         newest stable vX.Y.Z tag>-beta.<UTC
 *                                         YYYYMMDDHHMMSS>, channel = beta
 *
 * The macOS and Windows workflows each run this script independently (in
 * their own `resolve-version` job) for the SAME push, and both must
 * compute the IDENTICAL version string so their `softprops/action-gh-
 * release` steps append to the SAME GitHub Release/tag instead of racing
 * to create two different releases for one push. That rules out
 * wall-clock build time as the beta timestamp source — the two
 * workflows' jobs start at slightly different times. Instead we derive
 * the timestamp from HEAD's *committer* date, which is identical on
 * every checkout of the same commit and — because GitHub stamps merges
 * to `main` in commit order — is also monotonically increasing across
 * pushes, which Squirrel/NuGet's version comparison requires in order to
 * treat each new beta as "newer" than the last.
 *
 * The timestamp is a fixed-width 14-digit string (no `.`) because
 * `electron-winstaller`'s `convertVersion()` strips dots from the
 * prerelease when deriving the NuGet package id
 * (`-beta.20260919233000` becomes `-beta20260919233000`), and NuGet then
 * compares that trailing string LEXICALLY. A fixed width keeps lexical
 * order equal to chronological order forever; a variable-width or
 * dotted counter would not.
 *
 * Pure/testable: every function below takes explicit inputs instead of
 * reaching into `process.env` / shelling out to `git`, so
 * `desktop-next-beta-version.test.ts` can exercise every branch without
 * a real git checkout. `main()` — only invoked when this file is run
 * directly — is the sole part that touches the environment.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

export type UpdateChannel = 'stable' | 'beta'

export interface ResolvedVersion {
  version: string
  channel: UpdateChannel
}

export function isStableTag(tag: string): boolean {
  return /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag)
}

function compareStableTags(a: string, b: string): number {
  const pa = a.slice(1).split('.').map(Number)
  const pb = b.slice(1).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

/** Highest-semver stable (non-prerelease) `vX.Y.Z` tag, or null if none. */
export function pickLatestStableTag(tags: string[]): string | null {
  let best: string | null = null
  for (const tag of tags) {
    if (!isStableTag(tag)) continue
    if (!best || compareStableTags(tag, best) > 0) best = tag
  }
  return best
}

/** Bump the patch component of a `vX.Y.Z` tag by one. Returns "X.Y.(Z+1)" (no leading `v`). */
export function nextPatchVersion(stableTag: string): string {
  const [major, minor, patch] = stableTag.slice(1).split('.').map(Number)
  return `${major}.${minor}.${patch + 1}`
}

/** 14-digit fixed-width UTC timestamp, e.g. "20260919233000". */
export function formatBetaTimestamp(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    String(date.getUTCFullYear()) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds())
  )
}

export function resolveBetaVersion(tags: string[], commitDate: Date): string {
  const latestStable = pickLatestStableTag(tags)
  const base = latestStable ? nextPatchVersion(latestStable) : '0.0.1'
  return `${base}-beta.${formatBetaTimestamp(commitDate)}`
}

export interface ResolveVersionInput {
  eventName: string | undefined
  ref: string | undefined
  dispatchVersion: string | undefined
  dispatchChannel: string | undefined
  tags: string[]
  commitDate: Date
}

export function resolveVersion(input: ResolveVersionInput): ResolvedVersion {
  const { eventName, ref, dispatchVersion, dispatchChannel, tags, commitDate } = input

  if (typeof ref === 'string' && ref.startsWith('refs/tags/v')) {
    return { version: ref.slice('refs/tags/v'.length), channel: 'stable' }
  }
  if (eventName === 'workflow_dispatch' && dispatchVersion) {
    return { version: dispatchVersion, channel: dispatchChannel === 'beta' ? 'beta' : 'stable' }
  }
  if (ref === 'refs/heads/main') {
    return { version: resolveBetaVersion(tags, commitDate), channel: 'beta' }
  }
  return { version: '0.0.0-dev', channel: 'stable' }
}

function listTags(): string[] {
  try {
    return execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function headCommitDate(): Date {
  try {
    const iso = execFileSync('git', ['log', '-1', '--format=%cI'], { encoding: 'utf8' }).trim()
    const d = new Date(iso)
    if (!Number.isNaN(d.getTime())) return d
  } catch {
    // Not a git checkout (or git unavailable) — fall back to wall clock.
    // Only reachable in ad hoc/local invocations; CI always has a checkout.
  }
  return new Date()
}

function main(): void {
  const result = resolveVersion({
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    dispatchVersion: process.env.DISPATCH_VERSION || undefined,
    dispatchChannel: process.env.DISPATCH_CHANNEL || undefined,
    tags: listTags(),
    commitDate: headCommitDate(),
  })

  const out = `version=${result.version}\nchannel=${result.channel}\n`
  process.stdout.write(out)

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, out)
  }
}

if (import.meta.main) {
  main()
}
