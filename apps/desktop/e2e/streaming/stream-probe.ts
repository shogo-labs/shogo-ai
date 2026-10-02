// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Measures what a window actually shows while a scripted turn streams.
 *
 * `installProbe` runs inside the page. Every SAMPLE_MS it parses the page's
 * text for the turn's numbered tokens (`t<tag>w<NNNN>`, see fake-llm-server)
 * and records how many are visible, plus gaps, repeats and reordering. It also
 * records long tasks and frame times, which is how UI freezes show up.
 *
 * The analysis helpers at the bottom run in Node and compare those samples
 * with the fake server's own send times.
 */
import type { Page } from '@playwright/test'
import type { FakeTurn } from './fake-llm-server'

export const SAMPLE_MS = 40

export interface ProbeSample {
  /** Epoch ms in the page, comparable to FakeTurn.sentAt. */
  t: number
  /** Highest token number visible. */
  max: number
  /** Distinct token numbers visible. */
  distinct: number
  /** Total token occurrences visible (distinct + repeats). */
  total: number
}

export interface ProbeResult {
  samples: ProbeSample[]
  /** Final token numbers in DOM order. */
  sequence: number[]
  longTasks: { count: number; totalMs: number; maxMs: number }
  frames: { count: number; maxGapMs: number }
  /** When the window's own chat response stream (its POST) delivered each token. */
  own: ProbeSample[]
  /** Longest single probe sample, i.e. the measuring tool's own cost on the page. */
  sampleCostMaxMs: number
}

export interface SequenceCheck {
  count: number
  distinct: number
  repeats: number
  /** Numbers missing between 1 and the highest one seen. */
  gaps: number[]
  /** Adjacent pairs where the sequence goes backwards. */
  outOfOrder: number
  max: number
}


/**
 * Wraps window.fetch before the app loads (it captures fetch at start-up) so the
 * window's own chat response, the POST it sends, can be read through a clone and
 * timed. Must be called before the page navigates to the app.
 */
export async function installOwnStreamTap(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any
    if (w.__ownTap) return
    const tap = { tag: '', samples: [] as any[] }
    w.__ownTap = tap
    const original = window.fetch.bind(window)
    window.fetch = async (input: any, init?: any) => {
      const res: Response = await original(input, init)
      try {
        const url = typeof input === 'string' ? input : input?.url ?? String(input)
        const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase()
        if (method === 'POST' && /\/chat(\?|$)/.test(url) && res.body && tap.tag) {
          const tag = tap.tag
          const samples = tap.samples
          const re = new RegExp(`t${tag}w(\\d{4})`, 'g')
          const reader = res.clone().body!.getReader()
          const decoder = new TextDecoder()
          let carry = ''
          let max = 0
          void (async () => {
            for (;;) {
              const { value, done } = await reader.read()
              if (done) break
              const text = carry + decoder.decode(value, { stream: true })
              re.lastIndex = 0
              let m: RegExpExecArray | null
              let last = 0
              while ((m = re.exec(text))) {
                last = m.index + m[0].length
                if (Number(m[1]) > max) max = Number(m[1])
              }
              carry = text.slice(Math.max(last, text.length - 24))
              if (tap.samples === samples) samples.push({ t: Date.now(), max, distinct: 0, total: 0 })
            }
          })().catch(() => undefined)
        }
      } catch {
        /* never break the app's fetch */
      }
      return res
    }
  })
}

