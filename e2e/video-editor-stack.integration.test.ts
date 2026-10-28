// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-65 e2e: a project created as a Video Editor is a Remotion project, and
 * the stack switch that used to half-apply is refused.
 *
 * The fast half runs everywhere and pins the acceptance criteria that live on
 * disk — what a fresh project contains, that `src/compositions.ts` is the one
 * composition list (so Studio, the Player and `remotion render` cannot drift),
 * that a colliding switch writes nothing at all, and that `resetFiles: true` is
 * the only way through it.
 *
 * The heavy half (`RUN_HEAVY=1`) runs the real starter through the same build
 * path the canvas preview uses (`resolveStaticBuildPlan` + `runStaticBuild`,
 * `SHOGO_BASE_PATH`), proves an edit to `src/videos/Main.tsx` reaches the
 * rebuilt bundle, and renders `Main` to an MP4 with Remotion itself.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { resolveStaticBuildPlan, runStaticBuild } from '../packages/agent-runtime/src/static-build'
import {
  applyTechStackChange,
  planTechStackChange,
  setTechStackPreviewRestarter,
} from '../packages/agent-runtime/src/tech-stack-switch'
import { seedTechStack } from '../packages/agent-runtime/src/workspace-defaults'
import { techStackRoutes } from '../apps/api/src/routes/tech-stacks'

const HEAVY = process.env.RUN_HEAVY === '1'
const dirs: string[] = []

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sho65-e2e-'))
  dirs.push(dir)
  return dir
}

function freshVideoEditorProject(): string {
  const dir = tmpProject()
  expect(seedTechStack(dir, 'video-editor')).toBe(true)
  return dir
}

/** Every file's content hash, so "wrote nothing" can be asserted literally. */
function snapshot(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'out') continue
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) snapshot(path, base, out)
    else out[relative(base, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
  }
  return out
}

function changedFiles(before: Record<string, string>, after: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((key) => before[key] !== after[key]).sort()
}

/** Content of every JS chunk the build emitted. */
function bundleText(stagingDir: string): string {
  const assets = join(stagingDir, 'assets')
  return readdirSync(assets)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(assets, f), 'utf-8'))
    .join('\n')
}

