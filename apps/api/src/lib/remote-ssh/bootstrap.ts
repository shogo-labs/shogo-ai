// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Bootstrap the standalone agent-runtime binary on a Remote-SSH host.
 *
 * This module deliberately depends on a small injected SSH connection rather
 * than an SSH implementation. That keeps transport, host-key policy, and
 * credentials outside the bootstrapper.
 *
 * Release layout (shared with packages/shogo-worker):
 *   <baseUrl>/v<version>/shogo-agent-runtime-<target>.tar.gz
 *   <baseUrl>/v<version>/shogo-agent-runtime-<target>.tar.gz.sha256
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  execChecked,
  quoteRemoteShellArgument,
  type RemoteCommandRunner,
} from './shell';

/** The public release base URL used by the worker runtime installer. */
export const DEFAULT_RELEASES_BASE_URL =
  'https://github.com/shogo-labs/shogo-ai/releases/download';

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/**
 * The transport boundary used by this module. `upload` takes a local
 * filesystem path and an absolute remote path; it is never given credentials
 * or shell commands.
 */
export interface RemoteSshConnection extends RemoteCommandRunner {
  upload(localPath: string, remotePath: string): Promise<void>;
}

export type RemoteTarget = 'linux-x64' | 'linux-arm64';
export type RemoteRuntimeSource = 'installed' | 'remote-download' | 'local-upload';

export interface RemotePlatform {
  os: 'linux';
  arch: 'x64' | 'arm64';
  target: RemoteTarget;
}

export interface RemoteReleaseUrls {
  assetName: string;
  tarballUrl: string;
  checksumUrl: string;
}

export interface RemoteRuntimeBootstrapOptions {
  /** Exact app/runtime version, without the release tag's leading `v`. */
  version: string;
  /** Defaults to SHOGO_RUNTIME_RELEASES_URL, then DEFAULT_RELEASES_BASE_URL. */
  baseUrl?: string;
  /** Injectable for unit tests and for callers with a custom fetch policy. */
  fetch?: typeof fetch;
  logger?: Pick<Console, 'warn'>;
}

export interface RemoteRuntimeBootstrapResult {
  version: string;
  target: RemoteTarget;
  /** `~/.shogo-server/<version>/agent-runtime`, expanded by the remote shell. */
  binaryPath: string;
  source: RemoteRuntimeSource;
  /** The verified digest when this call installed the binary. */
  sha256?: string;
}

