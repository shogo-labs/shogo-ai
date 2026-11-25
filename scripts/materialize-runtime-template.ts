// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Materialize the `workspace:*` `@shogo-ai/*` pins in a shipped/installed
 * copy of the runtime template (or an SDK example) into a concrete
 * `X.Y.Z` version — always exact, never a `^X.Y.Z` range (SHO-522).
 *
 * Why this exists
 * ---------------
 * `templates/runtime-template/package.json` (and `packages/sdk/examples/*`)
 * reference the SDK as `"@shogo-ai/sdk": "workspace:*"`. That keeps the
 * source from ever going stale — there is no version number to forget to
 * bump. But `workspace:*` only resolves from the monorepo root, so it can
 * NOT be shipped to a pod or installed standalone (`cd templates/
 * runtime-template && bun install` outside the workspace, or a pod that
 * receives the template's `package.json` verbatim). Both would fail with
 * `EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"`.
 *
 * So every boundary that ships the template to a pod or installs it
 * standalone runs this script first to rewrite `workspace:*` -> `X.Y.Z`.
 *
 * Why EXACT, not `^X.Y.Z`
 * -----------------------
 * A caret range is resolved against npm *at install time*, so a pod or a
 * publish build installing from an image that pinned `^2.6.0` silently got
 * 2.6.1 the moment it was published — including the broken 2.6.1 that shipped
 * without `bin/bucket-cli.mjs` (SHO-511). With an exact pin, the SDK a pod
 * installs is the one its image was released with: a bad npm release cannot
 * reach running apps until an image that pins it is released, and that image
 * build runs the tarball gate (SHO-512).
 *
 * Where X.Y.Z comes from
 * ----------------------
 * 1. **Release-tag builds** pass the tag's own version (`SHOGO_SDK_PIN_VERSION`
 *    / `--pin-version`). The SDK for a tag is published by `publish-sdk.yml`
 *    *at the same time* as the image build starts, so the version may not be
 *    on npm yet: `waitForPublishedVersion()` polls the registry until that
 *    exact version appears (default 20 min) and the build FAILS if it never
 *    does. It never falls back to `latest`, so a tag image can never pin the
 *    previous release again (the v2.6.1 image pinned `^2.6.0`).
 * 2. **Everything else** (main/staging pushes, local builds) resolves npm's
 *    `latest` dist-tag, so the pin is always a version that is already
 *    published.
 *
 * Offline / local-dev fallback
 * ----------------------------
 * Resolution needs network. When it fails AND `ALLOW_UNPUBLISHED_SDK_PIN`
 * is set, we fall back to the in-repo `packages/<pkg>/package.json` version
 * and emit a loud warning (the pin is unverified against npm). CI builds,
 * where the published-first guarantee matters, run online and never set the
 * flag, so they can never silently ship an unpublished pin. The fallback is
 * never used for an explicit `--pin-version` (a release must fail loudly
 * instead of pinning something npm does not serve).
 *
 * Usage
 * -----
 *   bun run scripts/materialize-runtime-template.ts [<pkgJsonPath> ...]
 *   bun run scripts/materialize-runtime-template.ts --pin-version 2.6.1 [<pkgJsonPath> ...]
 *   bun run scripts/materialize-runtime-template.ts --wait-for @shogo-ai/sdk@2.6.1
 *   bun run scripts/materialize-runtime-template.ts --print-pin @shogo-ai/sdk
 *
 * With no args it defaults to `templates/runtime-template/package.json`.
 * Each caller (bundle-api.mjs, copy-runtime-template-to-dist.ts, Docker/VM
 * builds) passes the concrete manifest it is about to ship or install.
 * `SHOGO_SDK_PIN_VERSION` is honoured as an alternative to `--pin-version`
 * so a Docker `ARG` can reach the script without rewriting the RUN line.
 *
 * Idempotent: a manifest with no `@shogo-ai/* : workspace:*` deps is left
 * untouched (no-op), so it is safe to run on an already-materialized copy.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// scripts/ sits at the repo root.
const REPO_ROOT = resolve(__dirname, '..')

const DEP_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const

/** The one package a release pins to its own tag version. */
export const SDK_PACKAGE = '@shogo-ai/sdk'

const DEFAULT_WAIT_TIMEOUT_MS = 20 * 60 * 1000
const DEFAULT_WAIT_POLL_MS = 15 * 1000

const versionCache = new Map<string, string>()

const NPM_REGISTRY = (process.env.npm_config_registry || 'https://registry.npmjs.org').replace(/\/+$/, '')

