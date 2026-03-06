#!/usr/bin/env node

/**
 * Bundles the API server + workspace packages into resources/ for Electron packaging.
 *
 * The bundle mirrors the monorepo directory layout so that all relative path
 * references in the API source code (e.g. to packages/state-api/runtime-template)
 * continue to work at runtime.
 *
 * Structure created inside apps/desktop/resources/:
 *   apps/api/          — API server source
 *   packages/          — workspace packages needed by the API
 *   node_modules/      — installed dependencies + workspace symlinks
 *   prisma/            — local SQLite schema
 *   scripts/           — postinstall patches
 *   package.json       — workspace config for dependency resolution
 *   tsconfig.base.json — shared TS config
 *   prisma.config.local.ts
 *
 * Usage:
 *   node scripts/bundle-api.mjs                 # default
 *   node scripts/bundle-api.mjs --skip-install  # skip bun install (for debugging)
 */

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = path.join(__dirname, '..')
const RESOURCES_DIR = path.join(DESKTOP_DIR, 'resources')
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..', '..')

const WORKSPACE_PACKAGES = [
  'agent-runtime',
  'shared-runtime',
  'sdk',
]

const ITEMS_TO_CLEAN = [
  'apps',
  'packages',
  'node_modules',
  'prisma',
  'scripts',
  'package.json',
  'bun.lock',
  'tsconfig.base.json',
  'prisma.config.local.ts',
]

const API_EXCLUDES = [
  'node_modules',
  'Dockerfile',
  'Dockerfile.dev',
  'entrypoint.sh',
  '.env',
  '.env.local',
]

const PACKAGE_EXCLUDES = [
  'node_modules',
  '__tests__',
  '.turbo',
  'coverage',
]

/**
 * Dependencies to strip from copied package.json files before install.
 * Each entry maps a package directory name to an array of dependency names to remove.
 * Only includes deps confirmed to be behind dynamic/conditional imports or never imported.
 */
const DEPS_TO_STRIP = {
  'apps/api': [
    '@prisma/adapter-pg',        // dynamic import, guarded by !isLocalMode
    '@prisma/instrumentation',   // OTEL integration, disabled without env var
    'pg',                        // conditional require, guarded by !isLocalMode
    '@aws-sdk/client-ses',       // dynamic import in SDK email provider
    '@kubernetes/client-node',   // knative-project-manager now lazy-imported
    '@aws-sdk/client-auto-scaling', // only used by proactive-node-scaler (K8s only)
    // OTEL SDK packages -- entry.ts skips import('./instrumentation') in local mode.
    // @opentelemetry/api is kept (lightweight, used by tracing middleware, no-ops gracefully).
    '@opentelemetry/exporter-metrics-otlp-http',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/instrumentation-http',
    '@opentelemetry/instrumentation-undici',
    '@opentelemetry/resources',
    '@opentelemetry/sdk-metrics',
    '@opentelemetry/sdk-node',
    '@opentelemetry/sdk-trace-base',
    '@opentelemetry/sdk-trace-node',
    '@opentelemetry/semantic-conventions',
  ],
  'packages/agent-runtime': [
    '@aws-sdk/client-s3',        // phantom dep: never imported in agent-runtime source
    'playwright-core',           // dynamic import with try/catch in gateway-tools.ts
    '@playwright/mcp',           // only referenced as a catalog string, never imported
  ],
}

function clean() {
  for (const item of ITEMS_TO_CLEAN) {
    const target = path.join(RESOURCES_DIR, item)
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true })
    }
  }
}

function copyDir(src, dest, excludes = []) {
  fs.mkdirSync(dest, { recursive: true })
  const entries = fs.readdirSync(src, { withFileTypes: true })

  for (const entry of entries) {
    if (excludes.includes(entry.name)) continue
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, excludes)
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

/**
 * Strip devDependencies and cloud-only deps from a copied package.json.
 * @param {string} pkgJsonPath - absolute path to the copied package.json
 * @param {string} pkgKey - key into DEPS_TO_STRIP (e.g. 'apps/api')
 */
function stripDepsFromPackageJson(pkgJsonPath, pkgKey) {
  if (!fs.existsSync(pkgJsonPath)) return

  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
  let stripped = 0

  // Always strip devDependencies — not needed at runtime
  if (pkg.devDependencies) {
    stripped += Object.keys(pkg.devDependencies).length
    delete pkg.devDependencies
  }

  // Strip cloud-only deps that are confirmed safe to remove
  const depsToRemove = DEPS_TO_STRIP[pkgKey] || []
  for (const dep of depsToRemove) {
    if (pkg.dependencies && pkg.dependencies[dep]) {
      delete pkg.dependencies[dep]
      stripped++
    }
  }

  if (stripped > 0) {
    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n')
    console.log(`    Stripped ${stripped} deps from ${pkgKey}/package.json`)
  }
}

const PRUNE_PATTERNS = [
  /\/\.github\b/,
  /\/\.vscode\b/,
  /\/docs?\b/i,
  /\/test[s]?\b/i,
  /\/__tests__\b/,
  /\/examples?\b/i,
  /\/benchmarks?\b/i,
  /\/\.eslint/,
  /\/\.prettier/,
  /\/tsconfig.*\.json$/,
  /\/\.editorconfig$/,
  /\/\.npmignore$/,
  /\/CHANGELOG/i,
  /\/HISTORY/i,
  /\/CONTRIBUTING/i,
  /\/AUTHORS/i,
  /\/\.travis\.yml$/,
  /\/appveyor\.yml$/,
  /\/Makefile$/,
  /\/Gruntfile/i,
  /\/gulpfile/i,
]

const PRUNE_EXTENSIONS = new Set([
  '.md', '.markdown', '.ts', '.map', '.d.ts',
  '.flow', '.mts', '.cts', '.d.mts', '.d.cts',
])

function shouldPrune(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.ts' && !filePath.endsWith('.d.ts')) return false
  if (PRUNE_EXTENSIONS.has(ext)) return true
  return PRUNE_PATTERNS.some((p) => p.test(filePath))
}

function pruneNodeModules(nmDir) {
  if (!fs.existsSync(nmDir)) return

  let removed = 0
  function walk(dir) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (PRUNE_PATTERNS.some((p) => p.test('/' + entry.name))) {
          fs.rmSync(full, { recursive: true, force: true })
          removed++
        } else {
          walk(full)
        }
      } else if (entry.isFile() && shouldPrune(full)) {
        fs.rmSync(full, { force: true })
        removed++
      }
    }
  }

  walk(nmDir)
  console.log(`  Removed ${removed} files/directories`)
}

