import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  bootstrapRemoteRuntime,
  buildRemoteAssetUrls,
  detectRemotePlatform,
  type RemoteCommandResult,
  type RemoteSshConnection,
} from './bootstrap';

class FakeConnection implements RemoteSshConnection {
  readonly commands: string[] = [];
  readonly uploads: Array<{ localPath: string; remotePath: string }> = [];
  readonly uname: string;
  readonly failDownload: boolean;
  readonly finalizeDigest?: string;

  constructor(options: {
    uname?: string;
    failDownload?: boolean;
    finalizeDigest?: string;
  } = {}) {
    this.uname = options.uname ?? 'Linux\nx86_64\n';
    this.failDownload = options.failDownload ?? false;
    this.finalizeDigest = options.finalizeDigest;
  }

  async exec(command: string): Promise<RemoteCommandResult> {
    this.commands.push(command);
    if (command.includes('uname -s')) {
      return { stdout: this.uname };
    }
    if (this.failDownload && command.includes('command -v curl')) {
      return { stdout: '', exitCode: 127 };
    }
    return { stdout: this.finalizeDigest ?? '' };
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    this.uploads.push({ localPath, remotePath });
  }
}

describe('remote SSH runtime bootstrap', () => {
  test('detects Linux x64 and prefers remote download', async () => {
    const digest = 'a'.repeat(64);
    const connection = new FakeConnection({ finalizeDigest: digest });

    const result = await bootstrapRemoteRuntime(connection, {
      version: '1.2.3',
      baseUrl: 'https://releases.example.test/download',
    });

    expect(result.target).toBe('linux-x64');
    expect(result.source).toBe('remote-download');
    expect(result.binaryPath).toBe('~/.shogo-server/1.2.3/agent-runtime');
    expect(result.sidecarRoot).toBe('~/.shogo-server/1.2.3');
    expect(result.sha256).toBe(digest);
    expect(connection.uploads).toHaveLength(0);
    expect(connection.commands[1]).toContain('curl');
    expect(connection.commands[1]).toContain(
      "'https://releases.example.test/download/v1.2.3/shogo-agent-runtime-linux-x64.tar.gz'",
    );
  });

  test('uploads and locally verifies the artifact when remote download fails', async () => {
    const archive = new TextEncoder().encode('fake runtime archive');
    const digest = createHash('sha256').update(archive).digest('hex');
    const sidecar = new TextEncoder().encode(`${digest}  shogo-agent-runtime-linux-arm64.tar.gz\n`);
    const connection = new FakeConnection({
      uname: 'Linux\naarch64\n',
      failDownload: true,
      finalizeDigest: digest,
    });

    const result = await bootstrapRemoteRuntime(connection, {
      version: '2.0.0-beta.1',
      fetch: (async (input: RequestInfo | URL) =>
        new Response(String(input).endsWith('.sha256') ? sidecar : archive, { status: 200 })) as typeof fetch,
    });

    expect(result.target).toBe('linux-arm64');
    expect(result.source).toBe('local-upload');
    expect(result.sha256).toBe(digest);
    expect(connection.uploads).toHaveLength(2);
    expect(connection.uploads[0]?.remotePath).toMatch(
      /\/tmp\/shogo-agent-runtime-[0-9a-f]+\/agent-runtime\.tar\.gz$/,
    );
    expect(connection.uploads[1]?.remotePath).toMatch(/agent-runtime\.tar\.gz\.sha256$/);
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
      tarball:
        'https://github.com/shogo-labs/shogo-ai/releases/download/v3.4.5/shogo-agent-runtime-linux-arm64.tar.gz',
      sha256:
        'https://github.com/shogo-labs/shogo-ai/releases/download/v3.4.5/shogo-agent-runtime-linux-arm64.tar.gz.sha256',
    });
  });
});
