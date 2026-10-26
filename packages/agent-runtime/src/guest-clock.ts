// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Guest wall-clock correction after a metal snapshot restore.
 *
 * A Firecracker snapshot freezes the guest's memory, and a restore only moves
 * the guest's clock forward if the guest is running on `kvm-clock` (the
 * `clock_realtime` flag on `/snapshot/load` is KVM_CLOCK_REALTIME, which does
 * nothing for a TSC guest). Guests booted before the host pinned
 * `clocksource=kvm-clock` therefore resume with their clock frozen at the
 * moment the snapshot was taken: on staging 2026-10-25 a workspace resumed
 * 4h40m behind, so the agent read the wrong time and every outbound TLS
 * handshake failed with "certificate is not yet valid".
 *
 * The host sends its clock in the body of `POST /pool/rehydrate`; this module
 * decides whether the guest is off by enough to matter and, if so, sets the
 * guest's CLOCK_REALTIME before the sidecars restart. Both directions are
 * tolerated: an old host sends no `hostNowMs` (we do nothing) and an old guest
 * ignores the field.
 */

/** Skew small enough to be measurement noise rather than a frozen clock. */
export const CLOCK_SKEW_TOLERANCE_MS = 2000

export interface GuestClockSync {
  /** Guest minus host, in ms, as measured before any correction. */
  skewMs: number
  /** True when the guest clock was set from the host's. */
  corrected: boolean
  /** Skew left over after correcting, in ms. */
  residualMs?: number
  /** Why the skew was left uncorrected. Never set when `corrected` is true. */
  error?: string
}

export interface GuestClockSyncDeps {
  /** Read the guest clock. Defaults to `Date.now()`. */
  now?: () => number
  /** Set the guest clock. Returns an error string, or null on success. */
  setWallClock?: (atMs: number) => Promise<string | null>
  /** Why this process cannot set the clock, or null if it can. */
  clockSetBlockedReason?: () => string | null
}

/**
 * Correct the guest clock from the host's, if they differ by more than
 * `CLOCK_SKEW_TOLERANCE_MS`.
 *
 * Returns null when the host sent no usable `hostNowMs` — the caller then
 * behaves exactly as it did before this existed (AC3).
 */
export async function syncGuestClock(
  hostNowMs: unknown,
  deps: GuestClockSyncDeps = {},
): Promise<GuestClockSync | null> {
  if (typeof hostNowMs !== 'number' || !Number.isFinite(hostNowMs) || hostNowMs <= 0) return null
  const now = deps.now ?? (() => Date.now())
  const skewMs = now() - hostNowMs
  if (Math.abs(skewMs) <= CLOCK_SKEW_TOLERANCE_MS) return { skewMs, corrected: false }

  const blocked = (deps.clockSetBlockedReason ?? clockSetBlockedReason)()
  if (blocked) return { skewMs, corrected: false, error: blocked }

  const err = await (deps.setWallClock ?? setWallClock)(hostNowMs)
  if (err) return { skewMs, corrected: false, error: err }
  return { skewMs, corrected: true, residualMs: now() - hostNowMs }
}

/**
 * Metal guests run this runtime as PID 1 of the VM (fc-init execs
 * /entrypoint.sh as root, no privilege drop), so it holds CAP_SYS_TIME. Say so
 * explicitly when it does not instead of failing a `date -s` and hoping the
 * message is read.
 */
export function clockSetBlockedReason(): string | null {
  if (process.platform !== 'linux') return `cannot set the clock on ${process.platform}`
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  if (uid !== 0) return `cannot set the clock as uid ${uid} (needs root or CAP_SYS_TIME)`
  return null
}

/**
 * `date -u -s @<sec>` — whole seconds, which is the resolution of the `Date`
 * header the skew was measured from and well inside the tolerance. Setting
 * CLOCK_REALTIME leaves CLOCK_MONOTONIC alone, so no timer or timeout in the
 * guest fires early or late because of this.
 */
async function setWallClock(atMs: number): Promise<string | null> {
  const sec = Math.round(atMs / 1000)
  try {
    const out = Bun.spawnSync(['date', '-u', '-s', `@${sec}`], {
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    })
    if (out.exitCode === 0) return null
    const stderr = out.stderr?.toString().trim()
    return `date -s exited ${out.exitCode}${stderr ? `: ${stderr}` : ''}`
  } catch (err: any) {
    return `date -s failed: ${err?.message ?? err}`
  }
}
