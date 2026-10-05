// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * A short-lived SSH_ASKPASS broker.
 *
 * The local API owns the SSH child process, so Electron IPC cannot be used
 * directly from the askpass helper. Instead the helper writes one prompt into
 * a private temporary directory and waits for the authenticated local API
 * client to answer it. No private key material is ever written here.
 *
 * On Windows the helper is a `.cmd` launcher around a PowerShell script (a
 * `#!/bin/sh` script cannot be started by CreateProcess), and the broker can
 * remember an answered password/passphrase in memory: without ControlMaster
 * multiplexing every ssh process authenticates on its own, so the same prompt
 * would otherwise reappear for each command.
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Both files are published with rename so neither side can observe a
// partially written prompt or answer.
const HELPER = `#!/bin/sh
set -eu
dir="$SHOGO_ASKPASS_DIR"
prompt="$dir/prompt"
response="$dir/response"
rm -f "$prompt" "$response"
printf '%s' "\${1-}" > "$prompt.tmp"
mv -f "$prompt.tmp" "$prompt"
i=0
while [ "$i" -lt 1200 ]; do
  if [ -f "$response" ]; then
    cat "$response"
    rm -f "$prompt" "$response"
    exit 0
  fi
  i=$((i + 1))
  sleep 0.1
done
rm -f "$prompt"
exit 1
`

/**
 * Windows launcher. CreateProcess can start a `.cmd` directly; PowerShell then
 * speaks the same prompt/response file protocol as the sh helper.
 */
const WINDOWS_CMD_HELPER = [
  '@powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0askpass.ps1" %*',
  '@exit /b %ERRORLEVEL%',
  '',
].join('\r\n')

const WINDOWS_PS1_HELPER = [
  "$ErrorActionPreference = 'Stop'",
  '$dir = $env:SHOGO_ASKPASS_DIR',
  "$prompt = Join-Path $dir 'prompt'",
  "$response = Join-Path $dir 'response'",
  '$utf8 = New-Object System.Text.UTF8Encoding($false)',
  "$text = ''",
  'if ($args.Count -gt 0) { $text = [string]$args[0] }',
  "$sshPid = ''",
  'try {',
  '  # cmd.exe cuts %* at the first line feed, which truncates multi-line',
  '  # prompts (host-key confirmation). Recover the full text from the raw',
  '  # command line of the parent cmd.exe.',
  '  $me = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $PID)',
  '  $cmd = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $me.ParentProcessId)',
  '  if ($cmd -and $cmd.ParentProcessId) { $sshPid = [string]$cmd.ParentProcessId }',
  '  $raw = [string]$cmd.CommandLine',
  "  $i = $raw.IndexOf('askpass.cmd', [System.StringComparison]::OrdinalIgnoreCase)",
  '  if ($i -ge 0) {',
  '    $rest = $raw.Substring($i + 11).TrimStart(\'"\').Trim().Trim(\'"\').Replace(\'\\"\', \'"\')',
  '    $head = $text.Trim().Trim(\'"\').Trim()',
  '    if ($rest.Length -gt 0 -and ($head.Length -eq 0 -or $rest.StartsWith($head))) { $text = $rest }',
  '  }',
  '} catch { }',
  'Remove-Item -Force -ErrorAction SilentlyContinue $prompt, $response',
  '# The asking ssh process id lets the broker tell "same process asked again"',
  '# (password rejected) from "a new process asked" (normal reuse).',
  '[System.IO.File]::WriteAllText($prompt + \'.pid\', $sshPid, $utf8)',
  '[System.IO.File]::WriteAllText($prompt + \'.tmp\', $text, $utf8)',
  "Move-Item -Force -LiteralPath ($prompt + '.tmp') -Destination $prompt",
  'for ($n = 0; $n -lt 1200; $n++) {',
  '  if (Test-Path -LiteralPath $response) {',
  '    $answer = [System.IO.File]::ReadAllText($response, $utf8)',
  '    $bytes = $utf8.GetBytes($answer)',
  '    $stdout = [Console]::OpenStandardOutput()',
  '    $stdout.Write($bytes, 0, $bytes.Length)',
  '    $stdout.Flush()',
  '    Remove-Item -Force -ErrorAction SilentlyContinue $prompt, $response',
  '    exit 0',
  '  }',
  '  Start-Sleep -Milliseconds 100',
  '}',
  'Remove-Item -Force -ErrorAction SilentlyContinue $prompt',
  'exit 1',
  '',
].join('\r\n')

/** Prompts whose answers are safe to remember for the life of the broker. */
const CACHEABLE_PROMPT = /pass(?:word|phrase)|\bPIN\b/i
/** One-time codes must never be replayed. */
const NEVER_CACHE_PROMPT = /one[- ]?time|verification|token|\botp\b|code/i
/**
 * Without a process id, the same prompt returning this soon after an
 * automatic answer is treated as a rejection of the remembered secret.
 */
const REJECTION_WINDOW_MS = 3_000
const DEFAULT_POLL_INTERVAL_MS = 100

export interface SSHAskpassPrompt {
  prompt: string
  createdAt: number
}

export interface SSHAskpassBrokerOptions {
  /** Override `process.platform`, primarily for tests. */
  platform?: NodeJS.Platform
  /**
   * Remember answered password/passphrase prompts in memory and answer
   * identical prompts automatically. Host-key and one-time-code prompts are
   * never remembered.
   */
  cacheSecrets?: boolean
  /** How often cached prompts are answered. Defaults to 100ms. */
  pollIntervalMs?: number
}

