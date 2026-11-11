// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import {
  SERVER_FLAG_ALLOWLIST,
  buildServerArgs,
  buildWorkbenchUrl,
  createOutputTail,
  ensureConnectionToken,
  killProcessTree,
  pickPort,
  serverNodeBinary,
  startCodeOssServer,
  workspaceFolderQuery,
  type ServerProfile,
} from '../code-oss-server/launch'

const scratch = mkdtempSync(join(tmpdir(), 'shogo-ide-launch-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** A stand-in for out/server-main.js that honours the same flags and cookie. */
const FAKE_SERVER = `
const http = require('http')
const fs = require('fs')
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
if (process.env.FAKE_ARGS_FILE) {
  fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ args, vscodeDev: process.env.VSCODE_DEV ?? null }))
}
const mode = process.env.FAKE_MODE || 'ok'
if (mode === 'exit') {
  console.error('boom: cannot start')
  process.exit(3)
} else if (mode === 'hang') {
  console.log('starting forever')
  setInterval(() => {}, 1000)
} else {
  const token = fs.readFileSync(value('--connection-token-file'), 'utf8').trim()
  const start = () =>
    http
      .createServer((req, res) => {
        const ok = (req.headers.cookie || '').includes('vscode-tkn=' + token)
        res.writeHead(ok ? 200 : 403)
        res.end(ok ? '<html>workbench</html>' : 'forbidden')
      })
      .listen(Number(value('--port')), '127.0.0.1', () => console.log('Web UI available'))
  setTimeout(start, mode === 'delay' ? 600 : 0)
}
`

let counter = 0
function fakeServer(): { serverDir: string; profile: ServerProfile; argsFile: string } {
  const root = join(scratch, `s${counter++}`)
  const serverDir = join(root, 'server')
  mkdirSync(join(serverDir, 'out'), { recursive: true })
  writeFileSync(join(serverDir, 'out', 'server-main.js'), FAKE_SERVER)
  const profileDir = join(root, 'profile')
  return {
    serverDir,
    argsFile: join(root, 'args.json'),
    profile: {
      profileDir,
      userDataDir: join(profileDir, 'user-data'),
      extensionsDir: join(profileDir, 'extensions'),
      serverDataDir: join(profileDir, 'server-data'),
    },
  }
}

function waitExit(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => proc.once('exit', () => resolve()))
}

describe('server arguments', () => {
  const profile: ServerProfile = { profileDir: '/p', userDataDir: '/p/u', extensionsDir: '/p/e', serverDataDir: '/p/s' }
  const args = buildServerArgs({ serverDir: '/srv', port: 18000, tokenFile: '/p/token', profile })

  test('the entry point is out/server-main.js and every flag is a server option', () => {
    expect(args[0]).toBe(join('/srv', 'out', 'server-main.js'))
    const flags = args.filter((a) => a.startsWith('--'))
    expect(flags.every((f) => SERVER_FLAG_ALLOWLIST.has(f))).toBe(true)
    expect(args).toContain('--connection-token-file')
    expect(args[args.indexOf('--host') + 1]).toBe('127.0.0.1')
  })

  test('none of the flags the server ignores are passed', () => {
    for (const removed of [
      '--agents-user-data-dir',
      '--agents-extensions-dir',
      '--skip-welcome',
      '--disable-crash-reporter',
      '--crash-reporter-directory',
      '--extensionDevelopmentPath',
      '--builtin-extensions-dir',
    ]) {
      expect(args.some((a) => a.startsWith(removed))).toBe(false)
    }
    expect(args.some((a) => a.startsWith('--disable-extension'))).toBe(false)
  })

  test('the server runs on its own node, never a shell script', () => {
    expect(serverNodeBinary('C:\\srv', 'win32')).toMatch(/node\.exe$/)
    expect(serverNodeBinary('/srv', 'darwin')).toBe(join('/srv', 'node'))
  })
})

describe('workbench URL', () => {
  test('a Windows path becomes a server path the web client understands', () => {
    expect(workspaceFolderQuery('C:\\Users\\Дмитрий Иванов\\proj', 'win32')).toBe('/C:/Users/Дмитрий Иванов/proj')
    expect(workspaceFolderQuery('/home/d/proj', 'linux')).toBe('/home/d/proj')
  })

  test('carries the token and the encoded folder', () => {
    const url = new URL(buildWorkbenchUrl(18001, 'abc123', 'C:\\Users\\Дмитрий Иванов\\my proj', 'win32'))
    expect(url.origin).toBe('http://127.0.0.1:18001')
    expect(url.searchParams.get('tkn')).toBe('abc123')
    expect(url.searchParams.get('folder')).toBe('/C:/Users/Дмитрий Иванов/my proj')
    expect(url.toString()).not.toContain(' ')
  })
})

describe('connection token', () => {
  test('is created once with 64 hex characters and then reused', () => {
    const dir = join(scratch, 'token-profile')
    const first = ensureConnectionToken(dir)
    expect(first.token).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(first.tokenFile, 'utf8')).toBe(first.token)
    expect(ensureConnectionToken(dir).token).toBe(first.token)
    if (process.platform !== 'win32') expect(statSync(first.tokenFile).mode & 0o777).toBe(0o600)
  })
})