/** Installs `window.__probe`. Runs in the page; must stay self-contained. */
export async function installProbe(page: Page): Promise<void> {
  await page.evaluate((sampleMs) => {
    const w = window as any
    w.__probe?.dispose?.()

    const state = {
      tag: '' as string,
      samples: [] as any[],
      longTasks: { count: 0, totalMs: 0, maxMs: 0 },
      frames: { count: 0, maxGapMs: 0 },
      lastFrame: 0,
      sampleCostMaxMs: 0,
      raf: 0,
      timer: 0 as any,
      observer: null as PerformanceObserver | null,
    }

    const numbers = (tag: string): number[] => {
      const text = document.body?.textContent ?? ''
      const re = new RegExp(`t${tag}w(\\d{4})`, 'g')
      const out: number[] = []
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) out.push(Number(m[1]))
      return out
    }

    const sample = () => {
      if (!state.tag) return
      const began = performance.now()
      const seq = numbers(state.tag)
      let max = 0
      const seen = new Set<number>()
      for (const n of seq) {
        seen.add(n)
        if (n > max) max = n
      }
      state.samples.push({ t: Date.now(), max, distinct: seen.size, total: seq.length })
      const cost = performance.now() - began
      if (cost > state.sampleCostMaxMs) state.sampleCostMaxMs = cost
    }

    const frame = (ts: number) => {
      if (state.lastFrame) {
        const gap = ts - state.lastFrame
        state.frames.count++
        if (gap > state.frames.maxGapMs) state.frames.maxGapMs = gap
      }
      state.lastFrame = ts
      state.raf = requestAnimationFrame(frame)
    }


    try {
      state.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.count++
          state.longTasks.totalMs += entry.duration
          if (entry.duration > state.longTasks.maxMs) state.longTasks.maxMs = entry.duration
        }
      })
      state.observer.observe({ entryTypes: ['longtask'] })
    } catch {
      /* longtask unsupported: leave the counters at zero */
    }

    state.timer = setInterval(sample, sampleMs)
    state.raf = requestAnimationFrame(frame)

    w.__probe = {
      begin(tag: string) {
        state.tag = tag
        state.samples = []
        state.longTasks = { count: 0, totalMs: 0, maxMs: 0 }
        state.frames = { count: 0, maxGapMs: 0 }
        state.lastFrame = 0
        state.sampleCostMaxMs = 0
        w.__ownTap && ((w.__ownTap.tag = tag), (w.__ownTap.samples = []))
      },
      setTag(tag: string) {
        state.tag = tag
      },
      /** Current token numbers, in DOM order. */
      read(tag: string) {
        return numbers(tag)
      },
      /** Like read(), but only text that is actually displayed (skips hidden, still-mounted chats). */
      readVisible(tag: string) {
        const text = document.body?.innerText ?? ''
        const re = new RegExp(`t${tag}w(\\d{4})`, 'g')
        const out: number[] = []
        let m: RegExpExecArray | null
        while ((m = re.exec(text))) out.push(Number(m[1]))
        return out
      },
      textIncludes(needle: string) {
        return (document.body?.textContent ?? '').includes(needle)
      },
      result() {
        sample()
        return {
          samples: state.samples,
          sequence: state.tag ? numbers(state.tag) : [],
          longTasks: state.longTasks,
          frames: state.frames,
          sampleCostMaxMs: Math.round(state.sampleCostMaxMs),
          own: w.__ownTap?.samples ?? [],
        }
      },
      dispose() {
        clearInterval(state.timer)
        cancelAnimationFrame(state.raf)
        state.observer?.disconnect()
      },
    }
  }, SAMPLE_MS)
}

export async function beginProbe(page: Page, tag: string): Promise<void> {
  await page.evaluate((t) => (window as any).__probe.begin(t), tag)
}

export async function readProbe(page: Page): Promise<ProbeResult> {
  return page.evaluate(() => (window as any).__probe.result())
}

export async function visibleTokens(page: Page, tag: string): Promise<number[]> {
  return page.evaluate((t) => (window as any).__probe.read(t), tag)
}

/** Tokens of `tag` that are displayed right now (not merely mounted). */
export async function displayedTokens(page: Page, tag: string): Promise<number[]> {
  return page.evaluate((t) => (window as any).__probe.readVisible(t), tag)
}

export async function pageShows(page: Page, needle: string): Promise<boolean> {
  return page.evaluate((s) => (window as any).__probe.textIncludes(s), needle)
}


// ── Wire tap ────────────────────────────────────────────────────────────────

/**
 * Reads the turn's SSE stream from inside the page (the same endpoint a
 * resuming window uses) and records when each token arrived. Comparing it with
 * the fake model's send times and with the DOM splits lag into "server side"
 * and "renderer side".
 */
export async function startWireTap(page: Page, streamUrl: string, tag: string): Promise<void> {
  await page.evaluate(
    ({ streamUrl, tag }) => {
      const w = window as any
      w.__wire?.abort?.()
      const ctrl = new AbortController()
      const wire = { samples: [] as any[], ended: false, status: 0, error: '', abort: () => ctrl.abort() }
      w.__wire = wire
      const re = new RegExp(`t${tag}w(\\d{4})`, 'g')
      void (async () => {
        try {
          const res = await fetch(streamUrl, { credentials: 'include', signal: ctrl.signal })
          wire.status = res.status
          if (!res.body) return
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let carry = ''
          let max = 0
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            const text = carry + decoder.decode(value, { stream: true })
            re.lastIndex = 0
            let m: RegExpExecArray | null
            let last = 0
            while ((m = re.exec(text))) {
              last = m.index + m[0].length
              if (Number(m[1]) > max) max = Number(m[1])
            }
            carry = text.slice(Math.max(last, text.length - 24))
            wire.samples.push({ t: Date.now(), max, distinct: 0, total: 0 })
          }
        } catch (err) {
          if (!ctrl.signal.aborted) wire.error = String(err)
        } finally {
          wire.ended = true
        }
      })()
    },
    { streamUrl, tag },
  )
}

