#!/usr/bin/env node

/**
 * Bundles the API server for Electron desktop packaging using `bun build`.
 *
 * Instead of copying the full source tree + node_modules (~500MB+), this script
 * uses bun's bundler to compile each entry point into a single JS file with all
 * dependencies inlined. Only native modules that can't be bundled (Prisma, sqlite-vec)
 * are kept as external packages in a minimal node_modules.
 *
 * Entry points bundled:
 *   1. apps/api/src/entry.ts       → bundle/api.js        (~17 MB)
 *   2. packages/agent-runtime/src/server.ts → bundle/agent-runtime.js (~14 MB)
 *
 * Structure created inside apps/desktop/resources/:
 *   bundle/             — compiled JS entry points
 *   node_modules/       — only native/external packages
 *   prisma/             — local SQLite schema
 *   canvas-runtime/     — canvas-globals.d.ts for LSP linting
 *   runtime-template/   — Vite scaffold for new projects
 *   templates/          — agent templates
 *   package.json        — minimal manifest for external deps
 *   prisma.config.local.ts
 *
 * Usage:
 *   node scripts/bundle-api.mjs                 # default
 *   node scripts/bundle-api.mjs --skip-install  # skip external dep install
 */

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = path.join(__dirname, '..')
const RESOURCES_DIR = path.join(DESKTOP_DIR, 'resources')
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..', '..')

const ITEMS_TO_CLEAN = [
  'bundle',
  'vm-bundle',
  'apps',
  'packages',
  'node_modules',
  'prisma',
  'templates',
  'runtime-template',
  'canvas-runtime',
  'tree-sitter-wasm',
  'scripts',
  'package.json',
  'bun.lock',
  'tsconfig.base.json',
  'prisma.config.local.ts',
  'seed.db',
]

/**
 * Packages that contain native binaries or dynamic requires that can't be bundled.
 * These are kept as external imports and installed in a minimal node_modules.
 */
const EXTERNAL_PACKAGES = [
  'electron',
  'playwright-core',
  '@playwright/mcp',
  '@prisma/client',
  'prisma',
  'prisma-adapter-bun-sqlite',
  'sqlite-vec',
]

/**
 * Entry points to bundle with bun build.
 */
const ENTRY_POINTS = [
  {
    name: 'api',
    input: 'apps/api/src/entry.ts',
    output: 'api.js',
  },
  {
    name: 'agent-runtime',
    input: 'packages/agent-runtime/src/server.ts',
    output: 'agent-runtime.js',
  },
]

function clean() {
  for (const item of ITEMS_TO_CLEAN) {
    const target = path.join(RESOURCES_DIR, item)
    if (fs.existsSync(target)) {
      try {
        fs.rmSync(target, { recursive: true, force: true })
      } catch {
        // Fallback for directories with symlinks/hardlinks (e.g. bun node_modules)
        if (process.platform === 'win32') {
          execSync(`rmdir /s /q "${target}"`, { stdio: 'pipe' })
        } else {
          execSync(`rm -rf "${target}"`, { stdio: 'pipe' })
        }
      }
    }
  }
}

