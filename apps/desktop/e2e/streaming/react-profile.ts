// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Counts React re-renders in the real app without touching app code.
 *
 * A fake DevTools hook is installed before React loads. React then reports
 * every commit, and we diff the fiber tree the same way React DevTools does
 * (only descend where `child` changed, count fibers whose PerformedWork flag
 * is set). Having a hook present also turns on React's profile mode, which is
 * what makes `actualDuration` available in the dev build.
 *
 * Per commit we keep: when it happened, total render time, and how many
 * components re-rendered. Per component we keep render count and self time.
 */
import type { Page } from '@playwright/test'

export interface CommitSample {
  /** ms since profile start */
  t: number
  /** React render time for the commit (sum of root's actualDuration) */
  renderMs: number
  /** Wall time spent in our own bookkeeping (must stay small) */
  hookMs: number
  rendered: number
}

export interface ComponentStat {
  name: string
  renders: number
  selfMs: number
  /** Renders where props and state were referentially identical to last time. */
  wasted: number
  /** Prop names whose value changed (by identity) between renders, with counts. */
  changedProps?: Record<string, number>
  /** Contexts read by this component whose value changed, as `label` or `label.field`. */
  changedContexts?: Record<string, number>
}

export interface RenderProfile {
  durationMs: number
  commits: number
  commitsPerSec: number
  renderMs: { total: number; p50: number; p95: number; max: number }
  /** commits whose render took longer than 50ms */
  slowCommits: number
  hookMsTotal: number
  /** Commit render time in thirds of the run, to see whether it grows. */
  thirds: Array<{ commits: number; meanMs: number; p95Ms: number }>
  byRenders: ComponentStat[]
  bySelfMs: ComponentStat[]
  /** Components that re-rendered with identical props/state most often. */
  byWasted: ComponentStat[]
  /** Which component each commit started from (topmost re-rendered components). */
  commitEntryPoints: Array<{ name: string; commits: number }>
}

export async function installReactProfiler(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any
    if (w.__REACT_DEVTOOLS_GLOBAL_HOOK__ || w.__renderProfile) return

    const PERFORMED_WORK = 1
    // FunctionComponent, ClassComponent, ForwardRef, MemoComponent, SimpleMemoComponent
    const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15])

    const state = {
      active: false,
      startedAt: 0,
      commits: [] as any[],
      comps: new Map<string, { renders: number; selfMs: number; wasted: number; changedProps: Record<string, number>; changedContexts: Record<string, number> }>(),
      entries: new Map<string, number>(),
    }

    const nameOf = (fiber: any): string => {
      const t = fiber.type
      if (!t) return 'Unknown'
      if (typeof t === 'string') return t
      const named = t.displayName || t.name || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name
      if (named) return named
      // Anonymous: say who created it and what it looks like.
      const owner = fiber._debugOwner
      const ownerName = owner ? (owner.name ?? (owner.type && (owner.type.displayName || owner.type.name))) : ''
      const src = String((t.type ?? t.render ?? t)).replace(/\s+/g, ' ').slice(0, 70)
      return `Anonymous<${ownerName || '?'}> ${src}`
    }

    const didRender = (next: any, prev: any | null): boolean => {
      if (!COMPONENT_TAGS.has(next.tag)) return false
      if (prev === null) return true
      return (next.flags & PERFORMED_WORK) === PERFORMED_WORK
    }

    const shallowEqualProps = (a: any, b: any): boolean => {
      if (a === b) return true
      if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
      const ka = Object.keys(a)
      if (ka.length !== Object.keys(b).length) return false
      for (const k of ka) if (!Object.is(a[k], b[k])) return false
      return true
    }

    // Only useState/useReducer hooks carry a `queue`; effect hooks recreate
    // their record on every render so comparing them would always differ.
    const stateUnchanged = (next: any, prev: any): boolean => {
      if (next.tag === 1) return next.memoizedState === prev.memoizedState
      let n = next.memoizedState
      let p = prev.memoizedState
      while (n && p) {
        if (n.queue && !Object.is(n.memoizedState, p.memoizedState)) return false
        n = n.next
        p = p.next
      }
      return true
    }

    /** Same props (shallow) and same state: React.memo would have skipped this render. */
    const inputsUnchanged = (next: any, prev: any): boolean =>
      shallowEqualProps(prev.memoizedProps, next.memoizedProps) && stateUnchanged(next, prev)

    let renderedInCommit = 0
    const contextLabel = (ctx: any): string => {
      if (ctx.displayName) return ctx.displayName
      const v = ctx._currentValue
      if (v && typeof v === 'object') return `{${Object.keys(v).slice(0, 3).join(',')}}`
      return typeof v
    }

    const noteContextChanges = (next: any, prev: any, stat: any) => {
      let n = next.dependencies?.firstContext
      let p = prev.dependencies?.firstContext
      while (n && p) {
        const a = p.memoizedValue
        const b = n.memoizedValue
        if (!Object.is(a, b)) {
          const label = contextLabel(n.context)
          if (a && b && typeof a === 'object' && typeof b === 'object') {
            let any = false
            for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
              if (!Object.is(a[k], b[k])) {
                any = true
                const key = `${label}.${k}`
                stat.changedContexts[key] = (stat.changedContexts[key] || 0) + 1
              }
            }
            if (!any) stat.changedContexts[label] = (stat.changedContexts[label] || 0) + 1
          } else {
            stat.changedContexts[label] = (stat.changedContexts[label] || 0) + 1
          }
        }
        n = n.next
        p = p.next
      }
    }

    const visit = (next: any, prev: any | null, parentRendered = false) => {
      const rendered = didRender(next, prev)
      if (rendered && !parentRendered) {
        const entry = nameOf(next)
        state.entries.set(entry, (state.entries.get(entry) || 0) + 1)
      }
      if (rendered) {
        renderedInCommit++
        const name = nameOf(next)
        let stat = state.comps.get(name)
        if (!stat) state.comps.set(name, (stat = { renders: 0, selfMs: 0, wasted: 0, changedProps: {}, changedContexts: {} }))
        stat.renders++
        let childMs = 0
        for (let c = next.child; c; c = c.sibling) childMs += c.actualDuration || 0
        stat.selfMs += Math.max(0, (next.actualDuration || 0) - childMs)
        if (prev) {
          if (inputsUnchanged(next, prev)) stat.wasted++
          noteContextChanges(next, prev, stat)
          const a = prev.memoizedProps
          const b = next.memoizedProps
          if (a && b && typeof a === 'object' && typeof b === 'object') {
            for (const k of Object.keys(b)) if (!Object.is(a[k], b[k])) stat.changedProps[k] = (stat.changedProps[k] || 0) + 1
          }
        }
      }
      if (prev === null) {
        // Mount: everything below is new.
        for (let c = next.child; c; c = c.sibling) visit(c, null, rendered || parentRendered)
        return
      }
      if (next.child !== prev.child) {
        for (let c = next.child; c; c = c.sibling) visit(c, c.alternate, rendered || parentRendered)
      }
    }

    const hook: any = {
      supportsFiber: true,
      renderers: new Map(),
      inject(renderer: any) {
        const id = hook.renderers.size + 1
        hook.renderers.set(id, renderer)
        return id
      },
      onScheduleFiberRoot() {},
      onCommitFiberRoot(_id: number, root: any) {
        if (!state.active) return
        const started = performance.now()
        renderedInCommit = 0
        const current = root.current
        const prev = current.alternate
        visit(current, prev)
        const done = performance.now()
        state.commits.push({
          t: started - state.startedAt,
          renderMs: current.actualDuration || 0,
          hookMs: done - started,
          rendered: renderedInCommit,
        })
      },
      onPostCommitFiberRoot() {},
      onCommitFiberUnmount() {},
      checkDCE() {},
      isDisabled: false,
    }
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook

    w.__renderProfile = {
      start() {
        state.commits = []
        state.comps = new Map()
        state.entries = new Map()
        state.startedAt = performance.now()
        state.active = true
      },
      stop() {
        state.active = false
        return { entries: [...state.entries.entries()], commits: state.commits, comps: [...state.comps.entries()].map(([name, s]) => ({ name, ...s })), durationMs: performance.now() - state.startedAt }
      },
    }
  })
}

