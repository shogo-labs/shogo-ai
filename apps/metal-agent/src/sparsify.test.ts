// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { digHoles } from './sparsify'

// `fallocate --dig-holes` (FALLOC_FL_PUNCH_HOLE) is Linux + ext4/xfs only. The
// production hosts are Linux; skip on dev macOS where the syscall/tool is absent
// (digHoles correctly returns false there, which the "missing tool" spirit of
// the last case still exercises via a bad path).
const onLinux = process.platform === 'linux'
const d = onLinux ? describe : describe.skip

d('digHoles', () => {
  test('reclaims all-zero blocks while preserving exact bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparsify-'))
    try {
      const f = join(dir, 'snap.mem')
      // 1 MiB nonzero | 16 MiB zeros | 1 MiB nonzero — mimics a mem image whose
      // freed pages the balloon zeroed. Only the middle should be punched out.
      const head = Buffer.alloc(1 << 20, 0xab)
      const zeros = Buffer.alloc(16 << 20, 0x00)
      const tail = Buffer.alloc(1 << 20, 0xcd)
      writeFileSync(f, Buffer.concat([head, zeros, tail]))

      const beforeBytes = statSync(f).blocks * 512
      const ok = await digHoles(f)
      expect(ok).toBe(true)
      const afterBytes = statSync(f).blocks * 512

      // Freed roughly the 16 MiB zero region (slack for fs block rounding).
      expect(beforeBytes - afterBytes).toBeGreaterThan(12 << 20)

      // Logical size is unchanged and every byte reads back identically — the
      // holes return zeros, which is exactly what was there. This is why a
      // subsequent Firecracker LoadSnapshot is unaffected.
      const round = readFileSync(f)
      expect(round.length).toBe((1 << 20) + (16 << 20) + (1 << 20))
      expect(round.subarray(0, 1 << 20).equals(head)).toBe(true)
      expect(round.subarray(1 << 20, (1 << 20) + (16 << 20)).equals(zeros)).toBe(true)
      expect(round.subarray((17 << 20)).equals(tail)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('is best-effort: returns false (no throw) on a missing file', async () => {
    expect(await digHoles('/nonexistent/dir/does-not-exist.mem')).toBe(false)
  })
})
