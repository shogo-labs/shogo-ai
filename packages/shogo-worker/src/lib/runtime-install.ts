// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Download + verify + install the AGPL agent-runtime binary into
 * ~/.shogo/runtime/. Used by `shogo runtime install` and
 * `shogo runtime update`.
 *
 * License boundary: this module fetches a *separate* AGPL binary from
 * a release server and lays it on disk. The MIT worker never imports,
 * links, or embeds the runtime — it spawns this on-disk binary as a
 * separate OS process. See packages/shogo-worker/README.md.
 *
 * Source layout the workflow `.github/workflows/publish-agent-runtime.yml`
 * produces. Runtime tarballs ride the same `v*` tag as the rest of the
 * app (desktop, worker, sdk all share one version):
 *   <baseUrl>/v<version>/shogo-agent-runtime-<target>.tar.gz
 *   <baseUrl>/v<version>/shogo-agent-runtime-<target>.tar.gz.sha256
 *
 * Each tarball contains:
 *   ./agent-runtime           (executable, single self-contained `bun build --compile`)
 *   ./VERSION                 (key=value: version, target, built_at, source, license)
 *
 * We extract via the system `tar` binary so we don't add a streaming
 * tar dep just for one-shot installs. macOS, Linux, and Windows
 * (since 1803) all ship a usable `tar` on PATH.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  RUNTIME_BIN,
  RUNTIME_DIR,
  RUNTIME_VERSION_FILE,
  ensureRuntimeDir,
} from './paths.ts';

export type Channel = 'stable' | 'beta' | 'nightly';

/**
 * Default release base URL. The publish workflow appends agent-runtime
 * tarballs to GitHub Releases attached to the app's `v*` tags on the
 * canonical repo (same release that ships the desktop installers).
 * Users with a self-hosted CDN (e.g. releases.shogo.ai) can override
 * via `--base-url` on `shogo runtime install` or
 * `SHOGO_RUNTIME_RELEASES_URL`.
 *
 * Layout assumed by `buildAssetUrls()`:
 *   ${baseUrl}/v${version}/${assetName}
 */
export const DEFAULT_RELEASES_BASE_URL = 'https://github.com/shogo-ai/shogo/releases/download';

export interface InstallOptions {
  /** Specific version to install (e.g. "0.1.0"). Default: latest in channel. */
  version?: string;
  /** Channel to read latest from. Default: 'stable'. */
  channel?: Channel;
  /** Override release base URL. */
  baseUrl?: string;
  /** Override target slug (e.g. for testing). Default: detected from process. */
  target?: string;
  /** Reinstall even if the same version is already on disk. */
  force?: boolean;
  /** Logger. Defaults to console. */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface InstallResult {
  version: string;
  target: string;
  binPath: string;
  source: string; // resolved tarball URL
  sha256: string;
  channel: Channel;
}

export interface InstalledVersion {
  version: string;
  target: string;
  installedAt: string;
  channel: Channel;
  source: string;
  sha256: string;
}

/**
 * Detect the install target slug for the current host.
 * Mirrors `bun build --target=bun-${target}` slugs used in CI.
 */
export function detectTarget(): string {
  const platform = process.platform;
  const arch = process.arch;
  let os: string;
  if (platform === 'darwin') os = 'darwin';
  else if (platform === 'linux') os = 'linux';
  else if (platform === 'win32') os = 'windows';
  else throw new Error(`Unsupported platform: ${platform}`);

  let cpu: string;
  if (arch === 'arm64') cpu = 'arm64';
  else if (arch === 'x64') cpu = 'x64';
  else throw new Error(`Unsupported arch: ${arch} (need arm64 or x64)`);

  return `${os}-${cpu}`;
}

/**
 * Read the metadata file for the currently installed runtime, if any.
 */
export function readInstalledVersion(): InstalledVersion | null {
  if (!existsSync(RUNTIME_VERSION_FILE)) return null;
  try {
    const raw = readFileSync(RUNTIME_VERSION_FILE, 'utf-8');
    return JSON.parse(raw) as InstalledVersion;
  } catch {
    return null;
  }
}

/**
 * Resolve the latest version for a channel.
 *
 * Strategy: query GitHub's `/releases/latest` redirect via a HEAD
 * request and parse the tag from the `Location` header. This avoids
 * needing a GitHub token for unauthenticated rate-limited use.
 *
 * For non-stable channels we walk `/releases` (v1 API) and pick the
 * newest matching prerelease tag. Channel mapping:
 *   stable  → latest non-prerelease
 *   beta    → latest prerelease where tag matches `*-beta.*`
 *   nightly → latest prerelease where tag matches `*-nightly.*`
 */
export async function resolveLatestVersion(
  channel: Channel,
  baseUrl: string,
): Promise<string> {
  // baseUrl is `https://github.com/<owner>/<repo>/releases/download`.
  // Derive the owner/repo from it for the API calls.
  const m = baseUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download/);
  if (!m) {
    throw new Error(
      `Cannot auto-resolve latest version from non-GitHub baseUrl '${baseUrl}'. ` +
        `Pass --version explicitly.`,
    );
  }
  const owner = m[1];
  const repo = m[2];

