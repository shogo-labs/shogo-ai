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
  /** The model the latest attempt installed (or is installing). */
  model?: string
  error?: string
  startedAt?: number
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const RETRY_DELAY_MS = 5_000

let status: TranscriptionInstallStatus = { state: 'idle' }
/** In-flight or queued installs, by model. */
const installations = new Map<string, Promise<void>>()
/** Installs share the sherpa directory, so they run one after another. */
let queueTail: Promise<unknown> = Promise.resolve()
const failures = new Map<string, { at: number; error: string }>()

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
 * Ensure local transcription and diarization assets exist for `model`.
 *
 * Concurrent callers asking for the same model share one promise. A different
 * model queues behind the current install rather than being handed its
 * promise. A failed attempt is retryable, but not in a tight loop while a
 * desktop client is polling the status endpoint.
 */
export function ensureTranscriptionEngine(model = 'base.en'): Promise<void> {
  const existing = installations.get(model)
  if (existing) return existing

  if (isLocalTranscriptionAvailable(model) && isDiarizationAvailable()) {
    if (installations.size === 0) status = { state: 'ready', model }
    return Promise.resolve()
  }

  const failure = failures.get(model)
  if (failure && Date.now() - failure.at < RETRY_DELAY_MS) {
    return Promise.reject(new Error(failure.error))
  }

  status = { state: 'installing', model, startedAt: Date.now() }
  const installation = queueTail
    .catch(() => {})
    .then(() => installModel(model))
    .finally(() => {
      installations.delete(model)
    })
  installations.set(model, installation)
  queueTail = installation
  return installation
}

async function installModel(model: string): Promise<void> {
  // An earlier install in the queue may have fetched everything already.
  if (isLocalTranscriptionAvailable(model) && isDiarizationAvailable()) {
    status = { state: 'ready', model }
    return
  }

  const startedAt = Date.now()
  const scriptPath = findDownloadSherpaScript()
  if (!scriptPath) {
    const error = 'download-sherpa.mjs not found. Expected it in the desktop scripts or packaged resources directory.'
    status = { state: 'failed', model, error, startedAt }
    failures.set(model, { at: startedAt, error })
    throw new Error(error)
  }

  status = { state: 'installing', model, startedAt }
  try {
    await runInstaller(scriptPath, model)
    failures.delete(model)
    status = { state: 'ready', model, startedAt }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    failures.set(model, { at: Date.now(), error })
    status = { state: 'failed', model, error, startedAt }
    throw err
  }
}

/** Test-only reset for the process-local installer state. */
export function resetTranscriptionInstallState(): void {
  status = { state: 'idle' }
  installations.clear()
  queueTail = Promise.resolve()
  failures.clear()
}
