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
  'state-api',
  'project-runtime',
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

function main() {
  const skipInstall = process.argv.includes('--skip-install')

  console.log('Bundling API server for desktop...')
  console.log(`  Repo root:    ${REPO_ROOT}`)
  console.log(`  Resources:    ${RESOURCES_DIR}`)

  clean()
  fs.mkdirSync(RESOURCES_DIR, { recursive: true })

  // --- API source ---
  console.log('\n[1/7] Copying API source...')
  const apiSrc = path.join(REPO_ROOT, 'apps', 'api')
  const apiDest = path.join(RESOURCES_DIR, 'apps', 'api')
  copyDir(apiSrc, apiDest, API_EXCLUDES)

  // --- Workspace packages ---
  console.log('[2/7] Copying workspace packages...')
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
  console.log('[3/7] Copying Prisma schema...')
  const prismaDir = path.join(RESOURCES_DIR, 'prisma')
  fs.mkdirSync(prismaDir, { recursive: true })
  const localSchema = path.join(REPO_ROOT, 'prisma', 'schema.local.prisma')
  if (fs.existsSync(localSchema)) {
    fs.copyFileSync(localSchema, path.join(prismaDir, 'schema.local.prisma'))
  }

  // --- Config files ---
  console.log('[4/7] Copying config files...')
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
  console.log('[5/7] Copying patch scripts...')
  const patchSrc = path.join(REPO_ROOT, 'scripts', 'patch-claude-sdk.ts')
  if (fs.existsSync(patchSrc)) {
    const scriptsDest = path.join(RESOURCES_DIR, 'scripts')
    fs.mkdirSync(scriptsDest, { recursive: true })
    fs.copyFileSync(patchSrc, path.join(scriptsDest, 'patch-claude-sdk.ts'))
  }

  // --- Workspace package.json ---
  console.log('[6/7] Creating workspace package.json...')
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
    console.log('[7/7] Installing dependencies (bun install)...')
    execSync('bun install', {
      cwd: RESOURCES_DIR,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'production' },
    })
  } else {
    console.log('[7/7] Skipping dependency install (--skip-install)')
  }

  console.log('\n✅ API bundle complete!')
}

main()
