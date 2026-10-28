// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the preview "wait for the API before loading the UI" gate
 * (`lib/preview-gate.ts`). These pin the policy that the project layout
 * (`projects/[id]/_layout.tsx`) uses to hold the canvas iframe until the
 * project's API sidecar is actually responding — the fix for "UI loads but
 * `/api/*` calls fail because the server isn't up yet".
 *
 * Run: bun test apps/mobile/lib/__tests__/preview-gate.test.ts
 */

import { describe, test, expect } from 'bun:test'
import {
  resolveApiReady,
  resolveRunning,
  shouldStopPreviewPoll,
  shouldShowCanvas,
  isPreviewFailed,
  previewStatusPollBase,
  canvasDocumentUrl,
  nativeCanvasBaseReady,
  projectIdFromAgentProxyUrl,
  previewWakeUrl,
  isApiGateLatched,
  latchApiGate,
  resetApiGateLatches,
  previewActiveUrl,
  agentPortFromCanvasBaseUrl,
  isPreviewPingHealthy,
  decidePreviewPing,
  PREVIEW_ACTIVE_PING_MS,
  PREVIEW_RECOVERY_MAX_ATTEMPTS,
  previewRecoveryAttempts,
  recordPreviewRecovery,
  resetPreviewRecoveryAttempts,
} from '../preview-gate'

describe('API gate latch (survives canvas remounts)', () => {
  test('a preview that cleared the gate stays open for a fresh mount', () => {
    resetApiGateLatches()
    const key = 'https://studio.shogo.ai/api/projects/abc/agent-proxy'
    expect(isApiGateLatched(key)).toBe(false)
    latchApiGate(key)
    expect(isApiGateLatched(key)).toBe(true)
    // ...and, via shouldShowCanvas, a remount no longer waits on the sidecar.
    expect(
      shouldShowCanvas({ baseReady: true, apiLatched: isApiGateLatched(key), timedOut: false }),
    ).toBe(true)
  })

  test('is scoped per preview', () => {
    resetApiGateLatches()
    latchApiGate('https://studio.shogo.ai/api/projects/a/agent-proxy')
    expect(isApiGateLatched('https://studio.shogo.ai/api/projects/b/agent-proxy')).toBe(false)
    expect(isApiGateLatched(null)).toBe(false)
    latchApiGate(null) // no-op
    expect(isApiGateLatched(null)).toBe(false)
  })
})

describe('resolveApiReady', () => {
  test('passes through an explicit boolean', () => {
    expect(resolveApiReady({ apiReady: true })).toBe(true)
    expect(resolveApiReady({ apiReady: false })).toBe(false)
  })

  test('defaults to true when the field is absent (older runtime)', () => {
    // Backwards-compat: a runtime whose /preview/status predates apiReady
    // must not permanently block the UI.
    expect(resolveApiReady({})).toBe(true)
    expect(resolveApiReady({ running: true })).toBe(true)
  })
})

describe('resolveRunning', () => {
  // Regression coverage for the persistent "Project Ready" placeholder
  // (staging, 2026-09-22, project a0bea431-...): a metal cold-miss assign
  // boots a warm-pool TEMPLATE, hydrates the real source, then schedules a
  // rebuild (`scheduleHydrateRebuild()` in server.ts). `/pool/assign` returns
  // — and the API's `/sandbox/url` reports `ready: true` — well before that
  // rebuild finishes, so `running: true` at that point still describes the
  // template, not the project.
  test('reports not-running while a hydrate rebuild is pending, even if the raw flag is true', () => {
    expect(resolveRunning({ running: true, hydrateRebuildPending: true })).toBe(false)
  })

  test('passes through the raw flag once no hydrate rebuild is pending', () => {
    expect(resolveRunning({ running: true, hydrateRebuildPending: false })).toBe(true)
    expect(resolveRunning({ running: false, hydrateRebuildPending: false })).toBe(false)
  })

  test('degrades to the raw flag on runtimes that never report hydrateRebuildPending', () => {
    expect(resolveRunning({ running: true })).toBe(true)
    expect(resolveRunning({ running: false })).toBe(false)
    expect(resolveRunning({})).toBe(false)
  })
})

