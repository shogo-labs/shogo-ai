// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * prepare-bundle.ts — coverage closer for the VM bundle preparation helpers.
 *
 * Mocks fs, child_process, and os to drive every branch of:
 *   findGlobDirs, downloadLinuxBun, createBunAlias, copyPrismaPackages,
 *   copyWasmFiles, copyTemplates, getTreeSitterWasmBuffer, prepareVMBundle.
 *
 *   bun test packages/agent-runtime/src/__tests__/prepare-bundle-extra.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test'

// ---------------------------------------------------------------------------
// Virtual filesystem state — manipulated per-test
// ---------------------------------------------------------------------------

type FSEntry = { type: 'file' | 'dir'; content?: Buffer }
const fsState = new Map<string, FSEntry>()

function fsReset() {
  fsState.clear()
}
function fsMkdir(p: string) {
  fsState.set(p, { type: 'dir' })
}
function fsWriteFile(p: string, content: string | Buffer) {
  const buf = typeof content === 'string' ? Buffer.from(content) : content
  fsState.set(p, { type: 'file', content: buf })
}

const cpSyncCalls: Array<{ src: string; dest: string; opts: any }> = []
const symlinkCalls: Array<{ target: string; link: string }> = []
let symlinkImpl: (target: string, link: string) => void = (target, link) => {
  fsState.set(link, { type: 'file', content: Buffer.from(`symlink->${target}`) })
}
let cpSyncImpl: (src: string, dest: string, opts: any) => void = (src, dest) => {
  fsState.set(dest, { type: 'dir' })
  fsState.set(`${dest}/package.json`, { type: 'file', content: Buffer.from('{}') })
}
let readFileImpl: ((p: string) => Buffer) | null = null

const readdirEntries = new Map<string, Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>>()

mock.module('fs', () => ({
  existsSync: (p: string) => fsState.has(p),
  mkdirSync: (p: string, _opts: any) => {
    fsState.set(p, { type: 'dir' })
  },
  symlinkSync: (target: string, link: string) => {
    symlinkCalls.push({ target, link })
    symlinkImpl(target, link)
  },
  readdirSync: (p: string, opts?: any) => {
    if (opts && opts.withFileTypes) {
      return readdirEntries.get(p) ?? []
    }
    return (readdirEntries.get(p) ?? []).map((e) => e.name)
  },
  copyFileSync: (src: string, dest: string) => {
    const e = fsState.get(src)
    fsState.set(dest, { type: 'file', content: e?.content ?? Buffer.from('copied') })
  },
  cpSync: (src: string, dest: string, opts: any) => {
    cpSyncCalls.push({ src, dest, opts })
    cpSyncImpl(src, dest, opts)
  },
  writeFileSync: (p: string, content: string | Buffer) => {
    fsWriteFile(p, content)
  },
  readFileSync: (p: string) => {
    if (readFileImpl) return readFileImpl(p)
    const e = fsState.get(p)
    return e?.content ?? Buffer.from('')
  },
}))

// ---------------------------------------------------------------------------
// child_process mock
// ---------------------------------------------------------------------------

type ExecCall = { cmd: string; opts: any }
const execSyncCalls: ExecCall[] = []
let execSyncImpl: (cmd: string, opts: any) => string | Buffer = () => ''

mock.module('child_process', () => ({
  execSync: (cmd: string, opts: any) => {
    execSyncCalls.push({ cmd, opts })
    return execSyncImpl(cmd, opts)
  },
}))

// ---------------------------------------------------------------------------
// os.tmpdir mock (deterministic temp path)
// ---------------------------------------------------------------------------

mock.module('os', () => ({
  tmpdir: () => '/tmp-mock',
}))

const pb = await import('../../../../apps/desktop/src/vm/prepare-bundle')

// ---------------------------------------------------------------------------
// Platform helpers — we mutate process.platform between tests
// ---------------------------------------------------------------------------

const originalPlatform = process.platform
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