function encodeName(name: string): string {
  // Scoped names must be URL-encoded (@shogo-ai/sdk -> @shogo-ai%2Fsdk).
  return name.replace('/', '%2F')
}

/**
 * Latest published version from the npm registry's `latest` dist-tag, fetched
 * over HTTP. This needs only `fetch` (built into Bun) — no `npm` binary — so it
 * works in minimal Docker images (e.g. Dockerfile.swe-overlay) that ship `bun`
 * but not `npm`/`node`. Returns '' on any failure.
 */
async function fetchLatestFromRegistry(name: string): Promise<string> {
  try {
    const url = `${NPM_REGISTRY}/${encodeName(name)}`
    const res = await fetch(url, { headers: { accept: 'application/json', 'cache-control': 'no-cache' } })
    if (!res.ok) return ''
    const body = (await res.json()) as { 'dist-tags'?: Record<string, string> }
    return body['dist-tags']?.latest ?? ''
  } catch {
    return ''
  }
}

/** Latest published version via the `npm` binary (respects local .npmrc). '' on failure. */
function npmViewVersion(name: string): string {
  try {
    return execFileSync('npm', ['view', name, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

/** True once the registry serves that exact version. Never cached — that is the whole point. */
async function isPublishedOnRegistry(name: string, version: string): Promise<boolean> {
  try {
    // The per-version document is immutable once published (unlike the
    // packument, whose CDN copy lagged long enough for v2.6.0/v2.6.1's
    // `npm install --prefer-online` to keep answering ETARGET). Cache-busted
    // so neither Bun's fetch cache nor an intermediate proxy can hide it.
    const url = `${NPM_REGISTRY}/${encodeName(name)}/${version}?ts=${Date.now()}`
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'cache-control': 'no-cache', pragma: 'no-cache' },
      cache: 'no-store',
    })
    return res.ok
  } catch {
    return false
  }
}

export interface WaitForVersionOptions {
  /** Total time to keep polling. Default 20 min (SHOGO_SDK_WAIT_TIMEOUT_MS). */
  timeoutMs?: number
  /** Delay between polls. Default 15s (SHOGO_SDK_WAIT_POLL_MS). */
  pollIntervalMs?: number
  /** Injectable probe so tests never touch the network. */
  probe?: (name: string, version: string) => Promise<boolean>
  /** Injectable clock/sleep so tests run instantly. */
  sleep?: (ms: number) => Promise<void>
}

export interface WaitForVersionResult {
  name: string
  version: string
  attempts: number
  waitedMs: number
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * Wait until the npm registry serves that **exact** version of a package.
 *
 * This is the fix for the release race (SHO-522): `publish-sdk.yml`'s smoke
 * check went red on v2.6.0 and v2.6.1 because it started installing
 * `@shogo-ai/sdk@<version>` seconds after `npm publish` returned, while the
 * registry's packument still answered `ETARGET`. Polling the immutable
 * per-version document is the reliable readiness signal.
 *
 * Throws — loudly, with the deadline in the message — when the version never
 * appears. Callers must treat that as a failure; falling back to another
 * version is exactly the bug this replaced.
 */
export async function waitForPublishedVersion(
  name: string,
  version: string,
  opts: WaitForVersionOptions = {},
): Promise<WaitForVersionResult> {
  const timeoutMs = opts.timeoutMs ?? envMs('SHOGO_SDK_WAIT_TIMEOUT_MS', DEFAULT_WAIT_TIMEOUT_MS)
  const pollIntervalMs = opts.pollIntervalMs ?? envMs('SHOGO_SDK_WAIT_POLL_MS', DEFAULT_WAIT_POLL_MS)
  const probe = opts.probe ?? isPublishedOnRegistry
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  const startedAt = Date.now()
  let attempts = 0
  // Always probe at least once, even with a zero timeout.
  while (attempts === 0 || Date.now() - startedAt < timeoutMs) {
    attempts++
    if (await probe(name, version)) {
      const waitedMs = Date.now() - startedAt
      console.log(
        `[materialize-runtime-template] ${name}@${version} is on npm ` +
          `(after ${attempts} probe${attempts === 1 ? '' : 's'}, ${Math.round(waitedMs / 1000)}s)`,
      )
      return { name, version, attempts, waitedMs }
    }
    const elapsed = Date.now() - startedAt
    if (elapsed >= timeoutMs) break
    if (attempts === 1 || attempts % 4 === 0) {
      console.log(
        `[materialize-runtime-template] npm does not serve ${name}@${version} yet ` +
          `(attempt ${attempts}, ${Math.round(elapsed / 1000)}s elapsed) — retrying in ${Math.round(pollIntervalMs / 1000)}s`,
      )
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, timeoutMs - elapsed)))
  }

  const waited = Math.round((Date.now() - startedAt) / 1000)
  throw new Error(
    `[materialize-runtime-template] npm never served ${name}@${version} within ${waited}s ` +
      `(${attempts} probe${attempts === 1 ? '' : 's'}). The release cannot pin a version npm does not ` +
      `have — check the publish-sdk job for that tag, then re-run. Refusing to fall back to "latest": ` +
      `that is what pinned the previous release's SDK (v2.6.1 image pinned ^2.6.0).`,
  )
}