  if (channel === 'stable') {
    const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
    const resp = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
    if (!resp.ok) {
      throw new Error(`GitHub API ${resp.status} for ${url}`);
    }
    const data = (await resp.json()) as { tag_name?: string };
    if (!data.tag_name) throw new Error('GitHub API did not return tag_name');
    return tagToVersion(data.tag_name);
  }

  // For prerelease channels, walk page 1 of /releases. The runtime now
  // ships on the same `v*` tag as the rest of the app, so we filter by
  // a strict `vX.Y.Z-` prefix to avoid accidentally matching legacy
  // `runtime-v*` tags or unrelated prerelease tag schemes.
  const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=30`;
  const resp = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!resp.ok) throw new Error(`GitHub API ${resp.status} for ${url}`);
  const releases = (await resp.json()) as { tag_name: string; prerelease: boolean }[];
  const wanted = channel === 'beta' ? '-beta' : '-nightly';
  const match = releases.find(
    (r) => r.prerelease && /^v\d+\.\d+\.\d+-/.test(r.tag_name) && r.tag_name.includes(wanted),
  );
  if (!match) throw new Error(`No ${channel} runtime release found`);
  return tagToVersion(match.tag_name);
}

function tagToVersion(tag: string): string {
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`Unexpected app tag '${tag}' (expected vX.Y.Z[-prerelease])`);
  }
  return tag.slice(1);
}

interface AssetUrls {
  tarball: string;
  sha256: string;
  assetName: string;
}

function buildAssetUrls(version: string, target: string, baseUrl: string): AssetUrls {
  const assetName = `shogo-agent-runtime-${target}.tar.gz`;
  const tag = `v${version}`;
  const tarball = `${baseUrl.replace(/\/$/, '')}/${tag}/${assetName}`;
  return {
    tarball,
    sha256: `${tarball}.sha256`,
    assetName,
  };
}

/**
 * Stream a URL into a local file. Throws on non-2xx.
 */
async function downloadToFile(url: string, destPath: string): Promise<void> {
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) {
    throw new Error(`Download failed: HTTP ${resp.status} for ${url}`);
  }
  if (!resp.body) throw new Error(`Download failed: empty body for ${url}`);
  await pipeline(Readable.fromWeb(resp.body as any), createWriteStream(destPath));
}

async function fetchSha256(url: string): Promise<string> {
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`SHA256 sidecar fetch failed: HTTP ${resp.status} for ${url}`);
  const text = await resp.text();
  // sha256sum format: `<hex>  <filename>` — take the first whitespace-separated token.
  const hex = text.trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(`SHA256 sidecar at ${url} did not contain a 64-char hex digest`);
  }
  return hex.toLowerCase();
}

function sha256OfFile(path: string): string {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

async function extractTarGz(tarballPath: string, destDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('tar', ['-xzf', tarballPath, '-C', destDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Atomically swap an extracted runtime into place.
 *
 * Strategy: extract into a sibling staging dir, then `rename` the
 * binary on top of the live one. POSIX `rename` is atomic on the same
 * filesystem; if the binary is currently being executed by a running
 * worker the kernel keeps the in-flight inode alive until it exits.
 */
function installFromStaging(stagingBin: string, finalBin: string): void {
  ensureRuntimeDir();
  const dir = dirname(finalBin);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // rename across a tempfile suffix to keep the swap atomic even on
  // filesystems where write-in-place is preferred.
  const tmpDest = `${finalBin}.next`;
  if (existsSync(tmpDest)) rmSync(tmpDest, { force: true });
  renameSync(stagingBin, tmpDest);
  // chmod here so the +x bit survives the rename even if the source
  // tarball was created without it.
  try {
    if (process.platform !== 'win32') {
      const { chmodSync } = require('node:fs') as typeof import('node:fs');
      chmodSync(tmpDest, 0o755);
    }
  } catch { /* permissions best-effort */ }
  if (existsSync(finalBin)) rmSync(finalBin, { force: true });
  renameSync(tmpDest, finalBin);
}

export async function installRuntime(opts: InstallOptions = {}): Promise<InstallResult> {
  const log = opts.logger ?? console;
  const channel: Channel = opts.channel ?? 'stable';
  const baseUrl = opts.baseUrl ?? process.env.SHOGO_RUNTIME_RELEASES_URL ?? DEFAULT_RELEASES_BASE_URL;
  const target = opts.target ?? detectTarget();

  let version = opts.version;
  if (!version) {
    log.log(`[runtime install] Resolving latest ${channel} version...`);
    version = await resolveLatestVersion(channel, baseUrl);
    log.log(`[runtime install] Latest ${channel} = ${version}`);
  }

  const installed = readInstalledVersion();
  if (installed && installed.version === version && installed.target === target && !opts.force) {
    log.log(`[runtime install] ${version} (${target}) already installed at ${RUNTIME_BIN} — pass --force to reinstall`);
    return {
      version,
      target,
      binPath: RUNTIME_BIN,
      source: installed.source,
      sha256: installed.sha256,
      channel,
    };
  }

  const urls = buildAssetUrls(version, target, baseUrl);
  log.log(`[runtime install] Downloading ${urls.tarball}`);

  const stagingRoot = join(tmpdir(), `shogo-runtime-install-${process.pid}-${Date.now()}`);
  mkdirSync(stagingRoot, { recursive: true });
  try {
    const tarballPath = join(stagingRoot, urls.assetName);
    await downloadToFile(urls.tarball, tarballPath);

    log.log(`[runtime install] Verifying SHA-256...`);
    const expected = await fetchSha256(urls.sha256);
    const actual = sha256OfFile(tarballPath);
    if (actual !== expected) {
      throw new Error(
        `SHA-256 mismatch for ${urls.assetName}\n  expected: ${expected}\n  actual:   ${actual}`,
      );
    }

    const extractDir = join(stagingRoot, 'extract');
    mkdirSync(extractDir, { recursive: true });
    await extractTarGz(tarballPath, extractDir);

    const stagingBin = join(extractDir, 'agent-runtime');
    if (!existsSync(stagingBin)) {
      throw new Error(`Tarball ${urls.assetName} did not contain ./agent-runtime`);
    }

    installFromStaging(stagingBin, RUNTIME_BIN);

    const versionRecord: InstalledVersion = {
      version,
      target,
      installedAt: new Date().toISOString(),
      channel,
      source: urls.tarball,
      sha256: actual,
    };
    writeFileSync(RUNTIME_VERSION_FILE, JSON.stringify(versionRecord, null, 2) + '\n', { mode: 0o600 });

    log.log(`[runtime install] Installed agent-runtime ${version} (${target}) to ${RUNTIME_BIN}`);
    return {
      version,
      target,
      binPath: RUNTIME_BIN,
      source: urls.tarball,
      sha256: actual,
      channel,
    };
  } finally {
    try { rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/** Public for `shogo runtime where`. */
export function getRuntimePaths() {
  return {
    runtimeDir: RUNTIME_DIR,
    runtimeBin: RUNTIME_BIN,
    versionFile: RUNTIME_VERSION_FILE,
  };
}
