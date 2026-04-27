// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * End-to-end test for the notetaker recording pipeline.
 *
 * This launches the real Electron app with Chromium's fake audio device
 * feeding a canned WAV fixture into `getUserMedia`. We drive the preload's
 * `shogoDesktop.startRecording` / `stopRecording` through `page.evaluate`
 * and then verify the produced `mic.wav` (and, when available, the mixed
 * `audio.wav`) contains real audio.
 *
 * System-audio capture is intentionally out of scope here — Chromium's
 * fake-audio-capture flag only injects into `getUserMedia` streams.
 * System audio coverage lives in the manual integration checklist.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import os from 'os'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const DESKTOP_DIR = path.resolve(__dirname, '..')
const FIXTURE_WAV = path.join(REPO_ROOT, 'apps', 'api', 'test-fixtures', 'meeting-sample.wav')

const RECORD_SECONDS = 5
const FIXTURE_ANCHORS = ['quick', 'fox', 'lazy']

// Build the mic compiled JS exists before we launch — we rely on the tsc
// build output (`dist/main.js`). If the user hasn't built yet, try once.
function ensureDesktopBuild(): void {
  const mainJs = path.join(DESKTOP_DIR, 'dist', 'main.js')
  if (fs.existsSync(mainJs)) return
  // Best-effort: invoke tsc. The command surfaces compile errors to the
  // caller rather than silently moving on to a broken launch.
  const { spawnSync } = require('child_process') as typeof import('child_process')
  const result = spawnSync('npx', ['tsc'], { cwd: DESKTOP_DIR, stdio: 'inherit' })
  if (result.status !== 0) throw new Error('apps/desktop tsc build failed')
}

// --- WAV parsing / RMS (kept inline so the e2e has no deps outside Playwright).

function findDataChunk(bytes: Buffer): { valid: boolean; sampleRate: number; channels: number; bitsPerSample: number; dataOffset: number; dataSize: number } {
  const invalid = { valid: false, sampleRate: 0, channels: 0, bitsPerSample: 0, dataOffset: 0, dataSize: 0 }
  if (bytes.length < 44) return invalid
  if (bytes.toString('ascii', 0, 4) !== 'RIFF') return invalid
  if (bytes.toString('ascii', 8, 12) !== 'WAVE') return invalid

  let offset = 12
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataOffset = 0
  let dataSize = 0
  let sawFmt = false

  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const payloadStart = offset + 8
    if (id === 'fmt ') {
      channels = bytes.readUInt16LE(payloadStart + 2)
      sampleRate = bytes.readUInt32LE(payloadStart + 4)
      bitsPerSample = bytes.readUInt16LE(payloadStart + 14)
      sawFmt = true
    } else if (id === 'data') {
      dataSize = Math.min(size, bytes.length - payloadStart)
      dataOffset = payloadStart
      break
    }
    offset = payloadStart + size + (size % 2)
  }
  if (!sawFmt || dataOffset === 0) return invalid
  return { valid: true, sampleRate, channels, bitsPerSample, dataOffset, dataSize }
}

function computeRms(filePath: string): number {
  const bytes = fs.readFileSync(filePath)
  const info = findDataChunk(bytes)
  if (!info.valid || info.bitsPerSample !== 16 || info.dataSize === 0) return 0
  const samples = info.dataSize / 2
  let sum = 0
  for (let i = 0; i < samples; i++) {
    const v = bytes.readInt16LE(info.dataOffset + i * 2) / 32768
    sum += v * v
  }
  return Math.sqrt(sum / samples)
}

// ---------------------------------------------------------------------------

let app: ElectronApplication | null = null
let mainWindow: Page | null = null
let tmpUserData: string | null = null

