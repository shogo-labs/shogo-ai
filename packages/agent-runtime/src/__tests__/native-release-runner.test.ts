// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The runner is the only part of native release that touches the user's files, so
 * these tests are about what leaves the pod: no secret in the archive, no write to
 * the working tree, and a release that asks for the bundle id before it spends
 * anything.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildDynamicConfigWrapper,
  buildEasJson,
  buildIgnoreMatcher,
  computeFingerprint,
  hasMaestroFlows,
  isExcludedFromArchive,
  publicEnvFrom,
  runNativeRelease,
  writeProjectArchive,
} from '../native-release-runner'

const dirs: string[] = []

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-native-test-'))
  dirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return dir
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('what never enters the archive', () => {
  it('refuses every .env variant, and keeps the templates', () => {
    for (const name of ['.env', '.env.local', '.env.production', 'apps/mobile/.env', 'sub/.env.test']) {
      expect(isExcludedFromArchive(name)).toBe(true)
    }
    expect(isExcludedFromArchive('.env.example')).toBe(false)
    expect(isExcludedFromArchive('.env.sample')).toBe(false)
  })

  it('refuses node_modules, .shogo, .git and build output at any depth', () => {
    for (const path of [
      'node_modules/react/index.js',
      'apps/mobile/node_modules/x/y.js',
      '.shogo/logs/build.log',
      '.git/config',
      '.expo/state.json',
      'ios/Podfile',
      'android/build.gradle',
    ]) {
      expect(isExcludedFromArchive(path)).toBe(true)
    }
  })

  it('keeps application source', () => {
    expect(isExcludedFromArchive('apps/mobile/App.tsx')).toBe(false)
    expect(isExcludedFromArchive('app.json')).toBe(false)
    expect(isExcludedFromArchive('.maestro/smoke.yaml')).toBe(false)
  })

  it('honours .gitignore as well as the hard rules', () => {
    const matcher = buildIgnoreMatcher('/tmp/x', [{ name: '.gitignore', content: 'dist/\n*.log\n' }])
    expect(matcher('dist/index.js')).toBe(true)
    expect(matcher('debug.log')).toBe(true)
    expect(matcher('src/index.ts')).toBe(false)
  })
})

describe('the archive', () => {
  it('carries the generated eas.json and no .env, and leaves the tree untouched', async () => {
    const dir = makeProject({
      'package.json': '{"name":"app"}',
      'app.json': JSON.stringify({ expo: { name: 'App', slug: 'app' } }),
      'App.tsx': 'export default function App() { return null }',
      '.env': 'SECRET=shhh\nEXPO_PUBLIC_API_URL=https://api.test\n',
      '.gitignore': 'dist/\n',
      'dist/bundle.js': 'built',
    })

    const before = readFileSync(join(dir, '.env'), 'utf8')
    const out = join(dir, '..', `archive-${Date.now()}.tar.gz`)
    const result = await writeProjectArchive({
      projectId: 'proj_1',
      projectDir: dir,
      outFile: out,
      easyProjectId: 'eas_app_1',
    })

    expect(result.files).toBeGreaterThan(0)
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.publicEnv).toEqual({ EXPO_PUBLIC_API_URL: 'https://api.test' })

    const { list } = await import('tar')
    const entries: string[] = []
    await list({ file: out, onentry: (entry: any) => entries.push(entry.path) })

    expect(entries).toContain('eas.json')
    expect(entries).toContain('package.json')
    expect(entries).toContain('App.tsx')
    expect(entries.some((e) => e.includes('.env'))).toBe(false)
    expect(entries.some((e) => e.startsWith('dist/'))).toBe(false)
    expect(entries.some((e) => e.includes('node_modules'))).toBe(false)

    // The project itself is read-only for us.
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(before)
    expect(() => readFileSync(join(dir, 'eas.json'), 'utf8')).toThrow()

    rmSync(out, { force: true })
  })

  it('generates a store profile and a test profile, with the class left to the API', () => {
    const eas = buildEasJson({ projectId: 'proj_1' }) as any
    expect(eas.build['shogo-test'].withoutCredentials).toBe(true)
    expect(eas.build['shogo-test'].ios.simulator).toBe(true)
    expect(eas.build['shogo-store'].distribution).toBe('store')
    // resourceClass belongs to the API; a project profile that set it would be
    // overridden anyway, and setting it here would suggest otherwise.
    expect(JSON.stringify(eas)).not.toContain('resourceClass')
  })

  it('wraps a dynamic app config instead of overwriting it', () => {
    const wrapper = buildDynamicConfigWrapper({ extra: { eas: { projectId: 'p1' } } })
    expect(wrapper).toContain("require('./app.json')")
    expect(wrapper).toContain('module.exports = ({ config })')
    expect(wrapper).toContain('projectId')
  })
})

