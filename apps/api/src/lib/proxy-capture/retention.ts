import type { PrismaClient } from '../prisma'

const RETENTION_DAYS = Number(process.env.PROXY_CAPTURE_RETENTION_DAYS || 1095)
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000

let timer: ReturnType<typeof setInterval> | null = null

// Capture objects and their ProxyTurn summaries both stay in the serving
// region: proxy_turns is excluded from the cross-region publication
// (k8s/cnpg/logical-replication/exclude-region-local-tables.sql), so every
// region prunes all of its own rows.
export async function pruneProxyTurns(prisma: PrismaClient): Promise<number> {
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
