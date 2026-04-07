#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CLI wrapper for prepare-bundle.ts.
 *
 * Called by bundle-api.mjs during desktop packaging:
 *   bun run scripts/prepare-vm-bundle-cli.ts --dest resources/vm-bundle --server-js resources/bundle/agent-runtime.js
 */

import { resolve } from 'path'
import { prepareVMBundle } from '../src/vm/prepare-bundle'

const args = process.argv.slice(2)

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined
}

const dest = getArg('dest')
const serverJs = getArg('server-js')
const shogoJs = getArg('shogo-js')

if (!dest) {
  console.error('Usage: prepare-vm-bundle-cli.ts --dest <dir> [--server-js <path>] [--shogo-js <path>]')
  process.exit(1)
}

const DESKTOP_DIR = resolve(import.meta.dir, '..')
const REPO_ROOT = resolve(DESKTOP_DIR, '..', '..')
const destDir = resolve(DESKTOP_DIR, dest)

prepareVMBundle({
  destDir,
  repoRoot: REPO_ROOT,
  prebuiltServerJs: serverJs ? resolve(DESKTOP_DIR, serverJs) : undefined,
  prebuiltShogoJs: shogoJs ? resolve(DESKTOP_DIR, shogoJs) : undefined,
})