describe('pickPort', () => {
  test('skips a busy port in the range', async () => {
    const blocker = net.createServer()
    const busy = await new Promise<number>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as net.AddressInfo).port)))
    try {
      expect(await pickPort([busy, busy + 1])).toBe(busy + 1)
    } finally {
      blocker.close()
    }
  })

  test('falls back to an OS-assigned port when the range is full', async () => {
    const blocker = net.createServer()
    const busy = await new Promise<number>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as net.AddressInfo).port)))
    try {
      const port = await pickPort([busy, busy])
      expect(port).not.toBe(busy)
      expect(port).toBeGreaterThan(0)
    } finally {
      blocker.close()
    }
  })
})

describe('createOutputTail', () => {
  test('keeps the last lines across chunk boundaries', () => {
    const tail = createOutputTail(2)
    tail.push('one\ntw')
    tail.push('o\nthree\nfou')
    expect(tail.text()).toBe('three\nfou')
  })
})

describe('startCodeOssServer', () => {
  test('starts, waits for the token-protected page and exposes the workbench URL', async () => {
    const { serverDir, profile, argsFile } = fakeServer()
    const server = await startCodeOssServer({
      serverDir,
      profile,
      portRange: [0, -1],
      nodeBinary: process.execPath,
      env: { ...process.env, FAKE_MODE: 'delay', FAKE_ARGS_FILE: argsFile, VSCODE_DEV: '1' },
    })
    try {
      const recorded = JSON.parse(readFileSync(argsFile, 'utf8'))
      expect(recorded.vscodeDev).toBeNull()
      expect(recorded.args[recorded.args.indexOf('--port') + 1]).toBe(String(server.port))
      const page = await fetch(`http://127.0.0.1:${server.port}/`, { headers: { cookie: `vscode-tkn=${server.token}` } })
      expect(page.status).toBe(200)
      expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(403)
      expect(server.workbenchUrl('/proj')).toContain(`tkn=${server.token}`)
    } finally {
      killProcessTree(server.proc)
      await waitExit(server.proc)
    }
  })

  test('a server that exits early fails with its output', async () => {
    const { serverDir, profile } = fakeServer()
    await expect(
      startCodeOssServer({ serverDir, profile, portRange: [0, -1], nodeBinary: process.execPath, env: { ...process.env, FAKE_MODE: 'exit' } }),
    ).rejects.toThrow(/exited \(3\) before it was ready[\s\S]*boom: cannot start/)
  })

  test('a server that never answers times out with its output', async () => {
    const { serverDir, profile } = fakeServer()
    await expect(
      startCodeOssServer({
        serverDir,
        profile,
        portRange: [0, -1],
        nodeBinary: process.execPath,
        env: { ...process.env, FAKE_MODE: 'hang' },
        readyTimeoutMs: 1_500,
      }),
    ).rejects.toThrow(/did not start within 2 s[\s\S]*starting forever/)
  })

  test('uses the bundled node binary by default and reports an incomplete install', async () => {
    const { serverDir, profile } = fakeServer()
    await expect(startCodeOssServer({ serverDir, profile, portRange: [0, -1] })).rejects.toThrow(/install is incomplete: .*node(\.exe)? is missing/)
  })

  test('killProcessTree stops a running server', async () => {
    const { serverDir, profile } = fakeServer()
    const server = await startCodeOssServer({ serverDir, profile, portRange: [0, -1], nodeBinary: process.execPath })
    killProcessTree(server.proc)
    await waitExit(server.proc)
    expect(server.proc.exitCode !== null || server.proc.signalCode !== null).toBe(true)
  })
})
