// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { isLocalTranscriptionAvailable } from './transcription.service'
import { isDiarizationAvailable } from './diarization.service'

export type TranscriptionInstallState = 'idle' | 'installing' | 'ready' | 'failed'

export interface TranscriptionInstallStatus {
  state: TranscriptionInstallState
  error?: string
  startedAt?: number
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const RETRY_DELAY_MS = 5_000

let status: TranscriptionInstallStatus = { state: 'idle' }
let installation: Promise<void> | null = null
let lastAttemptAt = 0

/**
 * Locates the runtime installer in dev and packaged desktop builds.
 *
 * Dev resolves from apps/api/src/services to apps/desktop/scripts. The API
 * bundle copies the script to resources/scripts and the desktop local server
 * runs with resourcesPath as its cwd.
 */
export function findDownloadSherpaScript(): string | null {
  const candidates = [
    resolve(MODULE_DIR, '..', '..', '..', 'desktop', 'scripts', 'download-sherpa.mjs'),
    resolve(process.cwd(), 'scripts', 'download-sherpa.mjs'),
    resolve(process.cwd(), 'apps', 'desktop', 'scripts', 'download-sherpa.mjs'),
    resolve(process.cwd(), '..', '..', 'apps', 'desktop', 'scripts', 'download-sherpa.mjs'),
    resolve((process as any).resourcesPath || '', 'scripts', 'download-sherpa.mjs'),
  ]
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
}

function getScriptInterpreter(): string {
  return process.env.SHOGO_BUN_PATH || 'bun'
}

function runInstaller(scriptPath: string, model: string): Promise<void> {
  const destDir = process.env.SHOGO_SHERPA_DIR || ''
  const child = spawn(getScriptInterpreter(), [scriptPath, '--model', model], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(destDir ? { SHERPA_DEST_DIR: destDir } : {}),
    },
  })

  return new Promise((resolvePromise, reject) => {
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => reject(err))
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
      } else {
        reject(new Error(
          `sherpa-onnx installer exited with ${signal ? `signal ${signal}` : `code ${code}`}` +
            (stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ''),
        ))
      }
    })
  })
}

export function getTranscriptionInstallStatus(): TranscriptionInstallStatus {
  return { ...status }
}

/**
 * Ensure local transcription and diarization assets exist.
 *
 * The first caller starts the download and all concurrent callers share its
 * promise. A failed attempt is retryable, but not in a tight loop while a
 * desktop client is polling the status endpoint.
 */
export function ensureTranscriptionEngine(model = 'base.en'): Promise<void> {
  if (isLocalTranscriptionAvailable(model) && isDiarizationAvailable()) {
    status = { ...status, state: 'ready', error: undefined }
    return Promise.resolve()
  }

  if (installation) return installation

  const now = Date.now()
  if (status.state === 'failed' && now - lastAttemptAt < RETRY_DELAY_MS) {
    return Promise.reject(new Error(status.error || 'Transcription setup is waiting before retry'))
  }

  const scriptPath = findDownloadSherpaScript()
  if (!scriptPath) {
    const error = 'download-sherpa.mjs not found. Expected it in the desktop scripts or packaged resources directory.'
    status = { state: 'failed', error, startedAt: now }
    lastAttemptAt = now
    return Promise.reject(new Error(error))
  }

  lastAttemptAt = now
  status = { state: 'installing', startedAt: now }
  installation = runInstaller(scriptPath, model)
    .then(() => {
      status = { state: 'ready', startedAt: now }
    })
    .catch((err) => {
      const error = err instanceof Error ? err.message : String(err)
      status = { state: 'failed', error, startedAt: now }
      throw err
    })
    .finally(() => {
      installation = null
    })

  return installation
}

/** Test-only reset for the process-local installer state. */
export function resetTranscriptionInstallState(): void {
  status = { state: 'idle' }
  installation = null
  lastAttemptAt = 0
}
