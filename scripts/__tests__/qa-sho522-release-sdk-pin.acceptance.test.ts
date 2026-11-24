// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Acceptance tests for SHO-522 — a release image must pin the release's own
 * exact SDK, and publish-sdk must not go red on a version npm already serves.
 *
 * These drive the real CLI / real snippets out of the repo against a local
 * stub registry, so they cover the paths the unit tests inject around:
 *
 *   1. the CLI writes the tag's exact version once the registry serves it,
 *      even though `latest` still points at the previous release;
 *   2. a version that never appears exits non-zero and leaves the manifest
 *      byte-identical (never a fallback to `latest` — the v2.6.1 bug);
 *   3. publish-sdk's `--wait-for` readiness gate fails loudly when one of the
 *      seven packages is missing, and passes when all are served;
 *   4. the in-build assertion inside docker/workspace-deps/Dockerfile really
 *      rejects a caret pin and a pin that disagrees with the release;
 *   5. the deploy acceptance step reads the path the runtime image actually
 *      ships (a wrong path would fail every release);
 *   6. deploy.yml derives the release pin from `vX.Y.Z` and from nothing else.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI = join(REPO_ROOT, 'scripts', 'materialize-runtime-template.ts')
const BUN = process.execPath

const servers: { stop: (force?: boolean) => void }[] = []
afterEach(() => {
  while (servers.length) servers.pop()?.stop(true)
})

interface StubOptions {
  /** `latest` dist-tag every stub packument reports. */
  latest?: string
  /** Requests to `<pkg>/<version>` before that version document starts answering. */
  serveAfter?: Record<string, number>
}

/**
 * A minimal npm registry: every `@shogo-ai/*` packument reports `latest`, and a
 * `/@shogo-ai%2F<name>/<version>` document answers 404 until its request count
 * reaches the configured threshold (a registry catching up after publish).
 */
function startRegistry(opts: StubOptions = {}): { port: number; hits: string[] } {
  const latest = opts.latest ?? '2.6.0'
  const serveAfter = opts.serveAfter ?? {}
  const hits: string[] = []
  const counts = new Map<string, number>()
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      const path = decodeURIComponent(url.pathname)
      hits.push(path)
      // /@shogo-ai/<pkg>            -> packument
      // /@shogo-ai/<pkg>/<version>  -> per-version document
      const m = path.match(/^\/@shogo-ai\/([^/]+)(?:\/(.+))?$/)
      if (!m) return new Response('not found', { status: 404 })
      const pkg = m[1]
      const version = m[2]
      if (!version) {
        return Response.json({ name: `@shogo-ai/${pkg}`, 'dist-tags': { latest }, versions: {} })
      }
      const key = `@shogo-ai/${pkg}@${version}`
      const n = (counts.get(key) ?? 0) + 1
      counts.set(key, n)
      const threshold = serveAfter[key] ?? 0
      if (n < threshold) return new Response('{"error":"not found"}', { status: 404 })
      return Response.json({ name: `@shogo-ai/${pkg}`, version })
    },
  })
  servers.push(server)
  return { port: Number(server.port), hits }
}

function tmpDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'qa522-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return dir
}

// Async spawn, deliberately: the stub registry lives in this process, and a
// spawnSync would block the event loop the child is waiting on.
async function spawnAndRead(cmd: string, args: string[], env: Record<string, string>, cwd: string) {
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: `${out}${err}` }
}

async function runCli(args: string[], env: Record<string, string> = {}, cwd = REPO_ROOT) {
  return spawnAndRead(BUN, ['run', CLI, ...args], env, cwd)
}

const sdkTemplate = (extra: Record<string, string> = {}) =>
  JSON.stringify(
    {
      name: 'runtime-template',
      dependencies: { '@shogo-ai/sdk': 'workspace:*', '@shogo-ai/cli': 'workspace:*', hono: '^4.0.0', ...extra },
    },
    null,
    2,
  ) + '\n'

