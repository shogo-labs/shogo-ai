// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for handing a warm pool VM's pre-seeded root app to the workspace
 * anchor: the pre-seed must move into `<root>/<anchor>/` with its pre-built
 * dist rebased to the anchor's preview path, never leave a project copy in
 * the root, and never touch workspace-level files or project folders.
 *
 * Run: bun test packages/agent-runtime/src/__tests__/workspace-pool-adopt.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  POOL_DIST_BASE_PLACEHOLDER,
  POOL_TEMPLATE_DIST_MARKER,
  adoptPoolPreseedIntoMember,
  discardPoolPreseed,
  discardPoolPreseedArtifacts,
  listRootEntries,
  poolDistDir,
  readPoolPreseedManifest,
  rebaseDistAssets,
  removePoolTemplateDist,
  writePoolPreseedManifest,
} from '../workspace-pool-adopt'

const ANCHOR = '5a29ddda-1111-4222-8333-944445555666'
const OTHER = 'aaa380cf-5797-49fe-805f-81ba4aa48845'

let tmp: string
let root: string
let templateDir: string
let savedTemplateEnv: string | undefined

function write(path: string, content = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

/** Lay down what an unassigned pool VM leaves in WORKSPACE_DIR. */
function preseedRoot(opts: { dist?: boolean } = {}): string[] {
  const before = listRootEntries(root)
  write(join(root, 'AGENTS.md'), 'workspace agents')
  write(join(root, 'config.json'), '{}')
  mkdirSync(join(root, 'memory'), { recursive: true })
  write(join(root, 'package.json'), '{"name":"app"}')
  write(join(root, 'index.html'), '<div id="root"></div>')
  write(join(root, 'src', 'App.tsx'), 'export default () => "Project Ready"')
  write(join(root, 'src', 'generated', 'prisma', 'index.ts'), 'client')
  write(join(root, 'prisma', 'dev.db'), 'sqlite')
  write(join(root, 'server.tsx'), 'server')
  write(join(root, '.tech-stack'), 'react-app')
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
  write(join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'vite')
  symlinkSync('../vite/bin/vite.js', join(root, 'node_modules', '.bin', 'vite'))
  write(join(root, '.shogo', 'install-marker'), 'sha')
  if (opts.dist) {
    const dist = poolDistDir(root)
    write(
      join(dist, 'index.html'),
      `<script type="module" src="${POOL_DIST_BASE_PLACEHOLDER}assets/index.js"></script>`,
    )
    write(join(dist, 'assets', 'index.js'), `const base = "${POOL_DIST_BASE_PLACEHOLDER}";`)
    write(join(dist, 'assets', 'index.css'), `a{background:url(${POOL_DIST_BASE_PLACEHOLDER}assets/bg.png)}`)
    write(join(dist, 'assets', 'bg.png'), POOL_DIST_BASE_PLACEHOLDER)
  }
  return before
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pool-adopt-'))
  root = join(tmp, 'workspace')
  mkdirSync(root)
  templateDir = join(tmp, 'runtime-template')
  write(join(templateDir, 'package.json'), '{"name":"template"}')
  write(join(templateDir, 'AGENTS.md'), 'template agents')
  savedTemplateEnv = process.env.RUNTIME_TEMPLATE_DIR
  process.env.RUNTIME_TEMPLATE_DIR = templateDir
})

afterEach(() => {
  if (savedTemplateEnv === undefined) delete process.env.RUNTIME_TEMPLATE_DIR
  else process.env.RUNTIME_TEMPLATE_DIR = savedTemplateEnv
  rmSync(tmp, { recursive: true, force: true })
})

describe('writePoolPreseedManifest', () => {
  test('records only project entries the pre-seed created', () => {
    write(join(root, 'preexisting.txt'))
    const before = preseedRoot({ dist: true })
    const manifest = writePoolPreseedManifest(root, { entriesBefore: before, techStackId: 'react-app', distBuilt: true })
    expect([...manifest.entries].sort()).toEqual(
      ['.tech-stack', 'index.html', 'node_modules', 'package.json', 'prisma', 'server.tsx', 'src'].sort(),
    )
    expect(manifest.distBuilt).toBe(true)
    expect(readPoolPreseedManifest(root)).toEqual(manifest)
  })

  test('never records project folders or excluded mounts', () => {
    const before = preseedRoot()
    mkdirSync(join(root, OTHER))
    mkdirSync(join(root, 'linked-folder'))
    const manifest = writePoolPreseedManifest(root, {
      entriesBefore: before,
      techStackId: 'react-app',
      distBuilt: false,
      exclude: ['linked-folder'],
    })
    expect(manifest.entries).not.toContain(OTHER)
    expect(manifest.entries).not.toContain('linked-folder')
  })

  test('distBuilt is false when no build landed', () => {
    const manifest = writePoolPreseedManifest(root, { entriesBefore: preseedRoot(), techStackId: null, distBuilt: true })
    expect(manifest.distBuilt).toBe(false)
  })

  test('a tampered manifest cannot name paths outside the root', () => {
    write(join(root, '.shogo', 'pool-preseed.json'), JSON.stringify({ entries: ['../etc', 'a/b', OTHER, 'src'] }))
    expect(readPoolPreseedManifest(root)?.entries).toEqual(['src'])
  })
})

