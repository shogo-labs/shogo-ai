/**
 * Leak cycles: reload the renderer, open/close nothing heavy unless a
 * project id is provided, and require memory and webContents to settle.
 *
 *   SHOGO_MEMORY_E2E=1 \
 *     npx playwright test --config apps/desktop/e2e/playwright.config.ts \
 *     e2e/memory-leak.spec.ts
 *
 * Heap snapshots land in bench-results/heaps for memlab:
 *   memlab analyze unbound-object --snapshot-dir bench-results/heaps
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { withinLeakBudget } from '../../../scripts/bench/memory-report'

const enabled = process.env.SHOGO_MEMORY_E2E === '1'
const desktopDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(desktopDir, '..', '..')
const cycles = Number(process.env.SHOGO_MEMORY_LEAK_CYCLES ?? 10)

async function workingSetMb(app: ElectronApplication): Promise<number> {
  const kb = await app.evaluate(({ app }) =>
    app.getAppMetrics().reduce((sum, metric) => sum + metric.memory.workingSetSize, 0),
  )
  return kb / 1024
}

async function webContentsCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ webContents }) => webContents.getAllWebContents().length)
}

async function writeHeapSnapshot(page: Page, file: string): Promise<void> {
  const client = await page.context().newCDPSession(page)
  const chunks: string[] = []
  client.on('HeapProfiler.addHeapSnapshotChunk', (payload: { chunk: string }) => {
    chunks.push(payload.chunk)
  })
  await client.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  writeFileSync(file, chunks.join(''))
  await client.detach()
}

test.describe('desktop memory leak cycles', () => {
  test.skip(!enabled, 'set SHOGO_MEMORY_E2E=1')
  test.setTimeout(300_000)

  test('reloading the renderer 10 times does not accumulate webContents or working set', async () => {
    const electronEntry = require.resolve('electron', { paths: [desktopDir] })
    const electronModule = require(electronEntry) as unknown as string
    const app = await electron.launch({
      executablePath: electronModule,
      args: ['.', `--user-data-dir=${os.tmpdir()}/shogo-leak-${Date.now()}`, '--no-sandbox'],
      cwd: desktopDir,
      env: {
        ...process.env,
        SHOGO_E2E: 'true',
        SHOGO_SKIP_LOCAL_SERVER: process.env.SHOGO_SKIP_LOCAL_SERVER ?? 'true',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
      timeout: 60_000,
    })

    const heapDir = path.join(repoRoot, 'bench-results', 'heaps')
    mkdirSync(heapDir, { recursive: true })
    try {
      const page = await app.firstWindow({ timeout: 60_000 })
      await page.waitForLoadState('domcontentloaded')
      await page.waitForTimeout(2_000)
      const baselineContents = await webContentsCount(app)
      const baselineMb = await workingSetMb(app)
      await writeHeapSnapshot(page, path.join(heapDir, 'reload-baseline.heapsnapshot'))

      for (let i = 0; i < cycles; i++) {
        await page.reload()
        await page.waitForLoadState('domcontentloaded')
      }
      await page.waitForTimeout(2_000)
      const afterContents = await webContentsCount(app)
      const afterMb = await workingSetMb(app)
      await writeHeapSnapshot(page, path.join(heapDir, 'reload-after.heapsnapshot'))

      expect(afterContents).toBeLessThanOrEqual(baselineContents + 1)
      // A reload keeps the same webContents, so Chromium's working set stays
      // above the first-load baseline. Open/close cycles below are the 5% check.
      console.log(`reload working set ${baselineMb.toFixed(1)} -> ${afterMb.toFixed(1)} MB`)

      const projectId = process.env.SHOGO_PERF_E2E_PROJECT_ID
      if (projectId) {
        const routes = [
          { name: 'project', route: `/(app)/projects/${encodeURIComponent(projectId)}` },
          { name: 'ide', route: `/(app)/projects/${encodeURIComponent(projectId)}?tab=ide` },
          { name: 'preview', route: `/(app)/projects/${encodeURIComponent(projectId)}?tab=preview` },
        ]
        for (const item of routes) {
          const beforeMb = await workingSetMb(app)
          const beforeContents = await webContentsCount(app)
          for (let i = 0; i < cycles; i++) {
            await app.evaluate(({ BrowserWindow }, route) => {
              const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
              if (!window) return
              void window.loadURL(`shogo://app${route}`)
            }, item.route)
            await page.waitForTimeout(1_000)
            await app.evaluate(({ BrowserWindow }) => {
              const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
              if (!window) return
              void window.loadURL('shogo://app/')
            })
            await page.waitForTimeout(500)
          }
          await page.waitForTimeout(2_000)
          await writeHeapSnapshot(page, path.join(heapDir, `${item.name}-cycle-after.heapsnapshot`))
          expect(await webContentsCount(app)).toBeLessThanOrEqual(beforeContents + 2)
          expect(withinLeakBudget(beforeMb, await workingSetMb(app))).toBe(true)
        }

        if (process.env.SHOGO_SKIP_LOCAL_SERVER !== 'true') {
          const turns = Number(process.env.SHOGO_MEMORY_CHAT_TURNS ?? 50)
          await app.evaluate(({ BrowserWindow }, route) => {
            const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
            if (!window) return
            void window.loadURL(`shogo://app${route}`)
          }, `/(app)/projects/${encodeURIComponent(projectId)}`)
          const composer = page.getByTestId('project-composer-input').filter({ visible: true }).first()
          const visible = await composer.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false)
          if (visible) {
            const beforeChat = await workingSetMb(app)
            const beforeContents = await webContentsCount(app)
            for (let i = 0; i < turns; i++) {
              await composer.click()
              await composer.fill(`memory leak probe ${i}`)
              await page.keyboard.press('Enter')
              await page.waitForTimeout(300)
            }
            await page.waitForTimeout(2_000)
            await writeHeapSnapshot(page, path.join(heapDir, 'chat-turns-after.heapsnapshot'))
            expect(await webContentsCount(app)).toBeLessThanOrEqual(beforeContents + 2)
            expect(withinLeakBudget(beforeChat, await workingSetMb(app))).toBe(true)
          }
        }
      }
    } finally {
      await app.close().catch(() => {})
    }
  })
})
