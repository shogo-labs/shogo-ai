/**
 * Keep a Knative DomainMapping for each custom hostname of a Knative-published
 * site (see KnativeProjectManager.syncPublishedCustomDomainMappings for why).
 * Only acts in-cluster and only when the project's production ksvc exists, so
 * metal-backed and static sites are untouched. Best-effort: never throws.
 */
const inCluster = () => !!process.env.KUBERNETES_SERVICE_HOST

export async function ensurePublishedCustomDomainMapping(
  hostname: string,
  subdomain: string,
  projectId: string,
): Promise<void> {
  if (!inCluster()) return
  try {
    const { getKnativeProjectManager } = await import('./knative-project-manager')
    const manager = getKnativeProjectManager()
    if (!(await manager.getPublishedRevision(projectId, 'production'))) return
    await manager.createPublishedCustomDomainMapping(hostname, subdomain, projectId)
  } catch (err: any) {
    console.warn(`[custom-domain] DomainMapping for ${hostname} failed (non-fatal):`, err?.message ?? err)
  }
}

export async function removePublishedCustomDomainMapping(hostname: string): Promise<void> {
  if (!inCluster()) return
  try {
    const { getKnativeProjectManager } = await import('./knative-project-manager')
    await getKnativeProjectManager().deletePublishedCustomDomainMapping(hostname)
  } catch (err: any) {
    console.warn(`[custom-domain] DomainMapping removal for ${hostname} failed (non-fatal):`, err?.message ?? err)
  }
}
