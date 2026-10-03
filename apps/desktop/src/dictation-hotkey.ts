// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Global dictation shortcuts for the desktop shell.
 *
 * - Push to talk (hold) runs through the native `shogo-hotkey` helper (macOS),
 *   which can see `Fn` and key release.
 * - Hands-free (toggle) uses Electron's `globalShortcut`.
 *
 * Capture and transcription stay in the renderer (`desktop-dictation.ts`);
 * this service only emits start/stop/cancel events to it and pastes the
 * resulting text into the focused app.
 */
import { app, clipboard, globalShortcut, type BrowserWindow } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import fs from 'fs'
import path from 'path'
import { createDictationController, parseHelperLine, type DictationEvent } from './dictation-controller'
import { type DictationConfig, isValidAccelerator } from './dictation-protocol'

export type HelperStatus = 'off' | 'starting' | 'waiting' | 'listening' | 'unavailable'

export interface DictationHotkeyState {
  /** True once the native listener is running with Accessibility granted. */
  fnAvailable: boolean
  helper: HelperStatus
}

function getHelperBinaryPath(): string | null {
  if (process.platform !== 'darwin') return null
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  if (!app.isPackaged) {
    const nativeDir = path.join(app.getAppPath(), 'native', 'shogo-hotkey')
    const candidates = [
      path.join(nativeDir, `shogo-hotkey-${arch}`),
      path.join(nativeDir, '.build', 'release', 'shogo-hotkey'),
      path.join(nativeDir, '.build', 'debug', 'shogo-hotkey'),
    ]
    return candidates.find((p) => fs.existsSync(p)) ?? null
  }
  const packed = path.join(process.resourcesPath!, 'shogo-hotkey', `shogo-hotkey-${arch}`)
  return fs.existsSync(packed) ? packed : null
}

export class DictationHotkeyService {
  private helper: ChildProcessWithoutNullStreams | null = null
  private helperStatus: HelperStatus = 'off'
  private buffer = ''
  private config: DictationConfig = { pushToTalk: null, handsFree: null }
  private registeredHandsFree: string | null = null
  private stopped = true
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private readonly controller = createDictationController({ emit: (e) => this.dispatch(e) })

  constructor(private readonly getTargetWindow: () => BrowserWindow | null) {}

  getState(): DictationHotkeyState {
    return { fnAvailable: this.helperStatus === 'listening', helper: this.helperStatus }
  }

  /** Begin (or re-apply) listening with the given config. */
  start(config: DictationConfig): void {
    this.stopped = false
    this.applyConfig(config)
  }

  applyConfig(config: DictationConfig): void {
    this.config = config
    this.controller.reset()
    this.syncHandsFree()
    this.syncHelper()
  }

  stop(): void {
    this.stopped = true
    this.controller.reset()
    if (this.registeredHandsFree) {
      try { globalShortcut.unregister(this.registeredHandsFree) } catch { /* already gone */ }
      this.registeredHandsFree = null
    }
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.killHelper()
  }

  /**
   * Put the transcript on the clipboard and paste it into the focused app,
   * then restore the previous clipboard text. Without the helper the text just
   * stays on the clipboard (`pasted: false`).
   */
  async deliverText(text: string): Promise<{ ok: boolean; pasted: boolean }> {
    const clean = text.trim()
    if (!clean) return { ok: true, pasted: false }
    const previous = clipboard.readText()
    clipboard.writeText(clean)
    if (this.helper && this.helperStatus === 'listening') {
      this.helper.stdin.write('paste\n')
      setTimeout(() => {
        // Only restore if nothing else replaced the clipboard in the meantime.
        if (clipboard.readText() === clean) clipboard.writeText(previous)
      }, 500)
      return { ok: true, pasted: true }
    }
    return { ok: true, pasted: false }
  }

  private dispatch(event: DictationEvent): void {
    const win = this.getTargetWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send('dictation:event', event)
  }

  private syncHandsFree(): void {
    const next = this.config.handsFree && isValidAccelerator(this.config.handsFree) ? this.config.handsFree : null
    if (this.registeredHandsFree && this.registeredHandsFree !== next) {
      try { globalShortcut.unregister(this.registeredHandsFree) } catch { /* ignore */ }
      this.registeredHandsFree = null
    }
    if (next && this.registeredHandsFree !== next) {
      try {
        if (globalShortcut.register(next, () => this.controller.toggle())) {
          this.registeredHandsFree = next
        } else {
          console.warn(`[Dictation] Could not register hands-free shortcut ${next} (already in use?)`)
        }
      } catch (err) {
        console.warn(`[Dictation] Invalid hands-free shortcut ${next}:`, err)
      }
    }
  }

  private syncHelper(): void {
    const chord = this.config.pushToTalk
    if (!chord || process.platform !== 'darwin') {
      this.killHelper()
      return
    }
    if (this.helper) {
      this.helper.stdin.write(`set ${chord}\n`)
      return
    }
    const binary = getHelperBinaryPath()
    if (!binary) {
      this.helperStatus = 'unavailable'
      console.warn('[Dictation] shogo-hotkey binary not found — push to talk is unavailable')
      return
    }
    this.spawnHelper(binary, chord)
  }

  private spawnHelper(binary: string, chord: string): void {
    this.helperStatus = 'starting'
    const child = spawn(binary, [`--push-to-talk=${chord}`], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.helper = child
    this.buffer = ''

    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      let idx: number
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx)
        this.buffer = this.buffer.slice(idx + 1)
        this.onHelperLine(line)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => console.warn('[Dictation] helper stderr:', chunk.toString('utf8').trim()))
    child.stdin.on('error', () => { /* helper exited */ })
    child.on('error', (err) => {
      console.warn('[Dictation] helper failed to start:', err.message)
      this.helper = null
      this.helperStatus = 'unavailable'
    })
    child.on('exit', (code) => {
      // A newer helper has already replaced this one; leave its state alone.
      if (this.helper && this.helper !== child) return
      if (this.helper === child) this.helper = null
      this.controller.reset()
      if (this.stopped || !this.config.pushToTalk) {
        this.helperStatus = 'off'
        return
      }
      // Crashed or killed externally: bring it back shortly.
      this.helperStatus = 'unavailable'
      console.warn(`[Dictation] helper exited (${code}); restarting`)
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        if (!this.stopped) this.syncHelper()
      }, 2000)
    })
  }

  private onHelperLine(line: string): void {
    const event = parseHelperLine(line)
    if (!event) return
    switch (event.event) {
      case 'waiting':
        this.helperStatus = 'waiting'
        break
      case 'listening':
        this.helperStatus = 'listening'
        break
      case 'ptt':
        if (event.down) this.controller.pttDown()
        else this.controller.pttUp()
        break
      case 'combo':
        this.controller.combo()
        break
      case 'error':
        console.warn('[Dictation] helper error:', event.message)
        break
      default:
        break
    }
  }

  private killHelper(): void {
    const child = this.helper
    this.helper = null
    if (!child) {
      if (this.helperStatus !== 'unavailable') this.helperStatus = 'off'
      return
    }
    try { child.stdin.write('quit\n') } catch { /* already closed */ }
    setTimeout(() => { try { child.kill() } catch { /* already gone */ } }, 500)
    this.helperStatus = 'off'
  }
}
