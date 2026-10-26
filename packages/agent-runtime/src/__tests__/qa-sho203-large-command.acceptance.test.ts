// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-203 acceptance 1 — the command that filed the card now runs to completion.
 *
 * The card was filed because a 40B INT4 model (22.5 GB resident) was stopped
 * ~30 s in, every run, on a 128 GB Mac:
 *
 *   [shogo] Stopped: out of memory. … over the 8.0 GB limit for this project's
 *   commands.
 *
 * Every other test in the change proves the *policy* (which number, from where,
 * applied how). This one proves the outcome on a real host: a command that
 * really holds more than the old ceiling, under the budget the desktop derives
 * for this machine by default (`max(50% of RAM, RAM − 8 GB)`), is measured above
 * 8 GB by the guard's own sampler and is **not** killed.
 *
 * Skipped on a host under 64 GB: the card's own scope, and holding ~10 GB on a
 * smaller runner would be the test's problem rather than the product's.
 *
 *   bun test packages/agent-runtime/src/__tests__/qa-sho203-large-command.acceptance.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir, totalmem } from 'os'
import { join } from 'path'
import { execBudget, sampleOnce, sampleTreeRssKb, trackExecProcess } from '../exec-memory-guard'
import { sandboxExecAsync } from '../sandbox-exec'

const dir = mkdtempSync(join(tmpdir(), 'qa-sho203-large-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const GB = 1024 // MB
const totalMemMB = Math.floor(totalmem() / 1024 / 1024)

/** The desktop's default budget for this machine (apps/desktop/src/runtime-memory.ts). */
const autoBudgetMB = Math.max(Math.floor(totalMemMB * 0.5), totalMemMB - 8 * GB)

/** The old, borrowed ceiling — 40% of RAM capped at 8192MB. */
const OLD_CEILING_MB = Math.min(8192, Math.max(3072, Math.floor(totalMemMB * 0.4)))

/** Held memory: comfortably above the old ceiling, well under the new budget. */
const HOLD_MB = 10 * GB

/**
 * The child's script. The buffer has to stay **reachable** — a `Buffer.alloc`
 * nobody reads is collected and the child measures ~20 MB, which would make
 * this test pass for the wrong reason (SHO-154).
 */
const HOLD_SCRIPT =
  // One 1 GiB buffer per chunk: a single `Buffer.alloc` is capped at 4 GiB
  // (ERR_OUT_OF_RANGE), so a 10 GB holding set is ten of them.
  `const CHUNK = 1024 * 1024 * 1024\n` +
  `const held = []\n` +
  `for (let i = 0; i < ${Math.round(HOLD_MB / GB)}; i++) held.push(Buffer.alloc(CHUNK, 7))\n` +
  `function report() {\n` +
  `  for (const b of held) if (b[0] !== 7 || b[b.length - 1] !== 7) process.exit(2)\n` +
  `  console.log('[qa-sho203] held=' + process.memoryUsage().rss)\n` +
  `}\n` +
  `report()\n` +
  `setInterval(report, 500)\n` +
  `setTimeout(() => { report(); process.exit(0) }, ${20_000})\n`

describe('SHO-203 acceptance — a command over the old 8 GB ceiling completes', () => {
  test.skipIf(totalMemMB < 64 * GB)(
    `a ${Math.round(HOLD_MB / GB)} GB-resident command survives the desktop’s default budget`,
    async () => {
      // What the desktop publishes on this machine, at default settings.
      const limitsFile = join(dir, 'host-limits.json')
      writeFileSync(
        limitsFile,
        JSON.stringify({ execMemoryMB: autoBudgetMB, totalMemMB, source: 'auto' }),
      )
      const saved = {
        file: process.env.SHOGO_HOST_LIMITS_FILE,
        pids: process.env.SHOGO_EXEC_PIDS_FILE,
        mb: process.env.SHOGO_EXEC_MEMORY_MB,
        sample: process.env.SHOGO_EXEC_MEMORY_SAMPLE_MS,
        strikes: process.env.SHOGO_EXEC_MEMORY_STRIKES,
      }
      process.env.SHOGO_HOST_LIMITS_FILE = limitsFile
      process.env.SHOGO_EXEC_PIDS_FILE = join(dir, 'pids.json')
      process.env.SHOGO_EXEC_MEMORY_SAMPLE_MS = '2000'
      process.env.SHOGO_EXEC_MEMORY_STRIKES = '1'
      delete process.env.SHOGO_EXEC_MEMORY_MB

      const script = join(dir, 'hold.js')
      writeFileSync(script, HOLD_SCRIPT)
      const handle = sandboxExecAsync({
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
        workspaceDir: dir,
      })
      const untrack = trackExecProcess({
        pid: handle.pid!,
        killForMemory: () => handle.kill('SIGKILL'),
      })

      try {
        // The premise: the budget is the host-derived one, not the old ceiling.
        expect(execBudget().mb).toBe(autoBudgetMB)
        expect(execBudget().source).toBe('settings')
        expect(autoBudgetMB).toBeGreaterThan(OLD_CEILING_MB)

        // Sample the way the guard does, for as long as the command runs, and
        // record the highest reading so the test can prove the guard looked at a
        // command that really was over the old ceiling.
        let peakMB = 0
        let samples = 0
        const deadline = Date.now() + 60_000
        while (!handle.exited() && Date.now() < deadline) {
          const sizes = await sampleTreeRssKb([handle.pid!])
          peakMB = Math.max(peakMB, Math.floor((sizes.get(handle.pid!) ?? 0) / 1024))
          await sampleOnce()
          samples++
          if (handle.exited()) break
          await new Promise((resolve) => setTimeout(resolve, 500))
        }

        const result = await Promise.race([
          handle.done,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
        ])
        if (!result) {
          handle.kill('SIGKILL')
          throw new Error(`the command was still running after the loop; peak ${peakMB} MB`)
        }

        // It finished on its own…
        expect(result.killReason).toBeUndefined()
        expect(result.exitCode).toBe(0)
        // …after the guard sampled it several times…
        expect(samples).toBeGreaterThan(2)
        // …while holding more than the 8 GB that used to stop it.
        expect(peakMB).toBeGreaterThan(OLD_CEILING_MB)
        expect(peakMB).toBeGreaterThan(8 * GB)
        expect(peakMB).toBeLessThanOrEqual(autoBudgetMB)
        expect(result.stdout).toContain('[qa-sho203] held=')
      } finally {
        untrack()
        for (const [key, value] of [
          ['SHOGO_HOST_LIMITS_FILE', saved.file],
          ['SHOGO_EXEC_PIDS_FILE', saved.pids],
          ['SHOGO_EXEC_MEMORY_MB', saved.mb],
          ['SHOGO_EXEC_MEMORY_SAMPLE_MS', saved.sample],
          ['SHOGO_EXEC_MEMORY_STRIKES', saved.strikes],
        ] as const) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        if (!handle.exited()) handle.kill('SIGKILL')
      }
    },
    180_000,
  )
})
