// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `applyTechStackChange()` — the one implementation behind
 * `project_configure`'s `techStackId`/`resetFiles` and
 * `POST /agent/workspace/reset-stack`.
 *
 *   bun test packages/agent-runtime/src/__tests__/tech-stack-switch.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  applyTechStackChange,
  planTechStackChange,
  setTechStackPreviewRestarter,
  syncTechStackEnv,
  type PreviewRestartRequest,
} from '../tech-stack-switch'
import { refreshTechStackMarker } from '../workspace-defaults'

const dirs: string[] = []
let restarts: PreviewRestartRequest[] = []
const savedEnv = {
  TECH_STACK_ID: process.env.TECH_STACK_ID,
  WORKSPACE_TECH_STACKS: process.env.WORKSPACE_TECH_STACKS,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
}

/** A react-app-ish project: the files a Vite starter owns. */
function reactProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-stack-switch-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'App.tsx'), 'export const App = () => null\n')
  writeFileSync(join(dir, 'vite.config.ts'), 'export default {}\n')
  writeFileSync(join(dir, 'index.html'), '<div id="root"></div>\n')
  writeFileSync(join(dir, 'package.json'), '{"name":"p","scripts":{"build":"vite build"}}')
  writeFileSync(join(dir, '.tech-stack'), 'react-app')
  mkdirSync(join(dir, '.shogo'), { recursive: true })
  writeFileSync(join(dir, '.shogo', 'AGENTS.md'), '# agent identity\n')
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'memory', 'notes.md'), 'a remembered fact\n')
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return dir
}

beforeEach(() => {
  restarts = []
  setTechStackPreviewRestarter((req) => void restarts.push(req))
})

afterEach(() => {
  setTechStackPreviewRestarter(null)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  process.env.TECH_STACK_ID = savedEnv.TECH_STACK_ID
  process.env.WORKSPACE_TECH_STACKS = savedEnv.WORKSPACE_TECH_STACKS
  process.env.WORKSPACE_DIR = savedEnv.WORKSPACE_DIR
})

/** A directory with nothing in it yet. */
function emptyProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-stack-empty-'))
  dirs.push(dir)
  return dir
}

/** A real video-editor project: its own starter, marker and STACK.md. */
function videoProject(): string {
  const dir = emptyProject()
  writeFileSync(join(dir, '.tech-stack'), 'video-editor')
  const seeded = applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'video-editor', scope: 'root' })
  expect(seeded.ok).toBe(true)
  writeFileSync(join(dir, '.shogo', 'AGENTS.md'), '# video agent identity\n')
  return dir
}

