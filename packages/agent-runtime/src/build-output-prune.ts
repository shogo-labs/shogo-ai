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
const BUILD_OUTPUT_FINGERPRINT_FILE = 'build-output-fingerprint'

interface BuildOutputManifest {
  outDir: string
  files: string[]
  fingerprint?: string
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
 * current build's emitted file list to `manifestPath` after each write, plus a
 * fingerprint of what the build serves — the canvas "Update available" toast
 * fires only when that fingerprint changes.
 *
 * The fingerprint is taken over each module's *transformed source*, not over
 * the rendered chunks. Rollup renames colliding top-level identifiers at
 * render time, and a cached watch rebuild deconflicts them in a different
 * order from a full build (`Decimal` vs `Decimal$1` from decimal.js-light via
 * recharts), so the chunk bytes and their hashed filenames change on rebuilds
 * where nothing did — every one of them raised the toast. Any real edit still
 * changes some module's transform. Assets (CSS, HTML) are hashed as emitted,
 * with chunk filenames neutralised because those carry the render-time hash;
 * source maps are skipped for the same reason. A bundler without module info
 * falls back to hashing chunk code.
 */
export function buildOutputManifestPluginSource(manifestPath: string): string {
  return [
    '{',
    "  name: 'shogo-build-output-manifest',",
    "  apply: 'build',",
    '  writeBundle(options, bundle) {',
    '    try {',
    "      const hash = createHash('sha1')",
    '      const files = Object.keys(bundle).sort()',
    "      const chunkFiles = files.filter((f) => bundle[f].type === 'chunk')",
    "      const moduleIds = typeof this.getModuleIds === 'function' && typeof this.getModuleInfo === 'function'",
    '        ? Array.from(this.getModuleIds()).sort()',
    '        : null',
    '      if (moduleIds) {',
    '        for (const id of moduleIds) {',
    '          const info = this.getModuleInfo(id)',
    "          hash.update('m\\\\0' + id + '\\\\0')",
    "          hash.update(info && typeof info.code === 'string' ? info.code : '')",
    "          hash.update('\\\\0')",
    '        }',
    '      } else {',
    '        for (const fileName of chunkFiles) {',
    "          hash.update('c\\\\0' + fileName + '\\\\0')",
    '          hash.update(bundle[fileName].code)',
    "          hash.update('\\\\0')",
    '        }',
    '      }',
    '      for (const fileName of files) {',
    '        const output = bundle[fileName]',
    "        if (output.type !== 'asset' || fileName.endsWith('.map')) continue",
    "        let source = typeof output.source === 'string' ? output.source : Buffer.from(output.source)",
    "        if (typeof source === 'string' && moduleIds) {",
    "          for (const chunk of chunkFiles) source = source.split(chunk).join('[chunk:' + bundle[chunk].name + ']')",
    '        }',
    "        hash.update('a\\\\0' + fileName + '\\\\0')",
    '        hash.update(source)',
    "        hash.update('\\\\0')",
    '      }',
    '      const fingerprint = hash.digest("hex")',
    `      writeFileSync(${JSON.stringify(manifestPath)}, JSON.stringify({ outDir: options.dir, files, fingerprint }))`,
    '    } catch {}',
    '  },',
    '}',
  ].join('\n')
}

/**
 * Returns whether the latest successful build changed the served output.
 *
 * Missing or malformed state is treated as changed so a real update is never
 * hidden. The fingerprint is persisted separately from the prune history so
 * it survives runtime restarts without coupling the two concerns.
 */
export function consumeBuildOutputChange(shogoDir: string): boolean {
  const manifest = readJson<BuildOutputManifest>(join(shogoDir, BUILD_OUTPUT_MANIFEST))
  if (!manifest || typeof manifest.fingerprint !== 'string' || !manifest.fingerprint) {
    return true
  }

  const fingerprintPath = join(shogoDir, BUILD_OUTPUT_FINGERPRINT_FILE)
  let previous: string | null = null
  try {
    previous = readFileSync(fingerprintPath, 'utf-8').trim() || null
  } catch {
    /* First build, or state is unreadable. */
  }

  try {
    writeFileSync(fingerprintPath, manifest.fingerprint)
  } catch {
    // If state cannot be persisted, keep notifying rather than hide changes.
    return true
  }

  return previous !== manifest.fingerprint
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