describe('shouldStopPreviewPoll', () => {
  test('keeps polling while running but the API is not ready yet', () => {
    // The prebuilt-dist path reports running=true before the sidecar binds,
    // so we must NOT stop polling until apiReady flips true.
    expect(shouldStopPreviewPoll({ running: true, apiReady: false })).toBe(false)
  })

  test('keeps polling while the API is ready but the preview is not running', () => {
    expect(shouldStopPreviewPoll({ running: false, apiReady: true })).toBe(false)
  })

  test('stops once running AND the API is ready', () => {
    expect(shouldStopPreviewPoll({ running: true, apiReady: true })).toBe(true)
  })

  test('stops on an older runtime once running (absent apiReady → ready)', () => {
    expect(shouldStopPreviewPoll({ running: true })).toBe(true)
  })

  test('does not stop before the preview is running', () => {
    expect(shouldStopPreviewPoll({})).toBe(false)
    expect(shouldStopPreviewPoll({ apiReady: true })).toBe(false)
  })

  test('stops immediately when setup terminally failed (no infinite spinner)', () => {
    // phase=failed means the runtime will never come up on its own — stop
    // polling and let the UI render the error instead of spinning forever.
    expect(shouldStopPreviewPoll({ phase: 'failed' })).toBe(true)
    expect(shouldStopPreviewPoll({ phase: 'failed', running: false })).toBe(true)
  })

  test('keeps polling while a post-hydrate rebuild is pending, even though running+apiReady already look satisfied', () => {
    // Without this, a metal cold-miss assign latches onto the warm-pool
    // template's own quick running=true/apiReady=true and stops polling
    // before the real, post-hydrate rebuild ever runs — see resolveRunning.
    expect(
      shouldStopPreviewPoll({ running: true, apiReady: true, hydrateRebuildPending: true }),
    ).toBe(false)
  })

  test('stops once the hydrate rebuild has finished and running+apiReady are (still) true', () => {
    expect(
      shouldStopPreviewPoll({ running: true, apiReady: true, hydrateRebuildPending: false }),
    ).toBe(true)
  })
})

describe('isPreviewFailed', () => {
  test('true only for the terminal failed phase', () => {
    expect(isPreviewFailed({ phase: 'failed' })).toBe(true)
    expect(isPreviewFailed({ phase: 'building' })).toBe(false)
    expect(isPreviewFailed({ phase: 'ready' })).toBe(false)
    expect(isPreviewFailed({})).toBe(false)
  })
})

describe('shouldShowCanvas', () => {
  test('false until the dev server is reachable, regardless of API state', () => {
    expect(shouldShowCanvas({ baseReady: false, apiLatched: true, timedOut: false })).toBe(false)
    expect(shouldShowCanvas({ baseReady: false, apiLatched: false, timedOut: true })).toBe(false)
  })

  test('false while base is ready but the API has never been healthy', () => {
    expect(shouldShowCanvas({ baseReady: true, apiLatched: false, timedOut: false })).toBe(false)
  })

  test('true once base is ready and the API has been healthy (latched)', () => {
    expect(shouldShowCanvas({ baseReady: true, apiLatched: true, timedOut: false })).toBe(true)
  })

  test('timeout is a safety valve: loads even if the API never went healthy', () => {
    expect(shouldShowCanvas({ baseReady: true, apiLatched: false, timedOut: true })).toBe(true)
  })
})

describe('previewStatusPollBase', () => {
  test('returns null without an agent proxy', () => {
    expect(previewStatusPollBase(null, 'https://p.preview.shogo.ai/p/abc')).toBe(null)
  })

  test('polls the agent-proxy, not the public preview host', () => {
    expect(
      previewStatusPollBase(
        'https://studio.shogo.ai/api/projects/abc/agent-proxy',
        'https://abc.preview.shogo.ai',
      ),
    ).toBe('https://studio.shogo.ai/api/projects/abc/agent-proxy')
  })

  test('scopes workspace runtimes to /p/<id> on the proxy', () => {
    expect(
      previewStatusPollBase(
        'https://studio.shogo.ai/api/projects/abc/agent-proxy/',
        'https://preview.example/p/abc',
      ),
    ).toBe('https://studio.shogo.ai/api/projects/abc/agent-proxy/p/abc')
  })
})

