// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Release gate: smoke-test the *packed tarball* of every published package.
 *
 * Why this exists (SHO-511 → SHO-512)
 * -----------------------------------
 * SDK 2.6.1 shipped two packaging bugs that every existing check missed:
 *
 *   - `bin/cli.mjs` imported `./bucket-cli.mjs` at the top of the file, and
 *     `bin/bucket-cli.mjs` was not in `package.json#files`, so the published
 *     tarball did not contain it. Every `shogo` command — `generate` included —
 *     threw on module load.
 *   - `exports["./bucket"]` pointed at `dist/bucket/index.js`, but tsup had no
 *     entry for `src/bucket/index.ts`, so no such file was ever emitted.
 *
 * Nothing caught them because every check we had looked at the *source tree*:
 * tests run with `--conditions=development` (so `exports` resolves to `src/`),
 * and inside the monorepo `workspace:*` symlinks make even unpublished files
 * importable. Only the packed artifact is what a consumer installs.
 *
 * What this script does
 * ---------------------
 * For every published package it reproduces the release pipeline end to end in
 * a scratch directory outside the repo:
 *
 *   1. rewrite the manifest the way the publish workflow does (lockstep
 *      version, `workspace:*` → version, strip the `development` export
 *      condition), then `npm pack`;
 *   2. `npm install` the tarballs into a fresh consumer with no monorepo
 *      symlinks and no `development` condition;
 *   3. assert every `exports` target, `bin` file and `types` file named by the
 *      installed manifest actually exists in the tarball;
 *   4. `import()` every `exports` subpath as ESM and `require()` it as CJS;
 *   5. run every `bin` with `--help` and require exit 0;
 *   6. scan published `bin/**` and `dist/**` for relative imports that the
 *      tarball does not contain (the 2.6.1 crash);
 *   7. for `@shogo-ai/sdk`, run `shogo generate` against a tiny fixture and
 *      assert the generated files appear.
 *
 * Optional peer dependencies are reported but not failed on a *subpath*: a
 * consumer who skips `@elevenlabs/react` cannot load `@shogo-ai/sdk/voice/react`,
 * and that is not a packaging bug. A *root* entry that needs an optional peer is
 * printed as an "optional-peer gap" on its own line — the manifest says the peer
 * is optional, so the gate honours that contract, but a root that throws without
 * it is a real papercut for anyone who runs `npm install <pkg>` and imports the
 * root. A missing *required* peer or dependency is always a failure. (The SDK's
 * own root needed `mobx` and `react` this way; both are required peers now.)
 *
 * Usage
 * -----
 *   bun scripts/verify-packed-packages.ts            # build, pack, verify
 *   bun scripts/verify-packed-packages.ts --skip-build
 *   bun scripts/verify-packed-packages.ts --keep     # keep the scratch dir
 *   bun scripts/verify-packed-packages.ts --only sdk,voice
 *
 * `--skip-build` reuses the lockstep `dist/` already on disk; the standalone
 * packages are still built, because their packed bin needs the compiled entry.
 *
 * Exit code 0 means every package is installable and loadable. Any failure
 * prints the package, the check and the detail, and exits 1.
 *
 * Relationship to the static guard
 * --------------------------------
 * `packages/sdk/src/__tests__/sdk-packaging.test.ts` (SHO-511) and
 * `scripts/packaging-lists.ts` check the source tree for hand-kept-list drift
 * in milliseconds. This script is the dynamic half: it proves the artifact
 * that npm actually receives loads. Do not duplicate list checks here — this
 * script asks only "does the installed tarball work?".
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')

/**
 * The packages the release workflows publish. `LOCKSTEP_PACKAGES` all ship at
 * the tag version from `publish-sdk.yml`; `STANDALONE_PACKAGES` ship from
 * `publish-shogo-worker.yml` at their own cadence. A package that is not in
 * one of these lists is not published and is not gated here.
 */
export const LOCKSTEP_PACKAGES = ['core', 'agent', 'db', 'email', 'voice', 'cli', 'sdk'] as const
export const STANDALONE_PACKAGES = ['shogo-worker'] as const
export const PUBLISHED_PACKAGES = [...LOCKSTEP_PACKAGES, ...STANDALONE_PACKAGES] as const

/** Synthetic version so every tarball in a run satisfies its siblings' ranges. */
const GATE_VERSION = '0.0.0-gate'

