#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `scripts/run-sync-web.mjs` — the helper that the
 * forge `prePackage` hook calls. Run with:
 *
 *   cd apps/desktop && bun test-forge-config.ts
 *
 * These pin the post-mortem fix for the v1.8.12 / v1.8.13 release where
 * `npx electron-forge package` shipped a Monaco-less `resources/web/`.
 * The npm `prepackage` lifecycle hook used to be the only thing wiring
 * `sync-web.mjs` into the build; `npx` bypasses npm scripts entirely, so
 * the bundle just… didn't get synced. The forge `prePackage` hook fires
 * regardless of how forge is invoked, and these tests pin that wiring.
 *
 * We exercise `runSyncWeb()` directly with an injected `spawnSync` fake
 * so we never actually fork node + don't depend on a real
 * `apps/mobile/dist/` tree. The intent is:
 *
 *   1. happy path        — spawnSync returns status 0, no throw
 *   2. non-zero exit     — throws with a message naming "sync-web.mjs"
 *   3. spawn error       — throws with the spawn error message
 *   4. missing script    — throws BEFORE spawning (catches a deleted file)
 *   5. node args         — invokes `node` with the resolved sync-web.mjs path
 *
 * The helper lives in a sibling .mjs module rather than inlined in
 * `forge.config.ts` precisely so that this test file can import it
 * without triggering the top-level REQUIRED_RESOURCES check that
 * legitimately `process.exit(1)`s a build with no `./resources/bun`.
 */
import type { SpawnSyncReturns } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { runBuildDesktop } from './scripts/run-build-desktop.mjs'
import { runSyncWeb } from './scripts/run-sync-web.mjs'
import { runSyncShogoIde } from './scripts/run-sync-shogo-ide.mjs'

let passed = 0
let failed = 0

function ok(name: string): void {
  passed++
  console.log(`  \x1b[32m✓\x1b[0m ${name}`)
}
function bad(name: string, detail?: unknown): void {
  failed++
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${String(detail)}` : ''}`)
}
function assertTrue(name: string, cond: boolean, detail?: unknown): void {
  if (cond) ok(name)
  else bad(name, detail)
}

const REAL_SCRIPT = path.join(__dirname, 'scripts', 'sync-web.mjs')

interface Call {
  command: string
  args: readonly string[]
}

type SpawnFn = NonNullable<Parameters<typeof runSyncWeb>[0]>

function makeSpawn(
  result: Partial<SpawnSyncReturns<Buffer>>,
  recorder: Call[],
): SpawnFn {
  return ((command: string, args?: readonly string[]) => {
    recorder.push({ command, args: [...(args ?? [])] })
    return {
      pid: 0,
      output: [],
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
      ...result,
    } as SpawnSyncReturns<Buffer>
  }) as SpawnFn
}

console.log('runSyncWeb (forge.config.ts prePackage hook)')

// 1. Happy path — spawnSync returns status 0, runSyncWeb returns void
{
  const calls: Call[] = []
  let threw = false
  try {
    runSyncWeb(makeSpawn({ status: 0 }, calls))
  } catch (err) {
    threw = true
    bad('happy path does not throw', err)
  }
  if (!threw) ok('happy path returns without throwing')
  assertTrue(
    'spawned exactly once',
    calls.length === 1,
    `got ${calls.length} calls`,
  )
  assertTrue(
    'spawned `node`',
    calls[0]?.command === 'node',
    `got command=${calls[0]?.command}`,
  )
  assertTrue(
    'first arg is the resolved sync-web.mjs path',
    typeof calls[0]?.args[0] === 'string' &&
      (calls[0].args[0] as string).endsWith(path.join('scripts', 'sync-web.mjs')),
    `got ${JSON.stringify(calls[0]?.args)}`,
  )
}

