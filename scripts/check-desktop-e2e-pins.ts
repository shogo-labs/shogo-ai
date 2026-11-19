#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * desktop-e2e.yml copies the release workflows' build steps without signing.
 * A packaged-app test is only meaningful if it builds with the same toolchain
 * as a release, so this fails when BUN_VERSION, NODE_VERSION or the Windows
 * runner image drift between them.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WORKFLOWS = join(import.meta.dir, '..', '.github', 'workflows')

export function readPins(yaml: string): { bun?: string; node?: string; windowsRunner?: string } {
  return {
    bun: yaml.match(/^\s*BUN_VERSION:\s*'([^']+)'/m)?.[1],
    node: yaml.match(/^\s*NODE_VERSION:\s*'([^']+)'/m)?.[1],
    windowsRunner: yaml.match(/runs-on:\s*(windows-\d{4})/)?.[1],
  }
}

export function comparePins(e2e: ReturnType<typeof readPins>, windows: ReturnType<typeof readPins>, macos: ReturnType<typeof readPins>): string[] {
  const errors: string[] = []
  for (const [name, release] of [['desktop-release-windows.yml', windows], ['desktop-release-macos.yml', macos]] as const) {
    if (e2e.bun !== release.bun) errors.push(`BUN_VERSION ${e2e.bun} in desktop-e2e.yml, ${release.bun} in ${name}`)
    if (e2e.node !== release.node) errors.push(`NODE_VERSION ${e2e.node} in desktop-e2e.yml, ${release.node} in ${name}`)
  }
  if (e2e.windowsRunner !== windows.windowsRunner) {
    errors.push(`Windows runner ${e2e.windowsRunner} in desktop-e2e.yml, ${windows.windowsRunner} in desktop-release-windows.yml`)
  }
  return errors
}

if (import.meta.main) {
  const read = (file: string) => readPins(readFileSync(join(WORKFLOWS, file), 'utf8'))
  const errors = comparePins(read('desktop-e2e.yml'), read('desktop-release-windows.yml'), read('desktop-release-macos.yml'))
  if (errors.length) {
    for (const e of errors) console.error(`::error title=desktop-e2e.yml drifted from the release workflows::${e}`)
    process.exit(1)
  }
  console.log('desktop-e2e.yml uses the release workflows\' Bun, Node and Windows runner.')
}
