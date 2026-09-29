import type { PrismaClient } from '../prisma'

const RETENTION_DAYS = Number(process.env.PROXY_CAPTURE_RETENTION_DAYS || 90)
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000

let timer: ReturnType<typeof setInterval> | null = null

// Capture objects remain in the serving region's bucket. We do not
// cross-replicate them: exports and analysis run per region, while the
// compact ProxyTurn rows are the globally replicated signal. Each region
// prunes the rows of the workspaces it is home writer for (every row in
// single-region deployments such as staging), so deletes never collide.
export async function pruneProxyTurns(prisma: PrismaClient): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const { homeRegionWorkspaceWhere } = await import('../region')
  const homeWhere = homeRegionWorkspaceWhere()
  const result = await (prisma as any).proxyTurn.deleteMany({
    where: { lastAt: { lt: cutoff }, ...(homeWhere ? { workspace: homeWhere } : {}) },
  })
  if (result.count > 0) {
    console.log(`[ProxyCapture] Pruned ${result.count} proxy turns older than ${RETENTION_DAYS}d`)
  }
  return result.count
}

export function startProxyCaptureRetention(prisma: PrismaClient): void {
  if (timer) return
  void pruneProxyTurns(prisma).catch((error) => {
    console.error('[ProxyCapture] Retention cleanup failed:', error)
  })
  timer = setInterval(() => {
    void pruneProxyTurns(prisma).catch((error) => {
      console.error('[ProxyCapture] Retention cleanup failed:', error)
    })
  }, RETENTION_INTERVAL_MS)
  timer.unref?.()
}

export function stopProxyCaptureRetention(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