describe('EXPO_PUBLIC values', () => {
  it('extracts only public variables, unquoting and skipping comments', () => {
    const env = [
      '# comment',
      'SECRET=shhh',
      'EXPO_PUBLIC_API_URL=https://api.test',
      'EXPO_PUBLIC_TITLE="My App"',
      '',
      "EXPO_PUBLIC_KEY='abc'",
    ].join('\n')
    expect(publicEnvFrom(env)).toEqual({
      EXPO_PUBLIC_API_URL: 'https://api.test',
      EXPO_PUBLIC_TITLE: 'My App',
      EXPO_PUBLIC_KEY: 'abc',
    })
  })
})

describe('fingerprints', () => {
  it('is stable for the same tree and changes when a tracked file changes', async () => {
    const dir = makeProject({ 'a.ts': 'one', 'b.ts': 'two' })
    const first = await computeFingerprint(dir, ['a.ts', 'b.ts'])
    const again = await computeFingerprint(dir, ['a.ts', 'b.ts'])
    expect(first).toBe(again)
    expect(first.startsWith('shogo-hash-')).toBe(true)

    writeFileSync(join(dir, 'a.ts'), 'changed')
    const changed = await computeFingerprint(dir, ['a.ts', 'b.ts'])
    expect(changed).not.toBe(first)
  })

  it('does not depend on file order', async () => {
    const dir = makeProject({ 'a.ts': 'one', 'b.ts': 'two' })
    expect(await computeFingerprint(dir, ['a.ts', 'b.ts'])).toBe(
      await computeFingerprint(dir, ['b.ts', 'a.ts']),
    )
  })
})

describe('maestro flows', () => {
  it('are found when the project has them', async () => {
    const withFlows = makeProject({ '.maestro/smoke.yaml': 'appId: x\n---\n- launchApp\n' })
    expect(await hasMaestroFlows(withFlows)).toBe(true)
  })

  it('are skipped, not faked, when the project has none', async () => {
    const withoutFlows = makeProject({ 'app.json': '{}' })
    expect(await hasMaestroFlows(withoutFlows)).toBe(false)
  })
})

describe('a release, against a fake API', () => {
  it('asks for the bundle id before it spends anything', async () => {
    const dir = makeProject({ 'app.json': '{}' })
    let started = false
    const result = await runNativeRelease({
      projectId: 'p1',
      projectDir: dir,
      platforms: ['ios'],
      track: 'internal',
      hasMaestroFlows: false,
      api: {
        state: async () => ({
          ok: true,
          data: { needsBundleId: true, defaultBundleIdentifier: 'ai.shogo.app.cool', mode: 'byok', app: null },
        }),
        start: async () => {
          started = true
          return { ok: true, data: {} }
        },
        sources: async () => ({ ok: true, data: {} }),
      },
    })

    expect(started).toBe(false)
    expect(result.needs_bundle_id).toBe(true)
    expect(result.default_bundle_identifier).toBe('ai.shogo.app.cool')
  })

  it('uploads the archive and starts the test stage', async () => {
    const dir = makeProject({ 'app.json': '{"expo":{"name":"App"}}', 'App.tsx': 'x' })
    const uploaded: { url: string; size: number }[] = []
    const sourcesCalls: any[] = []

    const result = await runNativeRelease({
      projectId: 'p1',
      projectDir: dir,
      platforms: ['ios'],
      track: 'testflight',
      hasMaestroFlows: true,
      api: {
        state: async () => ({
          ok: true,
          data: { needsBundleId: false, mode: 'cloud', app: { easAppId: 'eas_1' } },
        }),
        start: async () => ({
          ok: true,
          data: {
            releaseId: 'rel_1',
            kind: 'build',
            mode: 'cloud',
            uploads: [{ kind: 'source', url: 'https://upload.test/1', bucketKey: 'bucket/1' }],
          },
        }),
        sources: async (_p, _r, input) => {
          sourcesCalls.push(input)
          return { ok: true, data: { status: 'testing', workflowRunId: 'wf_1' } }
        },
      },
      upload: async (url, body) => {
        uploaded.push({ url, size: body.byteLength })
      },
    })

    expect(result.ok).toBe(true)
    expect(result.release_id).toBe('rel_1')
    expect(result.test_stage).toBe('scheduled')
    expect(uploaded).toHaveLength(1)
    expect(uploaded[0].size).toBeGreaterThan(0)
    expect(sourcesCalls[0].bucketKey).toBe('bucket/1')
  })

  it('surfaces a plan refusal as a plan gate, not a generic failure', async () => {
    const dir = makeProject({ 'app.json': '{}' })
    const result = await runNativeRelease({
      projectId: 'p1',
      projectDir: dir,
      platforms: ['ios'],
      track: 'production',
      hasMaestroFlows: false,
      api: {
        state: async () => ({ ok: true, data: { needsBundleId: false, mode: 'cloud', app: {} } }),
        start: async () => ({
          ok: false,
          status: 402,
          error: 'Publishing to the App Store and Google Play is available on paid plans.',
          code: 'plan_not_allowed',
        }),
        sources: async () => ({ ok: true, data: {} }),
      },
    })

    expect(result.ok).toBe(false)
    expect(result.plan_gate).toBe(true)
    expect(result.code).toBe('plan_not_allowed')
  })
})
