// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..')

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