export async function stopWireTap(page: Page): Promise<{ samples: ProbeSample[]; status: number; ended: boolean; error: string }> {
  return page.evaluate(() => {
    const wire = (window as any).__wire
    wire?.abort?.()
    return { samples: wire?.samples ?? [], status: wire?.status ?? 0, ended: Boolean(wire?.ended), error: wire?.error ?? '' }
  })
}

// ── Analysis (Node) ─────────────────────────────────────────────────────────

export function checkSequence(sequence: number[]): SequenceCheck {
  const distinct = new Set(sequence)
  const max = sequence.reduce((a, b) => Math.max(a, b), 0)
  const gaps: number[] = []
  for (let i = 1; i <= max; i++) if (!distinct.has(i)) gaps.push(i)
  let outOfOrder = 0
  for (let i = 1; i < sequence.length; i++) if (sequence[i] < sequence[i - 1]) outOfOrder++
  return {
    count: sequence.length,
    distinct: distinct.size,
    repeats: sequence.length - distinct.size,
    gaps,
    outOfOrder,
    max,
  }
}

/** True when the sequence is exactly 1..n, once each, in order. */
export function isExactRun(sequence: number[], n: number): boolean {
  return sequence.length === n && sequence.every((v, i) => v === i + 1)
}

/** True when the sequence is exactly 1..k for some k (a clean prefix). */
export function isCleanPrefix(sequence: number[]): boolean {
  return sequence.every((v, i) => v === i + 1)
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

export interface LagStats {
  /** ms from the server sending token 1 to it being on screen. */
  firstTokenMs: number | null
  medianMs: number
  p95Ms: number
  maxMs: number
  /** Tokens the server sent that never appeared in the probe samples. */
  neverShown: number
}

/**
 * For each token the server sent, how long until a sample first showed it
 * (or anything later). Sampling adds up to SAMPLE_MS of error.
 */
export function renderLags(turn: Pick<FakeTurn, 'sentAt'>, samples: ProbeSample[]): { lags: number[]; neverShown: number } {
  const lags: number[] = []
  let neverShown = 0
  let cursor = 0
  for (let i = 1; i <= turn.sentAt.length; i++) {
    const sentAt = turn.sentAt[i - 1]
    while (cursor < samples.length && (samples[cursor].max < i || samples[cursor].t < sentAt)) cursor++
    if (cursor >= samples.length) {
      neverShown++
      continue
    }
    lags.push(samples[cursor].t - sentAt)
  }
  return { lags, neverShown }
}

/** When each token 1..n first appeared in `samples` (the time of the first sample showing it). */
export function arrivalTimes(samples: ProbeSample[], n: number): number[] {
  const out: number[] = []
  let cursor = 0
  for (let i = 1; i <= n; i++) {
    while (cursor < samples.length && samples[cursor].max < i) cursor++
    if (cursor >= samples.length) break
    out.push(samples[cursor].t)
  }
  return out
}

export function summarizeLags(lags: number[], neverShown = 0): LagStats {
  return {
    firstTokenMs: lags.length ? lags[0] : null,
    medianMs: percentile(lags, 50),
    p95Ms: percentile(lags, 95),
    maxMs: lags.reduce((a, b) => Math.max(a, b), 0),
    neverShown,
  }
}

export function renderLag(turn: Pick<FakeTurn, 'sentAt'>, samples: ProbeSample[]): LagStats {
  const { lags, neverShown } = renderLags(turn, samples)
  return summarizeLags(lags, neverShown)
}

/**
 * How far `behind` trails `ahead` over the run, in ms: for each sample of
 * `ahead`, the time until `behind` first showed at least that many tokens.
 */
export function maxDivergenceMs(ahead: ProbeSample[], behind: ProbeSample[]): number {
  let worst = 0
  let cursor = 0
  for (const a of ahead) {
    if (a.max === 0) continue
    while (cursor < behind.length && (behind[cursor].max < a.max || behind[cursor].t < a.t)) cursor++
    // Never caught up by the end of sampling: treat the tail as the lag.
    const caughtUpAt = cursor < behind.length ? behind[cursor].t : behind[behind.length - 1]?.t ?? a.t
    worst = Math.max(worst, caughtUpAt - a.t)
    if (cursor >= behind.length) cursor = Math.max(0, behind.length - 1)
  }
  return worst
}
