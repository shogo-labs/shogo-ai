// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression test for the "posix_spawnp failed" boot bug.
 *
 * If node-pty's prebuilt `spawn-helper` binaries ever lose their executable
 * bit (npm/bun packaging issues, electron-builder asar repack, manual
 * `chmod 644` from a git checkout, etc.) every terminal in the desktop app
 * fails to spawn with EACCES. The `postinstall` script
 * `scripts/fix-node-pty-perms.mjs` repairs the bits — this test asserts the
 * helper(s) for the current platform are actually executable so a broken
 * postinstall can't ship silently.
 *
 * Skipped on Windows (node-pty uses winpty/conpty, no helper binary).
 */
import { describe, it, expect } from 'bun:test';
import { statSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { platform, arch } from 'node:os';

describe('node-pty spawn-helper permissions', () => {
  if (platform() === 'win32') {
    it.skip('skipped on Windows (no spawn-helper)', () => {});
    return;
  }

  const platformDir = `${platform()}-${arch()}`;
  const helper = join(
    __dirname,
    '..',
    '..',
    '..',
    'node_modules',
    'node-pty',
    'prebuilds',
    platformDir,
    'spawn-helper',
  );

  it(`spawn-helper exists for ${platformDir}`, () => {
    const s = statSync(helper);
    expect(s.isFile()).toBe(true);
  });

  it('spawn-helper is executable (chmod +x)', () => {
    expect(() => accessSync(helper, constants.X_OK)).not.toThrow();
    const mode = statSync(helper).mode & 0o777;
    expect(mode & 0o111).not.toBe(0);
  });
});
