// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared VM bundle preparation logic.
 *
 * Used by both:
 * - The eval worker (vm-worker.ts) — builds JS from source at runtime
 * - The desktop build script (bundle-api.mjs) — copies pre-built JS at build time
 *
 * Produces a self-contained directory that cloud-init mounts at /mnt/bundle/
 * inside the VM guest.
 */

import { execSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  readdirSync,
  copyFileSync,
  cpSync,
  writeFileSync,
  readFileSync,
} from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'

const isWin = process.platform === 'win32'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PrepareVMBundleOptions {
  destDir: string
  repoRoot: string
  /** Copy this file as server.js instead of building from source. */
  prebuiltServerJs?: string
  /** Copy this file as shogo.js instead of building from source. */
  prebuiltShogoJs?: string
  /**
   * When true, only produce the files needed for seed ISO embedding
   * (server.js, shogo.js, wasm files). Skips Linux bun download,
   * templates, prisma packages, and LSP servers that are
   * pre-installed in rootfs-provisioned.qcow2 at /opt/shogo/node_modules/.
   */
  lightMode?: boolean
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

export function findGlobDirs(baseDir: string, pattern: RegExp): string[] {
  if (!existsSync(baseDir)) return []
  const results: string[] = []
  try {
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (entry.isDirectory() && pattern.test(entry.name)) {
        results.push(join(baseDir, entry.name))
      }
    }
  } catch {}
  return results
}

export function downloadLinuxBun(destDir: string): void {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64'
  const bunVersion = execSync('bun --version', { encoding: 'utf-8' }).trim()
  console.log(`  Downloading Linux ${arch} bun v${bunVersion} for VM...`)

  const zipPath = join(tmpdir(), `bun-linux-${arch}.zip`)
  const extractDir = join(tmpdir(), 'bun-extract')

  execSync(
    `curl -fsSL -o "${zipPath}" "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-linux-${arch}.zip"`,
    { stdio: 'pipe', timeout: 60_000 },
  )

  mkdirSync(extractDir, { recursive: true })

  if (isWin) {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
      { stdio: 'pipe', timeout: 30_000 },
    )
  } else {
    execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'pipe' })
  }

  const bunBinaryPath = join(extractDir, `bun-linux-${arch}`, 'bun')
  const dest = join(destDir, 'bun')
  copyFileSync(bunBinaryPath, dest)

  if (!isWin) {
    execSync(`chmod +x "${dest}"`, { stdio: 'pipe' })
  }
}

export function createBunAlias(dir: string, alias: string): void {
  const link = join(dir, alias)
  if (existsSync(link)) return

  if (isWin) {
    try {
      symlinkSync('bun', link)
    } catch {
      writeFileSync(link, '#!/bin/sh\nexec "$(dirname "$0")/bun" "$@"\n')
    }
  } else {
    try {
      symlinkSync('bun', link)
    } catch {}
  }
}

export function copyPrismaPackages(destDir: string, repoRoot: string): void {
  const prismaPackages = [
    'prisma',
    '@prisma/client',
    '@prisma/prisma-schema-wasm',
    '@prisma/internals',
    '@prisma/fetch-engine',
    '@prisma/engines',
  ]
  const srcBase = join(repoRoot, 'node_modules')
  const destBase = join(destDir, 'node_modules')

  for (const pkg of prismaPackages) {
    const destPkg = join(destBase, pkg)
    if (existsSync(destPkg)) continue

    let srcPkg = join(srcBase, pkg)
    if (!existsSync(join(srcPkg, 'package.json'))) {
      const bunDir = join(srcBase, '.bun')
      if (existsSync(bunDir)) {
        const prefix = pkg.replace('/', '+') + '@'
        const dirs = findGlobDirs(
          bunDir,
          new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        )
        for (const d of dirs) {
          const candidate = join(d, 'node_modules', pkg)
          if (existsSync(join(candidate, 'package.json'))) {
            srcPkg = candidate
            break
          }
        }
      }
    }

    if (existsSync(join(srcPkg, 'package.json'))) {
      mkdirSync(join(destBase, ...pkg.split('/').slice(0, -1)), { recursive: true })
      cpSync(srcPkg, destPkg, { recursive: true })
    }
  }
}