/** Every file under `dir` with its bytes — proof that a refusal wrote nothing. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(child)
      else out[child] = readFileSync(join(dir, child), 'utf-8')
    }
  }
  walk('')
  return out
}

describe('planTechStackChange', () => {
  test('collides with the files a switch would half-overwrite', () => {
    const plan = planTechStackChange({ projectDir: reactProject(), stackId: 'video-editor' })

    expect(plan.from).toBe('react-app')
    expect(plan.to).toBe('video-editor')
    expect(plan.needsReset).toBe(true)
    expect(plan.collisions).toEqual(['index.html', 'package.json', 'src', 'vite.config.ts'])
    expect(plan.leftInPlace).toEqual([])
  })

  test('is pure — it writes nothing', () => {
    const dir = reactProject()
    const before = snapshot(dir)

    planTechStackChange({ projectDir: dir, stackId: 'video-editor' })

    expect(snapshot(dir)).toEqual(before)
  })

  test('a starter-less target counts the runtime-template files', () => {
    const plan = planTechStackChange({ projectDir: videoProject(), stackId: 'react-app' })

    // react-app has no starter/ of its own — these come from the runtime-template.
    expect(plan.collisions).toContain('package.json')
    expect(plan.collisions).toContain('index.html')
    expect(plan.collisions).toContain('src')
    // Files the target stack does not write are not collisions.
    expect(plan.collisions).not.toContain('remotion.config.ts')
    expect(plan.collisions).not.toContain('README.md')
  })

  test('an empty project has nothing to collide with and nothing left in place', () => {
    const plan = planTechStackChange({ projectDir: emptyProject(), stackId: 'react-app' })

    expect(plan).toMatchObject({
      from: '',
      to: 'react-app',
      collisions: [],
      needsReset: false,
      leftInPlace: [],
    })
  })

  test('lists what the new stack does not write as leftInPlace', () => {
    const dir = videoProject()
    writeFileSync(join(dir, 'NOTES.md'), 'ours\n')

    const plan = planTechStackChange({ projectDir: dir, stackId: 'custom' })

    expect(plan.needsReset).toBe(false)
    expect(plan.collisions).toEqual([])
    expect(plan.leftInPlace).toContain('NOTES.md')
    expect(plan.leftInPlace).toContain('src')
    // Runtime-owned entries are neither.
    expect(plan.leftInPlace).not.toContain('.shogo')
    expect(plan.leftInPlace).not.toContain('memory')
  })

  test('resetFiles is what clears needsReset', () => {
    const plan = planTechStackChange({ projectDir: reactProject(), stackId: 'video-editor', resetFiles: true })

    expect(plan.needsReset).toBe(false)
    expect(plan.leftInPlace).toEqual([])
  })
})

describe('applyTechStackChange (a colliding switch is refused)', () => {
  test('returns stack_change_needs_reset and writes nothing at all', () => {
    const dir = videoProject()
    const before = snapshot(dir)

    const result = applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'react-app', scope: 'root' })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('stack_change_needs_reset')
    expect(result.collisions).toContain('package.json')
    expect(result.collisions).toContain('index.html')
    expect(result.collisions).toContain('src')
    expect(result.hint).toContain('resetFiles: true')

    // Byte-identical: no marker move, no doc swap, no seed, no package.json edit.
    expect(snapshot(dir)).toEqual(before)
    expect(readFileSync(join(dir, '.tech-stack'), 'utf-8').trim()).toBe('video-editor')
    expect(readFileSync(join(dir, '.shogo', 'STACK.md'), 'utf-8')).toContain('Video Editor')
    expect(readFileSync(join(dir, 'package.json'), 'utf-8')).not.toContain('@shogo-ai/sdk')
    expect(existsSync(join(dir, 'prisma'))).toBe(false)
    expect(existsSync(join(dir, 'scripts', 'generate.ts'))).toBe(false)
  })

  test('leaves the env, the preview and .shogo/ untouched', () => {
    const dir = reactProject()
    process.env.WORKSPACE_TECH_STACKS = JSON.stringify({ 'p-1': 'react-app' })
    const shogoBefore = snapshot(join(dir, '.shogo'))

    const result = applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'video-editor', scope: 'member' })

    expect(result.ok).toBe(false)
    expect(result.envUpdated).toBe(false)
    expect(result.previewRestarted).toBe(false)
    expect(restarts).toHaveLength(0)
    expect(JSON.parse(process.env.WORKSPACE_TECH_STACKS!)).toEqual({ 'p-1': 'react-app' })
    expect(snapshot(join(dir, '.shogo'))).toEqual(shogoBefore)
  })
})

describe('applyTechStackChange (clean seed)', () => {
  test('seeds an empty project, swaps the doc and reports nothing left in place', () => {
    const dir = emptyProject()

    const result = applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'video-editor', scope: 'root' })

    expect(result.ok).toBe(true)
    expect(result.seeded).toBe(true)
    expect(result.collisions).toEqual([])
    expect(result.leftInPlace).toEqual([])
    expect(result.stackDocUpdated).toBe(true)
    expect(readFileSync(join(dir, '.tech-stack'), 'utf-8').trim()).toBe('video-editor')
    expect(readFileSync(join(dir, '.shogo', 'STACK.md'), 'utf-8')).toContain('Video Editor')
  })

  test('restarts the preview exactly once', () => {
    const dir = emptyProject()

    applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'video-editor', scope: 'root' })

    expect(restarts).toHaveLength(1)
    expect(restarts[0]).toMatchObject({ projectDir: dir, projectId: 'p-1', stackId: 'video-editor', scope: 'root' })
  })

  test('a stack that ships no files applies without touching the project code', () => {
    const dir = videoProject()

    const result = applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'custom', scope: 'root' })

    expect(result.ok).toBe(true)
    expect(result.collisions).toEqual([])
    expect(result.leftInPlace).toContain('src')
    expect(existsSync(join(dir, 'src', 'videos', 'Main.tsx'))).toBe(true)
    expect(readFileSync(join(dir, '.shogo', 'STACK.md'), 'utf-8')).toContain('Tech Stack — Custom')
  })
})

describe('applyTechStackChange (resetFiles)', () => {
  test('replaces the project code but keeps identity, memory and git', () => {
    const dir = reactProject()

    const result = applyTechStackChange({
      projectDir: dir,
      projectId: 'p-1',
      stackId: 'video-editor',
      scope: 'root',
      resetFiles: true,
    })

    expect(result.ok).toBe(true)
    expect(result.wiped).toBeGreaterThan(0)
    expect(result.leftInPlace).toEqual([])
    // Old stack's code is gone, new stack's is there.
    expect(existsSync(join(dir, 'src', 'App.tsx'))).toBe(false)
    expect(readFileSync(join(dir, 'src', 'videos', 'Main.tsx'), 'utf-8')).toContain('export const Main')
    expect(existsSync(join(dir, 'remotion.config.ts'))).toBe(true)
    // Preserved by WIPE_PRESERVE_TOP_LEVEL.
    expect(readFileSync(join(dir, '.shogo', 'AGENTS.md'), 'utf-8')).toBe('# agent identity\n')
    expect(readFileSync(join(dir, 'memory', 'notes.md'), 'utf-8')).toBe('a remembered fact\n')
    expect(readFileSync(join(dir, '.git', 'HEAD'), 'utf-8')).toBe('ref: refs/heads/main\n')
  })

  test('resetFiles alone re-seeds the current stack', () => {
    const dir = reactProject()
    writeFileSync(join(dir, 'src', 'App.tsx'), 'broken\n')

    const result = applyTechStackChange({
      projectDir: dir,
      projectId: 'p-1',
      stackId: 'video-editor',
      scope: 'root',
      resetFiles: true,
    })

    expect(result.ok).toBe(true)
    expect(existsSync(join(dir, 'src', 'App.tsx'))).toBe(false)
  })
})

describe('applyTechStackChange (stack doc)', () => {
  test('resetFiles replaces it — .shogo/ survives the wipe, so nothing else would', () => {
    const dir = videoProject()
    expect(readFileSync(join(dir, '.shogo', 'STACK.md'), 'utf-8')).toContain('Video Editor')

    const result = applyTechStackChange({
      projectDir: dir,
      projectId: 'p-1',
      stackId: 'react-app',
      scope: 'root',
      resetFiles: true,
    })

    expect(result.ok).toBe(true)
    expect(result.wiped).toBeGreaterThan(0)
    expect(result.stackDocUpdated).toBe(true)
    expect(existsSync(join(dir, 'src', 'videos', 'Main.tsx'))).toBe(false)
    const doc = readFileSync(join(dir, '.shogo', 'STACK.md'), 'utf-8')
    expect(doc).toContain('# Tech Stack — React App')
    expect(doc).not.toContain('Video Editor')
    expect(readFileSync(join(dir, '.shogo', 'AGENTS.md'), 'utf-8')).toBe('# video agent identity\n')
  })

  test('re-seeding the same stack leaves a hand-edited STACK.md alone', () => {
    const dir = videoProject()
    writeFileSync(join(dir, '.shogo', 'STACK.md'), '# our own notes\n')

    applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'video-editor', scope: 'root', resetFiles: true })

    expect(readFileSync(join(dir, '.shogo', 'STACK.md'), 'utf-8')).toBe('# our own notes\n')
  })
})

describe('applyTechStackChange (validation)', () => {
  test('an unknown stack changes nothing', () => {
    const dir = reactProject()

    const result = applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'not-a-stack', scope: 'root' })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('unknown_stack')
    expect(result.error).toContain('Unknown tech stack')
    expect(readFileSync(join(dir, '.tech-stack'), 'utf-8').trim()).toBe('react-app')
    expect(restarts).toHaveLength(0)
  })

  test('a folder that is not there is a failure, not a seed', () => {
    const result = applyTechStackChange({
      projectDir: join(tmpdir(), 'shogo-does-not-exist-4f2a'),
      projectId: 'p-1',
      stackId: 'react-app',
      scope: 'root',
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('missing_folder')
  })
})

describe('the GitHub import path is not gated by the refusal rule', () => {
  test('an imported repo still re-stamps its marker and restarts its preview', () => {
    // The import path adopts a repo's own files: it calls
    // refreshTechStackMarker() + restartPreviewForStack() directly and never
    // routes through applyTechStackChange(), so colliding files there are
    // expected and must not refuse.
    const dir = mkdtempSync(join(tmpdir(), 'shogo-stack-import-'))
    dirs.push(dir)
    writeFileSync(join(dir, '.tech-stack'), 'react-app')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'site', dependencies: { astro: '^4.0.0' } }))
    writeFileSync(join(dir, 'astro.config.mjs'), 'export default {}\n')

    const stamp = refreshTechStackMarker(dir)

    expect(stamp).toEqual({ techStackId: 'custom', changed: true })
    expect(readFileSync(join(dir, '.tech-stack'), 'utf-8').trim()).toBe('custom')
    expect(existsSync(join(dir, 'astro.config.mjs'))).toBe(true)
  })
})

describe('syncTechStackEnv', () => {
  test('root: moves TECH_STACK_ID to the new stack', () => {
    process.env.TECH_STACK_ID = 'react-app'
    expect(syncTechStackEnv('p-1', 'video-editor', 'root')).toBe(true)
    expect(process.env.TECH_STACK_ID).toBe('video-editor')
    // Idempotent.
    expect(syncTechStackEnv('p-1', 'video-editor', 'root')).toBe(false)
  })

  test('root without TECH_STACK_ID leaves it unset (desktop resolves from the marker)', () => {
    delete process.env.TECH_STACK_ID
    expect(syncTechStackEnv('p-1', 'video-editor', 'root')).toBe(false)
    expect(process.env.TECH_STACK_ID).toBeUndefined()
  })

  test('member: updates only that project in WORKSPACE_TECH_STACKS', () => {
    process.env.WORKSPACE_TECH_STACKS = JSON.stringify({ 'p-1': 'react-app', 'p-2': 'python-data' })
    expect(syncTechStackEnv('p-1', 'video-editor', 'member')).toBe(true)
    expect(JSON.parse(process.env.WORKSPACE_TECH_STACKS!)).toEqual({
      'p-1': 'video-editor',
      'p-2': 'python-data',
    })
  })

  test('member: survives a malformed map', () => {
    process.env.WORKSPACE_TECH_STACKS = 'not json'
    expect(syncTechStackEnv('p-1', 'video-editor', 'member')).toBe(true)
    expect(JSON.parse(process.env.WORKSPACE_TECH_STACKS!)).toEqual({ 'p-1': 'video-editor' })
  })

  test('applyTechStackChange updates the env for the project it changed', () => {
    const dir = emptyProject()
    process.env.WORKSPACE_TECH_STACKS = JSON.stringify({ 'p-1': 'react-app' })

    const result = applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'video-editor', scope: 'member' })

    expect(result.envUpdated).toBe(true)
    expect(JSON.parse(process.env.WORKSPACE_TECH_STACKS!)).toEqual({ 'p-1': 'video-editor' })
  })
})

describe('applyTechStackChange without a registered preview restarter', () => {
  test('still seeds and reports previewRestarted: false', () => {
    setTechStackPreviewRestarter(null)
    const dir = emptyProject()
    const result = applyTechStackChange({ projectDir: dir, projectId: 'p-1', stackId: 'video-editor', scope: 'root' })
    expect(result.ok).toBe(true)
    expect(result.previewRestarted).toBe(false)
  })
})