// 2. Non-zero exit → throws, message names sync-web.mjs and the exit code
{
  const calls: Call[] = []
  let captured: unknown
  try {
    runSyncWeb(makeSpawn({ status: 1 }, calls))
  } catch (err) {
    captured = err
  }
  assertTrue(
    'non-zero exit throws',
    captured instanceof Error,
    captured ?? '(no error)',
  )
  if (captured instanceof Error) {
    assertTrue(
      'error message names sync-web.mjs',
      captured.message.includes('sync-web.mjs'),
      captured.message,
    )
    assertTrue(
      'error message includes the exit code',
      captured.message.includes('1'),
      captured.message,
    )
    assertTrue(
      'error message includes "refusing"',
      /refus/i.test(captured.message),
      captured.message,
    )
  }
}

// 3. spawn error (process couldn't be forked at all) → throws, surfaces the
//    underlying message
{
  const calls: Call[] = []
  const fakeErr = Object.assign(new Error('ENOENT: node not found'), {
    code: 'ENOENT' as const,
  })
  let captured: unknown
  try {
    runSyncWeb(
      makeSpawn({ status: null, error: fakeErr as NodeJS.ErrnoException }, calls),
    )
  } catch (err) {
    captured = err
  }
  assertTrue(
    'spawn error throws',
    captured instanceof Error,
    captured ?? '(no error)',
  )
  if (captured instanceof Error) {
    assertTrue(
      'error message surfaces the spawn failure',
      captured.message.includes('ENOENT: node not found'),
      captured.message,
    )
  }
}

// 4. Missing sync-web.mjs path → throws BEFORE spawning (catches a stale
//    checkout / deleted file)
{
  const calls: Call[] = []
  const bogus = path.join(os.tmpdir(), 'definitely-not-here', 'sync-web.mjs')
  if (fs.existsSync(bogus)) {
    bad('precondition: bogus path must not exist on disk')
  } else {
    let captured: unknown
    try {
      runSyncWeb(makeSpawn({ status: 0 }, calls), bogus)
    } catch (err) {
      captured = err
    }
    assertTrue(
      'missing script throws',
      captured instanceof Error,
      captured ?? '(no error)',
    )
    if (captured instanceof Error) {
      assertTrue(
        'error message names the bogus path',
        captured.message.includes(bogus),
        captured.message,
      )
    }
    assertTrue(
      'spawnSync is NOT called when script is missing',
      calls.length === 0,
      `got ${calls.length} calls`,
    )
  }
}

// 5. Sanity: the real sync-web.mjs script still exists on disk in this
//    checkout. If it doesn't, runSyncWeb() would throw with `cannot find`
//    against the default path, which means the prePackage hook is dead
//    even before we get to test #4. This is the "did someone delete the
//    script" canary.
assertTrue(
  'real sync-web.mjs is on disk at the expected location',
  fs.existsSync(REAL_SCRIPT),
  `expected ${REAL_SCRIPT}`,
)

// 6. run-sync-web.mjs exposes runSyncWeb as a named export (not just an
//    internal). If someone refactors and forgets to export it, the
//    `import` at the top of this file would fail at module-load time —
//    but we add an explicit assertion so the error in the test runner is
//    descriptive ("not a function") rather than a stack trace from the
//    first call. forge.config.ts dynamically imports the same module
//    inside its prePackage hook, so this also guards that wiring.
assertTrue(
  'run-sync-web.mjs exports runSyncWeb as a callable',
  typeof runSyncWeb === 'function',
)

