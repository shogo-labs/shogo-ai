// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The eviction verdict, behaviour-first (SHO-143).
 *
 * The rule these pin: a runtime is only evicted when the host can PROVE it is
 * idle. Anything unverifiable — no sample, a failed probe, a sample older than
 * the staleness window, a runtime still starting — keeps it. A Windows desktop
 * evicted a background runtime 146 times in 24h with 0 keeps; every one of
 * those came from "could not tell" being read as "idle".
 */
import { describe, expect, it } from 'bun:test';
import {
  ACTIVITY_STALE_MS,
  DEAD_PROBE_MS,
  STARTUP_GRACE_MS,
  decideBusy,
  type ActivitySample,
} from '../runtime-activity.ts';

const NOW = 1_800_000_000_000;
const OLD_START = NOW - 30 * 60_000;

function sample(over: Partial<ActivitySample> = {}, counts = { turns: 0, tasks: 0, streams: 0, children: 0 }): ActivitySample {
  return { counts, at: NOW - 5_000, ok: true, ...over };
}

describe('decideBusy — unknown is busy', () => {
  it('keeps a runtime with no sample yet', () => {
    const d = decideBusy({ now: NOW, startedAt: OLD_START, status: 'running', sample: null });
    expect(d.busy).toBe(true);
    expect(d.dead).toBe(false);
    expect(d.reason).toBe('unknown');
  });

  it('keeps a runtime whose last probe failed', () => {
    const d = decideBusy({
      now: NOW,
      startedAt: OLD_START,
      status: 'running',
      sample: sample({ ok: false, error: 'no answer', failingSince: NOW - 5_000 }),
    });
    expect(d.busy).toBe(true);
    expect(d.reason).toBe('unknown');
  });

  it('keeps a runtime whose sample has aged out of the staleness window', () => {
    const d = decideBusy({
      now: NOW,
      startedAt: OLD_START,
      status: 'running',
      sample: sample({ at: NOW - ACTIVITY_STALE_MS - 1_000 }),
    });
    expect(d.busy).toBe(true);
    expect(d.reason).toBe('stale');
  });

  it('treats a status it cannot vouch for as busy, not idle', () => {
    const d = decideBusy({ now: NOW, startedAt: OLD_START, status: 'stopping', sample: sample() });
    expect(d.busy).toBe(true);
    expect(d.reason).toBe('unknown');
  });
});

describe('decideBusy — real work is busy', () => {
  it.each([
    ['turns', { turns: 1, tasks: 0, streams: 0, children: 0 }],
    ['tasks', { turns: 0, tasks: 2, streams: 0, children: 0 }],
    ['streams', { turns: 0, tasks: 0, streams: 1, children: 0 }],
    ['children', { turns: 0, tasks: 0, streams: 0, children: 1 }],
  ])('keeps a runtime with %s in flight', (_label, counts) => {
    const d = decideBusy({ now: NOW, startedAt: OLD_START, status: 'running', sample: sample({}, counts) });
    expect(d.busy).toBe(true);
    expect(d.reason).toBe('work');
  });

  it('keeps a runtime with an open terminal even when everything else is idle', () => {
    const d = decideBusy({ now: NOW, startedAt: OLD_START, status: 'running', sample: sample(), terminalSessions: 1 });
    expect(d.busy).toBe(true);
    expect(d.reason).toBe('terminal');
  });

  it('keeps a runtime with a project call in flight', () => {
    const d = decideBusy({ now: NOW, startedAt: OLD_START, status: 'running', sample: sample(), inflightCalls: 1 });
    expect(d.busy).toBe(true);
    expect(d.reason).toBe('inflight-call');
  });

  it('keeps a runtime that is still starting, whatever the sample says', () => {
    const d = decideBusy({ now: NOW, startedAt: NOW - 1_000, status: 'starting', sample: sample() });
    expect(d.busy).toBe(true);
    expect(d.reason).toBe('grace');
  });

  it('keeps a freshly started runtime for the whole startup grace', () => {
    const d = decideBusy({
      now: NOW,
      startedAt: NOW - (STARTUP_GRACE_MS - 1_000),
      status: 'running',
      sample: sample(),
    });
    expect(d.busy).toBe(true);
    expect(d.reason).toBe('grace');
  });

  it('counts the log line for a busy runtime', () => {
    const d = decideBusy({
      now: NOW,
      startedAt: OLD_START,
      status: 'running',
      sample: sample({}, { turns: 0, tasks: 2, streams: 0, children: 1 }),
    });
    expect(d.countsText).toBe('turns=0 tasks=2 streams=0 children=1');
  });
});

describe('decideBusy — only proof of death reaps', () => {
  it('calls an exited process dead, not busy', () => {
    const d = decideBusy({ now: NOW, startedAt: OLD_START, status: 'running', processExited: true });
    expect(d.dead).toBe(true);
    expect(d.busy).toBe(false);
  });

  it('keeps a runtime that refuses connections briefly, then calls it dead', () => {
    const refusedJustNow = decideBusy({
      now: NOW,
      startedAt: OLD_START,
      status: 'running',
      sample: sample({ ok: false, failingSince: NOW - 10_000 }),
    });
    expect(refusedJustNow.busy).toBe(true);
    expect(refusedJustNow.dead).toBe(false);

    const refusedForAges = decideBusy({
      now: NOW,
      startedAt: OLD_START,
      status: 'running',
      sample: sample({ ok: false, failingSince: NOW - DEAD_PROBE_MS - 1_000 }),
    });
    expect(refusedForAges.dead).toBe(true);
  });
});

describe('decideBusy — idle is the only evictable answer', () => {
  it('reports idle with zero counts and a fresh sample', () => {
    const d = decideBusy({ now: NOW, startedAt: OLD_START, status: 'running', sample: sample() });
    expect(d.busy).toBe(false);
    expect(d.dead).toBe(false);
    expect(d.reason).toBe('idle');
    expect(d.countsText).toBe('turns=0 tasks=0 streams=0 children=0');
  });
});
