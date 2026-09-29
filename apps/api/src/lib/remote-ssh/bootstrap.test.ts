// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  bootstrapRemoteRuntime,
  buildRemoteAssetUrls,
  detectRemotePlatform,
  type RemoteSshConnection,
} from './bootstrap';
import type { RemoteCommandResult } from './shell';

function ok(stdout = ''): RemoteCommandResult {
  return { stdout, stderr: '', exitCode: 0 };
}

class FakeConnection implements RemoteSshConnection {
  readonly commands: string[] = [];
  readonly uploads: Array<{ localPath: string; remotePath: string }> = [];

  constructor(
    private readonly options: {
      uname?: string;
      installed?: boolean;
      failDownload?: boolean;
      finalize?: RemoteCommandResult;
    } = {},
  ) {}

  async exec(command: string): Promise<RemoteCommandResult> {
    this.commands.push(command);
    if (command.includes('uname -s')) return ok(this.options.uname ?? 'Linux\nx86_64\n');
    if (command.startsWith('test -x')) {
      return { stdout: '', stderr: '', exitCode: this.options.installed ? 0 : 1 };
    }
    if (this.options.failDownload && command.includes('command -v curl')) {
      return { stdout: '', stderr: 'curl or wget is unavailable on the remote host', exitCode: 127 };
    }
    if (command.includes('tar -xzf')) return this.options.finalize ?? ok();
    return ok();
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    this.uploads.push({ localPath, remotePath });
  }
}

describe('remote SSH runtime bootstrap', () => {
  test('reuses an installed binary for the same version without downloading', async () => {
    const connection = new FakeConnection({ installed: true });

    const result = await bootstrapRemoteRuntime(connection, { version: '1.2.3' });

    expect(result).toEqual({
      version: '1.2.3',
      target: 'linux-x64',
      binaryPath: '~/.shogo-server/1.2.3/agent-runtime',
      source: 'installed',
    });
    expect(connection.commands.some((command) => command.includes('curl'))).toBe(false);
  });

  test('detects Linux x64 and prefers remote download', async () => {
    const digest = 'a'.repeat(64);
    const connection = new FakeConnection({ finalize: ok(digest) });

    const result = await bootstrapRemoteRuntime(connection, {
      version: '1.2.3',
      baseUrl: 'https://releases.example.test/download',
    });

    expect(result.target).toBe('linux-x64');
    expect(result.source).toBe('remote-download');
    expect(result.binaryPath).toBe('~/.shogo-server/1.2.3/agent-runtime');
    expect(result.sha256).toBe(digest);
    expect(connection.uploads).toHaveLength(0);
    const download = connection.commands.find((command) => command.includes('curl'));
    expect(download).toContain(
      "'https://releases.example.test/download/v1.2.3/shogo-agent-runtime-linux-x64.tar.gz'",
    );
  });

  test('uploads and locally verifies the artifact when remote download fails', async () => {
    const archive = new TextEncoder().encode('fake runtime archive');
    const digest = createHash('sha256').update(archive).digest('hex');
    const sidecar = new TextEncoder().encode(`${digest}  shogo-agent-runtime-linux-arm64.tar.gz\n`);
    const warnings: string[] = [];
    const connection = new FakeConnection({
      uname: 'Linux\naarch64\n',
      failDownload: true,
      finalize: ok(digest),
    });

    const result = await bootstrapRemoteRuntime(connection, {
      version: '2.0.0-beta.1',
      logger: { warn: (message: string) => warnings.push(message) },
      fetch: (async (input: RequestInfo | URL) =>
        new Response(String(input).endsWith('.sha256') ? sidecar : archive, { status: 200 })) as typeof fetch,
    });

    expect(result.target).toBe('linux-arm64');
    expect(result.source).toBe('local-upload');
    expect(result.sha256).toBe(digest);
    expect(warnings[0]).toContain('curl or wget is unavailable');
    expect(connection.uploads).toHaveLength(2);
    expect(connection.uploads[0]?.remotePath).toMatch(
      /\/tmp\/shogo-agent-runtime-[0-9a-f]+\/agent-runtime\.tar\.gz$/,
    );
    expect(connection.uploads[1]?.remotePath).toMatch(/agent-runtime\.tar\.gz\.sha256$/);
  });

  test('surfaces the remote stderr when installation fails', async () => {
    const connection = new FakeConnection({
      finalize: { stdout: '', stderr: 'Remote runtime checksum mismatch\n', exitCode: 1 },
    });

    await expect(bootstrapRemoteRuntime(connection, { version: '1.2.3' })).rejects.toThrow(
      'remote runtime installation failed: Remote runtime checksum mismatch',
    );
  });

  test('rejects unsupported remote platforms', async () => {
    const connection = new FakeConnection({ uname: 'Darwin\narm64\n' });

    await expect(detectRemotePlatform(connection)).rejects.toThrow('only Linux is supported');
  });

  test('uses the worker release URL convention', () => {
    expect(buildRemoteAssetUrls('3.4.5', 'linux-arm64')).toEqual({
      assetName: 'shogo-agent-runtime-linux-arm64.tar.gz',
      tarballUrl:
        'https://github.com/shogo-labs/shogo-ai/releases/download/v3.4.5/shogo-agent-runtime-linux-arm64.tar.gz',
      checksumUrl:
        'https://github.com/shogo-labs/shogo-ai/releases/download/v3.4.5/shogo-agent-runtime-linux-arm64.tar.gz.sha256',
    });
  });
});
