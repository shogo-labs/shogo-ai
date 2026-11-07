// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `WarmPoolStarvation` declared `target: 3` while every production overlay
 * declares a *higher* minimum (`production` 10, `production-us` 5,
 * `production-eu` 5), so the rule tolerated a two-pod shortfall in a region
 * that declares five — which is exactly the state EU sat in all night.
 *
 * Pure-static: reads the alert rule and the production overlays, no SigNoz or
 * cluster access. Scoped to the `production*` overlays on purpose — the rule
 * filters `deployment.environment.name = 'production'`, so staging's
 * `WARM_POOL_MIN_PODS: "5"` is not its business.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse, parseAllDocuments } from 'yaml'

const root = resolve(import.meta.dir, '../..')
const ALERT = 'terraform/modules/signoz/alerts/warm-pool-starvation.yaml'

// The rule filters deployment.environment.name = 'production', so only the
// production* overlays are its business: k8s/overlays/staging/api-service.yaml
// (:599-600) also sets WARM_POOL_MIN_PODS to "5" and must NOT be counted here.
const REGION_OVERLAY: Record<string, string> = {
  'eu-frankfurt-1': 'k8s/overlays/production-eu/api-service.yaml', // "5"  @605-606
  'us-ashburn-1': 'k8s/overlays/production-us/api-service.yaml', // "5"  @588-589
}
const BASE_OVERLAY = 'k8s/overlays/production/api-service.yaml' // "10" @337-338

// The overlays are multi-document YAML (ServiceAccount, RBAC, Knative Service…),
// so walk every document for the api container's env list. Verified against
// de46c6c: production = 10, production-us = 5, production-eu = 5, staging = 5.
function overlayMin(rel: string): number {
  for (const doc of parseAllDocuments(readFileSync(resolve(root, rel), 'utf8'))) {
    const json = doc.toJSON() as any
    const containers = json?.spec?.template?.spec?.containers
    if (!Array.isArray(containers)) continue
    for (const c of containers) {
      for (const e of c?.env ?? []) {
        if (e?.name === 'WARM_POOL_MIN_PODS') return Number(e.value)
      }
    }
  }
  throw new Error(`no WARM_POOL_MIN_PODS in ${rel}`)
}

// Whatever shape the deployed v2alpha1 schema ends up in — a single `target`, or
// a per-region map — collect every numeric threshold the rule declares.
function declaredTargets(rule: any): number[] {
  const out: number[] = []
  for (const t of rule?.condition?.thresholds?.spec ?? []) {
    if (typeof t.target === 'number') out.push(t.target)
    if (t.targets && typeof t.targets === 'object') {
      out.push(...Object.values(t.targets).filter((v): v is number => typeof v === 'number'))
    }
  }
  return out
}

describe('WarmPoolStarvation threshold tracks the configured pool minimum', () => {
  const rule = parse(readFileSync(resolve(root, ALERT), 'utf8'))
  const productionMins = [BASE_OVERLAY, ...Object.values(REGION_OVERLAY)].map(overlayMin)
  const lowest = Math.min(...productionMins) // 5 (base 10, us 5, eu 5)

  test('no declared target sits below the lowest production minimum', () => {
    const targets = declaredTargets(rule)
    expect(targets.length).toBeGreaterThan(0)
    // today the rule declares target: 3 → 3 >= 5 is false → FAILS
    for (const t of targets) expect(t).toBeGreaterThanOrEqual(lowest)
  })

  test('per-region targets equal that region overlay, when the schema carries them', () => {
    const targets = declaredTargets(rule)
    if (targets.length <= 1) return // literal fallback form; covered above
    const map = rule.condition.thresholds.spec[0].targets as Record<string, number>
    for (const [region, overlay] of Object.entries(REGION_OVERLAY)) {
      expect(map[region]).toBe(overlayMin(overlay))
    }
  })

  test('the summary states the same floor as the rule', () => {
    const summary: string = rule?.annotations?.summary ?? ''
    const marker = 'fewer than '
    const idx = summary.indexOf(marker)
    expect(idx).toBeGreaterThanOrEqual(0)
    const stated = Number.parseInt(summary.slice(idx + marker.length), 10)
    expect(Number.isNaN(stated)).toBe(false)
    // today: "…fewer than 3 available pods…" → 3 >= 5 is false → FAILS
    expect(stated).toBeGreaterThanOrEqual(lowest)
  })
})
