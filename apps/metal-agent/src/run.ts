// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Run a host command without blocking the agent's event loop.
 *
 * The metal-agent runs one Firecracker boot after another on a single JS thread
 * (plus one shared loop, which is single-threaded within a given test file and,
 * more to the point, single-threaded for every VM the agent manages). A
 * synchronous `execFileSync` holds it for the whole duration of the child, so a
 * `dmsetup remove --retry` (seconds) or an 8 GiB `losetup`-backed copy stalls
 * every OTHER VM's boot in the same process — including the ones waiting for
 * their Firecracker API socket, which is what produced the parallel-boot
 * failures (`FC API socket never appeared`, SHO-545).
 *
 * Everything on the boot / restore / teardown / GC paths goes through here
 * instead. Startup-only work (config probing, disk sizing, self-update) may keep
 * using `execFileSync`: it runs before any VM exists.
 *
 * Trimmed stdout on success; on failure a single Error carrying the command and
 * whatever the child wrote to stderr, so a `dmsetup` or `ip` failure reads the
 * same in the journal as it did synchronously.
 */
import { execFile } from './vendor/child-process'

export function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr ?? '').trim()
        const base = `${cmd} ${args.join(' ')}`
        const e: NodeJS.ErrnoException = new Error(detail ? `${base}: ${detail}` : `${base}: ${err.message}`)
        if ((err as NodeJS.ErrnoException).code) e.code = (err as NodeJS.ErrnoException).code
        reject(e)
        return
      }
      resolve(String(stdout ?? '').trim())
    })
  })
}