afterAll(() => {
  setTechStackPreviewRestarter(null)
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('a fresh video-editor project is a Remotion project', () => {
  test('the mobile picker sees it, and the runtime declaration is the one the preview reads', async () => {
    const list = await techStackRoutes().request('/tech-stacks')
    expect(list.status).toBe(200)
    const { stacks } = (await list.json()) as { stacks: any[] }
    const videoEditor = stacks.find((stack) => stack.id === 'video-editor')
    expect(videoEditor).toBeTruthy()
    expect(videoEditor.name.length).toBeGreaterThan(0)
    expect(videoEditor.description.length).toBeGreaterThan(0)

    const one = await techStackRoutes().request('/tech-stacks/video-editor')
    expect(one.status).toBe(200)
    const { stack } = (await one.json()) as { stack: any }
    // `static-build` is what makes the canvas serve the Player page from dist/;
    // `vite` would boot a dev server and lose the point of the stack.
    expect(stack.runtime.devServer).toBe('static-build')
    expect(stack.target).toBe('web')
    expect(stack.quickCommands?.map((c: any) => c.command).join(' ')).toContain('remotion render')
  })

  test('the starter is wired so the canvas, Studio and the renderer share one list', () => {
    const dir = freshVideoEditorProject()

    expect(readFileSync(join(dir, '.tech-stack'), 'utf-8').trim()).toBe('video-editor')
    // The composition list is the single source of truth.
    const compositions = readFileSync(join(dir, 'src/compositions.ts'), 'utf-8')
    expect(compositions).toContain('export const COMPOSITIONS')
    expect(compositions).toContain("id: 'Main'")
    expect(compositions).toContain('durationInFrames: 150')
    // Studio + renderer register exactly that list…
    expect(readFileSync(join(dir, 'src/Root.tsx'), 'utf-8')).toContain('COMPOSITIONS')
    // …and the canvas preview is a Player shell over it, not a studio.
    expect(readFileSync(join(dir, 'index.html'), 'utf-8')).toContain('/src/preview.tsx')
    const preview = readFileSync(join(dir, 'src/preview.tsx'), 'utf-8')
    expect(preview).toContain('@remotion/player')
    expect(preview).toContain('COMPOSITIONS')
    // Remotion's CLI finds the entry point without being told.
    expect(readFileSync(join(dir, 'remotion.config.ts'), 'utf-8')).toContain("./src/index.ts")
    expect(readFileSync(join(dir, 'src/index.ts'), 'utf-8')).toContain('registerRoot')

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
    expect(pkg.dependencies.remotion).toBeTruthy()
    expect(pkg.dependencies['@remotion/player']).toBeTruthy()
    expect(pkg.scripts.build).toBeTruthy()
    expect(pkg.scripts.studio).toContain('remotion')
    expect(pkg.scripts.render).toContain('remotion render')

    // The doc an agent reads says how to preview and render, and to stay in one project.
    const stackDoc = readFileSync(join(dir, '.shogo/STACK.md'), 'utf-8')
    expect(stackDoc).toContain('remotion studio')
    expect(stackDoc).toContain('remotion render')
    expect(stackDoc).toContain('Never create a side `studio/` folder')
    expect(stackDoc).toContain('SHOGO_BASE_PATH')
  })
})

describe('switching away from it', () => {
  test('a colliding switch is refused and the project is byte-identical afterwards', () => {
    const dir = freshVideoEditorProject()
    const before = snapshot(dir)
    const restarts: unknown[] = []
    setTechStackPreviewRestarter((req) => void restarts.push(req))

    const plan = planTechStackChange({ projectDir: dir, stackId: 'react-app' })
    expect(plan.from).toBe('video-editor')
    expect(plan.needsReset).toBe(true)
    expect(plan.collisions).toContain('package.json')
    expect(plan.collisions).toContain('index.html')
    expect(plan.collisions).toContain('src')
    // Planning alone writes nothing.
    expect(changedFiles(before, snapshot(dir))).toEqual([])

    const refused = applyTechStackChange({
      projectDir: dir,
      projectId: 'e2e-project',
      stackId: 'react-app',
      scope: 'member',
    })
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('stack_change_needs_reset')
    expect(refused.collisions).toContain('package.json')
    expect(refused.hint).toContain('resetFiles: true')
    // The literal criterion: no marker, no seed, no `.shogo/` write, no pkg edit.
    expect(changedFiles(before, snapshot(dir))).toEqual([])
    expect(restarts).toHaveLength(0)

    setTechStackPreviewRestarter(null)
  })

  test('resetFiles: true is the way through — wipe, seed, swap the doc', () => {
    const dir = freshVideoEditorProject()
    // Identity and agent notes under `.shogo/` and `memory/` must survive a wipe.
    writeFileSync(join(dir, '.shogo/QA-NOTES.md'), '# keep me\n')
    mkdirSync(join(dir, 'memory'), { recursive: true })
    writeFileSync(join(dir, 'memory/keep.md'), '# memory survives\n')
    const restarts: any[] = []
    setTechStackPreviewRestarter((req) => void restarts.push(req))

    const applied = applyTechStackChange({
      projectDir: dir,
      projectId: 'e2e-project',
      stackId: 'react-app',
      scope: 'member',
      resetFiles: true,
    })

    expect(applied.ok).toBe(true)
    expect(applied.wiped).toBeGreaterThan(0)
    expect(applied.stackDocUpdated).toBe(true)
    expect(applied.leftInPlace).toEqual([])
    expect(readFileSync(join(dir, '.tech-stack'), 'utf-8').trim()).toBe('react-app')
    expect(existsSync(join(dir, 'src/videos/Main.tsx'))).toBe(false)
    expect(existsSync(join(dir, 'remotion.config.ts'))).toBe(false)
    // The doc follows the marker instead of describing the stack we left.
    expect(readFileSync(join(dir, '.shogo/STACK.md'), 'utf-8')).toContain('React App')
    // Identity and memory survive the wipe.
    expect(readFileSync(join(dir, '.shogo/QA-NOTES.md'), 'utf-8')).toBe('# keep me\n')
    expect(readFileSync(join(dir, 'memory/keep.md'), 'utf-8')).toBe('# memory survives\n')
    expect(restarts).toHaveLength(1)
    expect(restarts[0]).toMatchObject({ projectId: 'e2e-project', stackId: 'react-app', scope: 'member' })

    setTechStackPreviewRestarter(null)
  })

  test('a clean project seeds and reports what it left in place', () => {
    const dir = tmpProject()
    writeFileSync(join(dir, 'notes.md'), '# my notes\n')

    const applied = applyTechStackChange({
      projectDir: dir,
      projectId: 'e2e-clean',
      stackId: 'video-editor',
      scope: 'member',
    })

    expect(applied.ok).toBe(true)
    expect(applied.collisions).toEqual([])
    expect(applied.leftInPlace).toEqual(['notes.md'])
    expect(applied.seeded).toBe(true)
    expect(existsSync(join(dir, 'src/compositions.ts'))).toBe(true)
    expect(readFileSync(join(dir, 'notes.md'), 'utf-8')).toBe('# my notes\n')
  })
})

describe.skipIf(!HEAVY)('the starter builds, re-bundles on an edit, and renders to MP4', () => {
  test('build → edit → rebuild → render', async () => {
    const dir = freshVideoEditorProject()
    execFileSync('bun', ['install'], { cwd: dir, stdio: 'inherit' })

    // `stagingDir` is relative to the project (that is the contract the preview
    // manager uses: `.shogo/preview-dist`), so the staged copy lands in-folder.
    const stagingA = '.preview-e2e-a'
    const plan = resolveStaticBuildPlan(dir, { stagingDir: stagingA, basePath: '/p/e2e/' })
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.kind).toBe('command')
    expect(plan.kind === 'command' && plan.command).toContain('build')

    const first = await runStaticBuild(dir, plan, { stagingDir: stagingA, basePath: '/p/e2e/' })
    if (!first.ok) throw new Error(first.error)

    // The canvas serves these assets under the runtime's base path.
    const html = readFileSync(join(dir, stagingA, 'index.html'), 'utf-8')
    expect(html).toContain('/p/e2e/assets/')
    // The composition — not a placeholder — is in the bundle the Player runs.
    expect(bundleText(join(dir, stagingA))).toContain('Your first')

    // An edit to the composition reaches the rebuilt preview.
    const mainPath = join(dir, 'src/videos/Main.tsx')
    writeFileSync(mainPath, readFileSync(mainPath, 'utf-8').replace('Your first', 'QA edit landed'))
    const stagingB = '.preview-e2e-b'
    const replan = resolveStaticBuildPlan(dir, { stagingDir: stagingB, basePath: '/p/e2e/' })
    if ('error' in replan) throw new Error(replan.error)
    const second = await runStaticBuild(dir, replan, { stagingDir: stagingB, basePath: '/p/e2e/' })
    if (!second.ok) throw new Error(second.error)
    const rebundled = bundleText(join(dir, stagingB))
    expect(rebundled).toContain('QA edit landed')
    expect(rebundled).not.toContain('Your first')

    // And the same file renders to an MP4.
    execFileSync('bun', ['x', 'remotion', 'render', 'src/index.ts', 'Main', 'out/e2e.mp4'], {
      cwd: dir,
      stdio: 'inherit',
      timeout: 600_000,
    })
    const mp4 = join(dir, 'out/e2e.mp4')
    expect(existsSync(mp4)).toBe(true)
    expect(statSync(mp4).size).toBeGreaterThan(50_000)
  }, 900_000)
})
