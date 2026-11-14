#!/usr/bin/env node
// Identity of a prebuilt Shogo IDE server: the pinned Code - OSS commit plus a
// hash of every repo input that is baked into the build. CI publishes each
// build under a GitHub release named after `artifactId` and rebuilds only when
// this changes; desktop releases refuse a manifest whose id is stale.

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SHOGO_IDE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Desktop targets that must have a prebuilt server. linux-x64 serves dev and CI. */
export const SERVER_TARGETS = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64']

/** Paths (files or directories, relative to apps/shogo-ide) whose content is baked into the server. */
export const SERVER_INPUTS = [
  'code-oss.lock.json',
  'patches/code-oss',
  'product.shogo.template.json',
  'distribution/distribution.manifest.json',
  'distribution/defaults',
  'distribution/builtin-extensions',
  'extensions/shogo-core/package.json',
  'extensions/shogo-core/tsconfig.json',
  'extensions/shogo-core/README.md',
  'extensions/shogo-core/media',
  'extensions/shogo-core/src',
  'scripts/apply-code-oss-patches.mjs',
  'scripts/apply-product-overrides.mjs',
  'scripts/build-code-oss-server.mjs',
  'scripts/materialize-distribution.mjs',
]

function listFiles(root, rel, out) {
  const abs = join(root, rel)
  if (!existsSync(abs)) throw new Error(`Shogo IDE server input missing: ${rel}`)
  if (statSync(abs).isDirectory()) {
    for (const name of readdirSync(abs)) {
      if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue
      listFiles(root, `${rel}/${name}`, out)
    }
  } else {
    out.push(rel)
  }
  return out
}

export function readCodeOssLock(root = SHOGO_IDE_ROOT) {
  const lock = JSON.parse(readFileSync(join(root, 'code-oss.lock.json'), 'utf8'))
  if (!/^[0-9a-f]{40}$/.test(lock.commit ?? '')) throw new Error('code-oss.lock.json: commit must be a full 40-character SHA')
  return lock
}

/** SHA-256 over every input file (sorted POSIX paths, LF line endings). */
export function computeInputsHash(root = SHOGO_IDE_ROOT) {
  const files = SERVER_INPUTS.flatMap((rel) => listFiles(root, rel, [])).map((rel) => rel.split(sep).join('/')).sort()
  const hash = createHash('sha256')
  for (const rel of files) {
    const content = readFileSync(join(root, rel)).toString('latin1').replace(/\r\n/g, '\n')
    hash.update(rel).update('\0').update(content, 'latin1').update('\0')
  }
  return hash.digest('hex')
}

export function computeArtifactId(root = SHOGO_IDE_ROOT) {
  const { commit } = readCodeOssLock(root)
  const inputsHash = computeInputsHash(root)
  return {
    artifactId: `shogo-ide-server-${commit.slice(0, 12)}-${inputsHash.slice(0, 12)}`,
    commit,
    inputsHash,
  }
}

export function assetFileName(artifactId, target) {
  return `${artifactId}-${target}.tar.gz`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = computeArtifactId()
  if (process.argv.includes('--github-output') && process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `artifact_id=${id.artifactId}\ncommit=${id.commit}\ninputs_hash=${id.inputsHash}\n`,
    )
  }
  console.log(JSON.stringify({ ...id, targets: SERVER_TARGETS, root: relative(process.cwd(), SHOGO_IDE_ROOT) || '.' }, null, 2))
}