function validateVersion(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid runtime version '${version}'`);
  }
  return version;
}

function normalizeBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('Invalid runtime releases base URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Runtime releases base URL must use http or https');
  }
  // Credentials in a release URL would be copied into the remote shell
  // command line, where other users on the host can read them.
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Runtime releases base URL must not contain credentials or query parameters');
  }

  return baseUrl.replace(/\/+$/, '');
}

export function buildRemoteAssetUrls(
  version: string,
  target: RemoteTarget,
  baseUrl = DEFAULT_RELEASES_BASE_URL,
): RemoteReleaseUrls {
  const normalizedVersion = validateVersion(version);
  if (target !== 'linux-x64' && target !== 'linux-arm64') {
    throw new Error(`Unsupported remote runtime target '${target}'`);
  }
  const assetName = `shogo-agent-runtime-${target}.tar.gz`;
  const tarballUrl = `${normalizeBaseUrl(baseUrl)}/v${normalizedVersion}/${assetName}`;
  return { assetName, tarballUrl, checksumUrl: `${tarballUrl}.sha256` };
}

function parseUname(stdout: string): RemotePlatform {
  const fields = stdout.trim().split(/\s+/).filter(Boolean);
  if (fields.length < 2) {
    throw new Error('Remote uname returned incomplete OS/architecture information');
  }

  const os = fields[0].toLowerCase();
  const rawArch = fields[1].toLowerCase();
  if (os !== 'linux') {
    throw new Error(`Unsupported remote OS '${fields[0]}' (only Linux is supported)`);
  }

  let arch: RemotePlatform['arch'];
  if (rawArch === 'x86_64' || rawArch === 'amd64') {
    arch = 'x64';
  } else if (rawArch === 'aarch64' || rawArch === 'arm64') {
    arch = 'arm64';
  } else {
    throw new Error(`Unsupported remote architecture '${fields[1]}'`);
  }

  return { os: 'linux', arch, target: `linux-${arch}` };
}

/** Detect the supported release target using the remote host's uname values. */
export async function detectRemotePlatform(
  connection: RemoteCommandRunner,
): Promise<RemotePlatform> {
  const result = await execChecked(connection, 'uname -s && uname -m', 'remote platform detection');
  return parseUname(result.stdout);
}

function remoteInstallRoot(version: string): string {
  // The version is validated before this is built. Keeping HOME outside the
  // quoted version lets the remote shell resolve the user's home directory.
  return `"$HOME/.shogo-server"/${quoteRemoteShellArgument(version)}`;
}

function installedCheckCommand(version: string): string {
  return `test -x ${remoteInstallRoot(version)}/agent-runtime`;
}

function remoteDownloadCommand(transferRoot: string, urls: RemoteReleaseUrls): string {
  const transfer = quoteRemoteShellArgument(transferRoot);
  const url = quoteRemoteShellArgument(urls.tarballUrl);
  const checksumUrl = quoteRemoteShellArgument(urls.checksumUrl);
  return [
    'set -eu',
    `transfer=${transfer}`,
    'archive="$transfer/agent-runtime.tar.gz"',
    'checksum="$transfer/agent-runtime.tar.gz.sha256"',
    'rm -rf "$transfer"',
    'mkdir -p "$transfer"',
    'if command -v curl >/dev/null 2>&1; then',
    `  curl --fail --silent --show-error --location --retry 2 --connect-timeout 15 --output "$archive" ${url}`,
    `  curl --fail --silent --show-error --location --retry 2 --connect-timeout 15 --output "$checksum" ${checksumUrl}`,
    'elif command -v wget >/dev/null 2>&1; then',
    `  wget --quiet --output-document="$archive" ${url}`,
    `  wget --quiet --output-document="$checksum" ${checksumUrl}`,
    'else',
    "  printf '%s\\n' 'curl or wget is unavailable on the remote host' >&2",
    '  exit 127',
    'fi',
  ].join('\n');
}

function remoteFinalizeCommand(version: string, transferRoot: string): string {
  return [
    'set -eu',
    `root=${remoteInstallRoot(version)}`,
    `transfer=${quoteRemoteShellArgument(transferRoot)}`,
    'archive="$transfer/agent-runtime.tar.gz"',
    'checksum="$transfer/agent-runtime.tar.gz.sha256"',
    'extract="$transfer/extract"',
    'cleanup() { rm -rf "$transfer"; }',
    'trap cleanup EXIT HUP INT TERM',
    'test -s "$archive"',
    'test -s "$checksum"',
    "expected=$(awk 'NF { print $1; exit }' \"$checksum\")",
    'case "$expected" in',
    "  ''|*[!0-9A-Fa-f]*) printf '%s\\n' 'Invalid SHA-256 sidecar' >&2; exit 1 ;;",
    'esac',
    '[ "${#expected}" -eq 64 ]',
    'expected=$(printf "%s" "$expected" | tr "[:upper:]" "[:lower:]")',
    'if command -v sha256sum >/dev/null 2>&1; then',
    '  actual=$(sha256sum "$archive" | awk \'{ print $1 }\')',
    'elif command -v shasum >/dev/null 2>&1; then',
    '  actual=$(shasum -a 256 "$archive" | awk \'{ print $1 }\')',
    'else',
    "  printf '%s\\n' 'No SHA-256 utility is available on the remote host' >&2",
    '  exit 1',
    'fi',
    'actual=$(printf "%s" "$actual" | tr "[:upper:]" "[:lower:]")',
    '[ "$actual" = "$expected" ] || { printf \'%s\\n\' \'Remote runtime checksum mismatch\' >&2; exit 1; }',
    'rm -rf "$extract"',
    'mkdir -p "$root" "$extract"',
    'tar -xzf "$archive" -C "$extract"',
    'test -f "$extract/agent-runtime"',
    'test ! -L "$extract/agent-runtime"',
    'chmod 0755 "$extract/agent-runtime"',
    'mv -f "$extract/agent-runtime" "$root/agent-runtime"',
    'if test -f "$extract/VERSION"; then cp "$extract/VERSION" "$root/VERSION"; fi',
    'printf "%s\\n" "$actual"',
  ].join('\n');
}

function parseSha256Sidecar(text: string): string {
  const digest = text.trim().split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{64}$/i.test(digest)) {
    throw new Error('Release checksum sidecar did not contain a 64-character SHA-256 digest');
  }
  return digest.toLowerCase();
}

async function fetchReleaseBytes(
  fetchImpl: typeof fetch,
  url: string,
  artifactName: string,
): Promise<Uint8Array> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Failed to download release ${artifactName} (HTTP ${response.status})`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function digestFromCommandOutput(stdout: string): string | undefined {
  const digest = stdout
    .trim()
    .split(/\s+/)
    .find((candidate) => /^[0-9a-f]{64}$/i.test(candidate));
  return digest?.toLowerCase();
}

/**
 * Detect, download, verify, and install agent-runtime on a remote Linux host.
 *
 * An already-installed binary for this exact version is reused. Otherwise
 * the remote host downloads the release itself so the API process does not
 * proxy a large artifact; if curl/wget is absent or fails, the artifact is
 * fetched and verified locally and streamed over SSH. In both cases checksum
 * verification and extraction happen on the remote host.
 */
export async function bootstrapRemoteRuntime(
  connection: RemoteSshConnection,
  options: RemoteRuntimeBootstrapOptions,
): Promise<RemoteRuntimeBootstrapResult> {
  const version = validateVersion(options.version);
  const platform = await detectRemotePlatform(connection);
  const binaryPath = `~/.shogo-server/${version}/agent-runtime`;

  const installed = await connection.exec(installedCheckCommand(version));
  if (installed.exitCode === 0) {
    return { version, target: platform.target, binaryPath, source: 'installed' };
  }

  const releaseBaseUrl =
    options.baseUrl ?? process.env.SHOGO_RUNTIME_RELEASES_URL ?? DEFAULT_RELEASES_BASE_URL;
  const urls = buildRemoteAssetUrls(version, platform.target, releaseBaseUrl);
  const transferRoot = `/tmp/shogo-agent-runtime-${randomBytes(16).toString('hex')}`;

  let source: RemoteRuntimeSource = 'remote-download';
  let locallyVerifiedSha256: string | undefined;

  try {
    await execChecked(
      connection,
      remoteDownloadCommand(transferRoot, urls),
      'remote runtime download',
      { timeoutMs: DOWNLOAD_TIMEOUT_MS },
    );
  } catch (error) {
    source = 'local-upload';
    options.logger?.warn(
      `[remote ssh] Remote runtime download unavailable (${error instanceof Error ? error.message : String(error)}); uploading the release artifact locally.`,
    );

    const fetchImpl = options.fetch ?? globalThis.fetch;
    const archive = await fetchReleaseBytes(fetchImpl, urls.tarballUrl, urls.assetName);
    const sidecar = await fetchReleaseBytes(fetchImpl, urls.checksumUrl, `${urls.assetName}.sha256`);
    const expected = parseSha256Sidecar(new TextDecoder().decode(sidecar));
    const actual = createHash('sha256').update(archive).digest('hex');
    if (actual !== expected) {
      throw new Error(
        `Release checksum mismatch for ${urls.assetName}: expected ${expected}, got ${actual}`,
      );
    }
    locallyVerifiedSha256 = actual;

    const localRoot = await mkdtemp(join(tmpdir(), 'shogo-remote-runtime-'));
    const localArchive = join(localRoot, urls.assetName);
    const localChecksum = `${localArchive}.sha256`;
    try {
      await writeFile(localArchive, archive);
      await writeFile(localChecksum, sidecar);
      await execChecked(
        connection,
        `mkdir -p ${quoteRemoteShellArgument(transferRoot)}`,
        'remote upload directory setup',
      );
      await connection.upload(localArchive, `${transferRoot}/agent-runtime.tar.gz`);
      await connection.upload(localChecksum, `${transferRoot}/agent-runtime.tar.gz.sha256`);
    } finally {
      await rm(localRoot, { recursive: true, force: true });
    }
  }

  const finalizeResult = await execChecked(
    connection,
    remoteFinalizeCommand(version, transferRoot),
    'remote runtime installation',
  );
  return {
    version,
    target: platform.target,
    binaryPath,
    source,
    sha256: digestFromCommandOutput(finalizeResult.stdout) ?? locallyVerifiedSha256,
  };
}
