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
  // Keep the wave boundaries for dependency ordering, but build members one
  // at a time. Bun 1.4's concurrent tsup declaration workers can otherwise
  // make the next wave observe a workspace package before its dist/*.d.ts
  // files are visible, producing intermittent "Cannot find module" failures
  // for @shogo-ai/agent and @shogo-ai/voice in the SDK declaration build.
  for (const packageName of wave) {
    try {
      await buildPackage(packageName)
    } catch (error) {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    }
  }
}

