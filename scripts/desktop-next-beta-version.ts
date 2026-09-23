#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Resolves the desktop app's release `version` + update `channel` for the
 * `desktop-release-macos.yml` / `desktop-release-windows.yml` workflows,
 * and appends both to `$GITHUB_OUTPUT`.
 *
 *   - Tag push (refs/tags/vX.Y.Z[-...]):  version = X.Y.Z[-...], channel = stable
 *   - workflow_dispatch:                  version = inputs.version, or
 *                                         auto-computed for a beta dispatch;
 *                                         channel = inputs.channel || stable
 *
 * The macOS and Windows workflows each run this script independently (in
 * their own `resolve-version` job) for the SAME selected commit, and both must
 * compute the IDENTICAL version string so their `softprops/action-gh-
 * release` steps append to the SAME GitHub Release/tag instead of racing
 * to create two different releases for one manual beta build. That rules
 * out wall-clock build time as the beta timestamp source — the two
 * workflows' jobs start at slightly different times. Instead we derive
 * the timestamp from HEAD's *committer* date, which is identical on every
 * checkout of the same commit and preserves the required ordering when
 * manual beta builds target successive commits.
 *
 * The timestamp is a fixed-width `<YYYYMMDD>t<HHMMSS>` string (no `.`)
 * because two separate constraints apply at once:
 *
 *   1. `electron-winstaller`'s `convertVersion()` strips dots from the
 *      prerelease when deriving the NuGet package id
 *      (`-beta.20260919t233000` becomes `-beta20260919t233000`), and NuGet
 *      then compares that trailing string LEXICALLY. A fixed width keeps
 *      lexical order equal to chronological order forever; a variable-width
 *      or dotted counter would not.
 *   2. Squirrel.Windows bundles the legacy NuGet `SemanticVersion`, whose
 *      comparison path runs `Int32.Parse` over the numeric runs in the
 *      version. A single 14-digit run (`20260922093736`) is ~9,400x larger
 *      than `Int32.MaxValue` (2147483647) and threw
 *      `System.OverflowException` inside `ReleaseEntry.WriteReleaseFile`,
 *      which failed EVERY Windows beta build — 0 of 30 automatic runs on `main`
 *      produced an installer (SHOG-750).
 *
 * Splitting the stamp with a literal `t` keeps it human-readable and
 * fixed-width while capping every maximal digit run well inside `Int32`:
 * the date run maxes at `99991231` and the time run at `235959`. Because
 * `t` (0x74) sorts above every digit (0x30-0x39), a new stamp also always
 * compares GREATER than the legacy purely-numeric 14-digit stamps that
 * were already published, so existing beta installs still see an upgrade
 * rather than a downgrade.
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

/**
 * Fixed-width UTC timestamp `<YYYYMMDD>t<HHMMSS>`, e.g. "20260919t233000".
 *
 * The `t` separator is load-bearing: it splits the stamp into two digit runs
 * that each fit comfortably in `Int32`, which Squirrel/NuGet requires (see the
 * module docstring). Do not remove it or merge the runs back together.
 */
export function formatBetaTimestamp(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const datePart =
    String(date.getUTCFullYear()) + p(date.getUTCMonth() + 1) + p(date.getUTCDate())
  const timePart = p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds())
  return `${datePart}t${timePart}`
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
  if (eventName === 'workflow_dispatch') {
    if (dispatchVersion) {
      return { version: dispatchVersion, channel: dispatchChannel === 'beta' ? 'beta' : 'stable' }
    }
    if (dispatchChannel === 'beta') {
      return { version: resolveBetaVersion(tags, commitDate), channel: 'beta' }
    }
    throw new Error('A release version is required for a stable manual build.')
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
  let result: ResolvedVersion
  try {
    result = resolveVersion({
      eventName: process.env.GITHUB_EVENT_NAME,
      ref: process.env.GITHUB_REF,
      dispatchVersion: process.env.DISPATCH_VERSION || undefined,
      dispatchChannel: process.env.DISPATCH_CHANNEL || undefined,
      tags: listTags(),
      commitDate: headCommitDate(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`::error::${message}\n`)
    process.exit(1)
    return
  }

  const out = `version=${result.version}\nchannel=${result.channel}\n`
  process.stdout.write(out)

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, out)
  }
}

if (import.meta.main) {
  main()
}
