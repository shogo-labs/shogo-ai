/**
 * Whole-tree memory budgets for the desktop app.
 *
 * Opt-in: launching Electron and waiting out an idle window is too slow
 * for PR CI. Nightly `desktop-memory.yml` sets SHOGO_MEMORY_E2E=1.
 *
 *   SHOGO_MEMORY_E2E=1 SHOGO_MEMORY_ASSERT=1 \
 *     npx playwright test --config apps/desktop/e2e/playwright.config.ts \
 *     e2e/memory-budget.spec.ts
 *
 * SHOGO_SKIP_LOCAL_SERVER=true measures Electron without the Bun API.
 * SHOGO_MEMORY_IDLE_MS overrides the 60s launch checkpoint (default 60000).
 * SHOGO_PERF_E2E_PROJECT_ID adds the project-open checkpoint.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import os from 'os'
import path from 'path'
import {
  MEMORY_BUDGETS,
  buildCheckpoint,
  descendants,
  evaluateBudgets,
  parsePs,
  readFootprintMb,
  renderMarkdown,
  sampleProcessList,
  writeReport,
  type Checkpoint,
  type ElectronProcessSample,
} from '../../../scripts/bench/memory-report'

const enabled = process.env.SHOGO_MEMORY_E2E === '1'
const assertBudgets = process.env.SHOGO_MEMORY_ASSERT === '1'
const desktopDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(desktopDir, '..', '..')
const idleMs = Number(process.env.SHOGO_MEMORY_IDLE_MS ?? 60_000)

async function electronMetrics(app: ElectronApplication): Promise<ElectronProcessSample[]> {
  return app.evaluate(({ app }) => {
    return app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      serviceName: (metric as { serviceName?: string }).serviceName,
      workingSetKb: metric.memory.workingSetSize,
    }))
  })
}

async function rendererHeapMb(page: Page): Promise<number | undefined> {
  try {
    const client = await page.context().newCDPSession(page)
    const usage = await client.send('Runtime.getHeapUsage') as { usedSize?: number }
    await client.detach()
    if (!usage.usedSize) return undefined
    return Math.round((usage.usedSize / 1024 / 1024) * 10) / 10
  } catch {
    return undefined
  }
}

async function webContentsCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ webContents }) => webContents.getAllWebContents().length)
}

async function capture(app: ElectronApplication, page: Page, name: string): Promise<Checkpoint> {
  const metrics = await electronMetrics(app)
  const browserPid = metrics.find((metric) => metric.type === 'Browser')?.pid
  const processes = browserPid ? descendants(sampleProcessList(), browserPid) : []
  return buildCheckpoint({
    name,
    electron: metrics,
    processes,
    webContents: await webContentsCount(app),
    rendererHeapMb: await rendererHeapMb(page),
    footprintMb: browserPid ? readFootprintMb(browserPid) ?? undefined : undefined,
  })
}

test.describe('desktop memory budgets', () => {
  test.skip(!enabled, 'set SHOGO_MEMORY_E2E=1')
  test.setTimeout(Math.max(180_000, idleMs + 120_000))

  test('records launch idle and optional project-open against budgets', async () => {
    const electronEntry = require.resolve('electron', { paths: [desktopDir] })
    const electronModule = require(electronEntry) as unknown as string
    const executablePath = typeof electronModule === 'string' ? electronModule : undefined
    expect(executablePath).toBeTruthy()

    const app = await electron.launch({
      executablePath,
      args: ['.', `--user-data-dir=${os.tmpdir()}/shogo-memory-${Date.now()}`, '--no-sandbox'],
      cwd: desktopDir,
      env: {
        ...process.env,
        SHOGO_E2E: 'true',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
      timeout: 60_000,
    })
    const checkpoints: Checkpoint[] = []
    try {
      const page = await app.firstWindow({ timeout: 60_000 })
      await page.waitForLoadState('domcontentloaded')
      await page.waitForTimeout(idleMs)
      checkpoints.push(await capture(app, page, 'launch+60s-idle'))

      const projectId = process.env.SHOGO_PERF_E2E_PROJECT_ID
      if (projectId) {
        await app.evaluate(({ BrowserWindow }, route) => {
          const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
          if (!window) throw new Error('desktop window was not created')
          void window.loadURL(`shogo://app${route}`)
        }, `/(app)/projects/${encodeURIComponent(projectId)}`)
        await page.waitForTimeout(15_000)
        checkpoints.push(await capture(app, page, 'project-open'))
      }
    } finally {
      await app.close().catch(() => {})
    }

    const written = writeReport(path.join(repoRoot, 'bench-results'), checkpoints)
    console.log(renderMarkdown(checkpoints))
    console.log(`Wrote ${written.mdPath}`)
    expect(sampleProcessList().length).toBeGreaterThan(0)
    if (assertBudgets) {
      const failures = evaluateBudgets(checkpoints, MEMORY_BUDGETS)
      expect(failures, JSON.stringify(failures)).toEqual([])
    }
  })
})

test.describe('ps parser smoke', () => {
  test('this platform returns a parseable process list', () => {
    if (process.platform === 'win32') {
      test.skip(true, 'powershell sampler is covered by parsePs unit tests')
    }
    const text = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,rss=,command='], { encoding: 'utf-8' })
    expect(parsePs(text).length).toBeGreaterThan(0)
  })
})
