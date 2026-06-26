// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { spawnSync as realSpawnSync } from 'node:child_process'

export function runBuildDesktop(spawn = realSpawnSync) {
  const result = spawn('npm', ['run', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) {
    throw new Error(`[forge.config] prePackage: failed to spawn desktop build: ${result.error.message}`)
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(
      `[forge.config] prePackage: desktop build exited with code ${result.status}. ` +
        `Refusing to package stale or unbundled dist/ output.`,
    )
  }
}
