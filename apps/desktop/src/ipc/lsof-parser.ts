// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure parser for `lsof -iTCP -sTCP:LISTEN -P -n` output.
 *
 * We split this out from the IPC layer so the parser can be unit-tested
 * without spawning processes. Every quirk of lsof's tabular output goes here;
 * the IPC layer just feeds raw stdout in and gets typed rows out.
 *
 * Sample input row:
 *   node    12345 user   17u  IPv4 0x...      0t0  TCP *:3000 (LISTEN)
 *   node    12345 user   18u  IPv6 0x...      0t0  TCP [::1]:3000 (LISTEN)
 *
 * The same listener often appears twice (once for IPv4, once for IPv6 on the
 * same pid). Callers want one row per (port, pid) pair, so we dedupe.
 */

export interface PortEntry {
  /** TCP port being listened on. */
  port: number
  /** Listening process's command (lsof's COMMAND column — basename only). */
  command: string
  /** Process id (numeric). */
  pid: number
  /** Bound local address — '*' (all interfaces), '127.0.0.1', '::1', etc. */
  address: string
  /** 'IPv4' | 'IPv6' — whichever appeared first for this (port, pid) pair. */
  type: 'IPv4' | 'IPv6'
}

/**
 * Parse the raw stdout of `lsof -iTCP -sTCP:LISTEN -P -n` into a deduped
 * list of listening ports.
 *
 * Skips the header row and any non-LISTEN rows defensively (in case the
 * caller passes lsof output gathered without the -sTCP:LISTEN flag).
 *
 * Rows that don't match the expected column shape are skipped silently —
 * lsof can emit warnings on stdout for inaccessible processes ("lsof: WARNING:
 * can't stat..."), and we don't want a single bad line to nuke the whole list.
 */
export function parseLsof(stdout: string): PortEntry[] {
  const lines = stdout.split(/\r?\n/)
  const seen = new Map<string, PortEntry>()

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('COMMAND')) continue            // header
    if (line.startsWith('lsof:')) continue              // warnings
    if (!line.includes('(LISTEN)')) continue            // defensive

    // lsof's columns are whitespace-separated. The NAME column can contain
    // spaces in theory but for `-iTCP -P -n` it's always a single token
    // like `*:3000` or `[::1]:3000` or `127.0.0.1:8080`, possibly followed
    // by ` (LISTEN)` — split on whitespace and walk from the right.
    const cols = line.split(/\s+/)
    if (cols.length < 9) continue

    const command = cols[0] ?? ''
    const pidStr = cols[1] ?? ''
    const type = cols[4] ?? ''
    // NAME column is at index 8; (LISTEN) is at 9. If lsof packs them, NAME
    // ends with "(LISTEN)" — strip it.
    let nameCol = cols[8] ?? ''
    if (nameCol.endsWith('(LISTEN)')) {
      nameCol = nameCol.slice(0, -'(LISTEN)'.length).trim()
    }

    const pid = Number.parseInt(pidStr, 10)
    if (!Number.isFinite(pid) || pid <= 0) continue
    if (type !== 'IPv4' && type !== 'IPv6') continue

    const parsed = parseAddressPort(nameCol)
    if (!parsed) continue

    const key = `${parsed.port}:${pid}`
    if (seen.has(key)) continue   // dedupe IPv4/IPv6 twins

    seen.set(key, {
      port: parsed.port,
      command,
      pid,
      address: parsed.address,
      type,
    })
  }

  // Stable order: ascending port, then pid.
  return [...seen.values()].sort((a, b) => a.port - b.port || a.pid - b.pid)
}

/**
 * Split lsof's NAME column for a TCP listener into address + port.
 *
 * Accepts:
 *   "*:3000"               → { address: '*',         port: 3000 }
 *   "127.0.0.1:8080"       → { address: '127.0.0.1', port: 8080 }
 *   "[::1]:3000"           → { address: '::1',       port: 3000 }
 *   "[::]:8080"            → { address: '::',        port: 8080 }
 *
 * Returns null if the shape doesn't match (so the caller can skip the row).
 */
export function parseAddressPort(name: string): { address: string; port: number } | null {
  if (!name) return null

  // IPv6: bracketed address.
  if (name.startsWith('[')) {
    const close = name.indexOf(']')
    if (close < 0) return null
    const address = name.slice(1, close)
    const after = name.slice(close + 1)
    if (!after.startsWith(':')) return null
    const port = Number.parseInt(after.slice(1), 10)
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
    return { address, port }
  }

  // IPv4 / wildcard: last colon separates address from port.
  const lastColon = name.lastIndexOf(':')
  if (lastColon < 0) return null
  const address = name.slice(0, lastColon)
  const port = Number.parseInt(name.slice(lastColon + 1), 10)
  if (!address) return null
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
  return { address, port }
}

/**
 * Compute which entries are *new* between two scans — used by the renderer to
 * animate a 200ms highlight on freshly-detected ports.
 *
 * Newness is keyed on (port, pid): the same port appearing under a different
 * pid is treated as new, which matches what the user expects ("a new process
 * just claimed this port").
 */
export function diffNewPorts(prev: PortEntry[], next: PortEntry[]): PortEntry[] {
  const prevKeys = new Set(prev.map((p) => `${p.port}:${p.pid}`))
  return next.filter((p) => !prevKeys.has(`${p.port}:${p.pid}`))
}