type Failure = { pkg: string; check: string; detail: string }

type PackageReport = {
  pkg: string
  name: string
  subpaths: number
  loaded: number
  skipped: number
  failures: Failure[]
  notes: string[]
  /** Root entries that need a peer the manifest marks optional. */
  peerGaps: string[]
}

/* ------------------------------------------------------------------------- */
/* process helpers                                                            */
/* ------------------------------------------------------------------------- */

function run(cmd: string, args: string[], cwd: string) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function tail(text: string, lines = 12): string {
  return text.trim().split('\n').slice(-lines).join('\n')
}

/* ------------------------------------------------------------------------- */
/* manifest rewrite (mirrors publish-sdk.yml)                                  */
/* ------------------------------------------------------------------------- */

/**
 * Apply the publish-time manifest mutations in place and return the original
 * text so the caller can restore the checkout. Deliberately identical to the
 * workflow's step: if the gate tested a different manifest than the release
 * ships, it would be testing nothing.
 */
export function rewriteManifestForPublish(pkgDir: string, version: string): string {
  const file = join(pkgDir, 'package.json')
  const original = readFileSync(file, 'utf8')
  const manifest = JSON.parse(original) as Record<string, unknown>

  manifest.version = version

  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = manifest[field] as Record<string, string> | undefined
    if (!deps) continue
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue
      if (name.startsWith('@shogo-ai/')) deps[name] = version
      else delete deps[name]
    }
  }

  const stripDevelopment = (node: unknown): void => {
    if (node == null || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    delete record.development
    for (const value of Object.values(record)) stripDevelopment(value)
  }
  stripDevelopment(manifest.exports)

  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  return original
}

/* ------------------------------------------------------------------------- */
/* packing + installing                                                       */
/* ------------------------------------------------------------------------- */

type Packed = { dir: string; name: string; version: string; tarball: string; files: string[] }

function packPackage(dir: string, destination: string): Packed {
  const pkgDir = join(REPO_ROOT, 'packages', dir)
  const original = rewriteManifestForPublish(pkgDir, GATE_VERSION)
  try {
    const result = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], pkgDir)
    if (result.status !== 0) {
      throw new Error(`npm pack failed in packages/${dir}:\n${tail(result.stderr || result.stdout)}`)
    }
    const [meta] = JSON.parse(result.stdout) as Array<{
      name: string
      version: string
      filename: string
      files: Array<{ path: string }>
    }>
    return {
      dir,
      name: meta.name,
      version: meta.version,
      tarball: join(destination, meta.filename),
      files: meta.files.map((entry) => entry.path),
    }
  } finally {
    writeFileSync(join(pkgDir, 'package.json'), original)
  }
}

function installConsumer(consumerDir: string, tarballs: string[]): void {
  mkdirSync(consumerDir, { recursive: true })
  writeFileSync(
    join(consumerDir, 'package.json'),
    `${JSON.stringify({ name: 'shogo-pack-gate-consumer', private: true }, null, 2)}\n`,
  )
  // No --legacy-peer-deps: a consumer following the README runs a plain
  // `npm install`, which installs every *required* peer. Skipping that would
  // hide a package whose root entry needs a peer the manifest calls optional
  // (that is how 2.6.1 shipped a root that threw MODULE_NOT_FOUND on `mobx`).
  const result = run(
    'npm',
    ['install', '--no-audit', '--no-fund', '--ignore-scripts', ...tarballs],
    consumerDir,
  )
  if (result.status !== 0) {
    throw new Error(`npm install failed in ${consumerDir}:\n${tail(result.stderr || result.stdout)}`)
  }
}

/* ------------------------------------------------------------------------- */
/* the probe: runs inside the consumer, as a real consumer would               */
/* ------------------------------------------------------------------------- */