beforeEach(() => {
  fsReset()
  cpSyncCalls.length = 0
  symlinkCalls.length = 0
  execSyncCalls.length = 0
  readdirEntries.clear()
  symlinkImpl = (target, link) => {
    fsState.set(link, { type: 'file', content: Buffer.from(`symlink->${target}`) })
  }
  cpSyncImpl = (src, dest) => {
    fsState.set(dest, { type: 'dir' })
    fsState.set(`${dest}/package.json`, { type: 'file', content: Buffer.from('{}') })
  }
  readFileImpl = null
  execSyncImpl = () => ''
  setPlatform('linux')
})

afterEach(() => {
  setPlatform(originalPlatform)
})

afterAll(() => {
  setPlatform(originalPlatform)
})

// ---------------------------------------------------------------------------
// findGlobDirs
// ---------------------------------------------------------------------------

describe('findGlobDirs', () => {
  test('returns [] when baseDir does not exist', () => {
    expect(pb.findGlobDirs('/nope', /^x/)).toEqual([])
  })

  test('returns matching directory entries', () => {
    fsMkdir('/base')
    readdirEntries.set('/base', [
      { name: 'web-tree-sitter@1.0', isDirectory: () => true, isFile: () => false },
      { name: 'web-tree-sitter@2.0', isDirectory: () => true, isFile: () => false },
      { name: 'unrelated@1.0', isDirectory: () => true, isFile: () => false },
      { name: 'web-tree-sitter@3.0.txt', isDirectory: () => false, isFile: () => true },
    ])
    const out = pb.findGlobDirs('/base', /^web-tree-sitter@/)
    expect(out.length).toBe(2)
    expect(out[0]).toContain('web-tree-sitter@1.0')
    expect(out[1]).toContain('web-tree-sitter@2.0')
  })

  test('swallows readdir errors and returns []', () => {
    fsMkdir('/explodes')
    readdirEntries.set('/explodes', [])
    // Force readdirSync to throw by registering a getter that throws
    const originalGet = readdirEntries.get.bind(readdirEntries)
    readdirEntries.get = ((k: string) => {
      if (k === '/explodes') throw new Error('boom')
      return originalGet(k)
    }) as any
    expect(pb.findGlobDirs('/explodes', /./)).toEqual([])
    readdirEntries.get = originalGet
  })
})

// ---------------------------------------------------------------------------
// downloadLinuxBun
// ---------------------------------------------------------------------------