describe('SHO-522 acceptance: a release image pins the release SDK', () => {
  // -------------------------------------------------------------------------
  // 1. The v2.6.1 shape, end to end through the CLI.
  // -------------------------------------------------------------------------
  test('the tag version wins once the registry serves it, even while latest is the previous release', async () => {
    const { port, hits } = startRegistry({ latest: '2.6.0', serveAfter: { '@shogo-ai/sdk@2.6.1': 3 } })
    const dir = tmpDir({ 'package.json': sdkTemplate() })

    const { code, out } = await runCli(['package.json', '--pin-version', '2.6.1', '--poll-ms', '50'], {
      npm_config_registry: `http://127.0.0.1:${port}`,
      SHOGO_SDK_WAIT_TIMEOUT_MS: '20000',
      SHOGO_SDK_WAIT_POLL_MS: '50',
    }, dir)

    expect(out).toContain('@shogo-ai/sdk')
    expect(code).toBe(0)

    const deps = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies
    // The release's own version, exact — not `^2.6.0` (latest) and not a range.
    expect(deps['@shogo-ai/sdk']).toBe('2.6.1')
    expect(deps['@shogo-ai/cli']).toBe('2.6.0')
    expect(deps.hono).toBe('^4.0.0')
    // The readiness signal is the immutable per-version document, polled more
    // than once because the stub only serves it on the third request.
    expect(hits.filter((h) => h === '/@shogo-ai/sdk/2.6.1').length).toBeGreaterThanOrEqual(3)
  })

  // -------------------------------------------------------------------------
  // 2. Never a silent fallback: the build fails and writes nothing.
  // -------------------------------------------------------------------------
  test('a version npm never serves exits non-zero and leaves the manifest byte-identical', async () => {
    const { port } = startRegistry({ latest: '2.6.0', serveAfter: { '@shogo-ai/sdk@2.6.2': 1_000_000 } })
    const dir = tmpDir({ 'package.json': sdkTemplate() })
    const before = readFileSync(join(dir, 'package.json'), 'utf8')

    const { code, out } = await runCli(['package.json', '--pin-version', '2.6.2'], {
      npm_config_registry: `http://127.0.0.1:${port}`,
      SHOGO_SDK_WAIT_TIMEOUT_MS: '400',
      SHOGO_SDK_WAIT_POLL_MS: '100',
    }, dir)

    expect(code).not.toBe(0)
    expect(out).toContain('never served @shogo-ai/sdk@2.6.2')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
  })

  // -------------------------------------------------------------------------
  // 3. publish-sdk's readiness gate (all seven packages, then one install).
  // -------------------------------------------------------------------------
  test('publish-sdk readiness gate is red while one package is missing and green when all are served', async () => {
    const version = '2.6.1'
    const packages = ['core', 'agent', 'db', 'email', 'voice', 'cli', 'sdk']
    const { port } = startRegistry({ latest: '2.6.0', serveAfter: { '@shogo-ai/voice@2.6.1': 999 } })
    const waitArgs = packages.flatMap((p) => ['--wait-for', `@shogo-ai/${p}@${version}`])
    const env = {
      npm_config_registry: `http://127.0.0.1:${port}`,
      SHOGO_SDK_WAIT_TIMEOUT_MS: '500',
      SHOGO_SDK_WAIT_POLL_MS: '100',
    }

    const red = await runCli(waitArgs, env)
    expect(red.code).not.toBe(0)
    expect(red.out).toContain('never served @shogo-ai/voice@2.6.1')

    // Same gate, voice now served by the registry.
    const ok = startRegistry({ latest: '2.6.0' })
    const green = await runCli(waitArgs, { ...env, npm_config_registry: `http://127.0.0.1:${ok.port}` })
    expect(green.code).toBe(0)
    expect(green.out).toContain('@shogo-ai/sdk@2.6.1 is on npm')
  })

  // -------------------------------------------------------------------------
  // 4. The assertion the image build relies on.
  // -------------------------------------------------------------------------
  describe('docker/workspace-deps/Dockerfile in-build assertion', () => {
    const dockerfile = readFileSync(join(REPO_ROOT, 'docker', 'workspace-deps', 'Dockerfile'), 'utf8')
    const match = dockerfile.match(/bun -e '([\s\S]*?)'\s*&&\s*\\/)
    expect(match).not.toBeNull()
    const assertion = match![1]
    /** Run the extracted snippet exactly as the image build does. */
    // The image build runs this inside `/bin/sh -c`, which removes the
    // backslash-newline continuations before bun ever sees the script.
    const shellJoined = assertion.replace(/\\\r?\n\s*/g, ' ')
    const runAssertion = (pin: string, releasePin: string) => {
      const dir = tmpDir({ 'templates/runtime-template/package.json': JSON.stringify({ name: 't', dependencies: { '@shogo-ai/sdk': pin } }) })
      return spawnAndRead(BUN, ['-e', shellJoined], { SHOGO_SDK_PIN_VERSION: releasePin }, dir)
    }

    test('accepts the release version pinned exactly', async () => {
      const { code, out } = await runAssertion('2.6.1', '2.6.1')
      expect(code).toBe(0)
      expect(out).toContain('pinned exactly at 2.6.1')
    })

    test('rejects a caret range (the v2.6.1 image shipped ^2.6.0)', async () => {
      const { code, out } = await runAssertion('^2.6.0', '')
      expect(code).not.toBe(0)
      expect(out).toContain('must be an exact X.Y.Z')
    })

    test('rejects an exact pin that is not the release version', async () => {
      const { code, out } = await runAssertion('2.6.0', '2.6.1')
      expect(code).not.toBe(0)
      expect(out).toContain('was told to pin the release SDK 2.6.1')
    })
  })

  // -------------------------------------------------------------------------
  // 5. The acceptance step must read the path the image really ships.
  // -------------------------------------------------------------------------
  test("the deploy read-back points at the runtime image's own template path", () => {
    const runtimeDockerfile = readFileSync(join(REPO_ROOT, 'packages', 'agent-runtime', 'Dockerfile'), 'utf8')
    expect(runtimeDockerfile).toContain('COPY --from=workspace /app/templates/runtime-template ./templates/runtime-template')
    expect(runtimeDockerfile).toMatch(/^WORKDIR \/app$/m)

    const deploy = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8')
    expect(deploy).toContain('/app/templates/runtime-template/package.json')
    expect(deploy).toContain('docker run --rm --entrypoint cat "$RUNTIME_IMAGE"')
  })

  // -------------------------------------------------------------------------
  // 6. Which tags get a pin at all.
  // -------------------------------------------------------------------------
  test('deploy.yml derives the release pin from vX.Y.Z tags only', () => {
    const deploy = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8')
    const block = deploy
      .split('\n')
      .slice(deploy.split('\n').findIndex((l) => l.includes('RELEASE_SDK_PIN=""')))
      .join('\n')
    const snippet = block.slice(0, block.indexOf('echo "release_sdk_pin=$RELEASE_SDK_PIN"') + 'echo "release_sdk_pin=$RELEASE_SDK_PIN" >> "$GITHUB_OUTPUT"'.length)

    const derive = (currentTag: string, production: string, tagPush: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'qa522-pin-'))
      const outFile = join(dir, 'out')
      writeFileSync(outFile, '')
      const res = spawnSync('bash', ['-c', snippet], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_OUTPUT: outFile,
          IS_PRODUCTION: production,
          IS_TAG_PUSH: tagPush,
          CURRENT_TAG: currentTag,
        },
      })
      expect(res.status).toBe(0)
      return readFileSync(outFile, 'utf8').match(/release_sdk_pin=(.*)/)?.[1] ?? ''
    }

    expect(derive('v2.6.1', 'true', 'true')).toBe('2.6.1')
    expect(derive('v2.7.0-rc.1', 'true', 'true')).toBe('2.7.0-rc.1')
    expect(derive('v2.6', 'true', 'true')).toBe('')
    expect(derive('release-candidate', 'true', 'true')).toBe('')
    expect(derive('v2.6.1', 'false', 'true')).toBe('')
    expect(derive('v2.6.1', 'true', 'false')).toBe('')
  })
})
