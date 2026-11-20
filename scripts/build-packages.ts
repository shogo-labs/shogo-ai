// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..')

/**
 * Merge --max-old-space-size=8192 into NODE_OPTIONS for a package build
 * subprocess, inheriting the caller's environment.
 *
 * The SDK's tsup DTS worker (rollup-plugin-dts in a Node Worker thread) has
 * no resourceLimits and relies on the Node CLI heap cap. The 57-entry SDK DTS
 * build sits at the edge of Node's default heap on ubuntu-24.04 runners (15 GiB
 * RAM, swap removed). Setting 8192 MB gives 8 GiB — well under available RAM
 * and large enough for all current and near-future SDK growth.
 *
 * Rules:
 *  - If the caller already set --max-old-space-size, their value wins (do not
 *    reduce a larger limit or override a tuned smaller one).
 *  - Otherwise prepend the flag so other NODE_OPTIONS flags are preserved.
 */
export function packageBuildEnv(
  callerEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (/--max-old-space-size/.test(callerEnv.NODE_OPTIONS ?? '')) {
    return { ...callerEnv }
  }
  const heapFlag = '--max-old-space-size=8192'
  const existing = callerEnv.NODE_OPTIONS
  return {
    ...callerEnv,
    NODE_OPTIONS: existing ? `${heapFlag} ${existing}` : heapFlag,
  }
}

// These packages have no build-time dependency on one another. SDK is kept in
// the second wave because its declaration build resolves the extracted
// package entrypoints from the first wave.
const buildWaves = [
  ['core', 'agent', 'db', 'email', 'voice', 'cli'],
  ['sdk'],
] as const

function buildPackage(name: string): Promise<void> {
  return new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(
      process.execPath,
      ['run', '--cwd', `packages/${name}`, 'build'],
      {
        cwd: repoRoot,
        stdio: 'inherit',
        env: packageBuildEnv(),
      },
    )

    child.once('error', rejectBuild)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveBuild()
      } else {
        rejectBuild(
          new Error(
            `build:${name} exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`,
          ),
        )
      }
    })
  })
}

if (import.meta.main) {
  for (const wave of buildWaves) {
    const results = await Promise.allSettled(wave.map(buildPackage))
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(failure.reason instanceof Error ? failure.reason.message : failure.reason)
      }
      process.exit(1)
    }
  }
}