// 7. Shogo IDE package sync helper is wired and invokes the integrity script.
{
  const scriptPath = path.join(__dirname, 'scripts', 'sync-shogo-ide.mjs')
  const calls: Call[] = []
  let captured: unknown
  try {
    runSyncShogoIde(makeSpawn({ status: 0 }, calls), scriptPath)
  } catch (err) {
    captured = err
  }
  assertTrue(
    'run-sync-shogo-ide.mjs happy path does not throw',
    captured === undefined,
    captured,
  )
  assertTrue(
    'run-sync-shogo-ide.mjs spawned node once',
    calls.length === 1 && calls[0]?.command === 'node',
    JSON.stringify(calls),
  )
  assertTrue(
    'run-sync-shogo-ide.mjs invokes sync-shogo-ide.mjs',
    calls[0]?.args[0] === scriptPath,
    JSON.stringify(calls[0]?.args),
  )
  assertTrue(
    'sync-shogo-ide.mjs exists on disk',
    fs.existsSync(scriptPath),
    `expected ${scriptPath}`,
  )
  assertTrue(
    'run-sync-shogo-ide.mjs exports runSyncShogoIde as a callable',
    typeof runSyncShogoIde === 'function',
  )
}

// 8. Desktop build helper is wired and invokes `npm run build` so Forge cannot
//    package stale `dist/` output.
{
  const calls: Call[] = []
  let captured: unknown
  try {
    runBuildDesktop(makeSpawn({ status: 0 }, calls))
  } catch (err) {
    captured = err
  }
  assertTrue(
    'run-build-desktop.mjs happy path does not throw',
    captured === undefined,
    captured,
  )
  assertTrue(
    'run-build-desktop.mjs invokes npm run build',
    calls.length === 1 && calls[0]?.command === 'npm' && calls[0]?.args.join(' ') === 'run build',
    JSON.stringify(calls),
  )
  assertTrue(
    'run-build-desktop.mjs exports runBuildDesktop as a callable',
    typeof runBuildDesktop === 'function',
  )
}

