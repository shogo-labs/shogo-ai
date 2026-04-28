// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Typed helpers for the auto-generated CRUD routes served from Prisma models.
 * Missing routes return empty lists so a fresh workspace can render cleanly.
 */

export interface MacroIndicator {
  id: string
  name: string
  latestReading: string
  trend: string
  source: string
  marketImplication: string
  createdAt: string
  updatedAt: string
}

export interface PolicyOutlook {
  id: string
  institution: string
  baseCase: string
  nextMeeting: string
  ratePath: string
  riskToView: string
  createdAt: string
  updatedAt: string
}

export interface SectorView {
  id: string
  sector: string
  stance: string
  cycleRationale: string
  benefitsFrom: string
  watchItem: string
  createdAt: string
  updatedAt: string
}

export interface GlobalRisk {
  id: string
  name: string
  region: string
  probability: string
  marketChannel: string
  timeline: string
  createdAt: string
  updatedAt: string
}

export interface PortfolioImpact {
  id: string
  holdingOrSector: string
  macroDriver: string
  impact: string
  action: string
  confidence: string
  createdAt: string
  updatedAt: string
}

export interface ActionPlan {
  id: string
  action: string
  trigger: string
  timeframe: string
  owner: string
  status: string
  createdAt: string
  updatedAt: string
}

export interface Briefing {
  id: string
  title: string
  summary: string
  keyRisks: string
  recommendedActions: string
  asOfDate: string
  createdAt: string
  updatedAt: string
}

type ApiList<T> = { ok: true; items?: T[] } | { ok: false; error?: { message?: string } }

async function listAll<T>(path: string): Promise<T[]> {
  try {
    const res = await fetch(`/api/${path}`, { headers: { Accept: 'application/json' } })
    if (!res.ok) return []
    const body = (await res.json()) as ApiList<T>
    return body.ok && body.items ? body.items : []
  } catch {
    return []
  }
}

export async function listMacroIndicator(): Promise<MacroIndicator[]> {
  return listAll<MacroIndicator>('macro-indicators')
}

export async function listPolicyOutlook(): Promise<PolicyOutlook[]> {
  return listAll<PolicyOutlook>('policy-outlooks')
}

export async function listSectorView(): Promise<SectorView[]> {
  return listAll<SectorView>('sector-views')
}

export async function listGlobalRisk(): Promise<GlobalRisk[]> {
  return listAll<GlobalRisk>('global-risks')
}

export async function listPortfolioImpact(): Promise<PortfolioImpact[]> {
  return listAll<PortfolioImpact>('portfolio-impacts')
}

export async function listActionPlan(): Promise<ActionPlan[]> {
  return listAll<ActionPlan>('action-plans')
}

export async function listBriefing(): Promise<Briefing[]> {
  return listAll<Briefing>('briefings')
}
