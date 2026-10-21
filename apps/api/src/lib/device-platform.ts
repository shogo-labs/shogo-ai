// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One normalization for device identity in install analytics.
 *
 * Two writers put a platform into `api_keys.devicePlatform` and they disagree:
 * the desktop app sends `process.platform` (`darwin` / `win32`) while the
 * worker/CLI sends `<platform>-<arch>` (`darwin-arm64`, `win32-x64`,
 * `linux-x64`). Production carried 8 spellings for 3 operating systems, so the
 * admin dashboard counted macOS three times and Windows twice.
 *
 * Everything that reads or writes install identity goes through this module, so
 * a new writer cannot introduce a ninth spelling: `os` is a closed set and
 * `arch` is a separate dimension, which also keeps a macOS device on Apple
 * Silicon in the same bucket as one on Intel.
 */

export const DEVICE_OSES = ['macos', 'windows', 'linux', 'unknown'] as const
export type DeviceOs = (typeof DEVICE_OSES)[number]

export type DeviceArch = 'arm64' | 'x64' | null

/** `desktop` = the Shogo desktop app; `cli` = a worker/CLI device key. */
export type DeviceClient = 'desktop' | 'cli' | 'unknown'

export type ReleaseChannel = 'stable' | 'beta'

export interface ParsedDevicePlatform {
  os: DeviceOs
  arch: DeviceArch
}

const OS_TOKENS: Record<string, DeviceOs> = {
  darwin: 'macos',
  macos: 'macos',
  mac: 'macos',
  osx: 'macos',
  win32: 'windows',
  windows: 'windows',
  win: 'windows',
  win64: 'windows',
  linux: 'linux',
}

const ARM_TOKENS = new Set(['arm64', 'aarch64'])
const X64_TOKENS = new Set(['x64', 'x86_64', 'amd64', 'x86', 'ia32', 'i686'])

/**
 * Map every platform spelling seen in production (plus null) onto one OS.
 *
 * Accepts `darwin`, `darwin-arm64`, `darwin-x64`, `win32`, `win32-x64`,
 * `linux`, `linux-x64`, `linux-arm64` — and anything else, which lands on
 * `unknown` rather than inventing a new bucket.
 */
export function parseDevicePlatform(raw: string | null | undefined): ParsedDevicePlatform {
  if (!raw) return { os: 'unknown', arch: null }
  const value = raw.trim().toLowerCase()
  if (!value) return { os: 'unknown', arch: null }

  const [head, ...rest] = value.split(/[-_.]/)
  const os = OS_TOKENS[head] ?? 'unknown'

  let arch: DeviceArch = null
  for (const token of rest) {
    if (ARM_TOKENS.has(token)) {
      arch = 'arm64'
      break
    }
    if (X64_TOKENS.has(token)) {
      arch = 'x64'
      break
    }
  }

  return { os, arch }
}

/** Human label for an OS bucket, used by the admin UI and log lines. */
export function deviceOsLabel(os: DeviceOs): string {
  switch (os) {
    case 'macos':
      return 'macOS'
    case 'windows':
      return 'Windows'
    case 'linux':
      return 'Linux'
    default:
      return 'Unknown'
  }
}

const CLI_VERSION_PREFIX = 'shogo-cli/'
const CLI_PLATFORM_TOKEN = 'shogo-cli'

/**
 * Which client reported this device key.
 *
 * CLI/worker device keys report `shogo-cli/<version>` as the app version (all
 * 11 such rows in production), which used to land inside the Desktop card and
 * inflate both the desktop total and a bogus version bucket.
 */
export function parseClient(
  version: string | null | undefined,
  platform?: string | null,
): DeviceClient {
  const v = (version ?? '').trim().toLowerCase()
  if (v.startsWith(CLI_VERSION_PREFIX) || v === CLI_PLATFORM_TOKEN) return 'cli'

  const p = (platform ?? '').trim().toLowerCase()
  if (p === CLI_PLATFORM_TOKEN || p.startsWith(CLI_VERSION_PREFIX)) return 'cli'

  if (!v || v === 'unknown') return 'unknown'
  return 'desktop'
}

/**
 * Stable vs beta from the version string alone — production ships betas as
 * `2.3.6-beta.20261020t083308`, prereleases as `2.3.6-rc.1`.
 */
export function parseChannel(version: string | null | undefined): ReleaseChannel {
  const v = (version ?? '').trim().toLowerCase()
  if (!v) return 'stable'
  if (/(^|[.\-_])beta([.\-_]|$)/.test(v)) return 'beta'
  return 'stable'
}

export interface Semver {
  major: number
  minor: number
  patch: number
  prerelease: string | null
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?/

/** Parse `2.3.6`, `2.3.6-beta.20261020t083308`, `v2.3.6`. Null when unusable. */
export function parseSemver(version: string | null | undefined): Semver | null {
  const m = SEMVER_RE.exec((version ?? '').trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  }
}

/**
 * Sort order for versions: numeric parts, then prerelease last (a beta sorts
 * below the stable it leads to, as semver says). Unparsable strings sort below
 * everything comparable but keep a stable relative order.
 */
export function compareSemver(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa && !pb) return (a ?? '').localeCompare(b ?? '')
  if (!pa) return -1
  if (!pb) return 1

  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  if (pa.patch !== pb.patch) return pa.patch - pb.patch
  if (pa.prerelease === pb.prerelease) return 0
  if (!pa.prerelease) return 1
  if (!pb.prerelease) return -1
  return pa.prerelease.localeCompare(pb.prerelease)
}

/** True when `version` is exactly the release the API itself is running. */
export function isSameRelease(version: string | null | undefined, tag: string | null): boolean {
  if (!version || !tag) return false
  if (version.trim() === tag.trim()) return true
  const pv = parseSemver(version)
  const pt = parseSemver(tag)
  if (!pv || !pt) return false
  return compareSemver(version, tag) === 0
}
