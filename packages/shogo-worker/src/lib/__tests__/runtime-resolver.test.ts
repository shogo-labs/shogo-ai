// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRuntime, formatMissingRuntimeError } from '../runtime-resolver.ts';

/**
 * Resolver priority chain:
 *   1. --runtime-bin flag
 *   2. SHOGO_AGENT_RUNTIME_BIN env var
 *   3. ~/.shogo/runtime/agent-runtime (the "home" path; we can't easily
 *      override that without mocking paths.ts, so we just assert it's
 *      consulted via the missing-binary message).
 *   4. PATH search for the system bin name
 *
 * These tests construct a tmpdir with a fake executable and exercise the
 * first two + the PATH branch directly.
 */

describe('runtime-resolver: resolveRuntime', () => {
  let tmp: string;
  let realBin: string;
  let dummyDir: string;
  let dummyBin: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'shogo-resolver-'));
    realBin = join(tmp, 'fake-runtime');
    writeFileSync(realBin, '#!/bin/sh\necho hi\n');
    chmodSync(realBin, 0o755);

    dummyDir = join(tmp, 'pathdir');
    mkdirSync(dummyDir);
    dummyBin = join(dummyDir, 'shogo-agent-runtime');
    writeFileSync(dummyBin, '#!/bin/sh\necho hi\n');
    chmodSync(dummyBin, 0o755);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('--runtime-bin flag wins when set and the file is executable', () => {
    const result = resolveRuntime({ flag: realBin, env: { PATH: '' } });
    expect(result?.path).toBe(realBin);
    expect(result?.source).toBe('flag');
  });

  it('falls through when the flag points at a non-existent path', () => {
    const result = resolveRuntime({
      flag: join(tmp, 'does-not-exist'),
      env: { SHOGO_AGENT_RUNTIME_BIN: realBin, PATH: '' },
    });
    expect(result?.path).toBe(realBin);
    expect(result?.source).toBe('env');
  });

  it('falls through when the flag points at a non-executable file', () => {
    const nonExec = join(tmp, 'non-exec');
    writeFileSync(nonExec, 'plain text');
    chmodSync(nonExec, 0o644);

    const result = resolveRuntime({
      flag: nonExec,
      env: { SHOGO_AGENT_RUNTIME_BIN: realBin, PATH: '' },
    });
    expect(result?.source).toBe('env');
  });

  it('SHOGO_AGENT_RUNTIME_BIN wins when no flag is set', () => {
    const result = resolveRuntime({ env: { SHOGO_AGENT_RUNTIME_BIN: realBin, PATH: '' } });
    expect(result?.path).toBe(realBin);
    expect(result?.source).toBe('env');
  });

  it('falls back to PATH when flag/env/home are all unavailable', () => {
    const result = resolveRuntime({
      env: { PATH: dummyDir },
      systemBinName: 'shogo-agent-runtime',
    });
    expect(result?.path).toBe(dummyBin);
    expect(result?.source).toBe('path');
  });

  it('returns null when nothing resolves', () => {
    const result = resolveRuntime({
      env: { PATH: tmp /* tmp has no bin matching the system name */ },
      systemBinName: 'definitely-not-on-path-xyz',
    });
    expect(result).toBeNull();
  });
});

describe('runtime-resolver: formatMissingRuntimeError', () => {
  it('mentions the flag if one was passed', () => {
    const msg = formatMissingRuntimeError({ flag: '/tmp/foo' });
    expect(msg).toContain('--runtime-bin /tmp/foo');
  });

  it('mentions SHOGO_AGENT_RUNTIME_BIN when set', () => {
    const msg = formatMissingRuntimeError({ env: { SHOGO_AGENT_RUNTIME_BIN: '/opt/foo' } });
    expect(msg).toContain('SHOGO_AGENT_RUNTIME_BIN');
    expect(msg).toContain('/opt/foo');
  });

  it('always includes the install hint', () => {
    const msg = formatMissingRuntimeError();
    expect(msg).toContain('shogo runtime install');
  });
});
