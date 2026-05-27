#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Bundle apps/desktop/src/pty-host/pty-host.ts into
 * apps/desktop/dist/pty-host.js so Electron's utilityProcess.fork()
 * can load it by path.
 *
 * Follows the same pattern as bundle-main.mjs: bun build, target=node,
 * format=cjs, native modules left external so node-gyp .node files
 * aren't pulled into the JS string.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, symlinkSync, unlinkSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = path.join(__dirname, '..')
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..', '..')
const ENTRY = path.join(DESKTOP_DIR, 'src', 'pty-host', 'pty-host.ts')
const OUT_DIR = path.join(DESKTOP_DIR, 'dist')
const OUT_FILE = path.join(OUT_DIR, 'pty-host.js')

function lstatExists(p) { try { lstatSync(p); return true } catch { return false } }

/**
 * Mirror bundle-main.mjs's pattern for workspace packages — make
 * `@shogo/pty-core` resolvable inside apps/desktop/node_modules so
 * bun can inline it during the bundle pass.
 */
function ensurePtyCoreSymlink() {
  const sourceDir = path.join(REPO_ROOT, 'packages', 'pty-core')
  const namespaceDir = path.join(DESKTOP_DIR, 'node_modules', '@shogo')
  const linkPath = path.join(namespaceDir, 'pty-core')
  if (!existsSync(sourceDir)) {
    console.error(`[bundle-pty-host] pty-core source missing: ${sourceDir}`)
    process.exit(1)
  }
  mkdirSync(namespaceDir, { recursive: true })
  if (existsSync(linkPath) || lstatExists(linkPath)) {
    try { unlinkSync(linkPath) } catch { /* directory, leave */ }
  }
  if (!existsSync(linkPath)) {
    if (process.platform === 'win32') {
      symlinkSync(sourceDir, linkPath, 'junction')
    } else {
      symlinkSync(path.relative(namespaceDir, sourceDir), linkPath, 'dir')
    }
  }
}

if (!existsSync(ENTRY)) {
  console.error(`[bundle-pty-host] entry not found: ${ENTRY}`)
  process.exit(1)
}

mkdirSync(OUT_DIR, { recursive: true })

// EXTERNALS — node-pty is a native module (carries a .node binary). Must
// be resolved by Electron's Node loader at runtime, not bundled into a
// string literal. Same reason `electron` itself stays external.
const EXTERNALS = ['node-pty', 'electron']

ensurePtyCoreSymlink()

const args = [
  'build',
  ENTRY,
  '--target', 'node',
  '--format', 'cjs',
  '--outfile', OUT_FILE,
  ...EXTERNALS.flatMap((p) => ['--external', p]),
]

console.log('[bundle-pty-host] running:')
console.log(`  bun ${args.map((a) => (/\s|"/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)
const result = spawnSync('bun', args, { cwd: DESKTOP_DIR, stdio: 'inherit', shell: false })
if (result.error) {
  console.error('[bundle-pty-host] failed to invoke bun:', result.error.message)
  process.exit(1)
}
if (result.status !== 0) {
  console.error(`[bundle-pty-host] bun build failed (exit ${result.status ?? 'signal:' + result.signal})`)
  process.exit(result.status ?? 1)
}

const sizeKb = (statSync(OUT_FILE).size / 1024).toFixed(1)
console.log(`[bundle-pty-host] ✓ wrote dist/pty-host.js (${sizeKb} KB)`)