export interface MaterializeOptions {
  /**
   * Pin `@shogo-ai/sdk` to exactly this version (a release tag's version)
   * instead of resolving npm `latest`, after waiting for npm to serve it.
   * Defaults to `SHOGO_SDK_PIN_VERSION` when set.
   */
  pinVersion?: string
  /** Forwarded to `waitForPublishedVersion` for the pin. */
  waitTimeoutMs?: number
  waitPollIntervalMs?: number
  /** Injectable readiness probe (tests). */
  probe?: (name: string, version: string) => Promise<boolean>
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>
}

function resolvePin(explicit?: string): string {
  const raw = explicit ?? process.env.SHOGO_SDK_PIN_VERSION ?? ''
  const pin = raw.trim().replace(/^v/, '')
  return pin
}

/**
 * Resolve the version to pin for a single `@shogo-ai/*` package.
 *
 * Tiered so the "latest PUBLISHED" guarantee holds in every environment:
 *   1. npm registry over HTTP (works with just `bun`, no `npm` binary).
 *   2. `npm view` (binary; respects a custom registry / .npmrc when present).
 *   3. in-repo `packages/<pkg>` version — ONLY with ALLOW_UNPUBLISHED_SDK_PIN=1,
 *      and only as a true-offline last resort. This can be AHEAD of npm (the
 *      in-repo SDK is normally bumped before it publishes), so it is unsafe for
 *      a shipped artifact and is loudly warned + opt-in.
 */
async function resolveVersion(name: string): Promise<string> {
  const cached = versionCache.get(name)
  if (cached) return cached

  let version = await fetchLatestFromRegistry(name)
  if (!version) version = npmViewVersion(name)

  if (!version && process.env.ALLOW_UNPUBLISHED_SDK_PIN === '1') {
    const fallback = readInRepoVersion(name)
    if (fallback) {
      console.warn(
        `[materialize-runtime-template] WARNING: could not reach the npm registry for ${name}; ` +
          `falling back to in-repo version ${fallback} (UNVERIFIED — may be ahead of what is ` +
          `published; ALLOW_UNPUBLISHED_SDK_PIN=1). Do NOT use this for a shipped artifact.`,
      )
      version = fallback
    }
  }

  if (!version) {
    throw new Error(
      `[materialize-runtime-template] could not resolve a published version for ${name} ` +
        `(npm registry unreachable). Set ALLOW_UNPUBLISHED_SDK_PIN=1 to fall back to the ` +
        `in-repo version for truly offline builds.`,
    )
  }

  versionCache.set(name, version)
  return version
}

/**
 * Map `@shogo-ai/<pkg>` to its in-repo `packages/<pkg>/package.json`
 * version. Best-effort: returns null if the package isn't found in-tree.
 */
