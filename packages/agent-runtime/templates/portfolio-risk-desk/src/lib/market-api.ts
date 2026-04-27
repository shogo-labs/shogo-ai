// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Typed helpers for the auto-generated CRUD routes served from Prisma models.
 * Missing routes return empty lists so a fresh workspace can render cleanly.
 */

export interface Holding {
  id: string
  ticker: string
  name: string
  weight: string
  sector: string
  liquidityRating: string
  riskNote: string
  createdAt: string
  updatedAt: string
}

export interface PortfolioSnapshot {
  id: string
  asOfDate: string
  totalValue: string
  cashWeight: string
  topRisk: string
  notes: string
  createdAt: string
  updatedAt: string
}

export interface RiskScenario {
  id: string
  name: string
  probability: string
  estimatedDrawdown: string
  affectedHoldings: string
  mitigation: string
  createdAt: string
  updatedAt: string
}

export interface CorrelationObservation {
  id: string
  holdingA: string
  holdingB: string
  correlation: string
  period: string
  interpretation: string
  createdAt: string
  updatedAt: string
}

export interface AllocationTarget {
  id: string
  assetClass: string
  targetWeight: string
  currentWeight: string
  rationale: string
  benchmark: string
  createdAt: string
  updatedAt: string
}

export interface RebalanceAction {
  id: string
  action: string
  ticker: string
  targetWeight: string
  reason: string
  status: string
  createdAt: string
  updatedAt: string
}

export interface MacroAssumption {
  id: string
  driver: string
  baseCase: string
  portfolioImpact: string
  confidence: string
  reviewDate: string
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

export async function listHolding(): Promise<Holding[]> {
  return listAll<Holding>('holdings')
}

export async function listPortfolioSnapshot(): Promise<PortfolioSnapshot[]> {
  return listAll<PortfolioSnapshot>('portfolio-snapshots')
}

export async function listRiskScenario(): Promise<RiskScenario[]> {
  return listAll<RiskScenario>('risk-scenarios')
}

export async function listCorrelationObservation(): Promise<CorrelationObservation[]> {
  return listAll<CorrelationObservation>('correlation-observations')
}

export async function listAllocationTarget(): Promise<AllocationTarget[]> {
  return listAll<AllocationTarget>('allocation-targets')
}

export async function listRebalanceAction(): Promise<RebalanceAction[]> {
  return listAll<RebalanceAction>('rebalance-actions')
}

export async function listMacroAssumption(): Promise<MacroAssumption[]> {
  return listAll<MacroAssumption>('macro-assumptions')
}
