// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Typed helpers for the auto-generated CRUD routes served from Prisma models.
 * Missing routes return empty lists so a fresh workspace can render cleanly.
 */

export interface DividendCandidate {
  id: string
  ticker: string
  company: string
  sector: string
  yieldText: string
  safetyScore: number
  growthStreak: string
  createdAt: string
  updatedAt: string
}

export interface DividendPortfolio {
  id: string
  name: string
  capitalAmount: string
  incomeGoal: string
  accountType: string
  riskProfile: string
  createdAt: string
  updatedAt: string
}

export interface IncomeProjection {
  id: string
  period: string
  expectedIncome: string
  targetIncome: string
  gap: string
  assumptions: string
  createdAt: string
  updatedAt: string
}

export interface DividendSafetyCheck {
  id: string
  ticker: string
  payoutRatio: string
  debtNote: string
  coverageNote: string
  riskFlag: string
  createdAt: string
  updatedAt: string
}

export interface ReinvestmentScenario {
  id: string
  name: string
  horizonYears: number
  startingCapital: string
  assumedGrowth: string
  projectedIncome: string
  createdAt: string
  updatedAt: string
}

export interface TaxNote {
  id: string
  accountType: string
  dividendType: string
  summary: string
  questionForAdvisor: string
  updatedAtText: string
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

export async function listDividendCandidate(): Promise<DividendCandidate[]> {
  return listAll<DividendCandidate>('dividend-candidates')
}

export async function listDividendPortfolio(): Promise<DividendPortfolio[]> {
  return listAll<DividendPortfolio>('dividend-portfolios')
}

export async function listIncomeProjection(): Promise<IncomeProjection[]> {
  return listAll<IncomeProjection>('income-projections')
}

export async function listDividendSafetyCheck(): Promise<DividendSafetyCheck[]> {
  return listAll<DividendSafetyCheck>('dividend-safety-checks')
}

export async function listReinvestmentScenario(): Promise<ReinvestmentScenario[]> {
  return listAll<ReinvestmentScenario>('reinvestment-scenarios')
}

export async function listTaxNote(): Promise<TaxNote[]> {
  return listAll<TaxNote>('tax-notes')
}
