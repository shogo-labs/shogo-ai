// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * A short-lived SSH_ASKPASS broker.
 *
 * The local API owns the SSH child process, so Electron IPC cannot be used
 * directly from the askpass helper. Instead the helper writes one prompt into
 * a mode-0700 temporary directory and waits for the authenticated local API
 * client to answer it. No private key material is ever written here.
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HELPER = `#!/bin/sh
set -eu
dir="$SHOGO_ASKPASS_DIR"
prompt="$dir/prompt"
response="$dir/response"
rm -f "$prompt" "$response"
printf '%s' "\${1-}" > "$prompt"
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

export interface SSHAskpassPrompt {
  prompt: string
  createdAt: number
}

export class SSHAskpassBroker {
  readonly id: string
  readonly directory: string
  readonly helperPath: string
  private closed = false

  constructor(id = randomBytes(12).toString('hex')) {
    this.id = id
    this.directory = join(tmpdir(), `shogo-ssh-askpass-${id}`)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.helperPath = join(this.directory, 'askpass.sh')
    writeFileSync(this.helperPath, HELPER, { mode: 0o700 })
    chmodSync(this.helperPath, 0o700)
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
    try {
      const prompt = readFileSync(join(this.directory, 'prompt'), 'utf8')
      return prompt ? { prompt, createdAt: this.promptCreatedAt() } : null
    } catch {
      return null
    }
  }

  respond(answer: string): void {
    if (this.closed) throw new Error('SSH askpass broker is closed')
    if (answer.includes('\u0000') || answer.includes('\r') || answer.includes('\n')) {
      throw new TypeError('SSH askpass response must be a single line')
    }
    writeFileSync(join(this.directory, 'response'), answer, { mode: 0o600 })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    rmSync(this.directory, { recursive: true, force: true })
  }

  private promptCreatedAt(): number {
    try {
      return Number(readFileSync(join(this.directory, 'prompt.created'), 'utf8')) || Date.now()
    } catch {
      return Date.now()
    }
  }
}

export function createSSHAskpassBroker(id?: string): SSHAskpassBroker {
  return new SSHAskpassBroker(id)
}