describe('canvasDocumentUrl', () => {
  test('web loads the canvas origin, not the tokenized preview link', () => {
    expect(
      canvasDocumentUrl({
        canvasBaseUrl: 'https://abc.preview.shogo.ai',
        agentUrl: 'https://studio.shogo.ai/api/projects/abc/agent-proxy',
        previewUrl: 'https://abc.preview.shogo.ai/?__preview_token=tok',
        native: false,
      }),
    ).toBe('https://abc.preview.shogo.ai/')
  })

  test('native WebView loads the tokenized preview URL', () => {
    expect(
      canvasDocumentUrl({
        canvasBaseUrl: 'https://abc.preview.shogo.ai',
        agentUrl: 'https://studio.shogo.ai/api/projects/abc/agent-proxy',
        previewUrl: 'https://abc.preview.shogo.ai/?__preview_token=tok',
        native: true,
      }),
    ).toBe('https://abc.preview.shogo.ai/?__preview_token=tok')
  })
})

describe('nativeCanvasBaseReady', () => {
  test('web still waits for /preview/status running', () => {
    expect(
      nativeCanvasBaseReady({
        native: false,
        agentUrl: 'https://studio.shogo.ai/api/projects/abc/agent-proxy',
        previewUrl: 'https://abc.preview.shogo.ai/?__preview_token=tok',
        canvasBaseUrl: 'https://abc.preview.shogo.ai',
      }),
    ).toBe(false)
  })

  test('native is ready once sandbox/url returned a document URL', () => {
    expect(
      nativeCanvasBaseReady({
        native: true,
        agentUrl: 'https://studio.shogo.ai/api/projects/abc/agent-proxy',
        previewUrl: 'https://abc.preview.shogo.ai/?__preview_token=tok',
        canvasBaseUrl: null,
      }),
    ).toBe(true)
  })

  test('native is not ready without a runtime or document URL', () => {
    expect(
      nativeCanvasBaseReady({
        native: true,
        agentUrl: null,
        previewUrl: 'https://abc.preview.shogo.ai/?__preview_token=tok',
      }),
    ).toBe(false)
    expect(
      nativeCanvasBaseReady({
        native: true,
        agentUrl: 'https://studio.shogo.ai/api/projects/abc/agent-proxy',
      }),
    ).toBe(false)
  })
})

describe('projectIdFromAgentProxyUrl', () => {
  test('extracts the project id from the proxy path', () => {
    expect(
      projectIdFromAgentProxyUrl('https://studio.shogo.ai/api/projects/abc-123/agent-proxy'),
    ).toBe('abc-123')
  })
})

describe('previewWakeUrl', () => {
  test('hits the anonymous wake endpoint', () => {
    expect(previewWakeUrl('https://studio.shogo.ai', 'abc-123')).toBe(
      'https://studio.shogo.ai/api/preview/abc-123/wake',
    )
  })
})

/**
 * SHO-226: the canvas pings `preview/active` while it is on screen, which both
 * pins the runtime out of the warm-preview LRU and is how the client notices
 * its runtime was stopped or respawned on another port.
 */
describe('previewActiveUrl', () => {
  test('targets the project preview-active route', () => {
    expect(previewActiveUrl('https://studio.shogo.ai', 'abc-123')).toBe(
      'https://studio.shogo.ai/api/projects/abc-123/preview/active',
    )
  })

  test('tolerates a trailing slash on the API base', () => {
    expect(previewActiveUrl('http://localhost:8787/', 'abc-123')).toBe(
      'http://localhost:8787/api/projects/abc-123/preview/active',
    )
  })
})

describe('agentPortFromCanvasBaseUrl', () => {
  test('reads the port the iframe is actually pointed at', () => {
    expect(agentPortFromCanvasBaseUrl('http://localhost:5173/p/abc-123')).toBe(5173)
  })

  test('null when there is no explicit port (cloud / subdomain preview)', () => {
    expect(agentPortFromCanvasBaseUrl('https://abc.preview.shogo.ai/p/abc-123')).toBeNull()
    expect(agentPortFromCanvasBaseUrl(null)).toBeNull()
    expect(agentPortFromCanvasBaseUrl('not a url')).toBeNull()
  })
})

