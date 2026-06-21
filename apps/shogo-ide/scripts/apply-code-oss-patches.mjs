#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const upstreamPath = resolve(process.argv[2] ?? join(root, 'upstream/vscode'))
const patchesPath = join(root, 'patches/code-oss')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
  })
  return result
}

function fail(message, result) {
  console.error(message)
  if (result?.stdout) console.error(result.stdout.trim())
  if (result?.stderr) console.error(result.stderr.trim())
  process.exit(1)
}

if (!existsSync(upstreamPath) || !statSync(upstreamPath).isDirectory()) {
  fail(`Code - OSS checkout not found: ${upstreamPath}`)
}

if (!existsSync(join(upstreamPath, '.git'))) {
  fail(`Code - OSS checkout is not a Git repository: ${upstreamPath}`)
}

if (!existsSync(patchesPath) || !statSync(patchesPath).isDirectory()) {
  fail(`Patch directory not found: ${patchesPath}`)
}

const patches = readdirSync(patchesPath)
  .filter((file) => file.endsWith('.patch'))
  .sort()
  .map((file) => join(patchesPath, file))

if (patches.length === 0) {
  console.log('No Code - OSS patches to apply.')
  process.exit(0)
}

for (const patch of patches) {
  const label = basename(patch)
  const check = run('git', ['apply', '--check', patch], { cwd: upstreamPath })
  if (check.status === 0) {
    const apply = run('git', ['apply', patch], { cwd: upstreamPath })
    if (apply.status !== 0) fail(`Failed to apply ${label}`, apply)
    console.log(`Applied ${label}`)
    continue
  }

  const reverseCheck = run('git', ['apply', '--reverse', '--check', patch], { cwd: upstreamPath })
  if (reverseCheck.status === 0) {
    console.log(`Already applied ${label}`)
    continue
  }

  fail(`Patch is neither applicable nor already applied: ${label}`, check)
}
