// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for PreviewManager's status/URL contract. The agent relies on
// getStatus().url to tell the QA subagent (and the user) where the running
// app lives — this test exists because a regression here previously left the
// agent probing for the URL via `lsof` and hallucinated `.shogo/preview-url`.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PreviewManager } from '../preview-manager'

const TEST_DIR = '/tmp/test-preview-manager'

function setupProjectDir(hasPrebuiltDist = false) {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  writeFileSync(join(TEST_DIR, 'package.json'), JSON.stringify({ name: 'fixture' }))
  // Pre-create an empty node_modules/ so PreviewManager skips `bun install`
  // during the background setup path — otherwise install flips phase to
  // 'installing' and spawns a real package manager inside the test.
  mkdirSync(join(TEST_DIR, 'node_modules'), { recursive: true })
  if (hasPrebuiltDist) {
    mkdirSync(join(TEST_DIR, 'dist'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'dist', 'index.html'), '<html></html>')
  }
}

describe('PreviewManager', () => {
  beforeEach(() => setupProjectDir())
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

  test('getStatus before start: running=false, urls null', () => {
    const pm = new PreviewManager({ projectDir: TEST_DIR, runtimePort: 8080 })
    const s = pm.getStatus()
    expect(s.running).toBe(false)
    expect(s.port).toBeNull()
    expect(s.url).toBeNull()
    expect(s.internalUrl).toBeNull()
    expect(s.publicUrl).toBeNull()
    expect(s.phase).toBe('idle')
  })

  test('internalUrl getter always reflects runtimePort', () => {
    const pm = new PreviewManager({ projectDir: TEST_DIR, runtimePort: 9123 })
    expect(pm.internalUrl).toBe('http://localhost:9123/')
  })

  test('externalUrl falls back to internalUrl when publicUrl is unset', () => {
    const pm = new PreviewManager({ projectDir: TEST_DIR, runtimePort: 8080 })
    expect(pm.externalUrl).toBe('http://localhost:8080/')
  })

  test('externalUrl prefers publicUrl when set', () => {
    const pm = new PreviewManager({
      projectDir: TEST_DIR,
      runtimePort: 8080,
      publicUrl: 'https://preview--proj123.dev.shogo.ai',
    })
    expect(pm.externalUrl).toBe('https://preview--proj123.dev.shogo.ai')
  })

  test('externalUrl ignores empty publicUrl string', () => {
    const pm = new PreviewManager({ projectDir: TEST_DIR, runtimePort: 8080, publicUrl: '' })
    expect(pm.externalUrl).toBe('http://localhost:8080/')
  })

  test('getStatus when running reports runtimePort as port (not fake 5173)', async () => {
    // A pre-built dist triggers the immediate-ready path in start(), which
    // flips `started=true` + phase='ready' without spawning vite.
    setupProjectDir(true)
    const pm = new PreviewManager({ projectDir: TEST_DIR, runtimePort: 8080 })
    await pm.start()
    const s = pm.getStatus()
    expect(s.running).toBe(true)
    expect(s.port).toBe(8080)
    expect(s.url).toBe('http://localhost:8080/')
    expect(s.internalUrl).toBe('http://localhost:8080/')
    expect(s.publicUrl).toBeNull()
    pm.stop()
  })

  test('getStatus when running reports publicUrl as the canonical url', async () => {
    setupProjectDir(true)
    const pm = new PreviewManager({
      projectDir: TEST_DIR,
      runtimePort: 8080,
      publicUrl: 'https://preview--abc.dev.shogo.ai',
    })
    await pm.start()
    const s = pm.getStatus()
    expect(s.running).toBe(true)
    expect(s.url).toBe('https://preview--abc.dev.shogo.ai')
    expect(s.internalUrl).toBe('http://localhost:8080/')
    expect(s.publicUrl).toBe('https://preview--abc.dev.shogo.ai')
    pm.stop()
  })
})