describe('downloadLinuxBun', () => {
  test('non-win path: curl + unzip + chmod, x64 arch', () => {
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    execSyncImpl = (cmd) => {
      if (cmd === 'bun --version') return '1.1.0\n'
      // Simulate unzip producing the binary
      fsState.set('/tmp-mock/bun-extract/bun-linux-x64/bun', {
        type: 'file',
        content: Buffer.from('binary'),
      })
      return ''
    }
    pb.downloadLinuxBun('/dest')
    expect(execSyncCalls.some((c) => c.cmd === 'bun --version')).toBe(true)
    expect(execSyncCalls.some((c) => c.cmd.startsWith('curl'))).toBe(true)
    expect(execSyncCalls.some((c) => c.cmd.startsWith('unzip'))).toBe(true)
    expect(execSyncCalls.some((c) => c.cmd.startsWith('chmod'))).toBe(true)
    expect(fsState.has('/dest/bun')).toBe(true)
  })

  test('arm64 maps to aarch64', () => {
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true })
    execSyncImpl = (cmd) => {
      if (cmd === 'bun --version') return '1.2.0'
      fsState.set('/tmp-mock/bun-extract/bun-linux-aarch64/bun', {
        type: 'file',
        content: Buffer.from('arm'),
      })
      return ''
    }
    pb.downloadLinuxBun('/dest2')
    expect(execSyncCalls.some((c) => c.cmd.includes('bun-linux-aarch64'))).toBe(true)
  })

  test('win path: uses powershell Expand-Archive and skips chmod', () => {
    setPlatform('win32')
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    execSyncImpl = (cmd) => {
      if (cmd === 'bun --version') return '1.1.0'
      fsState.set('/tmp-mock/bun-extract/bun-linux-x64/bun', {
        type: 'file',
        content: Buffer.from('b'),
      })
      return ''
    }
    pb.downloadLinuxBun('/dwin')
    expect(execSyncCalls.some((c) => c.cmd.includes('Expand-Archive'))).toBe(true)
    expect(execSyncCalls.some((c) => c.cmd.startsWith('chmod'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// createBunAlias
// ---------------------------------------------------------------------------

describe('createBunAlias', () => {
  test('returns early if link already exists', () => {
    fsState.set('/d/node', { type: 'file', content: Buffer.from('') })
    pb.createBunAlias('/d', 'node')
    expect(symlinkCalls.length).toBe(0)
  })

  test('non-win: creates symlink', () => {
    pb.createBunAlias('/d', 'node')
    expect(symlinkCalls.length).toBe(1)
    expect(symlinkCalls[0]!.target).toBe('bun')
    expect(symlinkCalls[0]!.link).toBe('/d/node')
  })

  test('non-win: swallows symlink errors silently', () => {
    symlinkImpl = () => {
      throw new Error('eperm')
    }
    expect(() => pb.createBunAlias('/d', 'npx')).not.toThrow()
  })

  test('win: symlink success path', () => {
    setPlatform('win32')
    pb.createBunAlias('/d', 'node')
    expect(symlinkCalls.length).toBe(1)
  })

  test('win: symlink throws → falls back to writeFileSync shim', () => {
    setPlatform('win32')
    symlinkImpl = () => {
      throw new Error('symlink not permitted')
    }
    pb.createBunAlias('/d', 'npx')
    const shim = fsState.get('/d/npx')
    expect(shim?.type).toBe('file')
    expect(shim?.content?.toString()).toContain('exec "$(dirname')
  })
})

// ---------------------------------------------------------------------------
// copyPrismaPackages
// ---------------------------------------------------------------------------

describe('copyPrismaPackages', () => {
  test('skips packages already present in destination', () => {
    for (const pkg of [
      'prisma',
      '@prisma/client',
      '@prisma/prisma-schema-wasm',
      '@prisma/internals',
      '@prisma/fetch-engine',
      '@prisma/engines',
    ]) {
      fsState.set(`/dest/node_modules/${pkg}`, { type: 'dir' })
    }
    pb.copyPrismaPackages('/dest', '/repo')
    expect(cpSyncCalls.length).toBe(0)
  })

  test('copies directly from node_modules/<pkg> when present', () => {
    fsState.set('/repo/node_modules/prisma/package.json', {
      type: 'file',
      content: Buffer.from('{}'),
    })
    pb.copyPrismaPackages('/dest', '/repo')
    expect(cpSyncCalls.some((c) => c.src === '/repo/node_modules/prisma')).toBe(true)
  })

  test('resolves via .bun directory when direct path missing', () => {
    fsState.set('/repo/node_modules/.bun', { type: 'dir' })
    readdirEntries.set('/repo/node_modules/.bun', [
      { name: '@prisma+client@1.0.0', isDirectory: () => true, isFile: () => false },
    ])
    fsState.set(
      '/repo/node_modules/.bun/@prisma+client@1.0.0/node_modules/@prisma/client/package.json',
      { type: 'file', content: Buffer.from('{}') },
    )
    pb.copyPrismaPackages('/dest', '/repo')
    expect(
      cpSyncCalls.some((c) =>
        c.src.includes('@prisma+client@1.0.0/node_modules/@prisma/client'),
      ),
    ).toBe(true)
  })

  test('handles missing package gracefully (no .bun, no direct)', () => {
    pb.copyPrismaPackages('/dest', '/repo')
    expect(cpSyncCalls.length).toBe(0)
  })

  test('.bun present but candidate package.json missing → no copy', () => {
    fsState.set('/repo/node_modules/.bun', { type: 'dir' })
    readdirEntries.set('/repo/node_modules/.bun', [
      { name: 'prisma@7.4.1', isDirectory: () => true, isFile: () => false },
    ])
    pb.copyPrismaPackages('/dest', '/repo')
    expect(cpSyncCalls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// copyWasmFiles
// ---------------------------------------------------------------------------

describe('copyWasmFiles', () => {
  test('returns early if wasm dest dir already exists', () => {
    fsState.set('/dest/wasm', { type: 'dir' })
    pb.copyWasmFiles('/dest/wasm', '/repo')
    expect(cpSyncCalls.length).toBe(0)
  })

  test('copies tree-sitter core wasm + language wasms', () => {
    fsState.set('/repo/node_modules/.bun', { type: 'dir' })
    readdirEntries.set('/repo/node_modules/.bun', [
      { name: 'web-tree-sitter@0.20.0', isDirectory: () => true, isFile: () => false },
      { name: 'tree-sitter-wasms@4.0.0', isDirectory: () => true, isFile: () => false },
    ])
    fsState.set(
      '/repo/node_modules/.bun/web-tree-sitter@0.20.0/node_modules/web-tree-sitter/tree-sitter.wasm',
      { type: 'file', content: Buffer.from('CORE') },
    )
    fsState.set(
      '/repo/node_modules/.bun/tree-sitter-wasms@4.0.0/node_modules/tree-sitter-wasms/out',
      { type: 'dir' },
    )
    readdirEntries.set(
      '/repo/node_modules/.bun/tree-sitter-wasms@4.0.0/node_modules/tree-sitter-wasms/out',
      [
        { name: 'tree-sitter-python.wasm', isDirectory: () => false, isFile: () => true },
        { name: 'tree-sitter-javascript.wasm', isDirectory: () => false, isFile: () => true },
        { name: 'README.md', isDirectory: () => false, isFile: () => true },
      ],
    )
    fsState.set(
      '/repo/node_modules/.bun/tree-sitter-wasms@4.0.0/node_modules/tree-sitter-wasms/out/tree-sitter-python.wasm',
      { type: 'file', content: Buffer.from('PY') },
    )
    fsState.set(
      '/repo/node_modules/.bun/tree-sitter-wasms@4.0.0/node_modules/tree-sitter-wasms/out/tree-sitter-javascript.wasm',
      { type: 'file', content: Buffer.from('JS') },
    )
    pb.copyWasmFiles('/dest/wasm', '/repo')
    expect(fsState.get('/dest/wasm/tree-sitter.wasm')?.content?.toString()).toBe('CORE')
    expect(fsState.has('/dest/wasm/tree-sitter-python.wasm')).toBe(true)
    expect(fsState.has('/dest/wasm/tree-sitter-javascript.wasm')).toBe(true)
    expect(fsState.has('/dest/wasm/README.md')).toBe(false)
  })

  test('handles missing wasm directories gracefully', () => {
    pb.copyWasmFiles('/dest/wasm', '/repo')
    expect(fsState.has('/dest/wasm')).toBe(true)
  })

  test('swallows readdir errors in try/catch', () => {
    fsState.set('/repo/node_modules/.bun', { type: 'dir' })
    const realGet = readdirEntries.get.bind(readdirEntries)
    readdirEntries.get = ((k: string) => {
      if (k === '/repo/node_modules/.bun') throw new Error('boom')
      return realGet(k)
    }) as any
    expect(() => pb.copyWasmFiles('/dest/wasm', '/repo')).not.toThrow()
    readdirEntries.get = realGet
  })

  test('language wasm dir exists but contains no .wasm files', () => {
    fsState.set('/repo/node_modules/.bun', { type: 'dir' })
    readdirEntries.set('/repo/node_modules/.bun', [
      { name: 'tree-sitter-wasms@4.0.0', isDirectory: () => true, isFile: () => false },
    ])
    fsState.set(
      '/repo/node_modules/.bun/tree-sitter-wasms@4.0.0/node_modules/tree-sitter-wasms/out',
      { type: 'dir' },
    )
    readdirEntries.set(
      '/repo/node_modules/.bun/tree-sitter-wasms@4.0.0/node_modules/tree-sitter-wasms/out',
      [],
    )
    pb.copyWasmFiles('/dest/wasm', '/repo')
    expect(fsState.has('/dest/wasm')).toBe(true)
  })

  test('web-tree-sitter dir found but wasm file inside is missing → no break', () => {
    fsState.set('/repo/node_modules/.bun', { type: 'dir' })
    readdirEntries.set('/repo/node_modules/.bun', [
      { name: 'web-tree-sitter@0.20.0', isDirectory: () => true, isFile: () => false },
    ])
    pb.copyWasmFiles('/dest/wasm', '/repo')
    expect(fsState.has('/dest/wasm/tree-sitter.wasm')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// copyTemplates
// ---------------------------------------------------------------------------

describe('copyTemplates', () => {
  test('runtime-template + skill-server: full cp + bun install for both', () => {
    cpSyncImpl = (src, dest) => {
      fsState.set(dest, { type: 'dir' })
    }
    execSyncImpl = (_cmd, opts) => {
      // Simulate successful bun install — node_modules appears
      const cwd = opts?.cwd
      if (cwd) fsState.set(`${cwd}/node_modules`, { type: 'dir' })
      return ''
    }
    pb.copyTemplates('/dest', '/repo')
    expect(cpSyncCalls.some((c) => c.dest.endsWith('/runtime-template'))).toBe(true)
    expect(fsState.has('/dest/templates/skill-server/package.json')).toBe(true)
    const ssPkgRaw = fsState.get('/dest/templates/skill-server/package.json')?.content?.toString()
    expect(ssPkgRaw).toContain('skill-server')
    expect(execSyncCalls.filter((c) => c.cmd === 'bun install').length).toBe(2)
  })

  test('runtime-template node_modules already exists → skips cp/install', () => {
    fsState.set('/dest/templates/runtime-template/node_modules', { type: 'dir' })
    fsState.set('/dest/templates/skill-server/package.json', {
      type: 'file',
      content: Buffer.from('{}'),
    })
    fsState.set('/dest/templates/skill-server/node_modules', { type: 'dir' })
    pb.copyTemplates('/dest', '/repo')
    expect(cpSyncCalls.length).toBe(0)
    expect(execSyncCalls.length).toBe(0)
  })

  test('runtime-template bun install fails but node_modules ends up present → ok', () => {
    cpSyncImpl = (src, dest) => {
      fsState.set(dest, { type: 'dir' })
      // simulate cpSync producing node_modules from source already
      fsState.set(`${dest}/node_modules`, { type: 'dir' })
    }
    execSyncImpl = (cmd, opts) => {
      if (cmd === 'bun install' && opts?.cwd?.includes('runtime-template')) {
        throw new Error('install failed')
      }
      const cwd = opts?.cwd
      if (cwd) fsState.set(`${cwd}/node_modules`, { type: 'dir' })
      return ''
    }
    expect(() => pb.copyTemplates('/dest', '/repo')).not.toThrow()
  })

  test('runtime-template bun install fails AND node_modules still missing → throws', () => {
    cpSyncImpl = (src, dest) => {
      fsState.set(dest, { type: 'dir' })
    }
    execSyncImpl = (cmd) => {
      if (cmd === 'bun install') throw new Error('fail')
      return ''
    }
    expect(() => pb.copyTemplates('/dest', '/repo')).toThrow('bun install failed for runtime-template')
  })

  test('skill-server bun install fails AND node_modules missing → throws', () => {
    fsState.set('/dest/templates/runtime-template/node_modules', { type: 'dir' })
    execSyncImpl = (cmd, opts) => {
      if (cmd === 'bun install' && opts?.cwd?.includes('skill-server')) {
        throw new Error('fail')
      }
      return ''
    }
    expect(() => pb.copyTemplates('/dest', '/repo')).toThrow('bun install failed for skill-server')
  })

  test('skill-server install fails but node_modules ends up present → no throw', () => {
    fsState.set('/dest/templates/runtime-template/node_modules', { type: 'dir' })
    fsState.set('/dest/templates/skill-server/package.json', {
      type: 'file',
      content: Buffer.from('{}'),
    })
    let firstInstall = true
    execSyncImpl = (cmd, opts) => {
      if (cmd === 'bun install' && opts?.cwd?.includes('skill-server')) {
        if (firstInstall) {
          firstInstall = false
          // simulate side-effect: node_modules created despite throw
          fsState.set(`${opts.cwd}/node_modules`, { type: 'dir' })
          throw new Error('install failed')
        }
      }
      return ''
    }
    expect(() => pb.copyTemplates('/dest', '/repo')).not.toThrow()
  })

  test('skill-server package.json already exists → skips writeFile for it', () => {
    fsState.set('/dest/templates/runtime-template/node_modules', { type: 'dir' })
    fsState.set('/dest/templates/skill-server/package.json', {
      type: 'file',
      content: Buffer.from('{"name":"preexisting"}'),
    })
    execSyncImpl = (cmd, opts) => {
      const cwd = opts?.cwd
      if (cwd) fsState.set(`${cwd}/node_modules`, { type: 'dir' })
      return ''
    }
    pb.copyTemplates('/dest', '/repo')
    expect(
      fsState.get('/dest/templates/skill-server/package.json')?.content?.toString(),
    ).toContain('preexisting')
  })
})

// ---------------------------------------------------------------------------
// getTreeSitterWasmBuffer
// ---------------------------------------------------------------------------

describe('getTreeSitterWasmBuffer', () => {
  test('returns buffer when wasm file is found', () => {
    fsState.set('/repo/node_modules/.bun', { type: 'dir' })
    readdirEntries.set('/repo/node_modules/.bun', [
      { name: 'web-tree-sitter@0.21.0', isDirectory: () => true, isFile: () => false },
    ])
    fsState.set(
      '/repo/node_modules/.bun/web-tree-sitter@0.21.0/node_modules/web-tree-sitter/tree-sitter.wasm',
      { type: 'file', content: Buffer.from('WASM_BYTES') },
    )
    const buf = pb.getTreeSitterWasmBuffer('/repo')
    expect(buf?.toString()).toBe('WASM_BYTES')
  })

  test('returns null when no web-tree-sitter dirs found', () => {
    expect(pb.getTreeSitterWasmBuffer('/repo')).toBeNull()
  })

  test('returns null when dir found but wasm file missing inside', () => {
    fsState.set('/repo/node_modules/.bun', { type: 'dir' })
    readdirEntries.set('/repo/node_modules/.bun', [
      { name: 'web-tree-sitter@0.21.0', isDirectory: () => true, isFile: () => false },
    ])
    expect(pb.getTreeSitterWasmBuffer('/repo')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// prepareVMBundle — high-level orchestrator
// ---------------------------------------------------------------------------

describe('prepareVMBundle', () => {
  function primeBunInstallSideEffects() {
    execSyncImpl = (cmd, opts) => {
      if (cmd === 'bun --version') return '1.1.0'
      const cwd = opts?.cwd
      if (cmd === 'bun install' && cwd) {
        fsState.set(`${cwd}/node_modules`, { type: 'dir' })
      }
      if (cmd.startsWith('bun add') && cwd) {
        fsState.set(`${cwd}/node_modules`, { type: 'dir' })
        // Mirror the real bun-add: only create the markers for packages the
        // command actually installs. The old blanket-create masked the
        // typescript-language-server install step — prepare-bundle.ts skips
        // the install when the marker is already present, so the prisma
        // `bun add` (which used to seed the ts-lsp marker too) made the
        // ts-lsp install path unreachable from the test.
        if (cmd.includes('prisma')) {
          fsState.set(`${cwd}/node_modules/@prisma`, { type: 'dir' })
          fsState.set(`${cwd}/node_modules/@prisma/internals`, { type: 'dir' })
        }
        if (cmd.includes('typescript-language-server')) {
          fsState.set(`${cwd}/node_modules/typescript-language-server`, { type: 'dir' })
        }
      }
      if (cmd.startsWith('bun build') && cwd) {
        const outflagIdx = cmd.indexOf('--outfile')
        if (outflagIdx >= 0) {
          // shogo.js path
          const match = cmd.match(/--outfile "([^"]+)"/)
          if (match) fsState.set(match[1]!, { type: 'file', content: Buffer.from('') })
        }
        const outdirMatch = cmd.match(/--outdir "([^"]+)"/)
        if (outdirMatch) {
          fsState.set(`${outdirMatch[1]}/server.js`, { type: 'file', content: Buffer.from('') })
        }
      }
      if (cmd.startsWith('curl')) {
        fsState.set('/tmp-mock/bun-extract/bun-linux-x64/bun', {
          type: 'file',
          content: Buffer.from('b'),
        })
      }
      return ''
    }
  }

  test('lightMode: only builds/copies server.js, shogo.js, wasm', () => {
    primeBunInstallSideEffects()
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    pb.prepareVMBundle({ destDir: '/d', repoRoot: '/repo', lightMode: true })
    expect(fsState.has('/d/server.js')).toBe(true)
    expect(fsState.has('/d/shogo.js')).toBe(true)
    expect(fsState.has('/d/wasm')).toBe(true)
    // light mode → no prisma install, no linux bun
    expect(execSyncCalls.some((c) => c.cmd.startsWith('bun add prisma'))).toBe(false)
    expect(execSyncCalls.some((c) => c.cmd.startsWith('curl'))).toBe(false)
  })

  test('prebuilt JS bundles: copies, does not build', () => {
    primeBunInstallSideEffects()
    fsState.set('/pre/server.js', { type: 'file', content: Buffer.from('S') })
    fsState.set('/pre/shogo.js', { type: 'file', content: Buffer.from('G') })
    pb.prepareVMBundle({
      destDir: '/d',
      repoRoot: '/repo',
      prebuiltServerJs: '/pre/server.js',
      prebuiltShogoJs: '/pre/shogo.js',
      lightMode: true,
    })
    expect(fsState.get('/d/server.js')?.content?.toString()).toBe('S')
    expect(fsState.get('/d/shogo.js')?.content?.toString()).toBe('G')
    expect(execSyncCalls.some((c) => c.cmd.includes('bun build'))).toBe(false)
  })

  test('prebuilt path: server.js / shogo.js already at dest → no copy', () => {
    primeBunInstallSideEffects()
    fsState.set('/d/server.js', { type: 'file', content: Buffer.from('exist') })
    fsState.set('/d/shogo.js', { type: 'file', content: Buffer.from('exist') })
    fsState.set('/pre/server.js', { type: 'file', content: Buffer.from('S') })
    fsState.set('/pre/shogo.js', { type: 'file', content: Buffer.from('G') })
    pb.prepareVMBundle({
      destDir: '/d',
      repoRoot: '/repo',
      prebuiltServerJs: '/pre/server.js',
      prebuiltShogoJs: '/pre/shogo.js',
      lightMode: true,
    })
    expect(fsState.get('/d/server.js')?.content?.toString()).toBe('exist')
  })

  test('full mode: prisma install ok, linux bun, templates, tech-stacks, ts-lang-server', () => {
    primeBunInstallSideEffects()
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    fsState.set('/repo/packages/agent-runtime/tech-stacks', { type: 'dir' })
    pb.prepareVMBundle({ destDir: '/d', repoRoot: '/repo' })
    expect(fsState.has('/d/bun')).toBe(true)
    expect(fsState.has('/d/node')).toBe(true)
    expect(fsState.has('/d/npx')).toBe(true)
    expect(fsState.has('/d/npm')).toBe(true)
    expect(fsState.has('/d/package.json')).toBe(true)
    expect(execSyncCalls.some((c) => c.cmd.startsWith('bun add prisma'))).toBe(true)
    expect(
      execSyncCalls.some((c) =>
        c.cmd.startsWith('bun add typescript-language-server'),
      ),
    ).toBe(true)
    expect(cpSyncCalls.some((c) => c.dest === '/d/tech-stacks')).toBe(true)
  })

  test('full mode: prisma install fails → falls back to copyPrismaPackages', () => {
    execSyncImpl = (cmd, opts) => {
      if (cmd === 'bun --version') return '1.1.0'
      if (cmd.startsWith('bun add prisma')) throw new Error('network down')
      const cwd = opts?.cwd
      if (cmd === 'bun install' && cwd) fsState.set(`${cwd}/node_modules`, { type: 'dir' })
      if (cmd.startsWith('bun add typescript-language-server') && cwd) {
        fsState.set(`${cwd}/node_modules/typescript-language-server`, { type: 'dir' })
      }
      if (cmd.startsWith('bun build')) {
        const m1 = cmd.match(/--outfile "([^"]+)"/)
        if (m1) fsState.set(m1[1]!, { type: 'file', content: Buffer.from('') })
        const m2 = cmd.match(/--outdir "([^"]+)"/)
        if (m2) fsState.set(`${m2[1]}/server.js`, { type: 'file', content: Buffer.from('') })
      }
      if (cmd.startsWith('curl')) {
        fsState.set('/tmp-mock/bun-extract/bun-linux-x64/bun', {
          type: 'file',
          content: Buffer.from('b'),
        })
      }
      return ''
    }
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    // Source prisma packages exist in repo to be copied
    fsState.set('/repo/node_modules/prisma/package.json', {
      type: 'file',
      content: Buffer.from('{}'),
    })
    fsState.set('/repo/node_modules/@prisma/client/package.json', {
      type: 'file',
      content: Buffer.from('{}'),
    })
    pb.prepareVMBundle({ destDir: '/d', repoRoot: '/repo' })
    expect(cpSyncCalls.some((c) => c.src.includes('node_modules/prisma'))).toBe(true)
  })

  test('full mode: package.json already exists at dest → no rewrite', () => {
    primeBunInstallSideEffects()
    fsState.set('/d/package.json', { type: 'file', content: Buffer.from('{"name":"pre"}') })
    fsState.set('/d/node_modules/@prisma/internals', { type: 'dir' })
    fsState.set('/d/bun', { type: 'file', content: Buffer.from('') })
    fsState.set('/d/node_modules/typescript-language-server', { type: 'dir' })
    fsState.set('/d/templates/runtime-template/node_modules', { type: 'dir' })
    fsState.set('/d/templates/skill-server/package.json', {
      type: 'file',
      content: Buffer.from('{}'),
    })
    fsState.set('/d/templates/skill-server/node_modules', { type: 'dir' })
    pb.prepareVMBundle({ destDir: '/d', repoRoot: '/repo' })
    expect(fsState.get('/d/package.json')?.content?.toString()).toContain('pre')
  })

  test('full mode: tech-stacks source missing → not copied', () => {
    primeBunInstallSideEffects()
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    pb.prepareVMBundle({ destDir: '/d', repoRoot: '/repo' })
    expect(cpSyncCalls.some((c) => c.dest === '/d/tech-stacks')).toBe(false)
  })

  test('full mode: tech-stacks already at dest → skipped even if source exists', () => {
    primeBunInstallSideEffects()
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    fsState.set('/d/tech-stacks', { type: 'dir' })
    fsState.set('/repo/packages/agent-runtime/tech-stacks', { type: 'dir' })
    pb.prepareVMBundle({ destDir: '/d', repoRoot: '/repo' })
    expect(cpSyncCalls.some((c) => c.dest === '/d/tech-stacks')).toBe(false)
  })

  test('non-light mode: skips JS bundle build when output already exists', () => {
    primeBunInstallSideEffects()
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    fsState.set('/d/server.js', { type: 'file', content: Buffer.from('S') })
    fsState.set('/d/shogo.js', { type: 'file', content: Buffer.from('G') })
    pb.prepareVMBundle({ destDir: '/d', repoRoot: '/repo' })
    expect(execSyncCalls.some((c) => c.cmd.startsWith('bun build'))).toBe(false)
  })
})
