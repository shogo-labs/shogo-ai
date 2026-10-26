// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Runs every huddle (call / meeting) test, layer by layer, so one command
 * answers "does the whole feature still work?":
 *
 *   api      service + route behaviour against a real database: join/leave,
 *            ringing, invites, moderation, share link and knock, polls and Q&A,
 *            the call chat that follows who is in the call, LiveKit webhooks,
 *            and huddle notes (tickets, coverage handover, billing, finalize,
 *            live captions, the spoken "hey Shogo" wake).
 *   mobile   the client call state, roster, chat lookup, ringtone, call
 *            notifications, the captions strip and the wake note, and the
 *            call's panels (chat, polls, requests, invite).
 *   desktop  the Electron call window's protocol and bounds.
 *   e2e      real browsers through a real LiveKit server (opt-in: it needs the
 *            local stack and LiveKit running).
 *
 * Usage:
 *   bun scripts/test-huddles.ts                # api + mobile + desktop
 *   bun scripts/test-huddles.ts --only api     # one layer (repeatable)
 *   bun scripts/test-huddles.ts --e2e          # also the Playwright suite
 *   bun scripts/test-huddles.ts --list         # show what would run
 *
 * Each file runs in its own process: the API suites share a test database and
 * `mock.module()` state is process-wide, so they cannot run in one `bun test`.
 */

import { resolve } from 'path'
import { spawnSync } from 'child_process'

const ROOT = resolve(import.meta.dir, '..')

interface Layer {
  name: 'api' | 'mobile' | 'desktop' | 'e2e'
  cwd: string
  /** The command for one file. */
  cmd: (file: string) => string[]
  files: string[]
  optIn?: boolean
}

const LAYERS: Layer[] = [
  {
    name: 'api',
    cwd: 'apps/api',
    cmd: (f) => ['bun', 'test', f],
    files: [
      'src/__tests__/huddles.integration.test.ts',
      'src/__tests__/huddles-multi.integration.test.ts',
      'src/__tests__/huddle-notes.integration.test.ts',
      'src/services/__tests__/huddle-notes-coverage.test.ts',
      'src/__tests__/meeting-live-stream.test.ts',
      'src/services/__tests__/huddle-wake.test.ts',
      'src/routes/__tests__/internal.huddle-finals.test.ts',
      'src/lib/__tests__/apns.test.ts',
      'src/lib/__tests__/push-notifications.test.ts',
    ],
  },
  {
    name: 'mobile',
    cwd: 'apps/mobile',
    cmd: (f) => ['bun', '--no-env-file', 'test', f],
    files: [
      'lib/__tests__/huddles.test.tsx',
      'lib/__tests__/huddle-notes.test.ts',
      'lib/__tests__/live-transcription.test.ts',
      'lib/__tests__/huddle-roster.test.ts',
      'lib/__tests__/huddle-ringtone.test.ts',
      'lib/__tests__/native-call-payload.test.ts',
      'lib/__tests__/notification-sound.test.ts',
      'lib/notifications/__tests__/huddle-call-actions.test.ts',
      'hooks/__tests__/useHuddleChat.test.tsx',
      'hooks/__tests__/usePresence.test.tsx',
      'components/team-chat/__tests__/poll-card.rtl.test.tsx',
      'components/team-chat/__tests__/huddle-panels.rtl.test.tsx',
      'lib/__tests__/huddle-captions.test.ts',
      'components/__tests__/huddle-captions.rtl.test.tsx',
      'components/team-chat/__tests__/huddle-wake-note.rtl.test.tsx',
      'components/team-chat/__tests__/huddle-notes-notice.rtl.test.tsx',
    ],
  },
  {
    name: 'desktop',
    cwd: 'apps/desktop',
    cmd: (f) => ['bun', '--no-env-file', 'test', f],
    files: ['src/__tests__/huddle-protocol.test.ts'],
  },
  {
    name: 'e2e',
    cwd: '.',
    cmd: (f) => ['npx', 'playwright', 'test', '--config', 'e2e/local/playwright.config.ts', '--project=chromium', f],
    files: ['e2e/local/huddle-notes.test.ts'],
    optIn: true,
  },
]

function parseArgs(argv: string[]) {
  const only = new Set<string>()
  let e2e = false
  let list = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--e2e') e2e = true
    else if (a === '--list') list = true
    else if (a === '--only') {
      const v = argv[++i]
      if (!v || !LAYERS.some((l) => l.name === v)) throw new Error(`--only takes one of: ${LAYERS.map((l) => l.name).join(', ')}`)
      only.add(v)
    } else throw new Error(`Unknown argument: ${a}`)
  }
  return { only, e2e, list }
}

const { only, e2e, list } = parseArgs(process.argv.slice(2))
const selected = LAYERS.filter((l) => (only.size ? only.has(l.name) : !l.optIn || e2e))
if (e2e && only.size && !only.has('e2e')) selected.push(LAYERS.find((l) => l.name === 'e2e')!)

if (list) {
  for (const layer of selected) for (const file of layer.files) console.log(`${layer.name}\t${layer.cwd}/${file}`)
  process.exit(0)
}

interface Result {
  layer: string
  file: string
  ok: boolean
  seconds: number
  counts: string
}

const results: Result[] = []
for (const layer of selected) {
  console.log(`\n== ${layer.name} ==`)
  for (const file of layer.files) {
    const started = Date.now()
    const [bin, ...args] = layer.cmd(file)
    const run = spawnSync(bin!, args, { cwd: resolve(ROOT, layer.cwd), encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 })
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
    const pass = out.match(/^\s*(\d+) pass/m)?.[1]
    const fail = out.match(/^\s*(\d+) fail/m)?.[1]
    const playwright = out.match(/(\d+) passed/)?.[1]
    const ok = run.status === 0
    const counts = pass !== undefined ? `${pass} pass, ${fail ?? 0} fail` : playwright ? `${playwright} passed` : ok ? 'ok' : 'failed'
    results.push({ layer: layer.name, file, ok, seconds: (Date.now() - started) / 1000, counts })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${file}  (${counts}, ${((Date.now() - started) / 1000).toFixed(1)}s)`)
    if (!ok) console.log(out.split('\n').filter((l) => !l.startsWith('(pass)')).slice(-60).join('\n'))
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} files passed`)
if (failed.length) {
  for (const r of failed) console.log(`  FAILED  ${r.layer}  ${r.file}`)
  process.exit(1)
}