// 9. forge.config.ts actually wires `runBuildDesktop`, `runSyncWeb` and `runSyncShogoIde` into the `prePackage`
//    hook. We read the file as text rather than importing it because
//    importing fires the top-level REQUIRED_RESOURCES.filter()
//    process.exit(1) on any checkout that hasn't downloaded
//    `./resources/bun` etc., which is most dev machines without an
//    explicit `bun run download-bun`. This textual check is dumb but it
//    catches the specific regression that shipped v1.8.12: the hook
//    being absent / renamed / typo'd. The script-existence check above
//    handles the orthogonal "did someone delete sync-web.mjs" case.
{
  const forgeConfigPath = path.join(__dirname, 'forge.config.ts')
  const forgeConfigSrc = fs.readFileSync(forgeConfigPath, 'utf8')
  assertTrue(
    'forge.config.ts declares a prePackage hook',
    /prePackage\s*:/.test(forgeConfigSrc),
    'no `prePackage:` key found in forge.config.ts',
  )
  assertTrue(
    'forge.config.ts prePackage calls runBuildDesktop',
    /runBuildDesktop\s*\(/.test(forgeConfigSrc),
    'no `runBuildDesktop(` invocation found in forge.config.ts',
  )
  assertTrue(
    'forge.config.ts imports runBuildDesktop from the .mjs helper',
    /run-build-desktop\.mjs/.test(forgeConfigSrc),
    'forge.config.ts no longer references run-build-desktop.mjs',
  )
  assertTrue(
    'forge.config.ts prePackage calls runSyncWeb',
    /runSyncWeb\s*\(/.test(forgeConfigSrc),
    'no `runSyncWeb(` invocation found in forge.config.ts',
  )
  assertTrue(
    'forge.config.ts imports runSyncWeb from the .mjs helper',
    /run-sync-web\.mjs/.test(forgeConfigSrc),
    'forge.config.ts no longer references run-sync-web.mjs',
  )
  assertTrue(
    'forge.config.ts prePackage calls runSyncShogoIde',
    /runSyncShogoIde\s*\(/.test(forgeConfigSrc),
    'no `runSyncShogoIde(` invocation found in forge.config.ts',
  )
  assertTrue(
    'forge.config.ts imports runSyncShogoIde from the .mjs helper',
    /run-sync-shogo-ide\.mjs/.test(forgeConfigSrc),
    'forge.config.ts no longer references run-sync-shogo-ide.mjs',
  )
  assertTrue(
    'forge.config.ts ships resources/apps as an extraResource',
    forgeConfigSrc.includes("'./resources/apps'"),
    'resources/apps is not listed in extraResource',
  )
}

{
  const ideViewsPath = path.join(__dirname, 'src', 'ide-views.ts')
  const ideViewsSrc = fs.readFileSync(ideViewsPath, 'utf8')
  const shogoIdeSrc = fs.readFileSync(path.join(__dirname, 'src', 'shogo-ide.ts'), 'utf8')
  assertTrue(
    'ide-views.ts extracts Code OSS URLs through a dedicated filter',
    /extractCodeOssServerUrl\s*\(/.test(ideViewsSrc),
    'no extractCodeOssServerUrl helper found in ide-views.ts',
  )
  assertTrue(
    'ide-views.ts only accepts local Code OSS server URLs',
    ideViewsSrc.includes("url.hostname === '127.0.0.1'") && ideViewsSrc.includes("url.hostname === 'localhost'"),
    'local server hostname allow-list is missing',
  )
  assertTrue(
    'ide-views.ts no longer resolves the first arbitrary HTTPS URL from launch output',
    !ideViewsSrc.includes('const match = text.match(/https?:\\/\\/[^\\s]+/)'),
    'generic first-URL extraction would incorrectly accept https://nodejs.org inspector help output',
  )
  assertTrue(
    'ide-views.ts resolves the Code OSS launcher before spawning it',
    /function resolveCodeOssLauncher\s*\(/.test(ideViewsSrc) && ideViewsSrc.includes('const launch = resolveCodeOssLauncher(scriptPath, args, env)'),
    'Code OSS launch must resolve an executable before spawn()',
  )
  assertTrue(
    'ide-views.ts does not spawn a bare npx command',
    !ideViewsSrc.includes("command: 'npx'") && !ideViewsSrc.includes("spawn('npx'") && !ideViewsSrc.includes('spawn("npx"'),
    'Code OSS launch must not rely on PATH resolving bare npx',
  )
  assertTrue(
    'ide-views.ts fails with an actionable launcher error when npx cannot be resolved',
    ideViewsSrc.includes('Could not launch Shogo IDE because the required Code OSS launcher executable') && ideViewsSrc.includes('Searched PATH:'),
    'missing launcher error must be deterministic and actionable',
  )
  assertTrue(
    'ide-views.ts launches with the normalized setup command environment',
    ideViewsSrc.includes('...setupCommandEnv()') && !ideViewsSrc.includes('...process.env,\n      SHOGO_IDE_PHASE'),
    'Code OSS launch must not use raw production process.env',
  )
  assertTrue(
    'shogo-ide.ts exposes the normalized setup command environment to the launch path',
    /export function setupCommandEnv\s*\(/.test(shogoIdeSrc),
    'setupCommandEnv must be exported for launch-time executable resolution',
  )
  assertTrue(
    'shogo-ide.ts resolves setup executables before spawning npm or npx',
    /function resolveSetupCommand\s*\(command: string, env: NodeJS\.ProcessEnv\)/.test(shogoIdeSrc) && shogoIdeSrc.includes('const resolvedCommand = resolveSetupCommand(command, env)'),
    'setup commands must resolve npm/npx before spawn()',
  )
  assertTrue(
    'shogo-ide.ts does not probe npm root through a bare npm command',
    !shogoIdeSrc.includes("spawnSync('npm', ['root', '-g']") && shogoIdeSrc.includes("const npmCommand = resolveExecutableFromEnv('npm', env)"),
    'npm CLI discovery must resolve npm before spawnSync()',
  )
}

console.log('')
if (failed > 0) {
  console.log(`\x1b[31m${failed} failed\x1b[0m, ${passed} passed`)
  process.exit(1)
}
console.log(`\x1b[32mall ${passed} tests passed\x1b[0m`)
