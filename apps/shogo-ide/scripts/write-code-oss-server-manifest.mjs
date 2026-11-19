#!/usr/bin/env node
// Write apps/shogo-ide/code-oss-server.manifest.json from a directory of built
// server archives (each with its `.sha256` sidecar). The desktop app ships this
// file and downloads the asset for its platform on first "Open in Shogo IDE".
//
//   node scripts/write-code-oss-server-manifest.mjs --dir <artifacts> [--repo owner/name]

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SERVER_TARGETS, SHOGO_IDE_ROOT, assetFileName, computeArtifactId } from './code-oss-artifact-id.mjs'

export const MANIFEST_PATH = join(SHOGO_IDE_ROOT, 'code-oss-server.manifest.json')

export function releaseAssetUrl(repo, artifactId, file) {
  return `https://github.com/${repo}/releases/download/${artifactId}/${file}`
}

/** Parse a `sha256sum`-format sidecar: `<64 hex>  <file>`. */
export function parseSha256Sidecar(text) {
  const hex = text.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`Not a sha256 sidecar: ${JSON.stringify(text.slice(0, 80))}`)
  return hex
}

export function buildManifest({ dir, repo, id = computeArtifactId(), targets = SERVER_TARGETS }) {
  const assets = {}
  for (const target of targets) {
    const file = assetFileName(id.artifactId, target)
    const archive = join(dir, file)
    assets[target] = {
      file,
      url: releaseAssetUrl(repo, id.artifactId, file),
      sha256: parseSha256Sidecar(readFileSync(`${archive}.sha256`, 'utf8')),
      size: statSync(archive).size,
    }
  }
  return { artifactId: id.artifactId, commit: id.commit, inputsHash: id.inputsHash, assets }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const value = (flag) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  const dir = value('--dir')
  if (!dir) {
    console.error('Usage: node scripts/write-code-oss-server-manifest.mjs --dir <artifacts> [--repo owner/name]')
    process.exit(1)
  }
  const manifest = buildManifest({ dir: resolve(dir), repo: value('--repo') ?? 'shogo-labs/shogo-ai' })
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Wrote ${MANIFEST_PATH} for ${manifest.artifactId}`)
}
