// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Gemini 4 suite — catalog, alias, price-step, and proxy-cap invariants.
 *
 * Run: bun test packages/agent/src/model-catalog/__tests__/gemini-4.test.ts
 */
import { describe, it, expect } from 'bun:test'
import { getModelEntry, getMaxOutputTokens, modelSupportsVideoInput } from '../helpers'
import { MODEL_ALIASES } from '../aliases'
import { getModelDollarCosts, MODEL_PRICE_STEPS } from '../helpers'
import { calculateDollarCost } from '../helpers'

// ---------------------------------------------------------------------------
// Catalog entries
// ---------------------------------------------------------------------------

describe('Gemini 4 catalog entries', () => {
  const ids = ['gemini-4-carbon', 'gemini-4-neon', 'gemini-4-argon', 'gemini-4-hydrogen'] as const

  it.each(ids)('%s resolves in MODEL_CATALOG', (id) => {
    const entry = getModelEntry(id)
    expect(entry).toBeDefined()
    expect(entry!.provider).toBe('google')
    expect(entry!.family).toBe('gemini')
    expect(entry!.generation).toBe('current')
  })

  it.each(ids)('%s has maxOutputTokens = 65536', (id) => {
    expect(getMaxOutputTokens(id)).toBe(65_536)
  })

  it('Argon maxOutputTokens is 65536 (not the old 1M)', () => {
    expect(getMaxOutputTokens('gemini-4-argon')).toBe(65_536)
  })
})

// ---------------------------------------------------------------------------
// Video input — models the SHO-495 probe cleared against Google's
// OpenAI-compatible endpoint (2026-11-21): pi-ai's image_url + data:video/mp4
// block is decoded as video and the motion is described.
// ---------------------------------------------------------------------------