describe('adoptPoolPreseedIntoMember', () => {
  test('moves the pre-seed into the anchor and serves the rebased dist', () => {
    const before = preseedRoot({ dist: true })
    writePoolPreseedManifest(root, { entriesBefore: before, techStackId: 'react-app', distBuilt: true })
    const anchor = join(root, ANCHOR)

    const result = adoptPoolPreseedIntoMember(root, anchor, { basePath: `/p/${ANCHOR}/` })

    expect(result).toMatchObject({ adopted: true, distReady: true })
    for (const entry of ['package.json', 'index.html', 'src/App.tsx', 'src/generated/prisma/index.ts', 'prisma/dev.db', 'server.tsx', '.tech-stack']) {
      expect(existsSync(join(anchor, entry))).toBe(true)
      expect(existsSync(join(root, entry))).toBe(false)
    }
    expect(readlinkSync(join(anchor, 'node_modules', '.bin', 'vite'))).toBe('../vite/bin/vite.js')
    expect(existsSync(join(root, 'node_modules'))).toBe(false)

    // Workspace-level files stay at the root; the anchor gets the template's own AGENTS.md.
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toBe('workspace agents')
    expect(existsSync(join(root, 'memory'))).toBe(true)
    expect(existsSync(join(root, 'config.json'))).toBe(true)
    expect(readFileSync(join(anchor, 'AGENTS.md'), 'utf-8')).toBe('template agents')
    expect(readFileSync(join(anchor, '.shogo', 'install-marker'), 'utf-8')).toBe('sha')

    const html = readFileSync(join(anchor, 'dist', 'index.html'), 'utf-8')
    expect(html).toContain(`src="/p/${ANCHOR}/assets/index.js"`)
    expect(html).not.toContain(POOL_DIST_BASE_PLACEHOLDER)
    expect(readFileSync(join(anchor, 'dist', 'assets', 'index.js'), 'utf-8')).toContain(`"/p/${ANCHOR}/"`)
    expect(readFileSync(join(anchor, 'dist', 'assets', 'index.css'), 'utf-8')).toContain(`url(/p/${ANCHOR}/assets/bg.png)`)
    expect(readFileSync(join(anchor, 'dist', 'assets', 'bg.png'), 'utf-8')).toBe(POOL_DIST_BASE_PLACEHOLDER)
    expect(existsSync(join(anchor, 'dist', POOL_TEMPLATE_DIST_MARKER))).toBe(true)

    expect(readPoolPreseedManifest(root)).toBeNull()
    expect(existsSync(poolDistDir(root))).toBe(false)
  })

  test('adopts without a dist when the pool did not build one', () => {
    writePoolPreseedManifest(root, { entriesBefore: preseedRoot(), techStackId: 'react-app', distBuilt: false })
    const result = adoptPoolPreseedIntoMember(root, join(root, ANCHOR), { basePath: `/p/${ANCHOR}/` })
    expect(result).toMatchObject({ adopted: true, distReady: false })
    expect(existsSync(join(root, ANCHOR, 'dist'))).toBe(false)
  })

  test('refuses a member that already has source', () => {
    writePoolPreseedManifest(root, { entriesBefore: preseedRoot(), techStackId: 'react-app', distBuilt: false })
    write(join(root, ANCHOR, 'src', 'Real.tsx'), 'real')
    expect(adoptPoolPreseedIntoMember(root, join(root, ANCHOR), { basePath: '/p/x/' })).toEqual({
      adopted: false,
      reason: 'member-has-source',
    })
    expect(existsSync(join(root, 'package.json'))).toBe(true)
  })

  test('refuses a different tech stack but accepts an unset one', () => {
    writePoolPreseedManifest(root, { entriesBefore: preseedRoot(), techStackId: 'react-app', distBuilt: false })
    expect(
      adoptPoolPreseedIntoMember(root, join(root, ANCHOR), { basePath: '/p/x/', techStackId: 'expo-app' }),
    ).toEqual({ adopted: false, reason: 'stack-mismatch' })
    expect(adoptPoolPreseedIntoMember(root, join(root, ANCHOR), { basePath: '/p/x/' }).adopted).toBe(true)
  })

  test('no manifest means no adoption', () => {
    preseedRoot()
    expect(adoptPoolPreseedIntoMember(root, join(root, ANCHOR), { basePath: '/p/x/' })).toEqual({
      adopted: false,
      reason: 'no-manifest',
    })
  })
})

