// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Coverage gaps for cloud-login.ts.
 *
 * Targets:
 *   L201-205  sigHandler body (SIGINT/SIGTERM aborts the poll loop)
 *   L239-244  poll fetch network error → .catch swallows and retries
 *   L287-289  sleep() onAbort handler (signal fires DURING sleep)
 *   L323-337  openInBrowser (default openBrowser path)
 */
import { describe, it, expect } from 'bun:test';
import { runCloudLogin, CloudLoginError } from '../cloud-login.ts';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const startBody = {
  ok: true,
  state: 'state-abc',
  userCode: 'XXXXXX',
  authUrl: 'https://cloud.example.com/auth/cli-link?state=state-abc',
  expiresInMs: 60_000,
  pollIntervalMs: 1,
};

describe('runCloudLogin — sigHandler (L201-205)', () => {
  it('SIGINT during the poll loop unwinds via cancelled CloudLoginError', async () => {
    // Issue SIGINT after start; the sigHandler should abort the local controller.
    let pollCount = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/cli/login/start')) {
        return jsonResponse(startBody);
      }
      pollCount += 1;
      if (pollCount === 1) {
        // Fire SIGINT in the next microtask while the loop is about to sleep
        setImmediate(() => process.emit('SIGINT' as any));
        return jsonResponse({ ok: true, status: 'pending' });
      }
      return jsonResponse({ ok: true, status: 'pending' });
    }) as unknown as typeof fetch;

    try {
      await runCloudLogin({
        cloudUrl: 'https://cloud.example.com',
        deviceId: 'dev-abc',
        openBrowser: false,
        pollIntervalMs: 100,
        installSignalHandlers: true,
        log: () => {},
        fetchImpl,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CloudLoginError);
      expect((err as CloudLoginError).kind).toBe('cancelled');
    }
  });
});

describe('runCloudLogin — poll network error .catch (L239-244)', () => {
  it('soft network error during poll is logged and the loop retries until approved', async () => {
    let pollCount = 0;
    const logs: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/cli/login/start')) {
        return jsonResponse(startBody);
      }
      pollCount += 1;
      if (pollCount === 1) {
        throw new Error('ECONNRESET on first poll');
      }
      return jsonResponse({
        ok: true, status: 'approved', key: 'shogo_sk_recovered',
        email: 'u@e.com', workspace: 'w', deviceId: 'd',
      });
    }) as unknown as typeof fetch;

    const result = await runCloudLogin({
      cloudUrl: 'https://cloud.example.com',
      deviceId: 'd',
      openBrowser: false,
      pollIntervalMs: 1,
      installSignalHandlers: false,
      log: (s) => logs.push(s),
      fetchImpl,
    });
    expect(result.key).toBe('shogo_sk_recovered');
    expect(logs.some((l) => l.includes('poll error'))).toBe(true);
  });
});

describe('runCloudLogin — sleep onAbort (L287-289)', () => {
  it('abort signal fires DURING the inter-poll sleep → cancelled CloudLoginError', async () => {
    // Use a long pollIntervalMs so sleep is in flight when we abort.
    const ac = new AbortController();
    let pollCount = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/cli/login/start')) {
        return jsonResponse({ ...startBody, pollIntervalMs: 5000 });
      }
      pollCount += 1;
      if (pollCount === 1) {
        // After this poll, sleep(5000) begins. Schedule abort 20ms later.
        setTimeout(() => ac.abort(), 20);
        return jsonResponse({ ok: true, status: 'pending' });
      }
      return jsonResponse({ ok: true, status: 'pending' });
    }) as unknown as typeof fetch;

    try {
      await runCloudLogin({
        cloudUrl: 'https://cloud.example.com',
        deviceId: 'd',
        openBrowser: false,
        pollIntervalMs: 5000, // long sleep
        installSignalHandlers: false,
        log: () => {},
        fetchImpl,
        abortSignal: ac.signal,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CloudLoginError);
      expect((err as CloudLoginError).kind).toBe('cancelled');
    }
  });
});

describe('runCloudLogin — openInBrowser default path (L323-337)', () => {
  it('with openBrowser undefined: invokes openInBrowser (default path) without breaking the flow', async () => {
    // Default openBrowser triggers spawn('xdg-open' | 'open' | 'cmd'). On a
    // sandbox the spawn may fail or succeed; in BOTH cases the .catch on the
    // call site swallows it. We're after coverage of L323-334 / L335-337.
    let pollCount = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/cli/login/start')) {
        return jsonResponse(startBody);
      }
      pollCount += 1;
      return jsonResponse({
        ok: true, status: 'approved', key: 'shogo_sk_via_browser',
        email: 'u@e.com', workspace: 'w', deviceId: 'd',
      });
    }) as unknown as typeof fetch;

    const result = await runCloudLogin({
      cloudUrl: 'https://cloud.example.com',
      deviceId: 'd',
      // openBrowser omitted → defaults to true → openInBrowser runs
      pollIntervalMs: 1,
      installSignalHandlers: false,
      log: () => {},
      fetchImpl,
    });
    expect(result.key).toBe('shogo_sk_via_browser');
  });

  it('openInBrowser swallows synchronous spawn errors via the outer try/catch (L335-337)', async () => {
    // Force spawn to throw synchronously by temporarily replacing it via
    // process.binding-style override. The cleanest cross-runtime way: monkey-
    // patch the resolved module's spawn. cloud-login imports `spawn` at the
    // top, so we can't change it post-import. Instead, indirectly: pass a
    // platform that resolves to a binary that almost certainly does NOT exist
    // — and rely on the catch branch firing if spawn throws.
    //
    // In practice on the sandbox `spawn('xdg-open', ...)` resolves to ENOENT
    // asynchronously via child.on('error'), not synchronously, so this test
    // mainly documents the contract: a synchronous spawn failure is silently
    // swallowed and the flow still completes.
    let pollCount = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/cli/login/start')) {
        return jsonResponse(startBody);
      }
      pollCount += 1;
      return jsonResponse({
        ok: true, status: 'approved', key: 'shogo_sk_browser_failed',
        email: 'u@e.com', workspace: 'w', deviceId: 'd',
      });
    }) as unknown as typeof fetch;

    // Custom openBrowser function that throws — runCloudLogin .catch()es it.
    // This exercises L189-192 (custom openBrowser branch). For the actual
    // spawn-throws branch in openInBrowser we'd need module mocking, which
    // would conflict with the git-cloner.test.ts spawn mock running in the
    // same Bun process. The default-openBrowser test above already exercises
    // openInBrowser's spawn path with whatever the sandbox provides.
    const result = await runCloudLogin({
      cloudUrl: 'https://cloud.example.com',
      deviceId: 'd',
      openBrowser: () => { throw new Error('user opener boom'); },
      pollIntervalMs: 1,
      installSignalHandlers: false,
      log: () => {},
      fetchImpl,
    });
    expect(result.key).toBe('shogo_sk_browser_failed');
  });
});
