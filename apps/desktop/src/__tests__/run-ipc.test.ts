// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { promises as fs } from 'fs'
import { tmpdir, homedir } from 'os'
import * as path from 'path'
import { detectPackageManager, validateWorkspace, parsePackageJsonScripts } from '../run-ipc-pure'

describe('validateWorkspace', () => {
  it('rejects empty / non-string', () => {
    expect(validateWorkspace('')).toBe(null)
    expect(validateWorkspace(null as unknown as string)).toBe(null)
    expect(validateWorkspace(undefined as unknown as string)).toBe(null)
    expect(validateWorkspace(42 as unknown as string)).toBe(null)
  })
  it('rejects paths outside $HOME', () => {
    expect(validateWorkspace('/etc')).toBe(null)
    expect(validateWorkspace('/tmp/elsewhere')).toBe(null)
    expect(validateWorkspace('/usr/local')).toBe(null)
  })
  it('rejects path-traversal attempts', () => {
    expect(validateWorkspace(`${homedir()}/../etc`)).toBe(null)
    expect(validateWorkspace(`${homedir()}/../..`)).toBe(null)
  })
  it('accepts $HOME and descendants', () => {
    expect(validateWorkspace(homedir())).toBe(homedir())
    expect(validateWorkspace(`${homedir()}/Desktop`)).toBe(`${homedir()}/Desktop`)
    expect(validateWorkspace(`${homedir()}/x/y/z`)).toBe(`${homedir()}/x/y/z`)
  })
})

describe('detectPackageManager', () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'shogo-run-ipc-test-'))
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function cleanup() {
    for (const f of ['bun.lockb', 'bun.lock', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']) {
      await fs.rm(path.join(dir, f), { force: true })
    }
  }

  it('detects bun via bun.lockb', async () => {
    await cleanup()
    await fs.writeFile(path.join(dir, 'bun.lockb'), '')
    expect(await detectPackageManager(dir)).toBe('bun')
  })
  it('detects bun via bun.lock (text)', async () => {
    await cleanup()
    await fs.writeFile(path.join(dir, 'bun.lock'), '')
    expect(await detectPackageManager(dir)).toBe('bun')
  })
  it('detects pnpm', async () => {
    await cleanup()
    await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), '')
    expect(await detectPackageManager(dir)).toBe('pnpm')
  })
  it('detects yarn', async () => {
    await cleanup()
    await fs.writeFile(path.join(dir, 'yarn.lock'), '')
    expect(await detectPackageManager(dir)).toBe('yarn')
  })
  it('detects npm', async () => {
    await cleanup()
    await fs.writeFile(path.join(dir, 'package-lock.json'), '')
    expect(await detectPackageManager(dir)).toBe('npm')
  })
  it('falls back to npm when no lockfile present', async () => {
    await cleanup()
    expect(await detectPackageManager(dir)).toBe('npm')
  })
  it('respects precedence: bun > pnpm > yarn > npm', async () => {
    await cleanup()
    await fs.writeFile(path.join(dir, 'package-lock.json'), '')
    await fs.writeFile(path.join(dir, 'yarn.lock'), '')
    await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), '')
    await fs.writeFile(path.join(dir, 'bun.lockb'), '')
    expect(await detectPackageManager(dir)).toBe('bun')
    await fs.rm(path.join(dir, 'bun.lockb'))
    expect(await detectPackageManager(dir)).toBe('pnpm')
    await fs.rm(path.join(dir, 'pnpm-lock.yaml'))
    expect(await detectPackageManager(dir)).toBe('yarn')
    await fs.rm(path.join(dir, 'yarn.lock'))
    expect(await detectPackageManager(dir)).toBe('npm')
  })
})

describe('parsePackageJsonScripts', () => {
  it('returns empty list when scripts field is missing', () => {
    const r = parsePackageJsonScripts(JSON.stringify({ name: 'x', version: '1.0.0' }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.scripts).toEqual([])
  })
  it('parses a normal scripts block', () => {
    const r = parsePackageJsonScripts(JSON.stringify({
      scripts: { dev: 'vite', test: 'bun test', build: 'tsc -b' },
    }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.scripts).toHaveLength(3)
      expect(r.scripts.find(s => s.name === 'dev')?.command).toBe('vite')
      expect(r.scripts.find(s => s.name === 'test')?.command).toBe('bun test')
    }
  })
  it('returns error on malformed JSON', () => {
    const r = parsePackageJsonScripts('{not json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/parse error/)
  })
  it('returns error when root is not an object', () => {
    const r = parsePackageJsonScripts(JSON.stringify("hello"))
    expect(r.ok).toBe(false)
  })
  it('returns error when scripts is not an object', () => {
    const r = parsePackageJsonScripts(JSON.stringify({ scripts: ['dev', 'test'] }))
    expect(r.ok).toBe(false)
    const r2 = parsePackageJsonScripts(JSON.stringify({ scripts: 'vite' }))
    expect(r2.ok).toBe(false)
    const r3 = parsePackageJsonScripts(JSON.stringify({ scripts: null }))
    expect(r3.ok).toBe(false)
  })
  it('skips entries whose value is not a string', () => {
    const r = parsePackageJsonScripts(JSON.stringify({
      scripts: { dev: 'vite', bad: 42, nested: { x: 1 }, ok2: 'lint' },
    }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.scripts.map(s => s.name).sort()).toEqual(['dev', 'ok2'])
    }
  })
  it('handles an empty scripts object', () => {
    const r = parsePackageJsonScripts(JSON.stringify({ scripts: {} }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.scripts).toEqual([])
  })
  it('handles deeply realistic package.json', () => {
    const real = {
      name: 'shogo-ai',
      version: '0.1.0',
      private: true,
      workspaces: ['apps/*', 'packages/*'],
      scripts: {
        dev: 'bun run dev',
        build: 'bun run build',
        test: 'bun test',
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
      },
      dependencies: { react: '19.0.0' },
    }
    const r = parsePackageJsonScripts(JSON.stringify(real))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.scripts).toHaveLength(5)
  })
})
