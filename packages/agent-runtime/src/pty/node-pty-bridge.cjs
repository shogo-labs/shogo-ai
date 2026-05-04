// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

const { existsSync, chmodSync } = require('fs')
const { dirname, resolve } = require('path')
const readline = require('readline')

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function ensureSpawnHelperExecutable() {
  if (process.platform !== 'darwin') return
  try {
    const packageDir = dirname(require.resolve('node-pty/package.json'))
    const helper = resolve(packageDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  } catch {
    // node-pty will report the actionable native error below.
  }
}

try {
  ensureSpawnHelperExecutable()

  const pty = require('node-pty')
  const config = JSON.parse(process.argv[2] || '{}')
  const term = pty.spawn(config.file, config.args || [], config.options || {})

  term.onData((data) => send({ type: 'data', data }))
  term.onExit((event) => {
    send({ type: 'exit', exitCode: event.exitCode, signal: event.signal })
    process.exit(0)
  })

  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on('line', (line) => {
    if (!line) return
    const message = JSON.parse(line)
    if (message.type === 'write') term.write(message.data || '')
    else if (message.type === 'resize') term.resize(message.cols, message.rows)
    else if (message.type === 'kill') {
      term.kill(message.signal || 'SIGTERM')
      setTimeout(() => process.exit(0), 100).unref()
    }
  })

  send({ type: 'ready' })
} catch (err) {
  send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  process.exit(1)
}
