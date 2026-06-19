#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Bundle apps/desktop/src/extensions/extension-host-runner.ts into
 * apps/desktop/dist/extensions/extension-host-runner.js so Electron's
 * utilityProcess.fork() can load it by path (see host-manager.ts#hostEntry).
 *
 * Without this step the extension host has no runnable artifact and
 * ExtensionHostManager.ensureStarted() fails to fork — shipping the desktop
 * app without it is a hard error, hence this mirrors bundle-pty-host.mjs.
 *
 * The runner only depends on Node builtins (fs/module/path/url), so there is
 * no workspace symlink to set up — a plain bun build with node target / cjs
 * format is sufficient.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = path.join(__dirname, '..')
const ENTRY = path.join(DESKTOP_DIR, 'src', 'extensions', 'extension-host-runner.ts')
const OUT_DIR = path.join(DESKTOP_DIR, 'dist', 'extensions')
const OUT_FILE = path.join(OUT_DIR, 'extension-host-runner.js')

if (!existsSync(ENTRY)) {
  console.error(`[bundle-extension-host] entry not found: ${ENTRY}`)
  process.exit(1)
}

mkdirSync(OUT_DIR, { recursive: true })

// electron is left external as a safety net even though the runner does not
// import it — it runs in a utilityProcess without the electron module.
const EXTERNALS = ['electron']

const args = [
  'build',
  ENTRY,
  '--target', 'node',
  '--format', 'cjs',
  '--outfile', OUT_FILE,
  ...EXTERNALS.flatMap((p) => ['--external', p]),
]

console.log('[bundle-extension-host] running:')
console.log(`  bun ${args.map((a) => (/\s|"/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)
const result = spawnSync('bun', args, { cwd: DESKTOP_DIR, stdio: 'inherit', shell: false })
if (result.error) {
  console.error('[bundle-extension-host] failed to invoke bun:', result.error.message)
  process.exit(1)
}
if (result.status !== 0) {
  console.error(`[bundle-extension-host] bun build failed (exit ${result.status ?? 'signal:' + result.signal})`)
  process.exit(result.status ?? 1)
}

const sizeKb = (statSync(OUT_FILE).size / 1024).toFixed(1)
console.log(`[bundle-extension-host] ✓ wrote dist/extensions/extension-host-runner.js (${sizeKb} KB)`)