function main() {
  const skipInstall = process.argv.includes('--skip-install')

  console.log('Bundling API server for desktop (bun build)...')
  console.log(`  Repo root:    ${REPO_ROOT}`)
  console.log(`  Resources:    ${RESOURCES_DIR}`)

  clean()
  const bundleDir = path.join(RESOURCES_DIR, 'bundle')
  fs.mkdirSync(bundleDir, { recursive: true })

  // --- Step counter ---
  const externals = EXTERNAL_PACKAGES.map((p) => `--external ${p}`).join(' ')
  const totalSteps = ENTRY_POINTS.length + 10
  let step = 0

  const logStep = (label) => console.log(`[${++step}/${totalSteps}] ${label}`)

  // --- Generate Prisma client from local schema (must run before bun build) ---
  logStep('Generating Prisma client...')
  try {
    execSync(
      `bun x prisma generate --schema=prisma/schema.local.prisma`,
      {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL: 'file:./dummy.db' },
        timeout: 30_000,
      },
    )
    console.log('  ✓ Prisma client generated')
  } catch (err) {
    console.error('  Failed to generate Prisma client:', err.message)
    process.exit(1)
  }

  // --- Bundle entry points ---
  for (let i = 0; i < ENTRY_POINTS.length; i++) {
    const { name, input, output } = ENTRY_POINTS[i]
    logStep(`Bundling ${name}...`)

    const inputPath = path.join(REPO_ROOT, input)
    const tempDir = path.join(bundleDir, `_tmp_${name}`)
    fs.mkdirSync(tempDir, { recursive: true })

    const cmd = `bun build "${inputPath}" --target bun --outdir "${tempDir}" ${externals}`

    try {
      const result = execSync(cmd, { cwd: REPO_ROOT, stdio: 'pipe', encoding: 'utf-8' })
      console.log(`  ${result.trim().split('\n').pop()}`)

      const files = fs.readdirSync(tempDir)
      const entryFile = files.find((f) => f.endsWith('.js'))
      if (entryFile) {
        fs.renameSync(path.join(tempDir, entryFile), path.join(bundleDir, output))
      }
      for (const f of files) {
        if (f.endsWith('.node')) {
          fs.renameSync(path.join(tempDir, f), path.join(bundleDir, f))
        }
      }
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch (err) {
      console.error(`  Failed to bundle ${name}:`)
      console.error(err.stderr || err.message)
      fs.rmSync(tempDir, { recursive: true, force: true })
      process.exit(1)
    }
  }

  // --- Prisma schema ---
  logStep('Copying Prisma schema...')
  const prismaDir = path.join(RESOURCES_DIR, 'prisma')
  fs.mkdirSync(prismaDir, { recursive: true })
  const localSchema = path.join(REPO_ROOT, 'prisma', 'schema.local.prisma')
  if (fs.existsSync(localSchema)) {
    fs.copyFileSync(localSchema, path.join(prismaDir, 'schema.local.prisma'))
  }

  // --- Generate seed.db from current schema (prevents stale seed after migrations) ---
  logStep('Generating seed.db...')
  const seedDbPath = path.join(RESOURCES_DIR, 'seed.db')
  if (fs.existsSync(seedDbPath)) fs.rmSync(seedDbPath)
  try {
    execSync(
      `bun x prisma db push --schema=prisma/schema.local.prisma --accept-data-loss`,
      {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL: `file:${seedDbPath}` },
        timeout: 30_000,
      },
    )
    console.log('  ✓ seed.db generated')
  } catch (err) {
    console.error('  Failed to generate seed.db:', err.message)
    process.exit(1)
  }

  // --- Config files ---
  logStep('Copying config files...')
  const prismaConfig = path.join(REPO_ROOT, 'prisma.config.local.ts')
  if (fs.existsSync(prismaConfig)) {
    fs.copyFileSync(prismaConfig, path.join(RESOURCES_DIR, 'prisma.config.local.ts'))
    console.log('  ✓ prisma.config.local.ts')
  }

  // --- Install external packages ---
  logStep('Installing external packages...')
  const externalPkg = {
    name: 'shogo-desktop-bundle',
    private: true,
    dependencies: {},
  }

  const apiPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'apps/api/package.json'), 'utf-8'))
  const agentPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages/agent-runtime/package.json'), 'utf-8'))
  const allSourceDeps = {
    ...agentPkg.dependencies,
    ...agentPkg.devDependencies,
    ...apiPkg.dependencies,
    ...apiPkg.devDependencies,
  }

  for (const pkg of EXTERNAL_PACKAGES) {
    const version = allSourceDeps[pkg]
    if (version) {
      externalPkg.dependencies[pkg] = version
    }
  }

  fs.writeFileSync(
    path.join(RESOURCES_DIR, 'package.json'),
    JSON.stringify(externalPkg, null, 2) + '\n',
  )

  if (!skipInstall) {
    const isWindows = process.platform === 'win32'
    const installCmd = isWindows
      ? 'npm install --omit=dev'
      : 'bun install --production'
    console.log(`  Running: ${installCmd}`)
    execSync(installCmd, {
      cwd: RESOURCES_DIR,
      stdio: 'inherit',
    })
  }

  // --- Copy canvas-runtime type definitions (used by LSP for canvas code linting) ---
  logStep('Copying canvas-runtime...')
  const canvasRuntimeDir = path.join(REPO_ROOT, 'packages', 'canvas-runtime')
  const canvasRuntimeDest = path.join(RESOURCES_DIR, 'canvas-runtime')
  fs.mkdirSync(canvasRuntimeDest, { recursive: true })
  const globalsDts = path.join(canvasRuntimeDir, 'src', 'canvas-globals.d.ts')
  if (fs.existsSync(globalsDts)) {
    fs.copyFileSync(globalsDts, path.join(canvasRuntimeDest, 'canvas-globals.d.ts'))
    console.log('  ✓ Copied canvas-globals.d.ts')
  } else {
    console.warn('  ⚠ canvas-globals.d.ts not found at', globalsDts)
  }

  // --- Copy runtime template (Vite scaffold for new projects) ---
  logStep('Copying runtime template...')
  const runtimeTemplateSource = path.join(REPO_ROOT, 'templates', 'runtime-template')
  const runtimeTemplateDest = path.join(RESOURCES_DIR, 'runtime-template')
  if (fs.existsSync(runtimeTemplateSource)) {
    fs.cpSync(runtimeTemplateSource, runtimeTemplateDest, {
      recursive: true,
      filter: (src) => !src.includes('node_modules') && !src.includes('.git'),
    })
    console.log('  ✓ Copied runtime-template')
  } else {
    console.warn('  ⚠ runtime-template not found at', runtimeTemplateSource)
  }

  // --- Copy agent templates ---
  logStep('Copying agent templates...')
  const templatesSource = path.join(REPO_ROOT, 'packages', 'agent-runtime', 'templates')
  const templatesDest = path.join(RESOURCES_DIR, 'templates')
  if (fs.existsSync(templatesSource)) {
    fs.cpSync(templatesSource, templatesDest, { recursive: true })
    const count = fs.readdirSync(templatesDest, { withFileTypes: true }).filter(d => d.isDirectory()).length
    console.log(`  ✓ Copied ${count} template(s)`)
  } else {
    console.warn('  ⚠ Templates directory not found at', templatesSource)
  }

  // --- Copy tree-sitter WASM files (needed at runtime by agent-runtime) ---
  logStep('Copying tree-sitter WASM files...')
  const wasmDest = path.join(RESOURCES_DIR, 'tree-sitter-wasm')
  fs.mkdirSync(wasmDest, { recursive: true })

  function findInstalledPkg(pkgName, startDir) {
    let dir = startDir
    while (dir !== path.dirname(dir)) {
      const candidate = path.join(dir, 'node_modules', pkgName)
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
      dir = path.dirname(dir)
    }
    return null
  }

  const agentRuntimeDir = path.join(REPO_ROOT, 'packages', 'agent-runtime')

  const webTreeSitterDir = findInstalledPkg('web-tree-sitter', agentRuntimeDir)
  if (webTreeSitterDir) {
    const src = path.join(webTreeSitterDir, 'tree-sitter.wasm')
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(wasmDest, 'tree-sitter.wasm'))
      console.log('  ✓ tree-sitter.wasm')
    } else {
      console.warn(`  ⚠ tree-sitter.wasm not found inside ${webTreeSitterDir}`)
    }
  } else {
    console.warn('  ⚠ web-tree-sitter package not found')
  }

  const treeSitterWasmsDir = findInstalledPkg('tree-sitter-wasms', agentRuntimeDir)
  if (treeSitterWasmsDir) {
    const langWasmDir = path.join(treeSitterWasmsDir, 'out')
    const needed = ['python', 'typescript', 'tsx', 'javascript', 'go', 'rust', 'java']
    let copied = 0
    for (const lang of needed) {
      const src = path.join(langWasmDir, `tree-sitter-${lang}.wasm`)
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(wasmDest, `tree-sitter-${lang}.wasm`))
        copied++
      }
    }
    console.log(`  ✓ Copied ${copied} language grammar(s)`)
  } else {
    console.warn('  ⚠ tree-sitter-wasms package not found')
  }

  // --- Prepare VM bundle (Linux bun, templates, wasm for VirtioFS mount) ---
  logStep('Preparing VM bundle...')
  try {
    execSync(
      `bun run "${path.join(DESKTOP_DIR, 'scripts', 'prepare-vm-bundle-cli.ts')}" --dest resources/vm-bundle --server-js resources/bundle/agent-runtime.js`,
      { cwd: DESKTOP_DIR, stdio: 'inherit', timeout: 120_000 },
    )
    console.log('  ✓ VM bundle ready')
  } catch (err) {
    console.warn('  ⚠ VM bundle preparation failed (non-fatal):', err.message)
  }

  // --- Summary ---
  let totalSize = 0
  for (const { output } of ENTRY_POINTS) {
    const f = path.join(bundleDir, output)
    if (fs.existsSync(f)) {
      const size = fs.statSync(f).size
      totalSize += size
      console.log(`  ${output}: ${(size / 1024 / 1024).toFixed(1)} MB`)
    }
  }
  console.log(`  Total bundle: ${(totalSize / 1024 / 1024).toFixed(1)} MB`)

  console.log('\n✅ API bundle complete!')
}

main()