export function copyWasmFiles(wasmDestDir: string, repoRoot: string): void {
  if (existsSync(wasmDestDir)) return
  mkdirSync(wasmDestDir, { recursive: true })

  try {
    const bunModBase = join(repoRoot, 'node_modules', '.bun')

    const tsWasmDirs = findGlobDirs(bunModBase, /^web-tree-sitter@/)
    for (const d of tsWasmDirs) {
      const wasmFile = join(d, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm')
      if (existsSync(wasmFile)) {
        copyFileSync(wasmFile, join(wasmDestDir, 'tree-sitter.wasm'))
        break
      }
    }

    const langWasmDirs = findGlobDirs(bunModBase, /^tree-sitter-wasms@/)
    for (const d of langWasmDirs) {
      const outDir = join(d, 'node_modules', 'tree-sitter-wasms', 'out')
      if (existsSync(outDir)) {
        for (const f of readdirSync(outDir)) {
          if (f.endsWith('.wasm')) copyFileSync(join(outDir, f), join(wasmDestDir, f))
        }
        break
      }
    }
  } catch {}
}

export function copyTemplates(destDir: string, repoRoot: string): void {
  const templatesDir = join(destDir, 'templates')
  const rtDir = join(templatesDir, 'runtime-template')
  const ssDir = join(templatesDir, 'skill-server')

  if (!existsSync(join(rtDir, 'node_modules'))) {
    console.log('  Preparing runtime-template with deps for VM...')
    const srcTemplate = resolve(repoRoot, 'templates/runtime-template')
    mkdirSync(rtDir, { recursive: true })
    cpSync(srcTemplate, rtDir, { recursive: true })
    try {
      execSync('bun install', { cwd: rtDir, stdio: 'pipe', timeout: 60_000 })
    } catch {
      if (!existsSync(join(rtDir, 'node_modules'))) throw new Error('bun install failed for runtime-template')
    }
  }

  if (!existsSync(join(ssDir, 'package.json'))) {
    mkdirSync(ssDir, { recursive: true })
    writeFileSync(
      join(ssDir, 'package.json'),
      JSON.stringify({
        name: 'skill-server',
        private: true,
        dependencies: {
          hono: '^4.7.0',
          prisma: '7.4.1',
          '@prisma/client': '7.4.1',
          'prisma-adapter-bun-sqlite': '^0.6.8',
        },
      }),
    )
  }

  if (!existsSync(join(ssDir, 'node_modules'))) {
    console.log('  Preparing skill-server with deps for VM...')
    try {
      execSync('bun install', { cwd: ssDir, stdio: 'pipe', timeout: 60_000 })
    } catch {
      if (!existsSync(join(ssDir, 'node_modules')))
        throw new Error('bun install failed for skill-server')
    }
  }
}

/**
 * Reads a single tree-sitter.wasm from node_modules for ISO embedding (Windows path).
 */
export function getTreeSitterWasmBuffer(repoRoot: string): Buffer | null {
  const bunModBase = join(repoRoot, 'node_modules', '.bun')
  const tsWasmDirs = findGlobDirs(bunModBase, /^web-tree-sitter@/)
  for (const d of tsWasmDirs) {
    const wasmFile = join(d, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm')
    if (existsSync(wasmFile)) return readFileSync(wasmFile)
  }
  return null
}

// ---------------------------------------------------------------------------
// High-level orchestrator
// ---------------------------------------------------------------------------

/**
 * Prepare a complete VM bundle directory.
 *
 * For evals: call without prebuiltServerJs/prebuiltShogoJs to build from source.
 * For desktop packaging: pass pre-built JS bundle paths.
 */
export function prepareVMBundle(opts: PrepareVMBundleOptions): void {
  const { destDir, repoRoot, prebuiltServerJs, prebuiltShogoJs, lightMode } = opts
  mkdirSync(destDir, { recursive: true })

  // --- JS bundles (always needed) ---
  if (prebuiltServerJs) {
    if (!existsSync(join(destDir, 'server.js'))) {
      console.log('  Copying pre-built server.js for VM...')
      copyFileSync(prebuiltServerJs, join(destDir, 'server.js'))
    }
  } else if (!existsSync(join(destDir, 'server.js'))) {
    console.log('  Building agent-runtime bundle for VM...')
    execSync(
      `bun build src/server.ts --outdir "${destDir}" --target bun --external electron --external playwright-core --external playwright`,
      { cwd: resolve(repoRoot, 'packages/agent-runtime'), stdio: 'pipe' },
    )
  }

  if (prebuiltShogoJs) {
    if (!existsSync(join(destDir, 'shogo.js'))) {
      console.log('  Copying pre-built shogo.js for VM...')
      copyFileSync(prebuiltShogoJs, join(destDir, 'shogo.js'))
    }
  } else if (!existsSync(join(destDir, 'shogo.js'))) {
    console.log('  Building shogo CLI bundle for VM...')
    execSync(
      `bun build packages/sdk/bin/shogo.ts --outfile "${join(destDir, 'shogo.js')}" --target bun ` +
        `--external electron --external playwright-core --external playwright ` +
        `--external @prisma/prisma-schema-wasm --external @prisma/engines ` +
        `--external @prisma/fetch-engine --external @prisma/internals`,
      { cwd: repoRoot, stdio: 'pipe' },
    )
  }

  // --- Tree-sitter wasm files (always needed — embedded in seed ISO) ---
  copyWasmFiles(join(destDir, 'wasm'), repoRoot)

  // With pre-provisioned images the following are baked into rootfs-provisioned.qcow2:
  //   - /usr/local/bin/bun (+ node/npx/npm aliases)
  //   - /opt/shogo/node_modules/ (prisma, typescript-language-server, typescript, pyright)
  //   - /app/templates/runtime-template/ (+ symlink at /opt/shogo/templates/)
  //   - /app/templates/skill-server/
  // Only JS bundles + wasm files need to be in the seed ISO.
  if (!lightMode) {
    // --- Prisma packages ---
    if (!existsSync(join(destDir, 'node_modules', '@prisma', 'internals'))) {
      console.log('  Installing prisma packages for shogo CLI...')
      if (!existsSync(join(destDir, 'package.json'))) {
        writeFileSync(join(destDir, 'package.json'), JSON.stringify({ name: 'vm-bundle', private: true }))
      }
      try {
        execSync(
          `bun add prisma @prisma/client @prisma/prisma-schema-wasm @prisma/internals @prisma/fetch-engine`,
          { cwd: destDir, stdio: 'pipe', timeout: 60_000 },
        )
      } catch {
        copyPrismaPackages(destDir, repoRoot)
      }
    }

    // --- Linux bun binary + aliases ---
    if (!existsSync(join(destDir, 'bun'))) downloadLinuxBun(destDir)
    for (const alias of ['node', 'npx', 'npm']) createBunAlias(destDir, alias)

    // --- Templates ---
    copyTemplates(destDir, repoRoot)

    // --- typescript-language-server (used by LSP inside the VM) ---
    if (!existsSync(join(destDir, 'node_modules', 'typescript-language-server'))) {
      console.log('  Installing typescript-language-server for VM...')
      execSync('bun add typescript-language-server typescript', {
        cwd: destDir, stdio: 'pipe', timeout: 60_000,
      })
    }
  }

  console.log(`  VM bundle ready at ${destDir}`)
}