const PROBE_SOURCE = String.raw`
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { names } = JSON.parse(process.argv[2])
const nm = join(process.cwd(), 'node_modules')

const readManifest = (name) => JSON.parse(readFileSync(join(nm, name, 'package.json'), 'utf8'))

// Every peer dependency of anything installed here, and whether the manifest
// marks it optional. A missing optional peer is a consumer-side install gap; a
// missing required peer or dependency is a broken promise.
const peers = new Map()
for (const name of names) {
  const manifest = readManifest(name)
  for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
    peers.set(peer, Boolean(manifest.peerDependenciesMeta?.[peer]?.optional))
  }
}

const leaves = (node, out) => {
  if (typeof node === 'string') { out.push(node); return out }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) leaves(value, out)
  }
  return out
}

// A missing bare specifier that is a declared peer is a consumer-side install
// gap; a missing relative/absolute path is our own tarball being incomplete.
const classify = (error, key) => {
  const message = String(error && error.message ? error.message : error)
  const missingPackage = /Cannot find package '([^']+)'/.exec(message)
  if (missingPackage) {
    if (peers.has(missingPackage[1])) {
      const kind = peers.get(missingPackage[1]) ? 'optional-peer' : 'peer'
      return { kind, spec: missingPackage[1], message, key }
    }
    return { kind: 'fail', spec: missingPackage[1], message }
  }
  const missingModule = /Cannot find module '([^']+)'/.exec(message)
  if (missingModule) {
    const spec = missingModule[1]
    if (!spec.startsWith('.') && !spec.startsWith('/') && peers.has(spec)) {
      const kind = peers.get(spec) ? 'optional-peer' : 'peer'
      return { kind, spec, message, key }
    }
    return { kind: 'fail', spec, message }
  }
  return { kind: 'fail', spec: null, message }
}

const report = []
for (const name of names) {
  const manifest = readManifest(name)
  const dir = join(nm, name)
  const pkg = { name, missing: [], subpaths: [] }

  const exportsMap = manifest.exports
  const entries = typeof exportsMap === 'string' ? { '.': exportsMap } : (exportsMap ?? {})

  for (const [key, value] of Object.entries(entries)) {
    const targets = leaves(value, [])
    for (const target of targets) {
      if (!existsSync(join(dir, target))) pkg.missing.push({ key, target })
    }

    const specifier = key === '.' ? name : name + key.slice(1)
    const row = { key, esm: 'absent', cjs: 'absent' }
    const conditions = typeof value === 'string' ? { '.': value } : value
    const has = (condition) => Boolean(conditions && typeof conditions === 'object' && condition in conditions)

    // A package that ships TypeScript source (the worker exports ./src/*.ts)
    // cannot be imported by plain Node. Existence is the whole check there.
    const importable = targets.some((target) => /\.(mjs|cjs|js)$/.test(target))
    if (!importable) {
      row.esm = 'skip'
      row.cjs = 'skip'
      row.skipReason = 'typescript source'
      pkg.subpaths.push(row)
      continue
    }

    if (has('import') || has('module') || has('default')) {
      try {
        const loaded = await import(specifier)
        row.esm = 'ok'
        row.esmExports = Object.keys(loaded).length
      } catch (error) {
        row.esm = classify(error, key)
      }
    }
    if (has('require')) {
      try {
        const loaded = require(specifier)
        row.cjs = 'ok'
        row.cjsExports = Object.keys(loaded ?? {}).length
      } catch (error) {
        row.cjs = classify(error, key)
      }
    }
    pkg.subpaths.push(row)
  }

  // main / types / bin targets are not part of the exports map but the
  // installed manifest still promises them.
  for (const field of ['main', 'module', 'types', 'typings']) {
    const target = manifest[field]
    if (typeof target === 'string' && !existsSync(join(dir, target))) {
      pkg.missing.push({ key: field, target })
    }
  }
  const bins = typeof manifest.bin === 'string' ? { [manifest.name]: manifest.bin } : (manifest.bin ?? {})
  for (const [binName, target] of Object.entries(bins)) {
    if (!existsSync(join(dir, target))) pkg.missing.push({ key: 'bin:' + binName, target })
  }

  report.push(pkg)
}

process.stdout.write(JSON.stringify({ report }))
`

/* ------------------------------------------------------------------------- */
/* checks                                                                     */
/* ------------------------------------------------------------------------- */

function nodeExecutable(): string {
  const found = spawnSync('node', ['--version'], { encoding: 'utf8' })
  return found.status === 0 ? 'node' : process.execPath
}

/**
 * Relative imports in a published bin script. `bin/cli.mjs` hands subcommand
 * paths to `loadSubcommand('./bucket-cli.mjs')`, so a plain `import` regex is
 * not enough — this catches any quoted sibling path ending in a known suffix.
 */
function binRelativeImports(source: string): string[] {
  const specifiers = new Set<string>()
  for (const match of source.matchAll(/['"](\.{1,2}\/[^'"\n]+\.(?:mjs|cjs|js|json))['"]/g)) {
    specifiers.add(match[1])
  }
  return [...specifiers]
}

