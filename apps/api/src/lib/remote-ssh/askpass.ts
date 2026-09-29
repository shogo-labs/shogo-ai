// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * A short-lived SSH_ASKPASS broker.
 *
 * The local API owns the SSH child process, so Electron IPC cannot be used
 * directly from the askpass helper. Instead the helper writes one prompt into
 * a private temporary directory and waits for the authenticated local API
 * client to answer it. No private key material is ever written here.
 */

import {
  chmodSync,
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

export interface SSHAskpassPrompt {
  prompt: string
  createdAt: number
}

export class SSHAskpassBroker {
  readonly directory: string
  readonly helperPath: string
  private closed = false

  constructor() {
    // mkdtemp creates a fresh, unpredictable directory, so a pre-created
    // directory in a shared /tmp can never be adopted.
    this.directory = mkdtempSync(join(tmpdir(), 'shogo-ssh-askpass-'))
    chmodSync(this.directory, 0o700)
    this.helperPath = join(this.directory, 'askpass.sh')
    writeFileSync(this.helperPath, HELPER, { mode: 0o700 })
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
      return prompt ? { prompt, createdAt: statSync(path).mtimeMs } : null
    } catch {
      return null
    }
  }

  respond(answer: string): void {
    if (this.closed) throw new Error('SSH askpass broker is closed')
    if (answer.includes('\u0000') || answer.includes('\r') || answer.includes('\n')) {
      throw new TypeError('SSH askpass response must be a single line')
    }
    const temporary = join(this.directory, 'response.tmp')
    writeFileSync(temporary, answer, { mode: 0o600 })
    renameSync(temporary, join(this.directory, 'response'))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    rmSync(this.directory, { recursive: true, force: true })
  }
}
