import { prisma } from '../prisma'
import type { ProxyTokenPayload } from '../ai-proxy-token'

const CACHE_TTL_MS = 60_000
const consentCache = new Map<string, { expiresAt: number; enabled: boolean }>()

function captureEnabledGlobally(): boolean {
  return process.env.PROXY_CAPTURE_ENABLED === 'true'
}

/**
 * Capture is intentionally cloud-only. The local proxy forwards to the cloud
 * and must not create a second copy in the desktop SQLite database.
 */
export async function shouldCapture(tokenPayload: ProxyTokenPayload): Promise<boolean> {
  if (!captureEnabledGlobally()) return false
  if (process.env.SHOGO_LOCAL_MODE === 'true') return false
  if (!tokenPayload.workspaceId || tokenPayload.workspaceId === 'system') return false

  const cached = consentCache.get(tokenPayload.workspaceId)
  if (cached && cached.expiresAt > Date.now()) return cached.enabled

  try {
    const workspace = await prisma.workspace.findUnique({
      where: { id: tokenPayload.workspaceId },
      select: { trainingDataMode: true },
    })
    if (!workspace) return false

    const mode = workspace.trainingDataMode
    const { getEffectivePlanId } = await import('../../services/billing.service')
    const plan = await getEffectivePlanId(tokenPayload.workspaceId)
    const enabled = mode === 'enabled' || (mode === 'default' && plan !== 'enterprise')
    consentCache.set(tokenPayload.workspaceId, { expiresAt: Date.now() + CACHE_TTL_MS, enabled })
    return enabled
  } catch (error) {
    console.error('[ProxyCapture] Consent lookup failed:', error)
    return false
  }
}

export function clearConsentCache(workspaceId?: string): void {
  if (workspaceId) {
    consentCache.delete(workspaceId)
  } else {
    consentCache.clear()
  }
}
