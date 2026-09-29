// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Bounds `dist/` growth under `vite build --watch --emptyOutDir false`.
 *
 * The preview watcher can't empty its outDir (a failed rebuild must leave the
 * last good site serving), so every rebuild adds a fresh set of content-hashed
 * chunks next to the old ones. Over a long session that grows until the pod
 * hits ENOSPC and Vite dies.
 *
 * The watch config wrapper records exactly which files each build emitted
 * (`BUILD_OUTPUT_MANIFEST`). After every successful rebuild we delete files a
 * previous build emitted that are in none of the last `keepGenerations`
 * builds. Files Vite didn't emit (e.g. copied from `public/`) are never
 * touched, and a file rewritten after the manifest — i.e. by a rebuild
 * already in flight — is skipped.
 */
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'

export const BUILD_OUTPUT_MANIFEST = 'build-output.json'
const PRUNE_STATE_FILE = 'build-output-history.json'

interface BuildOutputManifest {
  outDir: string
  files: string[]
}

interface PruneState {
  outDir: string
  generations: string[][]
  tracked: string[]
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return null
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

/**
 * Vite plugin source spliced into the generated watch config. Writes the
 * current build's emitted file list to `manifestPath` after each write.
 */
export function buildOutputManifestPluginSource(manifestPath: string): string {
  return [
    '{',
    "  name: 'shogo-build-output-manifest',",
    "  apply: 'build',",
    '  writeBundle(options, bundle) {',
    '    try {',
    `      writeFileSync(${JSON.stringify(manifestPath)}, JSON.stringify({ outDir: options.dir, files: Object.keys(bundle) }))`,
    '    } catch {}',
    '  },',
    '}',
  ].join('\n')
}

export function pruneStaleBuildOutput(
  shogoDir: string,
  keepGenerations = 2,
): { removed: string[] } {
  const manifestPath = join(shogoDir, BUILD_OUTPUT_MANIFEST)
  const statePath = join(shogoDir, PRUNE_STATE_FILE)
  const manifest = readJson<BuildOutputManifest>(manifestPath)
  if (!manifest || typeof manifest.outDir !== 'string' || !isStringArray(manifest.files)) {
    return { removed: [] }
  }
  let manifestMtime: number
  try {
    manifestMtime = statSync(manifestPath).mtimeMs
  } catch {
    return { removed: [] }
  }

  const outDir = resolve(manifest.outDir)
  const prior = readJson<PruneState>(statePath)
  const state: PruneState =
    prior && prior.outDir === outDir && Array.isArray(prior.generations) && isStringArray(prior.tracked)
      ? prior
      : { outDir, generations: [], tracked: [] }

  const current = [...new Set(manifest.files)]
  const last = state.generations[state.generations.length - 1]
  const isNewGeneration = !last || last.length !== current.length || last.some((f, i) => f !== current[i])
  const generations = (isNewGeneration ? [...state.generations, current] : state.generations).slice(
    -Math.max(1, keepGenerations),
  )
  const keep = new Set(generations.flat())
  const tracked = new Set([...state.tracked, ...current])

  const removed: string[] = []
  for (const file of tracked) {
    if (keep.has(file)) continue
    const abs = resolve(outDir, file)
    const rel = relative(outDir, abs)
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel === 'index.html') {
      tracked.delete(file)
      continue
    }
    try {
      if (!existsSync(abs)) {
        tracked.delete(file)
        continue
      }
      if (statSync(abs).mtimeMs >= manifestMtime) continue
      unlinkSync(abs)
      tracked.delete(file)
      removed.push(file)
    } catch {
      /* best-effort — retry on the next rebuild */
    }
  }

  try {
    writeFileSync(statePath, JSON.stringify({ outDir, generations, tracked: [...tracked] }))
  } catch {
    /* best-effort */
  }
  return { removed }
}
