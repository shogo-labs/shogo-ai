import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { cloneTree } from '../clone-tree'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clone-tree-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function seed(): string {
  const src = join(root, 'src')
  mkdirSync(join(src, 'pkg', 'lib'), { recursive: true })
  mkdirSync(join(src, 'empty'))
  writeFileSync(join(src, 'pkg', 'package.json'), '{"name":"pkg"}')
  writeFileSync(join(src, 'pkg', 'lib', 'index.js'), 'module.exports = 1')
  writeFileSync(join(src, '.install-ok'), 'ok')
  return src
}

describe('cloneTree', () => {
  test('reproduces the tree and links regular files', async () => {
    const src = seed()
    const dst = join(root, 'dst')
    const result = await cloneTree(src, dst)

    expect(result.files).toBe(3)
    expect(result.dirs).toBe(4)
    expect(existsSync(join(dst, 'empty'))).toBe(true)
    expect(readFileSync(join(dst, 'pkg', 'lib', 'index.js'), 'utf8')).toBe('module.exports = 1')
    expect(readFileSync(join(dst, '.install-ok'), 'utf8')).toBe('ok')
    if (result.mode === 'link') {
      expect(statSync(join(dst, 'pkg', 'package.json')).nlink).toBe(2)
    }
  })

  test('copy mode produces independent files', async () => {
    const src = seed()
    const dst = join(root, 'dst')
    const result = await cloneTree(src, dst, { mode: 'copy' })

    expect(result.mode).toBe('copy')
    expect(statSync(join(dst, 'pkg', 'package.json')).nlink).toBe(1)
    writeFileSync(join(dst, 'pkg', 'package.json'), 'changed')
    expect(readFileSync(join(src, 'pkg', 'package.json'), 'utf8')).toBe('{"name":"pkg"}')
  })

  test('a replaced file in one clone does not affect the source', async () => {
    const src = seed()
    const dst = join(root, 'dst')
    await cloneTree(src, dst)
    // Package managers unlink and rewrite rather than truncate in place.
    rmSync(join(dst, 'pkg', 'lib', 'index.js'))
    writeFileSync(join(dst, 'pkg', 'lib', 'index.js'), 'module.exports = 2')
    expect(readFileSync(join(src, 'pkg', 'lib', 'index.js'), 'utf8')).toBe('module.exports = 1')
  })

  test('recreates symlinks instead of following them', async () => {
    const src = seed()
    let linked = false
    try {
      symlinkSync(join('..', 'lib', 'index.js'), join(src, 'pkg', 'bin-link'))
      linked = true
    } catch {
      // Symlink creation needs privileges on some Windows setups.
    }
    if (!linked) return
    const dst = join(root, 'dst')
    const result = await cloneTree(src, dst)
    expect(result.symlinks).toBe(1)
    expect(readFileSync(join(dst, 'pkg', 'bin-link'), 'utf8')).toBe('module.exports = 1')
  })

  test('refuses to clone onto an existing destination', async () => {
    const src = seed()
    const dst = join(root, 'dst')
    mkdirSync(dst)
    await expect(cloneTree(src, dst)).rejects.toThrow()
  })
})
