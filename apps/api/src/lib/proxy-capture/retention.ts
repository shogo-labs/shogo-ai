import type { PrismaClient } from '../prisma'

const RETENTION_DAYS = Number(process.env.PROXY_CAPTURE_RETENTION_DAYS || 90)
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000
const MAIN_REGION_ID = 'us-ashburn-1'

let timer: ReturnType<typeof setInterval> | null = null

// Capture objects remain in the workspace's home-region bucket. We do not
// cross-replicate them: exports and analysis run per region, while the
// compact ProxyTurn rows are the globally replicated signal.
export async function pruneProxyTurns(prisma: PrismaClient): Promise<number> {
  if (process.env.REGION_ID && process.env.REGION_ID !== MAIN_REGION_ID) return 0
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const result = await (prisma as any).proxyTurn.deleteMany({
    where: { lastAt: { lt: cutoff } },
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