function scanBinScripts(pkgName: string, pkgDir: string, manifest: Record<string, unknown>): Failure[] {
  const failures: Failure[] = []
  const bins = typeof manifest.bin === 'string' ? { [pkgName]: manifest.bin } : ((manifest.bin ?? {}) as Record<string, string>)
  for (const [binName, target] of Object.entries(bins)) {
    const binPath = join(pkgDir, target)
    if (!existsSync(binPath)) continue
    const source = readFileSync(binPath, 'utf8')
    for (const specifier of binRelativeImports(source)) {
      if (!existsSync(resolve(dirname(binPath), specifier))) {
        failures.push({
          pkg: pkgName,
          check: 'bin relative import',
          detail: `${binName} (${target}) imports '${specifier}', which the tarball does not contain`,
        })
      }
    }
  }
  return failures
}

function runBins(pkgName: string, pkgDir: string, manifest: Record<string, unknown>, cwd: string): Failure[] {
  const failures: Failure[] = []
  const bins = typeof manifest.bin === 'string' ? { [pkgName]: manifest.bin } : ((manifest.bin ?? {}) as Record<string, string>)
  for (const [binName, target] of Object.entries(bins)) {
    const binPath = join(pkgDir, target)
    if (!existsSync(binPath)) {
      failures.push({ pkg: pkgName, check: 'bin missing', detail: `${binName} → ${target} is not in the tarball` })
      continue
    }
    const result = run(nodeExecutable(), [binPath, '--help'], cwd)
    if (result.status !== 0) {
      failures.push({
        pkg: pkgName,
        check: 'bin --help',
        detail: `${binName} exited ${result.status}\n${tail(result.stderr || result.stdout)}`,
      })
    }
  }
  return failures
}

/**
 * Relative imports inside the published `dist/` bundles. tsup splits chunks and
 * re-exports across them, so a chunk that `files` excludes (or an entry whose
 * target was never emitted) only shows up as a runtime MODULE_NOT_FOUND in the
 * consumer. Only quoted specifiers with a file suffix are checked: tsup's
 * generator bundles contain template strings of *generated* code, and dynamic
 * targets (`./${name}.types`) are not literals we can resolve.
 */
function scanDistRefs(pkgName: string, pkgDir: string): Failure[] {
  const distDir = join(pkgDir, 'dist')
  if (!existsSync(distDir)) return []
  const failures: Failure[] = []
  const specifierPattern = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](\.[^'"]+)['"]/g
  const fileSuffix = /\.(?:mjs|cjs|js|json|d\.ts)$/

  const walk = (dir: string): string[] => {
    const found: string[] = []
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) found.push(...walk(full))
      else if (/\.(?:mjs|cjs|js)$/.test(name)) found.push(full)
    }
    return found
  }

  for (const file of walk(distDir)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(specifierPattern)) {
      const specifier = match[1]
      if (!fileSuffix.test(specifier)) continue
      if (existsSync(resolve(dirname(file), specifier))) continue
      failures.push({
        pkg: pkgName,
        check: 'dist relative import',
        detail: `${file.slice(pkgDir.length + 1)} imports '${specifier}', which the tarball does not contain`,
      })
    }
  }
  return failures
}

/**
 * `shogo generate` in a throwaway project: one Prisma model, a project-level
 * `scripts/generate.ts` and a `prisma` shim on the local bin path so the check
 * does not reach the network. Proves the CLI's real code path runs, which a
 * bare `--help` does not.
 */
