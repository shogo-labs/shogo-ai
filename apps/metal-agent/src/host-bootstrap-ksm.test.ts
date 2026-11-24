// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * host-bootstrap.sh's KSM provisioning (SHO-534), exercised for real.
 *
 * The block between the `ksm-setup` markers is extracted verbatim and run under
 * bash with `KSM_TMPFILES` pointed at a temp dir, so these prove the behaviour
 * the ACs ask for — a default host writes nothing, an opted-in host gets the
 * tmpfiles.d drop-in, and re-running is idempotent — instead of grepping the
 * script text for strings that could be sitting in a comment.
 *
 * What cannot be proven here is the sysfs effect (there is no /sys/kernel/mm/ksm
 * on a dev machine); that is a staging check, recorded in
 * docs/runbooks/metal-idle-memory.md.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SCRIPT = join(import.meta.dir, '../../../scripts/metal-agent/host-bootstrap.sh')

/** The KSM block, between its markers, exactly as the script runs it. */
function ksmBlock(): string {
  const text = readFileSync(SCRIPT, 'utf8')
  const start = text.indexOf('# >>> ksm-setup')
  const end = text.indexOf('# <<< ksm-setup')
  if (start < 0 || end < 0 || end < start) throw new Error('ksm-setup markers missing')
  return text.slice(start, end)
}

/**
 * Run the block with a stubbed `log` (so nothing prints) and a stubbed
 * `systemd-tmpfiles` (no systemd on a dev box). `set -u` matches the script's
 * `set -euo pipefail`, so an unset variable in the block fails the test.
 */
function runBlock(dir: string, env: { METAL_KSM?: string }): { stdout: string; code: number } {
  const script = `
set -euo pipefail
log() { printf '%s\\n' "$*"; }
systemd-tmpfiles() { :; }
export KSM_TMPFILES=${JSON.stringify(join(dir, 'metal-ksm.conf'))}
${ksmBlock()}
`
  const proc = Bun.spawnSync(['bash', '-c', script], {
    env: { ...process.env, ...(env.METAL_KSM !== undefined ? { METAL_KSM: env.METAL_KSM } : {}) },
  })
  return { stdout: proc.stdout.toString(), code: proc.exitCode ?? 0 }
}

function withDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'ksm-bootstrap-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('host-bootstrap.sh KSM block', () => {
  test('with the default env it writes nothing and logs nothing (prod unchanged)', () => {
    withDir((dir) => {
      // Start from the "prod host that never had KSM" state.
      delete process.env.METAL_KSM
      const r = runBlock(dir, {})
      expect(r.code).toBe(0)
      expect(r.stdout).toBe('')
      expect(existsSync(join(dir, 'metal-ksm.conf'))).toBe(false)
    })
  })

  test('METAL_KSM=1 provisions the tmpfiles.d drop-in with the starting values', () => {
    withDir((dir) => {
      const r = runBlock(dir, { METAL_KSM: '1' })
      expect(r.code).toBe(0)
      const conf = readFileSync(join(dir, 'metal-ksm.conf'), 'utf8')
      // Persisted through tmpfiles.d, so it survives a reboot without a hand edit.
      expect(conf).toContain('w /sys/kernel/mm/ksm/run              - - - - 1')
      expect(conf).toContain('w /sys/kernel/mm/ksm/pages_to_scan    - - - - 1000')
      expect(conf).toContain('w /sys/kernel/mm/ksm/sleep_millisecs  - - - - 50')
      expect(conf).toContain('w /sys/kernel/mm/ksm/use_zero_pages   - - - - 1')
      expect(r.stdout).toContain('KSM: enabling')
    })
  })

  test('re-running is idempotent: same file, no duplicate lines', () => {
    withDir((dir) => {
      runBlock(dir, { METAL_KSM: '1' })
      const first = readFileSync(join(dir, 'metal-ksm.conf'), 'utf8')
      runBlock(dir, { METAL_KSM: '1' })
      const second = readFileSync(join(dir, 'metal-ksm.conf'), 'utf8')
      expect(second).toBe(first)
      expect(second.split('\n').filter((l) => l.startsWith('w /sys/kernel/mm/ksm/run')).length).toBe(1)
    })
  })

  test('turning it back off removes the drop-in (and says so, once)', () => {
    withDir((dir) => {
      runBlock(dir, { METAL_KSM: '1' })
      const off = runBlock(dir, { METAL_KSM: '0' })
      expect(off.code).toBe(0)
      expect(existsSync(join(dir, 'metal-ksm.conf'))).toBe(false)
      expect(off.stdout).toContain('KSM: disabling')
      // A second run on the now-clean host says nothing.
      expect(runBlock(dir, { METAL_KSM: '0' }).stdout).toBe('')
    })
  })

  test('the unit only gets MemoryKSM=yes when the host opted in', () => {
    const text = readFileSync(SCRIPT, 'utf8')
    // The unit itself never carries the key; it is added by the gated sed.
    expect(text).not.toContain('MemoryKSM=yes\nUser=root')
    expect(text).toMatch(/if \[ "\$METAL_KSM" = "1" \]; then[\s\S]{0,400}MemoryKSM=yes/)
  })
})
