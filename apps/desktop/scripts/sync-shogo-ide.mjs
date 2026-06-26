#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..', '..')
const SOURCE = path.join(REPO_ROOT, 'apps', 'shogo-ide')
const DEST = path.join(DESKTOP_DIR, 'resources', 'apps', 'shogo-ide')

const REQUIRED_FILES = [
  { rel: 'package.json', minBytes: 100 },
  { rel: 'product.shogo.template.json', minBytes: 100 },
  { rel: 'scripts/materialize-distribution.mjs', minBytes: 100 },
  { rel: 'scripts/generate-hardening-report.mjs', minBytes: 100 },
  { rel: 'distribution/distribution.manifest.json', minBytes: 50 },
  { rel: 'distribution/generated/product.json', minBytes: 100 },
  { rel: 'distribution/generated/distribution.generated.json', minBytes: 100 },
  { rel: 'hardening/generated/production-readiness.json', minBytes: 100 },
  { rel: 'extensions/shogo-core/package.json', minBytes: 100 },
  { rel: 'extensions/shogo-core/dist/extension.js', minBytes: 100 },
]
const REQUIRED_DIRS_NONEMPTY = [
  'distribution/defaults',
  'distribution/builtin-extensions',
  'extensions/shogo-core/dist',
]
const COPY_ENTRIES = [
  'package.json',
  'product.shogo.template.json',
  'scripts',
  'distribution',
  'hardening/generated/production-readiness.json',
  'extensions/shogo-core',
]

function log(message) {
  console.log(`[sync-shogo-ide] ${message}`)
}

function fail(message) {
  console.error(`[sync-shogo-ide] ERROR: ${message}`)
  process.exit(1)
}

function run(command, args, options) {
  const pretty = `${command} ${args.join(' ')}`
  log(`$ ${pretty}  (cwd=${options?.cwd ?? process.cwd()})`)
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) fail(`failed to spawn \`${pretty}\`: ${result.error.message}`)
  if (typeof result.status === 'number' && result.status !== 0) fail(`\`${pretty}\` exited with code ${result.status}`)
}

function assertTree(root, label) {
  const failures = []
  for (const { rel, minBytes } of REQUIRED_FILES) {
    const filePath = path.join(root, rel)
    if (!existsSync(filePath)) {
      failures.push(`missing required file: ${label}/${rel}`)
      continue
    }
    const stat = statSync(filePath)
    if (!stat.isFile()) {
      failures.push(`expected file but got ${stat.isDirectory() ? 'directory' : 'other'}: ${label}/${rel}`)
      continue
    }
    if (stat.size < minBytes) failures.push(`${label}/${rel} is suspiciously small (${stat.size} bytes, expected >= ${minBytes})`)
  }
  for (const rel of REQUIRED_DIRS_NONEMPTY) {
    const dirPath = path.join(root, rel)
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
      failures.push(`missing required directory: ${label}/${rel}/`)
      continue
    }
    if (readdirSync(dirPath).length === 0) failures.push(`required directory is empty: ${label}/${rel}/`)
  }
  if (failures.length > 0) {
    console.error('[sync-shogo-ide] ERROR: integrity check failed:')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
}

if (!existsSync(path.join(SOURCE, 'package.json'))) fail(`apps/shogo-ide not found at ${SOURCE}`)

const forceRegenerate = process.env.SHOGO_IDE_REGENERATE === '1'
if (forceRegenerate || !existsSync(path.join(SOURCE, 'distribution', 'generated', 'product.json'))) {
  run('bun', ['run', 'distribution:materialize'], { cwd: SOURCE })
}
if (forceRegenerate || !existsSync(path.join(SOURCE, 'hardening', 'generated', 'production-readiness.json'))) {
  run('bun', ['run', 'hardening:report'], { cwd: SOURCE })
}
// The shogo-core extension's dist/ is git-ignored and built by `tsc`, but the
// release workflows only run `bun run build:packages` (which excludes
// shogo-ide), so dist/extension.js is absent at package time and the integrity
// check below would abort the whole tagged release. Build it on demand here —
// mirroring the materialize/hardening regeneration above — so packaging is
// self-healing in CI and locally without a separate workflow step.
if (forceRegenerate || !existsSync(path.join(SOURCE, 'extensions', 'shogo-core', 'dist', 'extension.js'))) {
  run('bun', ['run', 'extension:build'], { cwd: SOURCE })
}
assertTree(SOURCE, 'apps/shogo-ide')

if (existsSync(DEST)) {
  log(`wiping ${path.relative(REPO_ROOT, DEST)} ...`)
  rmSync(DEST, { recursive: true, force: true })
}
mkdirSync(DEST, { recursive: true })

for (const entry of COPY_ENTRIES) {
  const sourcePath = path.join(SOURCE, entry)
  const destPath = path.join(DEST, entry)
  if (!existsSync(sourcePath)) fail(`cannot copy missing source: apps/shogo-ide/${entry}`)
  mkdirSync(path.dirname(destPath), { recursive: true })
  cpSync(sourcePath, destPath, { recursive: true, force: true })
}

assertTree(DEST, 'resources/apps/shogo-ide')
log(`✓ resources/apps/shogo-ide is complete (${REQUIRED_FILES.length} files + ${REQUIRED_DIRS_NONEMPTY.length} dirs verified)`)
