// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * deps-doctor
 *
 * Reconciles a pod app's `package.json` with the set of runtime
 * dependencies required by the features enabled in `shogo.config.json`.
 *
 * Each feature in `FEATURE_DEPS` maps to a list of npm packages that
 * must be present in `dependencies`. When a feature is enabled and a
 * package is missing, `ensureFeatureDeps()`:
 *
 *   1. Patches `package.json` in memory to add each missing dep at the
 *      feature's pinned version range (no floating `^latest`).
 *   2. Reports the diff so the caller can decide whether to run
 *      `bun install` itself (the CLI does; tests just snapshot the
 *      returned payload).
 *
 * Does NOT remove deps when a feature is disabled — Shogo has no way
 * to know whether the user imported the lib elsewhere, and tearing
 * dependencies out silently is too dangerous. A future `shogo
 * disable <feature>` verb can surface that as an explicit prompt.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

/**
 * Minimal shape of the `shogo.config.json` `features` object that
 * `deps-doctor` cares about. Kept loose so the CLI can pass its
 * fully-typed `ShogoFeatures` in without an extra cast.
 */
export interface DepsDoctorFeatures {
  voice?:
    | boolean
    | { phoneNumber?: boolean }
}

/**
 * Per-feature dependency manifest. Versions are pinned to a tested
 * range to avoid surprise breakage when a pod is bumped from one
 * generator release to the next.
 */
export const FEATURE_DEPS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  voice: {
    // 1.1+ is required because `useConversation` now lives behind
    // `<ConversationProvider>` (which the SDK surfaces as
    // `<ShogoVoiceProvider>`). Older 0.x versions don't ship the
    // provider symbol and would crash the generated `VoiceButton` /
    // `VoiceSphere` at mount time.
    '@elevenlabs/react': '^1.1.1',
    '@elevenlabs/client': '^1.1.1',
  },
}

export interface DepsDoctorReport {
  /** Absolute path to the package.json that was inspected / patched. */
  packageJsonPath: string
  /** Missing deps detected per feature, before patching. */
  missing: Record<string, Record<string, string>>
  /** Deps that were actually added to package.json by this run. */
  added: Record<string, string>
  /**
   * True when package.json was modified on disk. Callers should then
   * run `bun install` (or equivalent) to materialize the new deps.
   */
  modified: boolean
  /** Warnings (missing package.json, invalid JSON, etc.). */
  warnings: string[]
}

/**
 * Walk the enabled-feature set and merge each feature's required
 * deps into the pod's `package.json`. Idempotent — running twice is
 * a no-op when everything is already in place.
 *
 * @param opts.cwd         Project root (contains `package.json`).
 * @param opts.features    `shogo.config.json` features object.
 * @param opts.dryRun      When true, reports what *would* change but
 *                         doesn't write to disk. Used by the CLI to
 *                         preview in verbose mode / tests.
 */
export function ensureFeatureDeps(opts: {
  cwd: string
  features: DepsDoctorFeatures | undefined
  dryRun?: boolean
}): DepsDoctorReport {
  const packageJsonPath = resolve(opts.cwd, 'package.json')
  const missing: Record<string, Record<string, string>> = {}
  const added: Record<string, string> = {}
  const warnings: string[] = []

  if (!existsSync(packageJsonPath)) {
    warnings.push(`package.json not found at ${packageJsonPath}`)
    return { packageJsonPath, missing, added, modified: false, warnings }
  }

  let raw: string
  let pkg: any
  try {
    raw = readFileSync(packageJsonPath, 'utf-8')
    pkg = JSON.parse(raw)
  } catch (err) {
    warnings.push(
      `Failed to parse package.json: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { packageJsonPath, missing, added, modified: false, warnings }
  }

  const deps: Record<string, string> = (pkg.dependencies ??= {})

  // Build the list of enabled features.
  const enabledFeatures: string[] = []
  if (opts.features?.voice) enabledFeatures.push('voice')

  for (const feature of enabledFeatures) {
    const required = FEATURE_DEPS[feature]
    if (!required) continue
    const featMissing: Record<string, string> = {}
    for (const [name, range] of Object.entries(required)) {
      if (!deps[name]) {
        featMissing[name] = range
        added[name] = range
        deps[name] = range
      }
    }
    if (Object.keys(featMissing).length > 0) missing[feature] = featMissing
  }

  const modified = Object.keys(added).length > 0
  if (modified && !opts.dryRun) {
    // Preserve trailing newline if present in the original.
    const hasTrailingNewline = raw.endsWith('\n')
    const serialized = JSON.stringify(pkg, null, 2) + (hasTrailingNewline ? '\n' : '')
    writeFileSync(packageJsonPath, serialized)
  }

  return { packageJsonPath, missing, added, modified, warnings }
}
