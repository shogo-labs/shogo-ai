// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The `custom` stack's static-build preview: what it runs, and a real build
 * through PreviewManager (initial build, rebuild on edit, base path).
 *
 *   bun test packages/agent-runtime/src/__tests__/static-build.test.ts
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveStaticBuildPlan, runStaticBuild, readStaticBuildConfig } from '../static-build'
import { PreviewManager } from '../preview-manager'

const dirs: string[] = []
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-static-build-'))
  dirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A build script that renders src/page.txt and the base path into dist/index.html. */
const BUILD_SCRIPT = [
  "const fs = require('fs')",
  "const out = process.argv[2] || 'dist'",
  'fs.mkdirSync(out, { recursive: true })',
  "fs.writeFileSync(out + '/index.html', '<p>' + fs.readFileSync('src/page.txt', 'utf8').trim() + '|' + process.env.SHOGO_BASE_PATH + '</p>')",
].join('\n')

describe('resolveStaticBuildPlan', () => {
  test('uses shogo.preview.json first, then the build script, else explains what is missing', () => {
    const configured = project({ 'shogo.preview.json': '{"build":"make site","outDir":"_site"}', 'package.json': '{"scripts":{"build":"x"}}' })
    expect(resolveStaticBuildPlan(configured, { stagingDir: 'dist.staging' })).toMatchObject({ kind: 'command', command: 'make site', outDir: '_site' })

    const scripted = project({ 'package.json': '{"scripts":{"build":"x"}}' })
    expect(resolveStaticBuildPlan(scripted, { stagingDir: 'dist.staging' })).toMatchObject({ kind: 'command', label: 'bun run build', outDir: 'dist' })

    const bare = project({ 'package.json': '{}' })
    expect((resolveStaticBuildPlan(bare, { stagingDir: 'dist.staging' }) as any).error).toContain('build')
  })

  test('builds Astro with its CLI straight into staging, with the base path', () => {
    const dir = project({ 'package.json': '{"dependencies":{"astro":"^6"}}', 'node_modules/.bin/astro': '#!/bin/sh\n' })
    const plan = resolveStaticBuildPlan(dir, { stagingDir: 'dist.staging', basePath: '/p/abc/' }) as any
    expect(plan.kind).toBe('astro')
    expect(plan.args.slice(-5)).toEqual(['build', '--outDir', 'dist.staging', '--base', '/p/abc/'])
  })

  test('rejects malformed config and output folders outside the project', () => {
    expect((readStaticBuildConfig(project({ 'shogo.preview.json': '{nope' })) as any).error).toContain('not valid JSON')
    expect((readStaticBuildConfig(project({ 'shogo.preview.json': '{"outDir":"../etc"}' })) as any).error).toContain('outDir')
    expect((readStaticBuildConfig(project({ 'shogo.preview.json': '{"outDir":"/tmp"}' })) as any).error).toContain('outDir')
  })
})

describe('runStaticBuild', () => {
  test('stages a command build from its output folder and passes the base path', async () => {
    const dir = project({
      'build.cjs': BUILD_SCRIPT,
      'src/page.txt': 'hello',
      'shogo.preview.json': '{"build":"bun build.cjs _site","outDir":"_site"}',
    })
    const plan = resolveStaticBuildPlan(dir, { stagingDir: 'dist.staging', basePath: '/p/x/' })
    const result = await runStaticBuild(dir, plan as any, { stagingDir: 'dist.staging', basePath: '/p/x/' })
    expect(result).toEqual({ ok: true })
    expect(readFileSync(join(dir, 'dist.staging/index.html'), 'utf8')).toBe('<p>hello|/p/x/</p>')
  })

  test('reports a failing build with its output, and a build that produced no page', async () => {
    const failing = project({ 'shogo.preview.json': '{"build":"echo broken >&2; exit 3"}' })
    const failed = await runStaticBuild(failing, resolveStaticBuildPlan(failing, { stagingDir: 's' }) as any, { stagingDir: 's' })
    expect(failed.ok).toBe(false)
    expect((failed as any).error).toContain('code 3')
    expect((failed as any).error).toContain('broken')

    const empty = project({ 'shogo.preview.json': '{"build":"true"}' })
    const nothing = await runStaticBuild(empty, resolveStaticBuildPlan(empty, { stagingDir: 's' }) as any, { stagingDir: 's' })
    expect((nothing as any).error).toContain('dist/index.html')
  })
})