describe('discardPoolPreseed', () => {
  test('removes the root app but keeps workspace files and project folders', () => {
    const before = preseedRoot({ dist: true })
    writePoolPreseedManifest(root, { entriesBefore: before, techStackId: 'react-app', distBuilt: true })
    write(join(root, OTHER, 'package.json'), '{}')

    const removed = discardPoolPreseed(root)

    expect(removed).toContain('src')
    expect(removed).toContain('node_modules')
    for (const entry of ['package.json', 'src', 'node_modules', 'prisma', 'server.tsx', 'index.html']) {
      expect(existsSync(join(root, entry))).toBe(false)
    }
    for (const entry of ['AGENTS.md', 'config.json', 'memory', '.shogo', `${OTHER}/package.json`]) {
      expect(existsSync(join(root, entry))).toBe(true)
    }
    expect(readPoolPreseedManifest(root)).toBeNull()
    expect(existsSync(poolDistDir(root))).toBe(false)
  })

  test('is a no-op without a manifest', () => {
    preseedRoot()
    expect(discardPoolPreseed(root)).toEqual([])
    expect(existsSync(join(root, 'package.json'))).toBe(true)
  })

  test('discardPoolPreseedArtifacts keeps the root app for single-project runtimes', () => {
    const before = preseedRoot({ dist: true })
    writePoolPreseedManifest(root, { entriesBefore: before, techStackId: 'react-app', distBuilt: true })
    discardPoolPreseedArtifacts(root)
    expect(existsSync(join(root, 'package.json'))).toBe(true)
    expect(existsSync(poolDistDir(root))).toBe(false)
    expect(readPoolPreseedManifest(root)).toBeNull()
  })
})

describe('removePoolTemplateDist', () => {
  function adoptWithDist(): string {
    writePoolPreseedManifest(root, { entriesBefore: preseedRoot({ dist: true }), techStackId: 'react-app', distBuilt: true })
    const anchor = join(root, ANCHOR)
    adoptPoolPreseedIntoMember(root, anchor, { basePath: `/p/${ANCHOR}/` })
    return anchor
  }

  test('drops an untouched template dist', () => {
    const anchor = adoptWithDist()
    expect(removePoolTemplateDist(anchor)).toBe(true)
    expect(existsSync(join(anchor, 'dist'))).toBe(false)
  })

  test('keeps a dist that a real build already replaced', () => {
    const anchor = adoptWithDist()
    writeFileSync(join(anchor, 'dist', 'index.html'), '<html>real app</html>')
    expect(removePoolTemplateDist(anchor)).toBe(false)
    expect(readFileSync(join(anchor, 'dist', 'index.html'), 'utf-8')).toBe('<html>real app</html>')
    expect(existsSync(join(anchor, 'dist', POOL_TEMPLATE_DIST_MARKER))).toBe(false)
  })

  test('ignores a dist without the marker', () => {
    write(join(root, ANCHOR, 'dist', 'index.html'), 'restored')
    expect(removePoolTemplateDist(join(root, ANCHOR))).toBe(false)
    expect(existsSync(join(root, ANCHOR, 'dist', 'index.html'))).toBe(true)
  })
})

describe('rebaseDistAssets', () => {
  test('rewrites nested text assets only', () => {
    const dir = join(tmp, 'dist')
    write(join(dir, 'a', 'b', 'chunk.mjs'), 'import("/old/x.js")')
    write(join(dir, 'font.woff2'), '/old/')
    expect(rebaseDistAssets(dir, '/old/', '/new/')).toBe(1)
    expect(readFileSync(join(dir, 'a', 'b', 'chunk.mjs'), 'utf-8')).toBe('import("/new/x.js")')
    expect(readFileSync(join(dir, 'font.woff2'), 'utf-8')).toBe('/old/')
  })
})
