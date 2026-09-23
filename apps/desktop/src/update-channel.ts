// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Feed-URL resolution for the desktop auto-updater's two channels.
 *
 * Deliberately has ZERO Electron imports so it can be unit-tested with
 * plain `bun test` (see `test-update-channel.ts`) without spinning up a
 * BrowserWindow or mocking the `electron` module.
 *
 *   - `stable` rides the existing update.electronjs.org proxy, which reads
 *     this repo's GitHub Releases and — by construction — ignores
 *     `prerelease`/`draft` releases (see electron/update.electronjs.org's
 *     `getLatest()`). Nothing here changes for stable users.
 *   - `beta` hits a new `/desktop/beta/...` route on the `releases.shogo.ai`
 *     Cloudflare Worker (see
 *     terraform/modules/install-shogo-ai/scripts/releases-worker.js.tftpl),
 *     which resolves the newest manually published prerelease. It
 *     speaks the exact same wire protocol as update.electronjs.org (204 =
 *     up to date, JSON `{name,url,notes}` = update available, `/RELEASES`
 *     for Squirrel.Windows) so `updater.ts` doesn't need channel-specific
 *     response handling — only the URL differs.
 *
 * `SHOGO_UPDATE_FEED_BASE_URL` lets e2e tests (and, in principle, a future
 * staging environment) point BOTH channels at a local mock server instead
 * of the real hosts. When set, the resulting URL is
 * `${base}/${channel}/${platform}-${arch}/${version}` for both channels —
 * a single mock server can then serve `/stable/...` and `/beta/...`.
 */

export type UpdateChannel = 'stable' | 'beta'

const STABLE_UPDATE_HOST = 'https://update.electronjs.org'
const STABLE_REPO = 'shogo-labs/shogo-ai'
const BETA_UPDATE_HOST = 'https://releases.shogo.ai'

/** Narrow an arbitrary (e.g. parsed-JSON or IPC-argument) value down to a
 * valid `UpdateChannel`, defaulting anything unrecognized to `stable`. Used
 * both when reading `config.json` and when handling the `set-update-channel`
 * IPC call, so a corrupt config file or a stale/renderer-side typo can never
 * put the updater in an invalid state. */
export function parseUpdateChannel(value: unknown): UpdateChannel {
  return value === 'beta' ? 'beta' : 'stable'
}

export interface ResolveFeedUrlOptions {
  channel: UpdateChannel
  /** `process.platform`, e.g. 'darwin' | 'win32'. */
  platform: string
  /** `process.arch`, e.g. 'arm64' | 'x64'. */
  arch: string
  /** `app.getVersion()`. */
  version: string
  /** `SHOGO_UPDATE_FEED_BASE_URL`, if set. Overrides both channels' base
   * host so tests can point at a local mock feed server. */
  baseUrlOverride?: string | null
}

/** Build the feed URL `autoUpdater.setFeedURL()` and our manual probe
 * (`net.fetch`) should use for the given channel/platform/arch/version. */
export function resolveFeedUrl({
  channel,
  platform,
  arch,
  version,
  baseUrlOverride,
}: ResolveFeedUrlOptions): string {
  const platformArch = `${platform}-${arch}`

  if (baseUrlOverride) {
    return `${baseUrlOverride.replace(/\/+$/, '')}/${channel}/${platformArch}/${version}`
  }

  if (channel === 'beta') {
    return `${BETA_UPDATE_HOST}/desktop/beta/${platformArch}/${version}`
  }

  return `${STABLE_UPDATE_HOST}/${STABLE_REPO}/${platformArch}/${version}`
}