export async function startRenderProfile(page: Page): Promise<void> {
  const ok = await page.evaluate(() => {
    const p = (window as any).__renderProfile
    if (!p) return false
    p.start()
    return true
  })
  if (!ok) throw new Error('React profiler is not installed (launch with SHOGO_E2E_REACT_PROFILE=1)')
}

const percentile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0)
const round = (n: number) => Math.round(n * 10) / 10

export async function stopRenderProfile(page: Page, top = 25): Promise<RenderProfile> {
  const raw = await page.evaluate(() => (window as any).__renderProfile.stop())
  return summarizeRenderProfile(raw, top)
}

export function summarizeRenderProfile(raw: { entries?: Array<[string, number]>; commits: CommitSample[]; comps: Array<ComponentStat>; durationMs: number }, top = 25): RenderProfile {
  const times = raw.commits.map((c) => c.renderMs).sort((a, b) => a - b)
  const size = Math.max(1, Math.ceil(raw.commits.length / 3))
  const thirds = [0, 1, 2].map((i) => {
    const part = raw.commits.slice(i * size, (i + 1) * size).map((c) => c.renderMs)
    const sorted = [...part].sort((a, b) => a - b)
    return { commits: part.length, meanMs: round(part.reduce((a, b) => a + b, 0) / Math.max(1, part.length)), p95Ms: round(percentile(sorted, 0.95)) }
  })
  const fmt = (c: ComponentStat): ComponentStat => ({
    ...c,
    selfMs: round(c.selfMs),
    changedProps: Object.fromEntries(Object.entries(c.changedProps ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8)),
    changedContexts: Object.fromEntries(Object.entries(c.changedContexts ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8)),
  })
  return {
    durationMs: Math.round(raw.durationMs),
    commits: raw.commits.length,
    commitsPerSec: round(raw.commits.length / Math.max(0.001, raw.durationMs / 1000)),
    renderMs: {
      total: round(times.reduce((a, b) => a + b, 0)),
      p50: round(percentile(times, 0.5)),
      p95: round(percentile(times, 0.95)),
      max: round(times[times.length - 1] ?? 0),
    },
    slowCommits: times.filter((t) => t > 50).length,
    hookMsTotal: round(raw.commits.reduce((a, c) => a + c.hookMs, 0)),
    thirds,
    byRenders: [...raw.comps].sort((a, b) => b.renders - a.renders).slice(0, top).map(fmt),
    bySelfMs: [...raw.comps].sort((a, b) => b.selfMs - a.selfMs).slice(0, top).map(fmt),
    commitEntryPoints: [...(raw.entries ?? [])].sort((a, b) => b[1] - a[1]).slice(0, top).map(([name, commits]) => ({ name, commits })),
    byWasted: [...raw.comps].filter((c) => c.wasted > 0).sort((a, b) => b.wasted - a.wasted).slice(0, top).map(fmt),
  }
}