async function waitFor(check: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('PreviewManager with the custom stack', () => {
  test('builds into dist/, rebuilds when a source file changes, and serves under the base path', async () => {
    const dir = project({
      '.tech-stack': 'custom',
      'build.cjs': BUILD_SCRIPT,
      'src/page.txt': 'first',
      'shogo.preview.json': '{"build":"bun build.cjs"}',
    })
    let builds = 0
    const pm = new PreviewManager({
      workspaceDir: dir,
      runtimePort: 0,
      basePath: '/p/proj-1/',
      onBuildComplete: () => void builds++,
    })
    try {
      const started = await pm.start()
      expect(started.mode).toBe('static-build (background)')
      const page = () => (existsSync(join(dir, 'dist/index.html')) ? readFileSync(join(dir, 'dist/index.html'), 'utf8') : '')
      await waitFor(() => page() === '<p>first|/p/proj-1/</p>')
      await waitFor(() => pm.getStatus().phase === 'ready')

      writeFileSync(join(dir, 'src/page.txt'), 'second')
      await waitFor(() => page() === '<p>second|/p/proj-1/</p>')
      await waitFor(() => builds >= 2, 5_000)
      expect(existsSync(join(dir, 'dist.staging'))).toBe(false)
    } finally {
      pm.stop()
    }
  }, 60_000)

  test('a broken build marks the preview failed, and fixing it recovers', async () => {
    const dir = project({
      '.tech-stack': 'custom',
      'build.cjs': BUILD_SCRIPT,
      'src/page.txt': 'ok',
      'shogo.preview.json': '{"build":"bun build.cjs"}',
    })
    writeFileSync(join(dir, 'shogo.preview.json'), '{"build":"exit 1"}')
    const pm = new PreviewManager({ workspaceDir: dir, runtimePort: 0 })
    try {
      await pm.start()
      await waitFor(() => pm.getStatus().phase === 'failed')
      writeFileSync(join(dir, 'shogo.preview.json'), '{"build":"bun build.cjs"}')
      await waitFor(() => pm.getStatus().phase === 'ready')
      expect(readFileSync(join(dir, 'dist/index.html'), 'utf8')).toBe('<p>ok|/</p>')
    } finally {
      pm.stop()
    }
  }, 60_000)

  test('an empty project builds once imported sources arrive, installing their dependencies', async () => {
    const dir = project({ '.tech-stack': 'custom' })
    const pm = new PreviewManager({ workspaceDir: dir, runtimePort: 0, basePath: '/p/proj-1/' })
    try {
      await pm.start()
      await waitFor(() => pm.getStatus().phase === 'failed')

      mkdirSync(join(dir, 'lib'), { recursive: true })
      writeFileSync(join(dir, 'lib/package.json'), '{"name":"page-lib","version":"1.0.0","main":"index.js"}')
      writeFileSync(join(dir, 'lib/index.js'), "module.exports = 'from-dep'")
      writeFileSync(
        join(dir, 'build.cjs'),
        "const fs = require('fs'); fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/index.html', require('page-lib'))",
      )
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'imported', dependencies: { 'page-lib': 'file:./lib' }, scripts: { build: 'node build.cjs' } }),
      )

      await waitFor(() => pm.getStatus().phase === 'ready', 90_000)
      expect(readFileSync(join(dir, 'dist/index.html'), 'utf8')).toBe('from-dep')
      expect(existsSync(join(dir, 'node_modules/page-lib'))).toBe(true)
    } finally {
      pm.stop()
    }
  }, 120_000)

  test('publish builds at the root path without touching the live preview', async () => {
    const dir = project({
      '.tech-stack': 'custom',
      'build.cjs': BUILD_SCRIPT,
      'src/page.txt': 'pub',
      'shogo.preview.json': '{"build":"bun build.cjs"}',
    })
    const pm = new PreviewManager({ workspaceDir: dir, runtimePort: 0, basePath: '/p/proj-1/' })
    expect(await pm.buildForPublish()).toEqual({ ok: true })
    expect(readFileSync(join(dir, 'dist.publish.staging/index.html'), 'utf8')).toBe('<p>pub|/</p>')
  })
})
