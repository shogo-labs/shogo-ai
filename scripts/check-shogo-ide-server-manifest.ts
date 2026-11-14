#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Release gate for the prebuilt Shogo IDE server.
 *
 * The desktop app downloads the server archive named in
 * apps/shogo-ide/code-oss-server.manifest.json. This fails when that manifest
 * no longer matches the repo (patches, product, shogo-core or the pin changed
 * without a rebuild), lacks a desktop target, or — unless `--offline` — points
 * at an asset that is not downloadable at the recorded size.
 *
 *   bun scripts/check-shogo-ide-server-manifest.ts [--offline]
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SERVER_TARGETS,
  SHOGO_IDE_ROOT,
  assetFileName,
  computeArtifactId,
} from '../apps/shogo-ide/scripts/code-oss-artifact-id.mjs'

export interface ServerAsset {
  file: string
  url: string
  sha256: string
  size: number
}

export interface ServerManifest {
  artifactId: string
  commit: string
  inputsHash: string
  assets: Record<string, ServerAsset>
}

export const MANIFEST_PATH = join(SHOGO_IDE_ROOT, 'code-oss-server.manifest.json')

export function validateManifest(
  manifest: ServerManifest,
  expected: { artifactId: string; commit: string; inputsHash: string },
  opts: { repo?: string; targets?: readonly string[] } = {},
): string[] {
  const repo = opts.repo ?? 'shogo-labs/shogo-ai'
  const targets = opts.targets ?? SERVER_TARGETS
  const errors: string[] = []
  if (manifest.commit !== expected.commit) {
    errors.push(`commit ${manifest.commit} does not match code-oss.lock.json (${expected.commit})`)
  }
  if (manifest.inputsHash !== expected.inputsHash) {
    errors.push('inputsHash is stale: patches, product, shogo-core or build scripts changed since the server was built')
  }
  if (manifest.artifactId !== expected.artifactId) {
    errors.push(`artifactId ${manifest.artifactId} should be ${expected.artifactId}`)
  }
  for (const target of targets) {
    const asset = manifest.assets?.[target]
    if (!asset) {
      errors.push(`no asset for ${target}`)
      continue
    }
    const file = assetFileName(expected.artifactId, target)
    if (asset.file !== file) errors.push(`${target}: file ${asset.file} should be ${file}`)
    const url = `https://github.com/${repo}/releases/download/${expected.artifactId}/${file}`
    if (asset.url !== url) errors.push(`${target}: url should be ${url}`)
    if (!/^[0-9a-f]{64}$/.test(asset.sha256 ?? '')) errors.push(`${target}: sha256 is not 64 hex characters`)
    if (!Number.isInteger(asset.size) || asset.size <= 0) errors.push(`${target}: size must be a positive integer`)
  }
  return errors
}

async function checkReachable(manifest: ServerManifest, targets: readonly string[]): Promise<string[]> {
  const errors: string[] = []
  for (const target of targets) {
    const asset = manifest.assets[target]
    if (!asset) continue
    try {
      const res = await fetch(asset.url, { method: 'HEAD', redirect: 'follow' })
      const length = Number(res.headers.get('content-length'))
      if (res.status !== 200) errors.push(`${target}: HEAD ${asset.url} returned ${res.status}`)
      else if (length !== asset.size) errors.push(`${target}: download is ${length} bytes, manifest says ${asset.size}`)
    } catch (error) {
      errors.push(`${target}: HEAD ${asset.url} failed: ${(error as Error).message}`)
    }
  }
  return errors
}

async function main(): Promise<void> {
  const offline = process.argv.includes('--offline')
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`::error::${MANIFEST_PATH} is missing. Run the "Shogo IDE server" workflow (shogo-ide-server.yml) to build and publish the server.`)
    process.exit(1)
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ServerManifest
  const errors = validateManifest(manifest, computeArtifactId())
  if (!offline && errors.length === 0) errors.push(...(await checkReachable(manifest, SERVER_TARGETS)))
  if (errors.length > 0) {
    for (const error of errors) console.error(`::error title=Shogo IDE server manifest::${error}`)
    console.error('Re-run .github/workflows/shogo-ide-server.yml to rebuild and refresh the manifest.')
    process.exit(1)
  }
  console.log(`Shogo IDE server manifest OK: ${manifest.artifactId}${offline ? ' (offline)' : ''}`)
}

if (import.meta.main) {
  await main()
}
