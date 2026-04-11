import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import fs from 'fs'
import path from 'path'
import os from 'os'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

// ---------------------------------------------------------------------------
// 1. readBundleDir wasm fix — both VM managers must read ALL .wasm files
// ---------------------------------------------------------------------------

describe('readBundleDir reads all wasm files from wasm/ subdirectory', () => {
  let tmpBundle: string

  beforeAll(() => {
    tmpBundle = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-bundle-wasm-test-'))
    fs.writeFileSync(path.join(tmpBundle, 'server.js'), 'console.log("server")')
    fs.writeFileSync(path.join(tmpBundle, 'shogo.js'), 'console.log("shogo")')
    const wasmDir = path.join(tmpBundle, 'wasm')
    fs.mkdirSync(wasmDir)
    fs.writeFileSync(path.join(wasmDir, 'tree-sitter.wasm'), 'CORE')
    fs.writeFileSync(path.join(wasmDir, 'tree-sitter-python.wasm'), 'PYTHON')
    fs.writeFileSync(path.join(wasmDir, 'tree-sitter-javascript.wasm'), 'JS')
    fs.writeFileSync(path.join(wasmDir, 'tree-sitter-typescript.wasm'), 'TS')
  })

  afterAll(() => { fs.rmSync(tmpBundle, { recursive: true, force: true }) })

  function readBundleDir(bundleDir: string): Record<string, Buffer> {
    if (!bundleDir || !fs.existsSync(bundleDir)) return {}
    const files: Record<string, Buffer> = {}
    for (const name of ['server.js', 'shogo.js']) {
      const p = path.join(bundleDir, name)
      if (fs.existsSync(p)) files[name] = fs.readFileSync(p)
    }
    const wasmDir = path.join(bundleDir, 'wasm')
    if (fs.existsSync(wasmDir)) {
      for (const f of fs.readdirSync(wasmDir)) {
        if (f.endsWith('.wasm')) files[f] = fs.readFileSync(path.join(wasmDir, f))
      }
    }
    if (!files['tree-sitter.wasm']) {
      const bunModBase = path.join(bundleDir, '..', '..', 'node_modules', '.bun')
      if (fs.existsSync(bunModBase)) {
        try {
          for (const entry of fs.readdirSync(bunModBase, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name.startsWith('web-tree-sitter@')) {
              const candidate = path.join(bunModBase, entry.name, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm')
              if (fs.existsSync(candidate)) { files['tree-sitter.wasm'] = fs.readFileSync(candidate); break }
            }
          }
        } catch {}
      }
    }
    return files
  }

  test('picks up all 4 wasm files, not just tree-sitter.wasm', () => {
    const files = readBundleDir(tmpBundle)
    expect(files['server.js']).toBeDefined()
    expect(files['shogo.js']).toBeDefined()
    expect(files['tree-sitter.wasm']).toBeDefined()
    expect(files['tree-sitter-python.wasm']).toBeDefined()
    expect(files['tree-sitter-javascript.wasm']).toBeDefined()
    expect(files['tree-sitter-typescript.wasm']).toBeDefined()
    expect(files['tree-sitter-python.wasm']!.toString()).toBe('PYTHON')
  })

  test('wasm file count matches what copyWasmFiles would produce', () => {
    const files = readBundleDir(tmpBundle)
    const wasmKeys = Object.keys(files).filter(k => k.endsWith('.wasm'))
    expect(wasmKeys.length).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// 2. Verify darwin-vm-manager.ts and win32-vm-manager.ts source code
//    actually contains the fix (reads wasm dir, not just one file)
// ---------------------------------------------------------------------------

describe('VM manager source code contains wasm directory reading', () => {
  test('darwin-vm-manager reads all wasm from wasm/ dir', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'apps/desktop/src/vm/darwin-vm-manager.ts'), 'utf-8'
    )
    expect(src).toContain("const wasmDir = path.join(bundleDir, 'wasm')")
    expect(src).toContain("f.endsWith('.wasm')")
    expect(src).not.toContain("const wasmPath = path.join(bundleDir, 'wasm', 'tree-sitter.wasm')")
  })

  test('win32-vm-manager reads all wasm from wasm/ dir', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'apps/desktop/src/vm/win32-vm-manager.ts'), 'utf-8'
    )
    expect(src).toContain("const wasmDir = path.join(bundleDir, 'wasm')")
    expect(src).toContain("f.endsWith('.wasm')")
    expect(src).not.toContain("const wasmPath = path.join(bundleDir, 'wasm', 'tree-sitter.wasm')")
  })
})

// ---------------------------------------------------------------------------
// 3. Verify provisioning scripts install prisma at /opt/shogo/
// ---------------------------------------------------------------------------