describe('isPreviewPingHealthy', () => {
  test('healthy when the runtime is running on the port the iframe uses', () => {
    expect(
      isPreviewPingHealthy({ ok: true, running: true, agentPort: 5173 }, 'http://localhost:5173/p/a'),
    ).toBe(true)
  })

  test('unhealthy when the API says the runtime is not running', () => {
    expect(isPreviewPingHealthy({ ok: true, running: false }, null)).toBe(false)
  })

  test('unhealthy when the runtime respawned on a different port', () => {
    expect(
      isPreviewPingHealthy({ ok: true, running: true, agentPort: 6001 }, 'http://localhost:5173/p/a'),
    ).toBe(false)
  })

  test('a port we cannot compare on either side is not evidence of a problem', () => {
    // Cloud no-op answers `agentPort: null`; the canvas URL has no port either.
    expect(
      isPreviewPingHealthy({ ok: true, running: true, agentPort: null }, 'https://a.preview.shogo.ai/p/a'),
    ).toBe(true)
  })

  test('a failed request or a non-ok body is unhealthy', () => {
    expect(isPreviewPingHealthy(null, null)).toBe(false)
    expect(isPreviewPingHealthy({ running: true }, null)).toBe(false)
  })
})

describe('decidePreviewPing', () => {
  const url = 'http://localhost:5173/p/a'
  const live = { ok: true, running: true, agentPort: 5173 }
  const dead = { ok: true, running: false, agentPort: null }

  test('keeps the iframe on a healthy ping and clears the failure streak', () => {
    expect(
      decidePreviewPing({
        ping: live,
        canvasBaseUrl: url,
        failures: 2,
        seenRunning: true,
      }),
    ).toEqual({ decision: 'keep', failures: 0, seenRunning: true })
  })

  test('recovers when a runtime this canvas had running is stopped under it', () => {
    expect(decidePreviewPing({ ping: dead, canvasBaseUrl: url, seenRunning: true })).toEqual({
      decision: 'recover',
      failures: 1,
      seenRunning: true,
    })
  })

  test('gives up at the attempt limit instead of restarting forever', () => {
    let verdict = decidePreviewPing({ ping: dead, canvasBaseUrl: url, seenRunning: true })
    for (let i = 1; i < PREVIEW_RECOVERY_MAX_ATTEMPTS; i++) {
      verdict = decidePreviewPing({
        ping: dead,
        canvasBaseUrl: url,
        failures: verdict.failures,
        seenRunning: verdict.seenRunning,
      })
    }
    // Re-resolving restarts the runtime, so the loop has to stop somewhere.
    expect(verdict).toEqual({
      decision: 'give-up',
      failures: PREVIEW_RECOVERY_MAX_ATTEMPTS,
      seenRunning: true,
    })
  })

  test('recovers when the runtime respawned on a different live port', () => {
    expect(
      decidePreviewPing({
        ping: { ok: true, running: true, agentPort: 6001 },
        canvasBaseUrl: url,
        seenRunning: true,
      }),
    ).toEqual({ decision: 'recover', failures: 1, seenRunning: true })
  })

  // The three regressions the E2E jobs caught on PR #1767. Each one used to
  // re-resolve `/sandbox/url` — which restarts the runtime — for a preview that
  // was perfectly healthy, or for a project this API does not own at all.
  describe('never re-resolves without positive evidence', () => {
    test('a ping that never reached the API (offline, blip, non-2xx) is not a lost runtime', () => {
      // chat-resume-on-send: the window goes offline for a minute; the runtime
      // must keep running the turn it is mid-way through.
      expect(decidePreviewPing({ ping: null, canvasBaseUrl: url, seenRunning: true })).toEqual({
        decision: 'keep',
        failures: 0,
        seenRunning: true,
      })
      expect(
        decidePreviewPing({ ping: { running: true }, canvasBaseUrl: url, seenRunning: true }),
      ).toEqual({ decision: 'keep', failures: 0, seenRunning: true })
    })

    test('offline means nothing about the runtime', () => {
      expect(decidePreviewPing({ ping: dead, canvasBaseUrl: url, online: false })).toEqual({
        decision: 'keep',
        failures: 0,
        seenRunning: false,
      })
    })

    test('running:false on the first ping is not a loss — a sleeping machine answers that way', () => {
      // machine-workspaces-live (SHO-185): waking the machine from a canvas that
      // is merely on screen would put a read into the relay and break the "the
      // machine stays asleep" contract.
      expect(decidePreviewPing({ ping: dead, canvasBaseUrl: url })).toEqual({
        decision: 'keep',
        failures: 0,
        seenRunning: false,
      })
    })

    test('a preview that has not started yet is not a loss either', () => {
      // project-chat-url: the panel must stay usable while the dev server comes
      // up, instead of being replaced by the give-up recovery UI.
      expect(decidePreviewPing({ ping: dead, canvasBaseUrl: null })).toEqual({
        decision: 'keep',
        failures: 0,
        seenRunning: false,
      })
    })

    test('a cold start (`status: starting`) is not a lost runtime, even after we saw it live', () => {
      // The project route holds its whole screen behind `runtimeReady`, so
      // re-resolving here is what left the composer and "+ new chat" missing.
      const starting = { ok: true, running: false, agentPort: null, status: 'starting' }
      expect(
        decidePreviewPing({ ping: starting, canvasBaseUrl: url, seenRunning: true }),
      ).toEqual({ decision: 'keep', failures: 0, seenRunning: true })
    })

    test('`status: stopped` after we saw it live IS a loss', () => {
      const stopped = { ok: true, running: false, agentPort: null, status: 'stopped' }
      expect(
        decidePreviewPing({ ping: stopped, canvasBaseUrl: url, seenRunning: true }),
      ).toEqual({ decision: 'recover', failures: 1, seenRunning: true })
    })

    test('a failing `/preview/status` poll is not evidence, however long it fails', () => {
      // project-chat-url and machine-workspaces-live: a stubbed agentUrl or a
      // machine workspace has no `/preview/status` to answer, so the poll fails
      // forever. Feeding that in as a lost runtime re-resolved `/sandbox/url`
      // over and over, and the remount detached "+ new chat" / the composer
      // before Playwright could click them.
      expect(decidePreviewPing({ ping: dead, canvasBaseUrl: url })).toEqual({
        decision: 'keep',
        failures: 0,
        seenRunning: false,
      })
    })

    test('a stopped/errored runtime the API still knows is a loss even if we never saw it live', () => {
      for (const status of ['stopped', 'error']) {
        expect(
          decidePreviewPing({
            ping: { ok: true, running: false, agentPort: null, status },
            canvasBaseUrl: url,
          }),
        ).toEqual({ decision: 'recover', failures: 1, seenRunning: false })
      }
    })

    test('an unknown runtime (status null) is not a loss, and neither is a cloud no-op', () => {
      for (const status of [null, undefined, 'stopping']) {
        expect(
          decidePreviewPing({
            ping: { ok: true, running: false, agentPort: null, status },
            canvasBaseUrl: url,
          }),
        ).toEqual({ decision: 'keep', failures: 0, seenRunning: false })
      }
    })
  })
})

