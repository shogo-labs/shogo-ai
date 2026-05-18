// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The config/credentials store reads HOME at module-load time. To test
 * different home dirs we mock `paths.ts` per-test so config.ts picks up
 * a tmpdir-rooted CONFIG_FILE / HOME_DIR pair without us having to
 * mutate process.env.HOME (which is racy across the rest of the suite).
 */

let tmp: string;

function setupTmpHome(): string {
  tmp = mkdtempSync(join(tmpdir(), 'shogo-config-'));
  const homeDir = join(tmp, '.shogo');
  const configFile = join(homeDir, 'config.json');
  mock.module('../paths.ts', () => ({
    HOME_DIR: homeDir,
    CONFIG_FILE: configFile,
    CREDENTIALS_FILE: join(homeDir, 'credentials.json'),
    DEVICE_ID_FILE: join(homeDir, 'device-id'),
    PID_FILE: join(homeDir, 'worker.pid'),
    LOGS_DIR: join(homeDir, 'logs'),
    WORKER_LOG: join(homeDir, 'logs', 'worker.log'),
    WORKER_ERR: join(homeDir, 'logs', 'worker.err.log'),
    RUNTIME_DIR: join(homeDir, 'runtime'),
    RUNTIME_BIN: join(homeDir, 'runtime', 'agent-runtime'),
    RUNTIME_VERSION_FILE: join(homeDir, 'runtime', 'version.json'),
    PROJECTS_DIR: join(homeDir, 'projects'),
    projectDirFor: (id: string, base = join(homeDir, 'projects')) => join(base, id),
    ensureHome: () => {
      mkdirSync(homeDir, { recursive: true, mode: 0o700 });
      mkdirSync(join(homeDir, 'logs'), { recursive: true, mode: 0o700 });
    },
    ensureRuntimeDir: () => {
      mkdirSync(join(homeDir, 'runtime'), { recursive: true, mode: 0o700 });
    },
    ensureProjectsDir: (base = join(homeDir, 'projects')) => {
      mkdirSync(base, { recursive: true, mode: 0o700 });
    },
  }));
  return configFile;
}

describe('config: load + save round-trip', () => {
  let configFile: string;
  beforeEach(() => {
    configFile = setupTmpHome();
  });
  afterEach(() => {
    mock.restore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('loadConfig returns {} when no file exists', async () => {
    const { loadConfig } = await import('../config.ts');
    expect(loadConfig()).toEqual({});
  });

  it('saveConfig writes JSON with mode 0600', async () => {
    const { saveConfig, loadConfig } = await import('../config.ts');
    saveConfig({ apiKey: 'shogo_sk_test', cloudUrl: 'https://example.com' });

    expect(existsSync(configFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(configFile, 'utf-8'));
    expect(parsed.apiKey).toBe('shogo_sk_test');
    expect(parsed.cloudUrl).toBe('https://example.com');
    if (process.platform !== 'win32') {
      const st = statSync(configFile);
      expect(st.mode & 0o077).toBe(0);
    }
    expect(loadConfig().apiKey).toBe('shogo_sk_test');
  });

  it('loadConfig throws on corrupt JSON', async () => {
    mkdirSync(join(tmp, '.shogo'), { recursive: true });
    writeFileSync(configFile, '{not json');
    const { loadConfig } = await import('../config.ts');
    expect(() => loadConfig()).toThrow(/Corrupt config/);
  });

  it('mergeConfig prefers override over base, drops undefined', async () => {
    const { mergeConfig } = await import('../config.ts');
    expect(
      mergeConfig({ apiKey: 'a', cloudUrl: 'old' }, { cloudUrl: 'new', name: undefined }),
    ).toEqual({ apiKey: 'a', cloudUrl: 'new' });
  });
});

describe('config: resolveConfig precedence', () => {
  let prevEnvKey: string | undefined;

  beforeEach(() => {
    setupTmpHome();
    prevEnvKey = process.env.SHOGO_API_KEY;
    delete process.env.SHOGO_API_KEY;
  });
  afterEach(() => {
    mock.restore();
    if (prevEnvKey === undefined) delete process.env.SHOGO_API_KEY;
    else process.env.SHOGO_API_KEY = prevEnvKey;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('throws when no API key resolves anywhere', async () => {
    const { resolveConfig } = await import('../config.ts');
    expect(() => resolveConfig()).toThrow(/No API key/);
  });

  it('reads API key from explicit override (highest precedence)', async () => {
    const { resolveConfig, saveConfig } = await import('../config.ts');
    saveConfig({ apiKey: 'shogo_sk_file' });
    process.env.SHOGO_API_KEY = 'shogo_sk_env';
    expect(resolveConfig({ apiKey: 'shogo_sk_override' }).apiKey).toBe('shogo_sk_override');
  });

  it('falls back to env var when no override is given', async () => {
    const { resolveConfig, saveConfig } = await import('../config.ts');
    saveConfig({ apiKey: 'shogo_sk_file' });
    process.env.SHOGO_API_KEY = 'shogo_sk_env';
    expect(resolveConfig().apiKey).toBe('shogo_sk_env');
  });

  it('falls back to file when no override or env is set', async () => {
    const { resolveConfig, saveConfig } = await import('../config.ts');
    saveConfig({ apiKey: 'shogo_sk_file' });
    expect(resolveConfig().apiKey).toBe('shogo_sk_file');
  });

  it('fills defaults for cloudUrl + port', async () => {
    const { resolveConfig, saveConfig } = await import('../config.ts');
    saveConfig({ apiKey: 'shogo_sk_file' });
    const cfg = resolveConfig();
    expect(cfg.cloudUrl).toBe('https://studio.shogo.ai');
    expect(cfg.port).toBe(8002);
  });
});