export class SSHAskpassBroker {
  readonly directory: string
  readonly helperPath: string
  private closed = false
  private readonly cacheSecrets: boolean
  private readonly secrets = new Map<string, string>()
  private lastAutoAnswer: { prompt: string; pid: string; at: number } | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined

  constructor(options: SSHAskpassBrokerOptions = {}) {
    const platform = options.platform ?? process.platform
    // mkdtemp creates a fresh, unpredictable directory, so a pre-created
    // directory in a shared /tmp can never be adopted.
    this.directory = mkdtempSync(join(tmpdir(), 'shogo-ssh-askpass-'))
    chmodSync(this.directory, 0o700)
    if (platform === 'win32') {
      this.helperPath = join(this.directory, 'askpass.cmd')
      writeFileSync(join(this.directory, 'askpass.ps1'), WINDOWS_PS1_HELPER, { mode: 0o700 })
      writeFileSync(this.helperPath, WINDOWS_CMD_HELPER, { mode: 0o700 })
    } else {
      this.helperPath = join(this.directory, 'askpass.sh')
      writeFileSync(this.helperPath, HELPER, { mode: 0o700 })
    }

    this.cacheSecrets = options.cacheSecrets === true
    if (this.cacheSecrets) {
      this.pollTimer = setInterval(
        () => this.answerCachedPrompt(),
        options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      )
      ;(this.pollTimer as unknown as { unref?: () => void }).unref?.()
    }
  }

  environment(): NodeJS.ProcessEnv {
    return {
      SHOGO_ASKPASS_DIR: this.directory,
      SSH_ASKPASS: this.helperPath,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: 'shogo-remote-ssh',
    }
  }

  getPrompt(): SSHAskpassPrompt | null {
    if (this.closed) return null
    const path = join(this.directory, 'prompt')
    try {
      const prompt = readFileSync(path, 'utf8')
      if (!prompt) return null
      // A remembered secret is answered by the poller; the user never needs
      // to see (or re-answer) it.
      if (this.secrets.has(prompt)) return null
      return { prompt, createdAt: statSync(path).mtimeMs }
    } catch {
      return null
    }
  }

  respond(answer: string): void {
    if (this.closed) throw new Error('SSH askpass broker is closed')
    if (answer.includes('\u0000') || answer.includes('\r') || answer.includes('\n')) {
      throw new TypeError('SSH askpass response must be a single line')
    }
    if (this.cacheSecrets) this.rememberAnswer(answer)
    this.publishResponse(answer)
  }

  /** Forget every remembered secret, e.g. after the server rejected one. */
  forgetSecrets(): void {
    this.secrets.clear()
    this.lastAutoAnswer = undefined
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = undefined
    this.forgetSecrets()
    rmSync(this.directory, { recursive: true, force: true })
  }

  /**
   * Answer the pending prompt from memory when it is one we have seen
   * before. Runs on a timer; exposed so callers and tests can drive it.
   */
  answerCachedPrompt(): void {
    if (this.closed || !this.cacheSecrets) return
    const prompt = this.readPendingPrompt()
    if (prompt === null) return
    const secret = this.secrets.get(prompt)
    if (secret === undefined) return
    // Already answered; the helper has not consumed the response yet.
    if (
      existsSync(join(this.directory, 'response')) ||
      existsSync(join(this.directory, 'response.tmp'))
    ) {
      return
    }

    const pid = this.readPendingPid()
    const last = this.lastAutoAnswer
    if (last && last.prompt === prompt) {
      // The same ssh process asking again means the server refused the
      // secret we just sent. Without a pid, fall back to timing.
      const rejected = pid && last.pid
        ? pid === last.pid
        : Date.now() - last.at < REJECTION_WINDOW_MS
      if (rejected) {
        this.secrets.delete(prompt)
        this.lastAutoAnswer = undefined
        return
      }
    }

    this.lastAutoAnswer = { prompt, pid, at: Date.now() }
    try {
      this.publishResponse(secret)
    } catch {
      // The helper may have timed out and removed the prompt; the next tick
      // starts over.
    }
  }

  private rememberAnswer(answer: string): void {
    const prompt = this.readPendingPrompt()
    if (!prompt || !answer) return
    if (!CACHEABLE_PROMPT.test(prompt) || NEVER_CACHE_PROMPT.test(prompt)) return
    this.secrets.set(prompt, answer)
    // A fresh user answer is a new attempt; do not treat the next prompt as
    // a rejection of an automatic one.
    this.lastAutoAnswer = undefined
  }

  private readPendingPrompt(): string | null {
    try {
      const prompt = readFileSync(join(this.directory, 'prompt'), 'utf8')
      return prompt || null
    } catch {
      return null
    }
  }

  private readPendingPid(): string {
    try {
      return readFileSync(join(this.directory, 'prompt.pid'), 'utf8').trim()
    } catch {
      return ''
    }
  }

  private publishResponse(answer: string): void {
    const temporary = join(this.directory, 'response.tmp')
    writeFileSync(temporary, answer, { mode: 0o600 })
    renameSync(temporary, join(this.directory, 'response'))
  }
}