function main() {
  const skipInstall = process.argv.includes('--skip-install')

  console.log('Bundling API server for desktop...')
  console.log(`  Repo root:    ${REPO_ROOT}`)
  console.log(`  Resources:    ${RESOURCES_DIR}`)

  clean()
  fs.mkdirSync(RESOURCES_DIR, { recursive: true })

  // --- API source ---
  console.log('\n[1/8] Copying API source...')
  const apiSrc = path.join(REPO_ROOT, 'apps', 'api')
  const apiDest = path.join(RESOURCES_DIR, 'apps', 'api')
  copyDir(apiSrc, apiDest, API_EXCLUDES)

  // --- Workspace packages ---
  console.log('[2/8] Copying workspace packages...')
  for (const pkg of WORKSPACE_PACKAGES) {
    const src = path.join(REPO_ROOT, 'packages', pkg)
    const dest = path.join(RESOURCES_DIR, 'packages', pkg)
    if (!fs.existsSync(src)) {
      console.warn(`  ⚠ Package not found: packages/${pkg} — skipping`)
      continue
    }
    copyDir(src, dest, PACKAGE_EXCLUDES)
    console.log(`  ✓ packages/${pkg}`)
  }

  // --- Prisma schema ---
  console.log('[3/8] Copying Prisma schema...')
  const prismaDir = path.join(RESOURCES_DIR, 'prisma')
  fs.mkdirSync(prismaDir, { recursive: true })
  const localSchema = path.join(REPO_ROOT, 'prisma', 'schema.local.prisma')
  if (fs.existsSync(localSchema)) {
    fs.copyFileSync(localSchema, path.join(prismaDir, 'schema.local.prisma'))
  }

  // --- Config files ---
  console.log('[4/8] Copying config files...')
  const configFiles = [
    ['prisma.config.local.ts', 'prisma.config.local.ts'],
    ['tsconfig.base.json', 'tsconfig.base.json'],
  ]
  for (const [src, dest] of configFiles) {
    const srcPath = path.join(REPO_ROOT, src)
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join(RESOURCES_DIR, dest))
      console.log(`  ✓ ${dest}`)
    }
  }

  // --- Patch script (runs during bun install postinstall) ---
  console.log('[5/8] Copying patch scripts...')
  const patchSrc = path.join(REPO_ROOT, 'scripts', 'patch-claude-sdk.ts')
  if (fs.existsSync(patchSrc)) {
    const scriptsDest = path.join(RESOURCES_DIR, 'scripts')
    fs.mkdirSync(scriptsDest, { recursive: true })
    fs.copyFileSync(patchSrc, path.join(scriptsDest, 'patch-claude-sdk.ts'))
  }

  // --- Strip cloud-only and dev deps from copied package.json files ---
  console.log('[6/8] Stripping cloud-only and dev dependencies...')
  stripDepsFromPackageJson(
    path.join(RESOURCES_DIR, 'apps', 'api', 'package.json'),
    'apps/api',
  )
  for (const pkg of WORKSPACE_PACKAGES) {
    stripDepsFromPackageJson(
      path.join(RESOURCES_DIR, 'packages', pkg, 'package.json'),
      `packages/${pkg}`,
    )
  }

  // --- Workspace package.json ---
  console.log('[7/8] Creating workspace package.json...')
  const workspacePkg = {
    name: 'shogo-desktop-bundle',
    private: true,
    workspaces: ['apps/api', 'packages/*'],
    scripts: {
      postinstall:
        '[ -f scripts/patch-claude-sdk.ts ] && bun scripts/patch-claude-sdk.ts || true',
    },
  }
  fs.writeFileSync(
    path.join(RESOURCES_DIR, 'package.json'),
    JSON.stringify(workspacePkg, null, 2) + '\n',
  )

  // --- Install dependencies ---
  if (!skipInstall) {
    const isWindows = process.platform === 'win32'
    const installCmd = isWindows
      ? 'bun install --production --linker=isolated'
      : 'bun install --production'
    console.log(`[8/9] Installing dependencies (${installCmd})...`)
    execSync(installCmd, {
      cwd: RESOURCES_DIR,
      stdio: 'inherit',
    })
  } else {
    console.log('[8/9] Skipping dependency install (--skip-install)')
  }

  // --- Prune node_modules to reduce size ---
  console.log('[9/9] Pruning node_modules...')
  pruneNodeModules(path.join(RESOURCES_DIR, 'node_modules'))

  console.log('\n✅ API bundle complete!')
}

main()
