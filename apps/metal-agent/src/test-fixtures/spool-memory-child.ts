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
import { mkdirSync, rmSync, statSync } from 'node:fs'

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

/** Peak RSS of this process, in MiB. */
const peakMib = (): number => {
  if (process.platform === 'linux') {
    const status = Bun.file('/proc/self/status')
    // Read synchronously through a spawn: cheap enough at this call frequency
    // and it avoids depending on readFileSync of a virtual file.
    const out = Bun.spawnSync(['sh', '-c', `awk '/^VmHWM/{print $2}' /proc/self/status`])
    return Math.round(Number(out.stdout.toString().trim() || '0') / 1024)
  }
  // macOS reports maxRSS in bytes.
  const { maxRSS } = process.resourceUsage()
  return Math.round(maxRSS / (1024 * 1024))
}

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