describe('preview recovery attempts', () => {
  // Recovering unmounts the canvas (it drops back to the loading gate), so the
  // count lives at module scope. Kept in a ref it restarted at zero on every
  // attempt, and a single false "lost runtime" signal looped forever.
  test('the count survives the remount that recovering causes', () => {
    resetPreviewRecoveryAttempts()
    const project = 'proj-loop'
    expect(previewRecoveryAttempts(project)).toBe(0)

    let failures = previewRecoveryAttempts(project)
    const stopped = { ok: true, running: false, agentPort: null, status: 'stopped' }
    for (let attempt = 1; attempt <= PREVIEW_RECOVERY_MAX_ATTEMPTS; attempt++) {
      const verdict = decidePreviewPing({ ping: stopped, canvasBaseUrl: null, failures })
      recordPreviewRecovery(project, verdict.failures)
      // A fresh mount reads the count back instead of starting from zero.
      failures = previewRecoveryAttempts(project)
      expect(failures).toBe(attempt)
      if (attempt < PREVIEW_RECOVERY_MAX_ATTEMPTS) expect(verdict.decision).toBe('recover')
      else expect(verdict.decision).toBe('give-up')
    }
  })

  test('a healthy ping clears the count, and projects do not share one', () => {
    resetPreviewRecoveryAttempts()
    recordPreviewRecovery('a', 2)
    recordPreviewRecovery('b', 1)
    expect(previewRecoveryAttempts('a')).toBe(2)
    expect(previewRecoveryAttempts('b')).toBe(1)
    recordPreviewRecovery('a', 0)
    expect(previewRecoveryAttempts('a')).toBe(0)
    expect(previewRecoveryAttempts('b')).toBe(1)
  })
})

describe('PREVIEW_ACTIVE_PING_MS', () => {
  test('pings well inside the manager view TTL, so one missed ping is survivable', () => {
    // The API pins a preview for 3 minutes; a minute leaves two misses of slack.
    expect(PREVIEW_ACTIVE_PING_MS).toBeLessThanOrEqual(60_000)
    expect(PREVIEW_ACTIVE_PING_MS * 2).toBeLessThan(3 * 60_000)
  })
})
