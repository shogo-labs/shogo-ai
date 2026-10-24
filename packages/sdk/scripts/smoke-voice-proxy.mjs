#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Release smoke check for the hosted voice proxy, run against an INSTALLED
 * copy of the packages (packed tarballs before publish, the npm registry
 * after) rather than the monorepo source.
 *
 * Why: `@shogo-ai/voice@1.10.0` shipped proxy-mode `tts: notImplemented(...)`
 * for months after main had the real proxy (SHO-68/#1550, SHO-106). Unit tests
 * on main were green the whole time because they import `src/`, never what a
 * project actually installs. This check imports the built package the way a
 * project's `server.tsx` does and fails if a hosted endpoint answers 501.
 *
 * Usage:
 *   node smoke-voice-proxy.mjs <installDir> <expectedVersion>
 *
 * `<installDir>` must contain node_modules/@shogo-ai/{sdk,voice}.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [installDirArg, expected] = process.argv.slice(2)
if (!installDirArg || !expected) {
  console.error('usage: smoke-voice-proxy.mjs <installDir> <expectedVersion>')
  process.exit(2)
}
const installDir = resolve(installDirArg)
const req = createRequire(join(installDir, 'package.json'))

const failures = []
const fail = (msg) => {
  failures.push(msg)
  console.error(`✗ ${msg}`)
}
const pass = (msg) => console.log(`✓ ${msg}`)

function readPkg(name) {
  return JSON.parse(readFileSync(join(installDir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
}

const voicePkg = readPkg('@shogo-ai/voice')
const sdkPkg = readPkg('@shogo-ai/sdk')
if (voicePkg.version !== expected) fail(`@shogo-ai/voice is ${voicePkg.version}, expected ${expected}`)
else pass(`@shogo-ai/voice@${voicePkg.version}`)
if (sdkPkg.version !== expected) fail(`@shogo-ai/sdk is ${sdkPkg.version}, expected ${expected}`)
else pass(`@shogo-ai/sdk@${sdkPkg.version}`)
const sdkVoiceDep = sdkPkg.dependencies?.['@shogo-ai/voice']
if (sdkVoiceDep !== expected) fail(`@shogo-ai/sdk depends on @shogo-ai/voice@${sdkVoiceDep}, expected ${expected} (lockstep broken)`)
else pass(`@shogo-ai/sdk → @shogo-ai/voice@${sdkVoiceDep} (lockstep)`)

const API = 'https://api.smoke.invalid'
const TOKEN = 'rt_smoke_token'
const PROJECT = 'proj_smoke'

// Every endpoint the Shogo API hosts for a pod with no BYO key. A 501 from
// any of these means a project gets "not available in runtime-token proxy
// mode" in production.
const CASES = [
  { handler: 'signedUrl', method: 'GET', url: '/api/voice/signed-url', upstream: '/api/voice/signed-url' },
  { handler: 'tts', method: 'POST', url: '/api/voice/tts', body: { text: 'smoke check' }, upstream: '/api/voice/tts' },
  { handler: 'music', method: 'POST', url: '/api/voice/music', body: { prompt: 'smoke check' }, upstream: '/api/voice/music' },
]

async function check(spec) {
  let mod
  try {
    mod = await import(pathToFileURL(req.resolve(spec)).href)
  } catch (err) {
    fail(`${spec}: cannot import (${err?.message ?? err})`)
    return
  }
  const createVoiceHandlers = mod.createVoiceHandlers ?? mod.default?.createVoiceHandlers
  if (typeof createVoiceHandlers !== 'function') {
    fail(`${spec}: no createVoiceHandlers export`)
    return
  }

  const calls = []
  const stubFetch = async (input, init = {}) => {
    calls.push({ url: String(input), init })
    if (new URL(String(input)).pathname.endsWith('/signed-url')) {
      return Response.json({ signedUrl: 'wss://smoke.invalid/x', agentId: 'agent_smoke' })
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } })
  }
  const handlers = createVoiceHandlers({
    proxy: { runtimeToken: TOKEN, projectId: PROJECT, apiUrl: API, fetch: stubFetch },
  })

  for (const c of CASES) {
    const label = `${spec} ${c.handler}`
    if (typeof handlers[c.handler] !== 'function') {
      fail(`${label}: handler missing`)
      continue
    }
    calls.length = 0
    const res = await handlers[c.handler](
      new Request(`http://pod${c.url}`, {
        method: c.method,
        ...(c.body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(c.body) } : {}),
      }),
    )
    if (res.status === 501) {
      const detail = await res.text().catch(() => '')
      fail(`${label}: 501 in runtime-token proxy mode — ${detail.slice(0, 200)}`)
      continue
    }
    const hit = calls.find((call) => new URL(call.url).pathname === c.upstream)
    if (!hit) {
      fail(`${label}: returned ${res.status} without forwarding to ${c.upstream} (calls: ${calls.map((x) => x.url).join(', ') || 'none'})`)
      continue
    }
    const token = new Headers(hit.init.headers).get('x-runtime-token')
    if (token !== TOKEN) {
      fail(`${label}: forwarded without the runtime token`)
      continue
    }
    pass(`${label} → ${c.upstream} (${res.status})`)
  }
}

await check('@shogo-ai/voice/server')
await check('@shogo-ai/sdk/voice/server')

if (failures.length > 0) {
  console.error(`\nVoice proxy smoke check FAILED (${failures.length}) for ${expected}.`)
  process.exit(1)
}
console.log(`\nVoice proxy smoke check passed for ${expected}.`)