describe('provisioning scripts install prisma packages at /opt/shogo/', () => {
  const PRISMA_PKGS = [
    '@prisma/internals',
    '@prisma/fetch-engine',
    '@prisma/prisma-schema-wasm',
  ]

  test('provision-darwin-image.ts installs prisma into /opt/shogo', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'apps/desktop/src/vm/provision-darwin-image.ts'), 'utf-8'
    )
    expect(src).toContain('cd /opt/shogo')
    for (const pkg of PRISMA_PKGS) {
      expect(src).toContain(pkg)
    }
    const optShogoIdx = src.indexOf("cd /opt/shogo")
    const prismaIdx = src.indexOf('@prisma/internals', optShogoIdx)
    expect(prismaIdx).toBeGreaterThan(optShogoIdx)
  })

  test('build-darwin.sh installs prisma into /opt/shogo', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'apps/desktop/scripts/build-vm-image/build-darwin.sh'), 'utf-8'
    )
    expect(src).toContain('cd /opt/shogo')
    for (const pkg of PRISMA_PKGS) {
      expect(src).toContain(pkg)
    }
  })

  test('build.sh installs prisma into /opt/shogo', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'apps/desktop/scripts/build-vm-image/build.sh'), 'utf-8'
    )
    expect(src).toContain('cd /opt/shogo')
    for (const pkg of PRISMA_PKGS) {
      expect(src).toContain(pkg)
    }
  })

  test('all three scripts install LSP into /opt/shogo (not globally)', () => {
    const darwinSh = fs.readFileSync(
      path.join(REPO_ROOT, 'apps/desktop/scripts/build-vm-image/build-darwin.sh'), 'utf-8'
    )
    const buildSh = fs.readFileSync(
      path.join(REPO_ROOT, 'apps/desktop/scripts/build-vm-image/build.sh'), 'utf-8'
    )
    const provTs = fs.readFileSync(
      path.join(REPO_ROOT, 'apps/desktop/src/vm/provision-darwin-image.ts'), 'utf-8'
    )

    for (const src of [darwinSh, buildSh, provTs]) {
      expect(src).toContain('typescript-language-server')
      const cdIdx = src.indexOf('cd /opt/shogo')
      const lspIdx = src.indexOf('typescript-language-server', cdIdx)
      expect(lspIdx).toBeGreaterThan(cdIdx)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. prepareVMBundle lightMode produces wasm files
// ---------------------------------------------------------------------------

describe('prepareVMBundle lightMode', () => {
  let tmpDest: string

  beforeAll(() => {
    tmpDest = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-lightmode-test-'))
  })
  afterAll(() => { fs.rmSync(tmpDest, { recursive: true, force: true }) })

  test('lightMode bundle includes wasm/ directory with files', () => {
    const { prepareVMBundle } = require(
      path.resolve(REPO_ROOT, 'apps/desktop/src/vm/prepare-bundle')
    ) as { prepareVMBundle: (opts: any) => void }

    prepareVMBundle({
      destDir: tmpDest,
      repoRoot: REPO_ROOT,
      lightMode: true,
    })

    expect(fs.existsSync(path.join(tmpDest, 'server.js'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDest, 'shogo.js'))).toBe(true)

    const wasmDir = path.join(tmpDest, 'wasm')
    expect(fs.existsSync(wasmDir)).toBe(true)
    const wasmFiles = fs.readdirSync(wasmDir).filter(f => f.endsWith('.wasm'))
    expect(wasmFiles.length).toBeGreaterThanOrEqual(1)
    expect(wasmFiles).toContain('tree-sitter.wasm')

    const langWasm = wasmFiles.filter(f => f !== 'tree-sitter.wasm')
    console.log(`  lightMode wasm files: ${wasmFiles.join(', ')} (${langWasm.length} language grammars)`)
    expect(langWasm.length).toBeGreaterThan(0)
  })

  test('lightMode bundle does NOT contain prisma, bun binary, or templates', () => {
    expect(fs.existsSync(path.join(tmpDest, 'node_modules'))).toBe(false)
    expect(fs.existsSync(path.join(tmpDest, 'bun'))).toBe(false)
    expect(fs.existsSync(path.join(tmpDest, 'templates'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. Verify cloud-init per-boot script routes wasm correctly
// ---------------------------------------------------------------------------

describe('cloud-init per-boot wasm routing', () => {
  test('cloud-init.ts routes *.wasm to /opt/shogo/wasm/ (not /opt/shogo/)', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'apps/desktop/src/vm/cloud-init.ts'), 'utf-8'
    )
    expect(src).toContain('*.wasm) cp "$f" /opt/shogo/wasm/')
  })
})
