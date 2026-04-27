// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Typed helpers for the auto-generated CRUD routes served from Prisma models.
 * Missing routes return empty lists so a fresh workspace can render cleanly.
 */

export interface TickerSetup {
  id: string
  ticker: string
  timeframe: string
  bias: string
  currentPosition: string
  notes: string
  createdAt: string
  updatedAt: string
}

export interface IndicatorSnapshot {
  id: string
  ticker: string
  trend: string
  rsi: string
  macd: string
  movingAverages: string
  volumeSignal: string
  createdAt: string
  updatedAt: string
}

export interface SupportResistanceLevel {
  id: string
  ticker: string
  levelType: string
  price: string
  timeframe: string
  evidence: string
  createdAt: string
  updatedAt: string
}

export interface PatternSignal {
  id: string
  ticker: string
  pattern: string
  signalType: string
  confidence: string
  evidence: string
  createdAt: string
  updatedAt: string
}

export interface EventPattern {
  id: string
  ticker: string
  eventType: string
  period: string
  historicalBehavior: string
  edgeSummary: string
  createdAt: string
  updatedAt: string
}

export interface OptionsSignal {
  id: string
  ticker: string
  signal: string
  expiry: string
  strikeContext: string
  interpretation: string
  createdAt: string
  updatedAt: string
}

export interface TradePlan {
  id: string
  ticker: string
  entryZone: string
  stopLoss: string
  profitTarget: string
  riskReward: string
  invalidation: string
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

export async function listTickerSetup(): Promise<TickerSetup[]> {
  return listAll<TickerSetup>('ticker-setups')
}

export async function listIndicatorSnapshot(): Promise<IndicatorSnapshot[]> {
  return listAll<IndicatorSnapshot>('indicator-snapshots')
}

export async function listSupportResistanceLevel(): Promise<SupportResistanceLevel[]> {
  return listAll<SupportResistanceLevel>('support-resistance-levels')
}

export async function listPatternSignal(): Promise<PatternSignal[]> {
  return listAll<PatternSignal>('pattern-signals')
}

export async function listEventPattern(): Promise<EventPattern[]> {
  return listAll<EventPattern>('event-patterns')
}

export async function listOptionsSignal(): Promise<OptionsSignal[]> {
  return listAll<OptionsSignal>('options-signals')
}

export async function listTradePlan(): Promise<TradePlan[]> {
  return listAll<TradePlan>('trade-plans')
}