function runSdkGenerateFixture(sdkDir: string, scratch: string): Failure[] {
  const fixture = join(scratch, 'generate-fixture')
  mkdirSync(join(fixture, 'prisma'), { recursive: true })
  mkdirSync(join(fixture, 'scripts'), { recursive: true })
  mkdirSync(join(fixture, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(fixture, 'package.json'), `${JSON.stringify({ name: 'gate-fixture', private: true }, null, 2)}\n`)
  writeFileSync(
    join(fixture, 'prisma', 'schema.prisma'),
    'datasource db {\n  provider = "sqlite"\n  url      = env("DATABASE_URL")\n}\n\nmodel Widget {\n  id   String @id @default(cuid())\n  name String\n}\n',
  )
  writeFileSync(
    join(fixture, 'scripts', 'generate.ts'),
    [
      "import { mkdirSync, writeFileSync } from 'node:fs'",
      "mkdirSync('src/generated', { recursive: true })",
      "writeFileSync('src/generated/types.tsx', '// generated by the gate fixture\\n')",
      "writeFileSync('src/generated/index.tsx', 'export {}\\n')",
      "console.log('[gate] fixture generate ran')",
      '',
    ].join('\n'),
  )
  const shim = join(fixture, 'node_modules', '.bin', 'prisma')
  writeFileSync(shim, '#!/bin/sh\necho "[gate] prisma shim"\nexit 0\n')
  spawnSync('chmod', ['+x', shim])

  const binPath = join(sdkDir, 'bin', 'cli.mjs')
  const result = run(nodeExecutable(), [binPath, 'generate'], fixture)
  const failures: Failure[] = []
  if (result.status !== 0) {
    failures.push({
      pkg: '@shogo-ai/sdk',
      check: 'shogo generate',
      detail: `exited ${result.status}\n${tail(result.stderr || result.stdout)}`,
    })
    return failures
  }
  for (const generated of ['src/generated/types.tsx', 'src/generated/index.tsx']) {
    if (!existsSync(join(fixture, generated))) {
      failures.push({
        pkg: '@shogo-ai/sdk',
        check: 'shogo generate',
        detail: `ran but did not produce ${generated}\n${tail(result.stdout)}`,
      })
    }
  }
  return failures
}

/**
 * The dual-package hazard QA flagged on SHO-511: `@shogo-ai/sdk`'s root entry
 * and its `./bucket` entry are separate tsup bundles, so in CJS each inlines
 * its own `BucketError` class and `instanceof` across the two entries is false.
 * It is pre-existing tsup behaviour, not a regression, so the gate records it
 * rather than failing — but it fails loudly if the ESM side ever diverges too,
 * which would mean the bundling changed.
 */
function checkDualPackageIdentity(consumerDir: string): string[] {
  // The probe must live inside the consumer: ESM resolves bare specifiers from
  // the importing file's directory, not from the process cwd.
  const probe = join(consumerDir, 'shogo-gate-dual-package.mjs')
  writeFileSync(
    probe,
    String.raw`
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const out = {}
const esmRoot = await import('@shogo-ai/sdk')
const esmBucket = await import('@shogo-ai/sdk/bucket')
const bucketExport = ['BucketError', 'BucketClient', 'ShogoBucketError'].find((name) => name in esmRoot)
out.esm = bucketExport ? esmRoot[bucketExport] === esmBucket[bucketExport] : null
const cjsRoot = require('@shogo-ai/sdk')
const cjsBucket = require('@shogo-ai/sdk/bucket')
out.cjs = bucketExport ? cjsRoot[bucketExport] === cjsBucket[bucketExport] : null
out.export = bucketExport ?? null
process.stdout.write(JSON.stringify(out))
`,
  )
  const result = run(nodeExecutable(), [probe], consumerDir)
  if (result.status !== 0) {
    return [`dual-package probe failed to run: ${tail(result.stderr || result.stdout, 4)}`]
  }
  const notes: string[] = []
  try {
    const parsed = JSON.parse(result.stdout) as { esm: boolean | null; cjs: boolean | null; export: string | null }
    if (parsed.export == null) return []
    if (parsed.esm === false) {
      notes.push(`ESM identity broken: ${parsed.export} from the root and ./bucket entries differ (expected identical)`)
    }
    if (parsed.cjs === false) {
      notes.push(
        `known hazard: CJS inlines a separate ${parsed.export} per entry, so instanceof across the root and ./bucket is false (pre-existing tsup behaviour)`,
      )
    }
  } catch {
    notes.push(`dual-package probe returned unparseable output: ${tail(result.stdout, 3)}`)
  }
  return notes
}

/* ------------------------------------------------------------------------- */
/* driver                                                                     */
/* ------------------------------------------------------------------------- */

function parseArgs(argv: string[]) {
  const options = { skipBuild: false, keep: false, only: null as string[] | null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--skip-build') options.skipBuild = true
    else if (arg === '--keep') options.keep = true
    else if (arg === '--only') {
      const value = argv[index + 1] ?? ''
      options.only = value.split(',').map((entry) => entry.trim()).filter(Boolean)
      index += 1
    }
  }
  return options
}

function build(skipPackages: boolean): void {
  if (!skipPackages) {
    const packages = run('bun', ['run', 'build:packages'], REPO_ROOT)
    if (packages.status !== 0) {
      throw new Error(`bun run build:packages failed:\n${tail(packages.stderr || packages.stdout)}`)
    }
  }
  // The standalone packages publish compiled entry points too, so their build
  // is not optional: without it the worker's tarball ships no `dist/cli.mjs`
  // and its bin falls back to TypeScript source that needs a `tsx` a consumer
  // does not have. It is a single fast `bun build`, so it always runs.
  for (const dir of STANDALONE_PACKAGES) {
    const built = run('bun', ['run', 'build'], join(REPO_ROOT, 'packages', dir))
    if (built.status !== 0) {
      throw new Error(`bun run build in packages/${dir} failed:\n${tail(built.stderr || built.stdout)}`)
    }
  }
}

function main(): number {
  const options = parseArgs(process.argv.slice(2))
  const selected: string[] = options.only
    ? PUBLISHED_PACKAGES.filter((dir) => options.only!.includes(dir))
    : [...PUBLISHED_PACKAGES]

  if (selected.length === 0) {
    console.error(`[packed-gate] no package matched --only; known: ${PUBLISHED_PACKAGES.join(', ')}`)
    return 1
  }

  const scratch = mkdtempSync(join(tmpdir(), 'shogo-packed-gate-'))
  const failures: Failure[] = []
  const reports: PackageReport[] = []

  const cleanup = () => {
    if (!options.keep) rmSync(scratch, { recursive: true, force: true })
    else console.log(`[packed-gate] scratch kept at ${scratch}`)
  }

  try {
    if (!options.skipBuild) {
      console.log('[packed-gate] building packages (dist must exist before packing)')
    } else {
      console.log('[packed-gate] --skip-build: reusing the dist already on disk for the lockstep packages')
    }
    build(options.skipBuild)

    const tarballDir = join(scratch, 'tarballs')
    mkdirSync(tarballDir, { recursive: true })
    // Pack everything: a lockstep package's manifest points at its siblings at
    // the gate version, so the install group has to be complete even when the
    // report is narrowed with --only.
    const packed: Packed[] = []
    for (const dir of PUBLISHED_PACKAGES) {
      const artifact = packPackage(dir, tarballDir)
      packed.push(artifact)
      console.log(`[packed-gate] packed ${artifact.name}@${artifact.version} (${artifact.files.length} files)`)
    }

    // One consumer for every published package: the lockstep manifests point at
    // their siblings at the gate version and the worker points at @shogo-ai/sdk,
    // so all of them have to resolve to the local tarballs. Each package's bin is
    // invoked by absolute path, so the `shogo` bin name shared by the SDK and the
    // worker does not matter.
    const groups: Array<{ label: string; members: Packed[] }> = [
      { label: 'packages', members: packed },
    ]

    for (const group of groups) {
      const consumerDir = join(scratch, `consumer-${group.label}`)
      const names = group.members.map((member) => member.name)
      console.log(`[packed-gate] installing ${names.join(', ')} into a clean consumer`)
      installConsumer(consumerDir, group.members.map((member) => member.tarball))

      const probeFile = join(consumerDir, 'shogo-gate-probe.mjs')
      writeFileSync(probeFile, PROBE_SOURCE)
      const probe = run(nodeExecutable(), [probeFile, JSON.stringify({ names })], consumerDir)
      if (probe.status !== 0) {
        failures.push({
          pkg: group.label,
          check: 'probe',
          detail: `probe exited ${probe.status}\n${tail(probe.stderr || probe.stdout)}`,
        })
        continue
      }

      const { report } = JSON.parse(probe.stdout) as {
        report: Array<{
          name: string
          missing: Array<{ key: string; target: string }>
          subpaths: Array<{
            key: string
            esm: string | { kind: string; spec: string | null; message: string; key?: string }
            cjs: string | { kind: string; spec: string | null; message: string; key?: string }
          }>
        }>
      }

      for (const entry of report) {
        const member = group.members.find((candidate) => candidate.name === entry.name)
        if (member && !selected.includes(member.dir)) continue
        const pkgDir = join(consumerDir, 'node_modules', ...entry.name.split('/'))
        const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Record<string, unknown>
        const pkgFailures: Failure[] = []
        let loaded = 0
        let skipped = 0
        const pkgNotes: string[] = []
        const peerGaps: string[] = []

        for (const miss of entry.missing) {
          pkgFailures.push({
            pkg: entry.name,
            check: 'missing file',
            detail: `${miss.key} → ${miss.target} is named by the installed manifest but is not in the tarball`,
          })
        }

        for (const row of entry.subpaths) {
          for (const [mode, value] of [
            ['esm', row.esm],
            ['cjs', row.cjs],
          ] as const) {
            if (value === 'absent') continue
            if (value === 'skip') {
              skipped += 1
              continue
            }
            if (value === 'ok') {
              loaded += 1
              continue
            }
            if (typeof value === 'object' && value.kind === 'peer') {
              // A *required* peer the consumer did not get is a broken promise:
              // a plain `npm install` installs required peers, so its absence
              // means the manifest and the code disagree.
              pkgFailures.push({
                pkg: entry.name,
                check: `exports ${mode} peer`,
                detail: `${row.key} needs required peer '${value.spec}', which the consumer did not get`,
              })
              continue
            }
            if (typeof value === 'object' && value.kind === 'optional-peer') {
              // A subpath may legitimately need an optional peer the consumer
              // did not install. The root entry may not: `npm install <pkg>` is
              // the documented install and leaves optional peers out, so a root
              // that needs one throws for every consumer. Reported, not failed —
              // the manifest's own contract says the peer is optional — but the
              // gap gets its own line so it cannot be missed.
              if (value.key === '.') {
                peerGaps.push(
                  `${entry.name} root requires optional peer '${value.spec}' — \`npm install ${entry.name}\` does not install it`,
                )
                continue
              }
              skipped += 1
              pkgNotes.push(`${row.key} (${mode}) needs optional peer '${value.spec}' — not installed in the consumer`)
              continue
            }
            const detail = typeof value === 'object' ? value.message : String(value)
            pkgFailures.push({
              pkg: entry.name,
              check: `exports ${mode}`,
              detail: `${row.key} → ${detail.split('\n')[0]}`,
            })
          }
        }

        pkgFailures.push(...scanBinScripts(entry.name, pkgDir, manifest))
        pkgFailures.push(...scanDistRefs(entry.name, pkgDir))
        pkgFailures.push(...runBins(entry.name, pkgDir, manifest, scratch))

        if (entry.name === '@shogo-ai/sdk') {
          pkgFailures.push(...runSdkGenerateFixture(pkgDir, scratch))
          pkgNotes.push(...checkDualPackageIdentity(consumerDir))
        }

        reports.push({
          pkg: member?.dir ?? entry.name,
          name: entry.name,
          subpaths: entry.subpaths.length,
          loaded,
          skipped,
          failures: pkgFailures,
          notes: pkgNotes,
          peerGaps,
        })
        failures.push(...pkgFailures)
      }
    }

  } finally {
    cleanup()
  }

  console.log('')
  console.log('[packed-gate] report')
  for (const report of reports) {
    const status = report.failures.length === 0 ? 'PASS' : 'FAIL'
    console.log(
      `  ${status}  ${report.name} — ${report.subpaths} exports subpaths, ${report.loaded} loaded, ${report.skipped} skipped (optional peers)`,
    )
    for (const note of report.notes) console.log(`        note: ${note}`)
    for (const gap of new Set(report.peerGaps)) console.log(`        ⚠ optional-peer gap: ${gap}`)
    for (const failure of report.failures) console.log(`        ✗ ${failure.check}: ${failure.detail}`)
  }

  const peerGaps = [...new Set(reports.flatMap((report) => report.peerGaps))]
  if (peerGaps.length > 0) {
    console.log('')
    console.log(`[packed-gate] ${peerGaps.length} optional-peer gap(s) — the manifest says optional, the root entry needs it:`)
    for (const gap of peerGaps) console.log(`  ⚠ ${gap}`)
  }

  if (failures.length > 0) {
    console.error('')
    console.error(`[packed-gate] FAILED — ${failures.length} problem(s) in the packed tarballs`)
    for (const failure of failures) {
      console.error(`  ${failure.pkg} — ${failure.check}: ${failure.detail}`)
    }
    return 1
  }

  console.log('')
  console.log(`[packed-gate] OK — ${reports.length} packed package(s) install and load`)
  return 0
}

if (import.meta.main) {
  process.exit(main())
}