describe('Gemini 4 video input', () => {
  const videoNative = [
    'gemini-4-carbon',
    'gemini-4-argon',
    'gemini-4-neon',
    'gemini-4-hydrogen',
    'gemini-3.8-flash',
  ] as const

  it.each(videoNative)('%s is video-native', (id) => {
    expect(getModelEntry(id)!.capabilities?.supportsVideoInput).toBe(true)
    expect(modelSupportsVideoInput(id)).toBe(true)
  })

  it('bare aliases resolve to a video-native model', () => {
    expect(modelSupportsVideoInput('carbon')).toBe(true)
    expect(modelSupportsVideoInput('argon')).toBe(true)
  })

  it('a Google model the probe did not clear stays text-only', () => {
    expect(modelSupportsVideoInput('gemini-3.5-flash-lite')).toBe(false)
    expect(modelSupportsVideoInput('gemini-3.1-pro-preview')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Alias resolution
// ---------------------------------------------------------------------------

describe('Gemini 4 aliases', () => {
  it('carbon → gemini-4-carbon', () => expect(MODEL_ALIASES['carbon']).toBe('gemini-4-carbon'))
  it('gemini-carbon → gemini-4-carbon', () => expect(MODEL_ALIASES['gemini-carbon']).toBe('gemini-4-carbon'))
  it('neon → gemini-4-neon', () => expect(MODEL_ALIASES['neon']).toBe('gemini-4-neon'))
  it('gemini-neon → gemini-4-neon', () => expect(MODEL_ALIASES['gemini-neon']).toBe('gemini-4-neon'))
  it('hydrogen → gemini-4-hydrogen', () => expect(MODEL_ALIASES['hydrogen']).toBe('gemini-4-hydrogen'))
  it('gemini-hydrogen → gemini-4-hydrogen', () => expect(MODEL_ALIASES['gemini-hydrogen']).toBe('gemini-4-hydrogen'))
  it('argon → gemini-4-argon', () => expect(MODEL_ALIASES['argon']).toBe('gemini-4-argon'))
  it('gemini-argon → gemini-4-argon', () => expect(MODEL_ALIASES['gemini-argon']).toBe('gemini-4-argon'))

  it('gemini-pro → gemini-4-carbon (moved from 3.1 Pro)', () =>
    expect(MODEL_ALIASES['gemini-pro']).toBe('gemini-4-carbon'))
  it('gemini → gemini-3.8-flash (unchanged)', () =>
    expect(MODEL_ALIASES['gemini']).toBe('gemini-3.8-flash'))
  it('gemini-flash → gemini-3.8-flash (unchanged)', () =>
    expect(MODEL_ALIASES['gemini-flash']).toBe('gemini-3.8-flash'))
})

// ---------------------------------------------------------------------------
// Price steps — injected dates, not real clock
// ---------------------------------------------------------------------------

const PRE_STEP  = new Date('2026-11-30T23:59:59Z')  // just before Dec 1 08:00 UTC
const POST_STEP = new Date('2026-12-01T09:00:00Z')  // well after Dec 1 08:00 UTC
const PRE_FLASH = new Date('2026-12-31T23:59:59Z')  // before Flash Jan-1 step
const POST_FLASH = new Date('2027-01-01T09:00:00Z') // after Flash Jan-1 step

describe('MODEL_PRICE_STEPS coverage', () => {
  it('has steps for gemini-4-carbon, gemini-4-argon, gemini-3-8-flash', () => {
    expect(MODEL_PRICE_STEPS['gemini-4-carbon']).toBeDefined()
    expect(MODEL_PRICE_STEPS['gemini-4-argon']).toBeDefined()
    expect(MODEL_PRICE_STEPS['gemini-3-8-flash']).toBeDefined()
  })
})

describe('getModelDollarCosts — Carbon', () => {
  it('pre-step: $2/$10/$0.10 in/out/cached', () => {
    const c = getModelDollarCosts('gemini-4-carbon', PRE_STEP)
    expect(c.inputPerMillion).toBe(2.00)
    expect(c.outputPerMillion).toBe(10.00)
    expect(c.cachedInputPerMillion).toBe(0.10)
  })
  it('post-step: $4/$20/$0.20 in/out/cached', () => {
    const c = getModelDollarCosts('gemini-4-carbon', POST_STEP)
    expect(c.inputPerMillion).toBe(4.00)
    expect(c.outputPerMillion).toBe(20.00)
    expect(c.cachedInputPerMillion).toBe(0.20)
  })
})

describe('getModelDollarCosts — Argon', () => {
  it('pre-step: $2/$10/$0.10', () => {
    const c = getModelDollarCosts('gemini-4-argon', PRE_STEP)
    expect(c.inputPerMillion).toBe(2.00)
    expect(c.outputPerMillion).toBe(10.00)
    expect(c.cachedInputPerMillion).toBe(0.10)
  })
  it('post-step: $4/$20/$0.20', () => {
    const c = getModelDollarCosts('gemini-4-argon', POST_STEP)
    expect(c.inputPerMillion).toBe(4.00)
    expect(c.outputPerMillion).toBe(20.00)
    expect(c.cachedInputPerMillion).toBe(0.20)
  })
})

describe('getModelDollarCosts — Neon (no step)', () => {
  it('pre-step: $3/$15/$0.15', () => {
    const c = getModelDollarCosts('gemini-4-neon', PRE_STEP)
    expect(c.inputPerMillion).toBe(3.00)
    expect(c.outputPerMillion).toBe(15.00)
    expect(c.cachedInputPerMillion).toBe(0.15)
  })
  it('post-step: same rates', () => {
    const c = getModelDollarCosts('gemini-4-neon', POST_STEP)
    expect(c.inputPerMillion).toBe(3.00)
    expect(c.outputPerMillion).toBe(15.00)
  })
})

describe('getModelDollarCosts — Hydrogen (no step)', () => {
  it('$1.50/$7.50/$0.075', () => {
    const c = getModelDollarCosts('gemini-4-hydrogen', PRE_STEP)
    expect(c.inputPerMillion).toBe(1.50)
    expect(c.outputPerMillion).toBe(7.50)
    expect(c.cachedInputPerMillion).toBe(0.075)
  })
})

describe('getModelDollarCosts — 3.8 Flash step', () => {
  it('pre-step: $0.75/$3.75', () => {
    const c = getModelDollarCosts('gemini-3-8-flash', PRE_FLASH)
    expect(c.inputPerMillion).toBe(0.75)
    expect(c.outputPerMillion).toBe(3.75)
  })
  it('post-step: $1.50/$7.50', () => {
    const c = getModelDollarCosts('gemini-3-8-flash', POST_FLASH)
    expect(c.inputPerMillion).toBe(1.50)
    expect(c.outputPerMillion).toBe(7.50)
  })
})

// ---------------------------------------------------------------------------
// calculateDollarCost — acceptance criteria values
// ---------------------------------------------------------------------------

describe('calculateDollarCost acceptance criteria (1M tokens each)', () => {
  const M = 1_000_000

  it('Carbon pre-step = $12.10', () => {
    expect(calculateDollarCost('gemini-4-carbon', M, M, M, 0, PRE_STEP)).toBeCloseTo(12.10, 5)
  })
  it('Carbon post-step = $24.20', () => {
    expect(calculateDollarCost('gemini-4-carbon', M, M, M, 0, POST_STEP)).toBeCloseTo(24.20, 5)
  })
  it('Argon pre-step = $12.10', () => {
    expect(calculateDollarCost('gemini-4-argon', M, M, M, 0, PRE_STEP)).toBeCloseTo(12.10, 5)
  })
  it('Argon post-step = $24.20', () => {
    expect(calculateDollarCost('gemini-4-argon', M, M, M, 0, POST_STEP)).toBeCloseTo(24.20, 5)
  })
  it('Neon = $18.15 (both sides of step)', () => {
    expect(calculateDollarCost('gemini-4-neon', M, M, M, 0, PRE_STEP)).toBeCloseTo(18.15, 5)
    expect(calculateDollarCost('gemini-4-neon', M, M, M, 0, POST_STEP)).toBeCloseTo(18.15, 5)
  })
  it('Hydrogen = $9.075 (both sides of step)', () => {
    expect(calculateDollarCost('gemini-4-hydrogen', M, M, M, 0, PRE_STEP)).toBeCloseTo(9.075, 5)
    expect(calculateDollarCost('gemini-4-hydrogen', M, M, M, 0, POST_STEP)).toBeCloseTo(9.075, 5)
  })
})