function readInRepoVersion(name: string): string | null {
  const short = name.replace(/^@shogo-ai\//, '')
  const candidate = join(REPO_ROOT, 'packages', short, 'package.json')
  if (!existsSync(candidate)) return null
  try {
    const pkg = JSON.parse(readFileSync(candidate, 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

type VersionResolver = (name: string) => string | Promise<string>

/**
 * @param pkgJsonPath manifest to rewrite in place.
 * @param resolveFn   version resolver (defaults to the npm-registry resolver).
 *                    Injectable so tests can avoid network access.
 * @param opts        pin override for release-tag builds (see `pinVersion`).
 */
export async function materialize(
  pkgJsonPath: string,
  resolveFn: VersionResolver = resolveVersion,
  opts: MaterializeOptions = {},
): Promise<boolean> {
  const abs = isAbsolute(pkgJsonPath) ? pkgJsonPath : resolve(process.cwd(), pkgJsonPath)
  if (!existsSync(abs)) {
    throw new Error(`[materialize-runtime-template] manifest not found: ${abs}`)
  }

  const raw = readFileSync(abs, 'utf8')
  const pkg = JSON.parse(raw)

  const pin = resolvePin(opts.pinVersion)
  const hasSdkWorkspaceDep = DEP_KEYS.some((key) => {
    const spec = pkg[key]?.[SDK_PACKAGE]
    return typeof spec === 'string' && spec.startsWith('workspace:')
  })
  // Wait for the release's own SDK before touching the manifest, so a build
  // that never gets it fails before it writes a partial pin.
  let pinnedVersion: string | null = null
  if (pin && hasSdkWorkspaceDep) {
    await waitForPublishedVersion(SDK_PACKAGE, pin, {
      timeoutMs: opts.waitTimeoutMs,
      pollIntervalMs: opts.waitPollIntervalMs,
      probe: opts.probe,
      sleep: opts.sleep,
    })
    pinnedVersion = pin
  }

  let changed = false
  for (const key of DEP_KEYS) {
    const deps = pkg[key]
    if (!deps || typeof deps !== 'object') continue
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue
      if (!name.startsWith('@shogo-ai/')) {
        // Only @shogo-ai/* are published; a non-@shogo-ai workspace dep in a
        // shipped template would be unresolvable. Surface it loudly.
        throw new Error(
          `[materialize-runtime-template] ${abs}: ${key}.${name} is "${spec}" but ` +
            `is not an @shogo-ai/* package — cannot materialize to a published version.`,
        )
      }
      const version = name === SDK_PACKAGE && pinnedVersion ? pinnedVersion : await resolveFn(name)
      // Exact, deliberately: a range would be re-resolved against npm at
      // install time and could pick up a newer (possibly broken) release.
      deps[name] = version
      changed = true
      console.log(`[materialize-runtime-template] ${name}: ${spec} -> ${version} (${abs})`)
    }
  }

  if (changed) {
    // Preserve the trailing-newline style of the original file.
    const trailing = raw.endsWith('\n') ? '\n' : ''
    writeFileSync(abs, JSON.stringify(pkg, null, 2) + trailing)
  } else {
    console.log(`[materialize-runtime-template] no @shogo-ai/* workspace:* deps in ${abs} — no-op`)
  }

  // Hard guard (mirrors publish-shogo-worker.yml): never let a `workspace:`
  // specifier survive into a manifest we are about to ship or install.
  const after = readFileSync(abs, 'utf8')
  if (after.includes('"workspace:')) {
    throw new Error(
      `[materialize-runtime-template] ${abs} still contains a "workspace:" specifier after ` +
        `materialization — refusing to ship a broken manifest.`,
    )
  }

  return changed
}

interface CliArgs {
  targets: string[]
  pinVersion?: string
  waitFor: { name: string; version: string }[]
  printPin?: string
  waitTimeoutMs?: number
  waitPollIntervalMs?: number
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { targets: [], waitFor: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const v = argv[++i]
      if (!v) throw new Error(`[materialize-runtime-template] ${arg} needs a value`)
      return v
    }
    if (arg === '--pin-version') args.pinVersion = next()
    else if (arg === '--print-pin') args.printPin = next()
    else if (arg === '--timeout-ms') args.waitTimeoutMs = Number(next())
    else if (arg === '--poll-ms') args.waitPollIntervalMs = Number(next())
    else if (arg === '--wait-for') {
      const spec = next()
      const at = spec.lastIndexOf('@')
      if (at <= 0) throw new Error(`[materialize-runtime-template] --wait-for expects <name>@<version>, got "${spec}"`)
      args.waitFor.push({ name: spec.slice(0, at), version: spec.slice(at + 1) })
    } else if (arg.startsWith('-')) {
      throw new Error(`[materialize-runtime-template] unknown flag ${arg}`)
    } else {
      args.targets.push(arg)
    }
  }
  return args
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  for (const { name, version } of args.waitFor) {
    await waitForPublishedVersion(name, version, {
      timeoutMs: args.waitTimeoutMs,
      pollIntervalMs: args.waitPollIntervalMs,
    })
  }

  if (args.printPin) {
    // Repo-independent: used by workflows to learn the exact pin a main-push
    // build will write, so it can be stamped on the image as a label.
    const version = await resolveVersion(args.printPin)
    process.stdout.write(`${version}\n`)
  }

  if (args.targets.length > 0 || (!args.printPin && args.waitFor.length === 0)) {
    const targets = args.targets.length > 0 ? args.targets : [join(REPO_ROOT, 'templates', 'runtime-template', 'package.json')]
    for (const target of targets) {
      await materialize(target, resolveVersion, {
        pinVersion: args.pinVersion,
        waitTimeoutMs: args.waitTimeoutMs,
        waitPollIntervalMs: args.waitPollIntervalMs,
      })
    }
  }
}

// Only run the CLI when invoked directly (`bun run materialize-runtime-template.ts`),
// not when imported by another build script.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
