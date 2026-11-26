// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Child process for `spool-memory.test.ts`: run ONE export path over a body of
 * a given size and report this process's peak RSS.
 *
 * It has to be a separate process: peak RSS is a property of the process, so a
 * measurement taken inside the test runner would be polluted by every other
 * test's allocations, and a regression here is exactly "the agent's own RSS".
 *
 *   bun spool-memory-child.ts <spool|gzip> <mib>
 *
 * Prints one JSON line: { mode, src_bytes, out_bytes, peak_rss_mib }.
 */
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'

const [mode = 'spool', mibArg = '128'] = process.argv.slice(2)
const mib = Number(mibArg)
const dir = `/tmp/spool-memory-${process.pid}`
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

const src = `${dir}/body.bin`
const chunk = new Uint8Array(1024 * 1024)
const handle = Bun.file(src).writer()
for (let i = 0; i < mib; i++) await handle.write(chunk)
await handle.end()

/**
 * Current RSS of this process, in MiB.
 *
 * Linux reads THIS process's `/proc/self/status` VmHWM (an exact high-water
 * mark, in kB). It must not go through a spawned `sh`: `/proc/self` inside that
 * child resolves to the child, so the reading came back as the shell's own
 * ~2 MiB mark and the bound in `spool-memory.test.ts` could never fail.
 *
 * Everywhere else samples `process.memoryUsage().rss()`, which is bytes by API
 * contract. `process.resourceUsage().maxRSS` is NOT bytes — it is kilobytes on
 * POSIX — so dividing it by 1 MiB reported 0 MiB on macOS, which also made the
 * bound unfalsifiable (SHO-593 QA). The test asserts a floor as well, so a
 * measurement that quietly stops working fails loudly instead of passing.
 */
const rssMib = (): number => {
  if (process.platform === 'linux') {
    const m = readFileSync('/proc/self/status', 'utf8').match(/^VmHWM:\s+(\d+) kB$/m)
    if (m) return Math.round(Number(m[1]) / 1024)
  }
  return Math.round(process.memoryUsage().rss / (1024 * 1024))
}
const peakMib = rssMib

let outBytes = 0
let peak = 0
const tick = setInterval(() => {
  peak = Math.max(peak, peakMib())
}, 50)

const { spoolResponse } = await import('../pool.ts')
const { pushGzippedObject } = await import('../snapshot-store.ts')

if (mode === 'spool') {
  const dest = `${dir}/spooled.tar.gz`
  const res = new Response(Bun.file(src), { headers: { 'content-length': String(mib * 1024 * 1024) } })
  const spooled = await spoolResponse(res, dest, 8 * 1024 * 1024 * 1024)
  outBytes = spooled.size
  clearInterval(tick)
  peak = Math.max(peak, peakMib())
  rmSync(dir, { recursive: true, force: true })
  console.log(JSON.stringify({ mode, src_bytes: mib * 1024 * 1024, out_bytes: outBytes, peak_rss_mib: peak }))
} else {
  // The snapshot push: pigz to a temp file, then a file-body upload. The sink
  // reads the gz so the assertion also covers a real reader of the artifact.
  let uploaded = 0
  await pushGzippedObject(
    {
      putFile: async (_key, path) => {
        uploaded = statSync(path).size
      },
    },
    'memory-test/mem.gz',
    src,
  )
  clearInterval(tick)
  peak = Math.max(peak, peakMib())
  rmSync(dir, { recursive: true, force: true })
  console.log(JSON.stringify({ mode, src_bytes: mib * 1024 * 1024, out_bytes: uploaded, peak_rss_mib: peak }))
}
