#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Integrity check of a packaged Shogo app: bundled Bun, the Shogo IDE
// resources (including the prebuilt-server manifest) and no unresolved
// workspace-source requires in app.asar. Works on a macOS Shogo.app, a
// Windows Shogo-win32-x64 folder, or an extracted Squirrel nupkg (lib/net45).
//
//   node scripts/assert-packaged-shogo-ide.mjs [path]   (or SHOGO_APP_PATH=...)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = path.resolve(__dirname, '..')
const explicitApp = process.env.SHOGO_APP_PATH || process.argv[2]

const REQUIRED_FILES = [
  'bundle/browser-relay.cjs',
  'node_modules/ws/package.json',
  'apps/shogo-ide/package.json',
  'apps/shogo-ide/code-oss-server.manifest.json',
  'apps/shogo-ide/product.shogo.template.json',
  'apps/shogo-ide/scripts/materialize-distribution.mjs',
  'apps/shogo-ide/scripts/generate-hardening-report.mjs',
  'apps/shogo-ide/distribution/generated/product.json',
  'apps/shogo-ide/distribution/generated/distribution.generated.json',
  'apps/shogo-ide/hardening/generated/production-readiness.json',
  'apps/shogo-ide/extensions/shogo-core/package.json',
  'apps/shogo-ide/extensions/shogo-core/dist/extension.js',
]
const REQUIRED_DIRS_NONEMPTY = [
  'apps/shogo-ide/distribution/defaults',
  'apps/shogo-ide/distribution/builtin-extensions',
  'apps/shogo-ide/extensions/shogo-core/dist',
]
const FORBIDDEN_ASAR_PATTERNS = [
  /require\(["']@shogo\/agent-runtime\/src\//,
  /require\(["']@shogo-ai\/worker\/src\//,
]
const SERVER_TARGETS = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64']

function fail(message) {
  console.error(`[assert-packaged-shogo-ide] ERROR: ${message}`)
  process.exit(1)
}

/** The `resources` directory of a packaged app at or under `dir`. */
export function findResourcesDir(dir) {
  if (!existsSync(dir)) return null
  const stat = statSync(dir)
  if (stat.isFile()) return /shogo(\.exe)?$/i.test(dir) ? findResourcesDir(path.dirname(dir)) : null
  if (path.basename(dir) === 'Shogo.app') {
    const resources = path.join(dir, 'Contents', 'Resources')
    return existsSync(resources) ? resources : null
  }
  if (existsSync(path.join(dir, 'Shogo.exe')) && existsSync(path.join(dir, 'resources'))) return path.join(dir, 'resources')
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    const nested = findResourcesDir(path.join(dir, entry.name))
    if (nested) return nested
  }
  return null
}

const searchRoot = explicitApp ? path.resolve(explicitApp) : path.join(DESKTOP_DIR, 'out')
const resourcesPath = findResourcesDir(searchRoot)
if (!resourcesPath) {
  fail(`No packaged Shogo app found under ${searchRoot}. Run \`npm run package\` first, or pass SHOGO_APP_PATH=<Shogo.app | Shogo-win32-x64 | extracted nupkg>.`)
}

const label = (rel) => `resources/${rel}`
const bunRel = existsSync(path.join(resourcesPath, 'bun', 'bun.exe')) ? 'bun/bun.exe' : 'bun/bun'
const bunPath = path.join(resourcesPath, bunRel)
if (!existsSync(bunPath)) fail(`missing bundled Bun at ${label(bunRel)}`)
if (process.platform !== 'win32' && bunRel === 'bun/bun') {
  const mode = statSync(bunPath).mode
  if ((mode & 0o111) === 0) fail(`bundled Bun is not executable: ${label(bunRel)}`)
}

const failures = []
for (const rel of REQUIRED_FILES) {
  const filePath = path.join(resourcesPath, rel)
  if (!existsSync(filePath)) {
    failures.push(`missing required file: ${label(rel)}`)
    continue
  }
  if (!statSync(filePath).isFile()) failures.push(`expected file: ${label(rel)}`)
}
for (const rel of REQUIRED_DIRS_NONEMPTY) {
  const dirPath = path.join(resourcesPath, rel)
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
    failures.push(`missing required directory: ${label(rel)}/`)
    continue
  }
  if (readdirSync(dirPath).length === 0) failures.push(`required directory is empty: ${label(rel)}/`)
}

const manifestPath = path.join(resourcesPath, 'apps/shogo-ide/code-oss-server.manifest.json')
if (existsSync(manifestPath)) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!/^shogo-ide-server-[0-9a-f]{12}-[0-9a-f]{12}$/.test(manifest.artifactId ?? '')) failures.push('server manifest has no valid artifactId')
    for (const target of SERVER_TARGETS) {
      const asset = manifest.assets?.[target]
      if (!asset || !/^https:\/\//.test(asset.url ?? '') || !/^[0-9a-f]{64}$/.test(asset.sha256 ?? '')) {
        failures.push(`server manifest has no valid asset for ${target}`)
      }
    }
  } catch (err) {
    failures.push(`server manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const asarPath = path.join(resourcesPath, 'app.asar')
if (!existsSync(asarPath)) fail(`missing ${label('app.asar')}`)
try {
  const require = createRequire(import.meta.url)
  const asar = require('@electron/asar')
  const files = asar.listPackage(asarPath).filter((file) => file.endsWith('.js'))
  for (const file of files) {
    const archiveFile = file.replace(/^[\\/]/, '')
    const source = asar.extractFile(asarPath, archiveFile).toString('utf8')
    for (const pattern of FORBIDDEN_ASAR_PATTERNS) {
      if (pattern.test(source)) failures.push(`forbidden unresolved workspace source require in app.asar:${file}: ${pattern}`)
    }
  }
} catch (err) {
  failures.push(`could not inspect app.asar JavaScript for unresolved workspace source requires: ${err instanceof Error ? err.message : String(err)}`)
}

if (failures.length > 0) {
  console.error('[assert-packaged-shogo-ide] ERROR: packaged app integrity check failed:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(`[assert-packaged-shogo-ide] ✓ ${resourcesPath} contains bundled Bun, Shogo IDE resources with a valid server manifest, and no unresolved workspace source requires`)
