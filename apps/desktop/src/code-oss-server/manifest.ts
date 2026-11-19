// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The prebuilt Shogo IDE server manifest (apps/shogo-ide/code-oss-server.manifest.json,
 * written by .github/workflows/shogo-ide-server.yml and shipped in the app's
 * resources). Electron-free so it can be unit tested.
 */
import fs from 'node:fs'

export type ServerTarget = 'win32-x64' | 'darwin-arm64' | 'darwin-x64' | 'linux-x64'

export const SERVER_TARGETS: readonly ServerTarget[] = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64']

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
  assets: Partial<Record<ServerTarget, ServerAsset>>
}

export class UnsupportedTargetError extends Error {
  constructor(readonly target: string) {
    super(`Shogo IDE is not available for ${target} yet.`)
    this.name = 'UnsupportedTargetError'
  }
}

export function serverTarget(platform: string = process.platform, arch: string = process.arch): ServerTarget | null {
  const target = `${platform}-${arch}`
  return (SERVER_TARGETS as readonly string[]).includes(target) ? (target as ServerTarget) : null
}

function invalid(reason: string): never {
  throw new Error(`Invalid Shogo IDE server manifest: ${reason}`)
}

export function parseServerManifest(raw: unknown): ServerManifest {
  if (!raw || typeof raw !== 'object') invalid('not an object')
  const m = raw as Record<string, unknown>
  if (typeof m.artifactId !== 'string' || !/^shogo-ide-server-[0-9a-f]{12}-[0-9a-f]{12}$/.test(m.artifactId)) invalid('artifactId')
  if (typeof m.commit !== 'string' || !/^[0-9a-f]{40}$/.test(m.commit)) invalid('commit')
  if (typeof m.inputsHash !== 'string' || !/^[0-9a-f]{64}$/.test(m.inputsHash)) invalid('inputsHash')
  if (!m.assets || typeof m.assets !== 'object') invalid('assets')
  const assets: ServerManifest['assets'] = {}
  for (const [target, value] of Object.entries(m.assets as Record<string, unknown>)) {
    if (!(SERVER_TARGETS as readonly string[]).includes(target)) continue
    const a = value as Record<string, unknown>
    if (typeof a?.file !== 'string' || !/^[\w.-]+\.tar\.gz$/.test(a.file)) invalid(`${target}.file`)
    if (typeof a.url !== 'string' || !/^https:\/\//.test(a.url)) invalid(`${target}.url`)
    if (typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256)) invalid(`${target}.sha256`)
    if (typeof a.size !== 'number' || !Number.isInteger(a.size) || a.size <= 0) invalid(`${target}.size`)
    assets[target as ServerTarget] = { file: a.file, url: a.url, sha256: a.sha256, size: a.size }
  }
  return { artifactId: m.artifactId, commit: m.commit, inputsHash: m.inputsHash, assets }
}

export function loadServerManifest(manifestPath: string): ServerManifest {
  if (!fs.existsSync(manifestPath)) {
    throw new Error('This build of Shogo does not include the Shogo IDE server manifest.')
  }
  return parseServerManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
}

/**
 * The asset to download for `target`. `SHOGO_IDE_SERVER_BASE_URL` swaps the
 * host (mirrors, tests) while keeping the file name and checksum.
 */
export function resolveServerAsset(
  manifest: ServerManifest,
  target: ServerTarget,
  env: NodeJS.ProcessEnv = process.env,
): ServerAsset {
  const asset = manifest.assets[target]
  if (!asset) throw new UnsupportedTargetError(target)
  const base = env.SHOGO_IDE_SERVER_BASE_URL?.trim()
  if (!base) return asset
  return { ...asset, url: `${base.replace(/\/+$/, '')}/${asset.file}` }
}
