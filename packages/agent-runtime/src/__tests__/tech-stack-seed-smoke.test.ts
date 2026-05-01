// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Per-stack workspace seed smoke. For each entry in TECH_STACK_REGISTRY:
//   1. seedTechStack into a fresh workspace dir.
//   2. Assert the stack-specific marker file lands on disk.
//   3. Assert the .tech-stack marker is written and matches the stack id.
//   4. Assert .shogo/STACK.md is copied over.
//
// This catches the Frankenstein-workspace bug class (Vite template seeding
// over a non-Vite stack, missing starter files, etc.) without requiring a
// real `bun install` — the install + build path is gated behind RUN_HEAVY=1
// for nightly / pre-merge runs only.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  TECH_STACK_REGISTRY,
  type StackRegistryEntry,
} from '@shogo/shared-runtime'
import { seedTechStack, wipeProjectFiles } from '../workspace-defaults'

const TMP_BASE = join(import.meta.dir, '..', '..', '.test-tmp-seed-smoke')
let workspaceDir: string
let nextId = 0

function freshWorkspace(): string {
  const dir = join(TMP_BASE, `w-${nextId++}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

beforeEach(() => {
  workspaceDir = freshWorkspace()
})

afterEach(() => {
  if (existsSync(TMP_BASE)) {
    rmSync(TMP_BASE, { recursive: true, force: true })
  }
})

/**
 * One stack-specific marker file we assert lands on disk after seeding.
 * Picked to be unambiguous — a file the legacy Vite template would NOT
 * produce. `null` means the stack has no starter files (e.g. `none`,
 * `unity-game`) and we only check the metadata side of the contract.
 */
const STACK_MARKERS: Record<string, string | null> = {
  'react-app': null, // No starter dir; runtime-template handles it.
  'threejs-game': 'vite.config.ts',
  'phaser-game': 'vite.config.ts',
  'expo-app': 'app.json',
  'expo-three': 'app.json',
  'react-native': null, // Registered but no starter dir on disk yet.
  'python-data': 'requirements.txt',
  'unity-game': null, // Empty starter (Unity assets are managed by Unity).
  none: null, // Bare workspace by definition.
}

describe('per-stack workspace seed smoke', () => {
  for (const [stackId, entry] of Object.entries(TECH_STACK_REGISTRY) as Array<
    [string, StackRegistryEntry]
  >) {
    const marker = STACK_MARKERS[stackId]

    test(`seedTechStack(${stackId}): writes .tech-stack marker matching id`, () => {
      const ok = seedTechStack(workspaceDir, stackId)
      // `react-native` has a registry entry but no on-disk stack.json, so
      // seedTechStack returns false. That's the contract — assert it
      // explicitly so a future stack.json drop doesn't silently pass.
      if (entry.id === 'react-native') {
        expect(ok).toBe(false)
        expect(existsSync(join(workspaceDir, '.tech-stack'))).toBe(false)
        return
      }
      expect(ok).toBe(true)
      const techStackFile = join(workspaceDir, '.tech-stack')
      expect(existsSync(techStackFile)).toBe(true)
      expect(readFileSync(techStackFile, 'utf-8').trim()).toBe(stackId)
    })

    test(`seedTechStack(${stackId}): copies .shogo/STACK.md`, () => {
      if (entry.id === 'react-native') return // covered above
      seedTechStack(workspaceDir, stackId)
      const stackMd = join(workspaceDir, '.shogo', 'STACK.md')
      expect(existsSync(stackMd)).toBe(true)
    })

    if (marker) {
      test(`seedTechStack(${stackId}): produces stack-specific marker "${marker}"`, () => {
        seedTechStack(workspaceDir, stackId)
        const path = join(workspaceDir, marker)
        expect(existsSync(path)).toBe(true)
      })
    }
  }

  test('seedTechStack with unknown id: returns false, no files written', () => {
    const ok = seedTechStack(workspaceDir, 'definitely-not-a-stack')
    expect(ok).toBe(false)
    expect(existsSync(join(workspaceDir, '.tech-stack'))).toBe(false)
    expect(existsSync(join(workspaceDir, '.shogo', 'STACK.md'))).toBe(false)
  })

  test('seedTechStack does NOT overwrite existing files', () => {
    // Pre-write a fake app.json before seeding expo-app. The seed copy
    // filter must skip it.
    if (!STACK_MARKERS['expo-app']) return
    const filename = 'app.json'
    const path = join(workspaceDir, filename)
    const sentinel = '{"sentinel": "user-edited"}\n'
    require('fs').writeFileSync(path, sentinel, 'utf-8')

    seedTechStack(workspaceDir, 'expo-app')
    expect(readFileSync(path, 'utf-8')).toBe(sentinel)
  })
})

// `wipeProjectFiles` powers the destructive "reset project to new tech
// stack" flow exposed via `POST /agent/workspace/reset-stack`. It must
// delete the previous stack's project code while preserving the user's
// agent identity, persistent memory, and git history.
describe('wipeProjectFiles + stack switch', () => {
  test('preserves .shogo/, memory/, .git/, .canvas-state.json, .template', () => {
    // Lay down a representative spread of project files first.
    seedTechStack(workspaceDir, 'expo-app')

    // User-edited content under the preserve allowlist.
    const agentsMd = join(workspaceDir, '.shogo', 'AGENTS.md')
    mkdirSync(join(workspaceDir, '.shogo'), { recursive: true })
    writeFileSync(agentsMd, '# user edited identity\n', 'utf-8')

    const memoryNote = join(workspaceDir, 'memory', 'notes.md')
    mkdirSync(join(workspaceDir, 'memory'), { recursive: true })
    writeFileSync(memoryNote, 'remembered fact\n', 'utf-8')

    const gitHead = join(workspaceDir, '.git', 'HEAD')
    mkdirSync(join(workspaceDir, '.git'), { recursive: true })
    writeFileSync(gitHead, 'ref: refs/heads/main\n', 'utf-8')

    const canvasState = join(workspaceDir, '.canvas-state.json')
    writeFileSync(canvasState, '{"surfaces":[]}', 'utf-8')

    const templateMarker = join(workspaceDir, '.template')
    writeFileSync(templateMarker, 'travel-concierge', 'utf-8')

    // Sanity: expo's `app.json` was seeded above.
    expect(existsSync(join(workspaceDir, 'app.json'))).toBe(true)

    const removed = wipeProjectFiles(workspaceDir)
    expect(removed).toBeGreaterThan(0)

    // Project code should be gone.
    expect(existsSync(join(workspaceDir, 'app.json'))).toBe(false)
    expect(existsSync(join(workspaceDir, '.tech-stack'))).toBe(false)

    // Allowlisted paths and their contents must survive untouched.
    expect(readFileSync(agentsMd, 'utf-8')).toBe('# user edited identity\n')
    expect(readFileSync(memoryNote, 'utf-8')).toBe('remembered fact\n')
    expect(readFileSync(gitHead, 'utf-8')).toBe('ref: refs/heads/main\n')
    expect(readFileSync(canvasState, 'utf-8')).toBe('{"surfaces":[]}')
    expect(readFileSync(templateMarker, 'utf-8')).toBe('travel-concierge')
  })

  test('wipe + reseed switches stack from react-app/threejs-game to expo-app', () => {
    // Start on a Vite-based stack with a stack-specific marker.
    seedTechStack(workspaceDir, 'threejs-game')
    expect(existsSync(join(workspaceDir, 'vite.config.ts'))).toBe(true)

    // User customisation in .shogo/ that must survive the reset.
    const customAgents = join(workspaceDir, '.shogo', 'AGENTS.md')
    writeFileSync(customAgents, '# my custom agent\n', 'utf-8')

    // Wipe + reseed onto a Metro-based stack.
    wipeProjectFiles(workspaceDir)
    expect(existsSync(join(workspaceDir, 'vite.config.ts'))).toBe(false)

    const ok = seedTechStack(workspaceDir, 'expo-app')
    expect(ok).toBe(true)

    // New stack's marker file lands.
    expect(existsSync(join(workspaceDir, 'app.json'))).toBe(true)
    // Old stack's marker file is gone.
    expect(existsSync(join(workspaceDir, 'vite.config.ts'))).toBe(false)
    // .tech-stack reflects the new stack.
    expect(readFileSync(join(workspaceDir, '.tech-stack'), 'utf-8').trim()).toBe(
      'expo-app',
    )
    // User customisation in .shogo/ survived.
    expect(readFileSync(customAgents, 'utf-8')).toBe('# my custom agent\n')
  })

  test('wipeProjectFiles is a no-op on a non-existent dir', () => {
    const ghost = join(TMP_BASE, 'does-not-exist')
    expect(wipeProjectFiles(ghost)).toBe(0)
  })
})

// Heavy install / build smoke is gated behind RUN_HEAVY=1 because each
// stack's `bun install` takes ~30–90s and pulls 100–400MB of tarballs.
// This section only runs in nightly / pre-merge CI.
const HEAVY = process.env.RUN_HEAVY === '1'
describe.skipIf(!HEAVY)('per-stack install + build smoke (RUN_HEAVY=1)', () => {
  for (const [stackId, entry] of Object.entries(TECH_STACK_REGISTRY)) {
    if (entry.target === 'none' || entry.target === 'native') continue
    if (entry.id === 'react-native') continue // no stack.json yet
    const hasStarter = !!STACK_MARKERS[stackId]
    if (!hasStarter) continue

    test(`bun install + bun run build succeeds for ${stackId}`, async () => {
      seedTechStack(workspaceDir, stackId)
      const { execSync } = await import('child_process')
      execSync('bun install --no-frozen-lockfile', {
        cwd: workspaceDir,
        stdio: 'inherit',
      })
      execSync('bun run build', { cwd: workspaceDir, stdio: 'inherit' })
      expect(existsSync(join(workspaceDir, 'dist', 'index.html'))).toBe(true)
    }, 600_000)
  }
})
