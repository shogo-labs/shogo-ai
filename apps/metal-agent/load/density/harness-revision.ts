// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * Which harness produced a run.
 *
 * The runner executes on the soak host, where `/root/metal-agent` is a deployed
 * copy with no `.git` — so `git rev-parse` returns nothing and every run used to
 * record `gitSha: "unknown"`. That left a committed report unable to say which
 * tree measured it, and it took hashing the host's copy by hand to place the
 * 2026-11-26 run on `61403ca40`.
 *
 * Hashing the files it actually loaded answers that portably: the runner is
 * `density-soak.ts` plus `density/*.ts`, nothing else participates in a
 * measurement. Same digest = same measurement code, whatever the checkout.
 */

/** Every harness file that takes part in a run, relative to `load/`, sorted. */
export function harnessFiles(loadDir: string): string[] {
  const densityDir = join(loadDir, 'density')
  const nested = existsSync(densityDir)
    ? readdirSync(densityDir)
        .filter((f) => f.endsWith('.ts'))
        .map((f) => join('density', f))
        .sort()
    : []
  return ['density-soak.ts', ...nested].filter((rel) => existsSync(join(loadDir, rel)))
}

/**
 * sha256 over `name\0fileSha256\n` for each harness file, in sorted order.
 *
 * Names are in the digest so a rename changes it; `.ts` files only, so a test
 * file or a result directory never moves the hash of the code that ran.
 */
export function harnessDigest(loadDir: string): string {
  const h = createHash('sha256')
  for (const rel of harnessFiles(loadDir)) {
    const fileHash = createHash('sha256').update(readFileSync(join(loadDir, rel))).digest('hex')
    h.update(`${basename(rel) === rel ? rel : rel.replace(/\\/g, '/')}\0${fileHash}\n`)
  }
  return h.digest('hex')
}
