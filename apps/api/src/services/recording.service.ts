// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Server-side recording service — spawns the native shogo-audio helper to
 * capture system audio + mic. Used in local dev mode (bun dev:all) where
 * there is no Electron main process.
 */

import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import os from 'os'

interface RecordingState {
  id: string
  process: ChildProcess
  startTime: Date
  audioPath: string
  duration: number
  durationTimer: ReturnType<typeof setInterval>
}

let current: RecordingState | null = null

function getAudioHelperPath(): string | null {
  const root = process.cwd()
  const nativeDir = resolve(root, 'apps', 'desktop', 'native', 'shogo-audio')

  const release = join(nativeDir, '.build', 'release', 'shogo-audio')
  if (existsSync(release)) return release

  const debug = join(nativeDir, '.build', 'debug', 'shogo-audio')
  if (existsSync(debug)) return debug

  return null
}

function getRecordingsDir(): string {
  const dataDir = process.env.SHOGO_DATA_DIR || join(os.homedir(), '.shogo')
  const dir = join(dataDir, 'data', 'recordings')
  mkdirSync(dir, { recursive: true })
  return dir
}

function generateId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  return `recording-${ts}`
}

export function getRecordingStatus() {
  if (!current) {
    return { isRecording: false, id: null, duration: 0, audioPath: null }
  }
  return {
    isRecording: true,
    id: current.id,
    duration: current.duration,
    audioPath: current.audioPath,
  }
}

export async function startRecording(): Promise<{ id: string; audioPath: string }> {
  if (current) throw new Error('Already recording')

  const helperPath = getAudioHelperPath()
  if (!helperPath) {
    throw new Error(
      "Audio helper not found. Run 'make build' in apps/desktop/native/shogo-audio/",
    )
  }

  const id = generateId()
  const audioPath = join(getRecordingsDir(), `${id}.wav`)

  const proc = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })

  proc.stderr?.on('data', (data: Buffer) => {
    console.error(`[Recording] ${data.toString().trim()}`)
  })

  proc.on('error', (err) => {
    console.error('[Recording] Process error:', err)
    cleanup()
  })

  proc.on('exit', (code) => {
    console.log(`[Recording] Process exited: ${code}`)
    if (current?.process === proc) cleanup()
  })

  // Wait for the helper to emit "ready"
  await new Promise<void>((res, rej) => {
    const timeout = setTimeout(() => rej(new Error('Audio helper startup timeout')), 10_000)

    const onData = (data: Buffer) => {
      for (const line of data.toString().trim().split('\n')) {
        try {
          if (JSON.parse(line).type === 'ready') {
            clearTimeout(timeout)
            proc.stdout?.off('data', onData)
            res()
          }
        } catch {}
      }
    }

    proc.stdout?.on('data', onData)
    proc.on('error', (err) => { clearTimeout(timeout); rej(err) })
  })

  // Now that ready handshake is done, log diagnostic events from the helper
  proc.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n')) {
      try {
        const evt = JSON.parse(line)
        if (['warning', 'mic_info', 'system_audio_info', 'wav_finalized', 'recording_started', 'recording_stopped'].includes(evt.type)) {
          console.log(`[Recording] ${evt.type}:`, JSON.stringify(evt.data))
        }
      } catch {}
    }
  })

  proc.stdin?.write(`record ${audioPath}\n`)

  const durationTimer = setInterval(() => {
    if (current) {
      current.duration = Math.floor((Date.now() - current.startTime.getTime()) / 1000)
    }
  }, 1000)

  current = { id, process: proc, startTime: new Date(), audioPath, duration: 0, durationTimer }
  console.log(`[Recording] Started: ${id} -> ${audioPath}`)
  return { id, audioPath }
}

export async function stopRecording(): Promise<{ id: string; audioPath: string; duration: number } | null> {
  if (!current) return null

  const { id, audioPath, durationTimer, process: proc, duration } = current

  clearInterval(durationTimer)

  if (proc && !proc.killed) {
    proc.stdin?.write('stop\n')
    await new Promise<void>((res) => {
      const timeout = setTimeout(() => { if (!proc.killed) proc.kill('SIGTERM'); res() }, 5000)
      proc.stdin?.write('quit\n')
      proc.on('exit', () => { clearTimeout(timeout); res() })
    })
  }

  const result = { id, audioPath, duration }
  current = null
  console.log(`[Recording] Stopped: ${id}, duration: ${duration}s`)
  return result
}

function cleanup() {
  if (!current) return
  clearInterval(current.durationTimer)
  current = null
}

export function cleanupRecording() {
  if (current) stopRecording().catch(() => {})
}
