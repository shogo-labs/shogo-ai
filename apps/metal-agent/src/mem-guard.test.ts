// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The agent memory guard (SHO-593).
 *
 * The kernel OOM-killed metal-agent at 63 GiB RSS on 2026-11-26. A systemd
 * MemoryMax cannot guard that, because the firecracker guests share the agent's
 * cgroup (staging: 148 procs, 335 GB), so the guard watches the agent process's
 * own VmRSS and restarts it — the routine rolling-deploy path, where guests
 * survive. `--decide` is the whole policy, so it runs for real here.
 *
 * What cannot be proven on a dev box is the restart itself (no systemd, no
 * metal-agent); that is a host check, recorded in the SHO-593 card.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(import.meta.dir, '../../..')
const SCRIPT = join(ROOT, 'scripts/metal-agent/mem-guard.sh')
const BOOTSTRAP = join(ROOT, 'scripts/metal-agent/host-bootstrap.sh')

const MiB = 1024 // VmRSS is in kB, so 1 GiB = 1024 * 1024 kB

/** Run the real script's pure decision: `ok <why>` or `restart <why>`. */
function decide(
  rssKb: number,
  capMib: number,
  lastEpoch: number,
  nowEpoch: number,
  warnMib = 0,
): string {
  const proc = Bun.spawnSync([
    'bash',
    SCRIPT,
    '--decide',
    String(rssKb),
    String(capMib),
    String(lastEpoch),
    String(nowEpoch),
    String(warnMib),
  ])
  expect(proc.exitCode).toBe(0)
  return proc.stdout.toString().trim()
}

describe('metal-agent-memguard decision', () => {
  test('leaves an agent under the cap alone', () => {
    // The soak's peak on a 140-VM host was 365 MiB, far under a 12 GiB cap.
    expect(decide(365 * MiB, 12288, 0, 1_000_000)).toStartWith('ok below-cap')
  })

  test('restarts an agent that crossed the cap once the cooldown has passed', () => {
    // 33.6 GiB is the measured export burst; 63 GiB is what the kernel killed.
    expect(decide(33_600 * MiB, 12288, 0, 1_000_000)).toStartWith('restart over=33600MiB')
    expect(decide(63 * MiB * 1024, 12288, 0, 1_000_000)).toStartWith('restart over=64512MiB')
  })

  test('does not restart again inside the cooldown, so a recovering host is not looped', () => {
    // After a restart the agent re-adopts its VMs and its RSS climbs again from
    // a cold start; a second restart 30 s later would just churn.
    const out = decide(20_000 * MiB, 12288, 1_000_000, 1_000_030)
    expect(out).toStartWith('ok cooling-down 30s/1800s')
  })

  test('a busy-but-healthy agent warns instead of restarting', () => {
    // dal-2 held 26-29 GiB RSS for 14 days without an OOM, so the restart cap
    // cannot sit there; the warn line is how the climb becomes visible.
    const out = decide(34 * MiB * 1024, 49152, 0, 1_000_000, 32768)
    expect(out).toStartWith('warn over-warn=34816MiB')
  })

  test('cap 0 turns the guard off (opt-out for a host that needs the headroom)', () => {
    expect(decide(200_000 * MiB, 0, 0, 1_000_000)).toBe('ok disabled')
  })

  test('an agent that is not running yet is not a restart', () => {
    expect(decide(0, 12288, 0, 1_000_000)).toBe('ok no-rss')
  })
})

describe('host-bootstrap installs the guard', () => {
  const bootstrap = readFileSync(BOOTSTRAP, 'utf8')

  /** The body of the `<<'DELIM'` heredoc in the bootstrap script, verbatim. */
  function heredoc(delim: string): string {
    const open = `<<'${delim}'\n`
    const i = bootstrap.indexOf(open)
    if (i < 0) throw new Error(`no ${delim} heredoc`)
    const from = i + open.length
    const to = bootstrap.indexOf(`\n${delim}\n`, from)
    if (to < 0) throw new Error(`${delim} heredoc never closed`)
    return bootstrap.slice(from, to + 1)
  }

  test('the embedded script is byte-identical to the tested one', () => {
    // bootstrap has to be self-contained (a fresh host has no checkout), so the
    // script is embedded — this is what keeps the copy from drifting away from
    // the file the decisions above are proven against.
    expect(heredoc('MEMGUARD_SCRIPT')).toBe(readFileSync(SCRIPT, 'utf8'))
  })

  test('installs the timer that runs it every 30 s', () => {
    const timer = heredoc('MEMGUARD_TIMER')
    expect(timer).toContain('OnUnitActiveSec=30s')
    expect(timer).toContain('WantedBy=timers.target')
    const service = heredoc('MEMGUARD_UNIT')
    expect(service).toContain('ExecStart=/usr/local/bin/metal-agent-memguard')
    expect(bootstrap).toContain('systemctl enable --now metal-agent-memguard.timer')
  })

  test('does not put a memory cap on the unit that holds the guests', () => {
    // The whole reason this is a watchdog: MemoryMax / OOMScoreAdjust on
    // metal-agent.service would apply to the guest VMs in its cgroup.
    const unit = heredoc('UNIT')
    expect(unit).not.toContain('MemoryMax=')
    expect(unit).not.toContain('OOMScoreAdjust=')
  })
})
