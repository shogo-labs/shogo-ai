#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = path.resolve(__dirname, '..')
const explicitApp = process.env.SHOGO_APP_PATH || process.argv[2]

const REQUIRED_FILES = [
  'apps/shogo-ide/package.json',
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

function fail(message) {
  console.error(`[assert-packaged-shogo-ide] ERROR: ${message}`)
  process.exit(1)
}

function findPackagedApp(dir) {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory() && entry.name === 'Shogo.app') return fullPath
    if (entry.isDirectory()) {
      const nested = findPackagedApp(fullPath)
      if (nested) return nested
    }
  }
  return null
}

const appPath = explicitApp ? path.resolve(explicitApp) : findPackagedApp(path.join(DESKTOP_DIR, 'out'))
if (!appPath) fail('No packaged Shogo.app found. Run `npm run package` first, or pass SHOGO_APP_PATH=/path/to/Shogo.app.')

const resourcesPath = path.join(appPath, 'Contents', 'Resources')
if (!existsSync(resourcesPath)) fail(`Packaged app has no Contents/Resources directory: ${appPath}`)

const bunRel = process.platform === 'win32' ? 'bun/bun.exe' : 'bun/bun'
const bunPath = path.join(resourcesPath, bunRel)
if (!existsSync(bunPath)) fail(`missing bundled Bun at Contents/Resources/${bunRel}`)
if (process.platform !== 'win32') {
  const mode = statSync(bunPath).mode
  if ((mode & 0o111) === 0) fail(`bundled Bun is not executable: Contents/Resources/${bunRel}`)
}

const failures = []
for (const rel of REQUIRED_FILES) {
  const filePath = path.join(resourcesPath, rel)
  if (!existsSync(filePath)) {
    failures.push(`missing required file: Contents/Resources/${rel}`)
    continue
  }
  if (!statSync(filePath).isFile()) failures.push(`expected file: Contents/Resources/${rel}`)
}
for (const rel of REQUIRED_DIRS_NONEMPTY) {
  const dirPath = path.join(resourcesPath, rel)
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
    failures.push(`missing required directory: Contents/Resources/${rel}/`)
    continue
  }
  if (readdirSync(dirPath).length === 0) failures.push(`required directory is empty: Contents/Resources/${rel}/`)
}

const asarPath = path.join(resourcesPath, 'app.asar')
if (!existsSync(asarPath)) fail(`missing Contents/Resources/app.asar: ${appPath}`)
try {
  const require = createRequire(import.meta.url)
  const asar = require('@electron/asar')
  const files = asar.listPackage(asarPath).filter((file) => file.endsWith('.js'))
  for (const file of files) {
    const archiveFile = file.startsWith('/') ? file.slice(1) : file
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

console.log(`[assert-packaged-shogo-ide] ✓ ${appPath} contains bundled Bun, Shogo IDE resources, and no unresolved workspace source requires`)
