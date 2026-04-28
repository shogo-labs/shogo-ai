// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Typed helpers for the auto-generated CRUD routes served from Prisma models.
 * Missing routes return empty lists so a fresh workspace can render cleanly.
 */

export interface StockWatchlist {
  id: string
  ticker: string
  company: string
  sector: string
  thesis: string
  status: string
  createdAt: string
  updatedAt: string
}

export interface StockScreen {
  id: string
  name: string
  criteria: string
  topTickers: string
  riskRating: number
  notes: string
  createdAt: string
  updatedAt: string
}

export interface EquityReport {
  id: string
  ticker: string
  title: string
  verdict: string
  bullCase: string
  bearCase: string
  sourceCount: number
  createdAt: string
  updatedAt: string
}

export interface ValuationModel {
  id: string
  ticker: string
  method: string
  fairValueRange: string
  wacc: string
  terminalAssumption: string
  keyRisk: string
  createdAt: string
  updatedAt: string
}

export interface CompetitiveSet {
  id: string
  sector: string
  leaderTicker: string
  peerTickers: string
  moatSummary: string
  catalyst: string
  createdAt: string
  updatedAt: string
}

export interface EarningsNote {
  id: string
  ticker: string
  period: string
  headline: string
  takeaways: string
  openQuestions: string
  createdAt: string
  updatedAt: string
}

export interface SourceCitation {
  id: string
  relatedTicker: string
  sourceTitle: string
  url: string
  publisher: string
  publishedAt: string
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

export async function listStockWatchlist(): Promise<StockWatchlist[]> {
  return listAll<StockWatchlist>('stock-watchlists')
}

export async function listStockScreen(): Promise<StockScreen[]> {
  return listAll<StockScreen>('stock-screens')
}

export async function listEquityReport(): Promise<EquityReport[]> {
  return listAll<EquityReport>('equity-reports')
}

export async function listValuationModel(): Promise<ValuationModel[]> {
  return listAll<ValuationModel>('valuation-models')
}

export async function listCompetitiveSet(): Promise<CompetitiveSet[]> {
  return listAll<CompetitiveSet>('competitive-sets')
}

export async function listEarningsNote(): Promise<EarningsNote[]> {
  return listAll<EarningsNote>('earnings-notes')
}

export async function listSourceCitation(): Promise<SourceCitation[]> {
  return listAll<SourceCitation>('source-citations')
}