test.beforeAll(async () => {
  if (process.platform === 'win32') {
    test.skip(true, 'notetaker e2e currently disabled on Windows runners (no fake audio file fixture path handling)')
  }
  expect(fs.existsSync(FIXTURE_WAV), `fixture not found at ${FIXTURE_WAV}`).toBe(true)
  ensureDesktopBuild()

  tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'shogo-notetaker-e2e-'))

  // Resolve the Electron executable from apps/desktop's node_modules
  // (the test runner's cwd is the repo root, which doesn't install
  // electron itself — so playwright's auto-detect fails).
  const electronEntry = require.resolve('electron', { paths: [DESKTOP_DIR] })
  const electronModule = require(electronEntry) as unknown as string
  const executablePath = typeof electronModule === 'string' ? electronModule : undefined
  expect(executablePath, 'could not resolve electron executable').toBeTruthy()

  app = await electron.launch({
    executablePath,
    args: [
      '.',
      `--user-data-dir=${tmpUserData}`,
      '--no-sandbox',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${FIXTURE_WAV}`,
    ],
    cwd: DESKTOP_DIR,
    env: {
      ...process.env,
      // Skip heavy startup paths we don't need for recording: the local
      // Bun API server, VM pool, etc.
      SHOGO_SKIP_LOCAL_SERVER: 'true',
      SHOGO_E2E: 'true',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
    timeout: 60_000,
  })

  mainWindow = await app.firstWindow({ timeout: 60_000 })

  // Surface renderer + electron process logs so CI failures are debuggable
  // without round-tripping through the trace viewer.
  if (process.env.SHOGO_NOTETAKER_E2E_VERBOSE === 'true') {
    mainWindow.on('console', (msg) => console.log(`[renderer:${msg.type()}] ${msg.text()}`))
    mainWindow.on('pageerror', (err) => console.log(`[renderer:error] ${err.message}`))
    app.process().stderr?.on('data', (d: Buffer) => process.stderr.write(`[electron] ${d}`))
    app.process().stdout?.on('data', (d: Buffer) => process.stdout.write(`[electron] ${d}`))
  }

  // Let the preload script finish loading before we poke at it.
  await mainWindow.waitForFunction(() => typeof (window as any).shogoDesktop?.startRecording === 'function', undefined, {
    timeout: 30_000,
  })
})

test.afterAll(async () => {
  try { await app?.close() } catch { /* ignore */ }
  if (tmpUserData) {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

test('records a non-silent mic WAV using Chromium fake audio capture', async () => {
  const page = mainWindow!

  // 1. Start recording through the preload bridge.
  const started = await page.evaluate(async () => {
    return (window as any).shogoDesktop.startRecording() as Promise<{
      ok: boolean; id?: string; audioPath?: string; error?: string
    }>
  })
  expect(started.ok, `start failed: ${started.error ?? 'unknown'}`).toBe(true)
  expect(typeof started.id).toBe('string')
  expect(typeof started.audioPath).toBe('string')

  // 2. Give the fake audio pipeline time to feed enough samples through.
  await page.waitForTimeout(RECORD_SECONDS * 1000)

  // 3. Stop recording.
  const stopped = await page.evaluate(async () => {
    return (window as any).shogoDesktop.stopRecording() as Promise<{
      ok: boolean; id?: string; audioPath?: string; duration?: number; error?: string
    }>
  })
  expect(stopped.ok, `stop failed: ${stopped.error ?? 'unknown'}`).toBe(true)
  expect(typeof stopped.audioPath).toBe('string')

  // 4. The reported audioPath may point at the mix if a system stream was
  //    recorded; for e2e we always inspect the mic file directly since the
  //    fake-audio flag only injects into `getUserMedia`.
  const audioPath = stopped.audioPath!
  expect(fs.existsSync(audioPath), `audio file missing: ${audioPath}`).toBe(true)

  const sessionDir = path.dirname(audioPath)
  const micPath = path.join(sessionDir, 'mic.wav')
  expect(fs.existsSync(micPath), `mic.wav missing: ${micPath}`).toBe(true)

  const bytes = fs.readFileSync(micPath)
  const info = findDataChunk(bytes)
  expect(info.valid).toBe(true)
  expect(info.sampleRate).toBe(48000)
  expect(info.channels).toBe(1)
  expect(info.bitsPerSample).toBe(16)
  expect(info.dataSize).toBeGreaterThan(info.sampleRate * 2 * 2) // ≥2 s

  const rms = computeRms(micPath)
  console.log(`[notetaker-e2e] mic rms=${rms.toFixed(4)} bytes=${info.dataSize}`)
  expect(rms).toBeGreaterThan(0.001)

  // 5. Transcript check is optional — only runs if we deliberately keep the
  //    local Bun API alive (opt-in via SHOGO_NOTETAKER_E2E_TRANSCRIBE=true)
  //    and sherpa-onnx is installed. By default this test keeps the local
  //    API off so it's fast and self-contained; the recording-pipeline
  //    assertions above already cover the core contract.
  const sherpaPresent = fs.existsSync(path.join(REPO_ROOT, 'apps', 'desktop', 'resources', 'sherpa-onnx', 'bin'))
  if (!sherpaPresent || process.env.SHOGO_NOTETAKER_E2E_TRANSCRIBE !== 'true') {
    console.log('[notetaker-e2e] skipping transcript assertion (opt-in via SHOGO_NOTETAKER_E2E_TRANSCRIBE=true)')
    return
  }

  const apiUrl = await page.evaluate(() => (window as any).shogoDesktop.apiUrl as string)
  if (!apiUrl) return

  const deadline = Date.now() + 120_000
  let lastBody: any = null
  while (Date.now() < deadline) {
    const listRes = await page.evaluate(async (url: string) => {
      const r = await fetch(`${url}/api/local/meetings`)
      return r.json()
    }, apiUrl)
    const meetings = listRes?.meetings ?? []
    if (meetings.length > 0) {
      const meetingId = meetings[0].id
      const meetingRes = await page.evaluate(async ([url, id]: [string, string]) => {
        const r = await fetch(`${url}/api/local/meetings/${id}`)
        return r.json()
      }, [apiUrl, meetingId])
      lastBody = meetingRes
      const status = meetingRes?.meeting?.status
      if (status === 'ready' || status === 'error') {
        expect(status).toBe('ready')
        const transcript = JSON.parse(meetingRes.meeting.transcript ?? '{}')
        const text = String(transcript.text ?? '').toLowerCase()
        const matched = FIXTURE_ANCHORS.some((w) => text.includes(w))
        expect(matched, `transcript "${text}" contains none of ${FIXTURE_ANCHORS.join(', ')}`).toBe(true)
        return
      }
    }
    await page.waitForTimeout(500)
  }
  throw new Error(`meeting did not reach terminal status within 120s; last body: ${JSON.stringify(lastBody)}`)
})
