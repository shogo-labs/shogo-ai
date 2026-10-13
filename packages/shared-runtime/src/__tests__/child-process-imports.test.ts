// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// A direct `child_process` import from production code skips the windowsHide
// wrapper, which is what makes console windows flash on Windows. Tests, evals,
// and scripts are out of scope. The wrapper modules themselves, and Squirrel's
// Update.exe launcher, are the only allowed exceptions.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const repoRoot = join(import.meta.dir, '../../../..')
const roots = [
  'apps/api/src',
  'apps/desktop/src',
  'packages/agent-runtime/src',
  'packages/shared-runtime/src',
  'packages/shogo-worker/src',
  'packages/cli/src',
  'packages/sdk/src',
]
const skipDir = new Set(['__tests__', 'evals', 'scripts', 'node_modules', 'dist'])
const allow = new Set([
  'packages/shared-runtime/src/child-process.ts',
  'packages/cli/src/child-process.ts',
  'packages/sdk/src/child-process.ts',
  'packages/shogo-worker/src/lib/child-process.ts',
  'apps/desktop/src/child-process.ts',
  // Squirrel's Update.exe is a GUI updater launched on purpose.
  'apps/desktop/src/squirrel-startup.ts',
])
const importRe = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?child_process['"]/g

function walk(dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (skipDir.has(entry)) continue
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walk(full, out)
      continue
    }
    if (!/\.(ts|tsx|mts|cts)$/.test(entry)) continue
    if (/\.(test|spec)\./.test(entry)) continue
    out.push(full)
  }
}

describe('production code imports child_process through the windowsHide wrapper', () => {
  test('no direct child_process import outside the wrapper', () => {
    const files: string[] = []
    for (const root of roots) walk(join(repoRoot, root), files)
    const offenders: string[] = []
    for (const file of files) {
      const rel = relative(repoRoot, file).replaceAll('\\', '/')
      if (allow.has(rel)) continue
      const text = readFileSync(file, 'utf8')
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        importRe.lastIndex = 0
        if (importRe.test(lines[i]!)) offenders.push(`${rel}:${i + 1}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
