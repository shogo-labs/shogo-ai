// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Client for the Electron main-process recording bridge.
 *
 * The old implementation of this module spawned the now-deleted
 * `shogo-audio` Swift binary directly from the Bun API process. Audio
 * capture now lives inside Electron (renderer Web Audio + main-process
 * file I/O), so this module just forwards HTTP calls to the localhost
 * bridge Electron exposes at startup.
 *
 * Discovery mechanism:
 *  - Electron writes `recording-bridge.json` to its `userData` directory
 *    on boot with a random port + per-process token.
 *  - We read that file lazily, cache it, and retry if the stored port is
 *    stale (e.g., Electron restarted since the last request).
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import os from 'os'

interface BridgeDescriptor {
  port: number
  token: string
  pid?: number
}

interface Recording {
  id: string
  audioPath: string
  duration: number
}

let cached: BridgeDescriptor | null = null

function getBridgeFilePath(): string {
  // Mirror Electron's `app.getPath('userData')` for the 'Shogo' productName.
  const platform = process.platform
  let dir: string
  if (platform === 'darwin') {
    dir = join(os.homedir(), 'Library', 'Application Support', 'Shogo')
  } else if (platform === 'win32') {
    dir = join(process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming'), 'Shogo')
  } else {
    dir = join(process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config'), 'Shogo')
  }
  return join(dir, 'recording-bridge.json')
}

function loadDescriptor(force = false): BridgeDescriptor | null {
  if (cached && !force) return cached
  const filePath = getBridgeFilePath()
  if (!existsSync(filePath)) return null
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    if (typeof raw.port === 'number' && typeof raw.token === 'string') {
      cached = { port: raw.port, token: raw.token, pid: raw.pid }
      return cached
    }
  } catch {
    // fall through
  }
  return null
}

async function callBridge(method: 'GET' | 'POST', pathname: string): Promise<Response> {
  let descriptor = loadDescriptor()
  if (!descriptor) throw new BridgeUnavailableError('Electron recording bridge not running — start the desktop app first')

  try {
    return await doFetch(descriptor, method, pathname)
  } catch (err) {
    // Retry once with a fresh descriptor in case Electron restarted and
    // minted a new port/token.
    descriptor = loadDescriptor(true)
    if (!descriptor) throw new BridgeUnavailableError('Electron recording bridge not running')
    return doFetch(descriptor, method, pathname)
  }
}

async function doFetch(descriptor: BridgeDescriptor, method: 'GET' | 'POST', pathname: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${descriptor.port}${pathname}`, {
    method,
    headers: { 'x-shogo-bridge-token': descriptor.token },
  })
}

export class BridgeUnavailableError extends Error {}

export function getRecordingStatus(): { isRecording: boolean; id: string | null; duration: number; audioPath: string | null } {
  // Status is expected to be called often (polling from the UI in dev). We
  // serve a best-effort synchronous answer from cache when the bridge is
  // unreachable so the UI doesn't explode.
  const descriptor = loadDescriptor()
  if (!descriptor) {
    return { isRecording: false, id: null, duration: 0, audioPath: null }
  }
  // We can't do a sync HTTP call; return a non-recording placeholder and let
  // the async variant below supersede it for callers that need real state.
  return { isRecording: false, id: null, duration: 0, audioPath: null }
}

export async function getRecordingStatusAsync(): Promise<{ isRecording: boolean; id: string | null; duration: number; audioPath: string | null }> {
  try {
    const res = await callBridge('GET', '/recording/status')
    if (!res.ok) return { isRecording: false, id: null, duration: 0, audioPath: null }
    return (await res.json()) as { isRecording: boolean; id: string | null; duration: number; audioPath: string | null }
  } catch {
    return { isRecording: false, id: null, duration: 0, audioPath: null }
  }
}

export async function startRecording(): Promise<{ id: string; audioPath: string }> {
  const res = await callBridge('POST', '/recording/start')
  const body = (await res.json()) as { id?: string; audioPath?: string; error?: string }
  if (!res.ok || !body.id || !body.audioPath) {
    throw new Error(body.error || `bridge returned HTTP ${res.status}`)
  }
  return { id: body.id, audioPath: body.audioPath }
}

export async function stopRecording(): Promise<Recording | null> {
  const res = await callBridge('POST', '/recording/stop')
  const body = (await res.json()) as { id?: string; audioPath?: string; duration?: number; error?: string }
  if (!res.ok) {
    if (res.status === 400 && /not recording/i.test(body.error ?? '')) return null
    throw new Error(body.error || `bridge returned HTTP ${res.status}`)
  }
  if (!body.id || !body.audioPath) return null
  return { id: body.id, audioPath: body.audioPath, duration: body.duration ?? 0 }
}

/** Legacy name kept for server.ts shutdown hook. */
export function cleanupRecording(): void {
  // Nothing to clean up on this side — Electron owns the recording. The
  // bridge will be torn down when Electron exits.
}
