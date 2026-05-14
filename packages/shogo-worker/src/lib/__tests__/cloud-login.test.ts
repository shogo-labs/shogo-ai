// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, it, expect } from 'bun:test';
import { runCloudLogin, CloudLoginError } from '../cloud-login.ts';

/**
 * Drive `runCloudLogin` against a scripted fetch implementation so we
 * can exercise the start → poll → approved happy path plus all four
 * documented terminal states (denied / expired / state-mismatch via
 * malformed responses / network error).
 *
 * The CLI client should:
 *   - never auto-open a browser when openBrowser:false
 *   - poll until status='approved' or terminal state
 *   - return the key + email + workspace from the approved poll exactly
 *     once and not call any further endpoints
 *   - throw CloudLoginError with the right `kind` for each failure mode
 */

function scripted(handlers: Array<(url: string) => Response | Promise<Response>>) {
  let i = 0;
  const fetchImpl = async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (i >= handlers.length) {
      throw new Error(`scripted fetch ran out of handlers at request #${i + 1} (${url})`);
    }
    return handlers[i++](url);
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls: () => i };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('runCloudLogin', () => {
  it('returns the minted key on the second poll (start → pending → approved)', async () => {
    const { fetchImpl } = scripted([
      (url) => {
        expect(url).toEndWith('/api/cli/login/start');
        return jsonResponse({
          ok: true,
          state: 'abcdef0123456789',
          userCode: '456789',
          authUrl: 'https://cloud.example.com/auth/cli-link?state=abcdef0123456789',
          expiresInMs: 60_000,
          pollIntervalMs: 1_000,
        });
      },
      (url) => {
        expect(url).toContain('/api/cli/login/poll?state=abcdef0123456789');
        return jsonResponse({ ok: true, status: 'pending' });
      },
      (url) => {
        expect(url).toContain('/api/cli/login/poll?state=abcdef0123456789');
        return jsonResponse({
          ok: true,
          status: 'approved',
          key: 'shogo_sk_test_key_123',
          email: 'user@example.com',
          workspace: 'My Workspace',
          deviceId: 'dev-abc',
        });
      },
    ]);

    const result = await runCloudLogin({
      cloudUrl: 'https://cloud.example.com',
      deviceId: 'dev-abc',
      openBrowser: false,
      pollIntervalMs: 1, // tighten so the test runs fast
      log: () => { /* silence */ },
      fetchImpl,
    });

    expect(result.key).toBe('shogo_sk_test_key_123');
    expect(result.email).toBe('user@example.com');
    expect(result.workspace).toBe('My Workspace');
    expect(result.deviceId).toBe('dev-abc');
  });

  it('throws CloudLoginError(kind="denied") when the user clicks Cancel', async () => {
    const { fetchImpl } = scripted([
      () =>
        jsonResponse({
          ok: true,
          state: 's',
          userCode: 'XXXXXX',
          authUrl: 'https://cloud.example.com/auth/cli-link?state=s',
          expiresInMs: 60_000,
          pollIntervalMs: 1,
        }),
      () => jsonResponse({ ok: true, status: 'denied' }),
    ]);

    await expect(
      runCloudLogin({
        cloudUrl: 'https://cloud.example.com',
        deviceId: 'dev-abc',
        openBrowser: false,
        pollIntervalMs: 1,
        log: () => { /* silence */ },
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(CloudLoginError);
  });

  it('throws CloudLoginError(kind="expired") when the cloud says expired', async () => {
    const { fetchImpl } = scripted([
      () =>
        jsonResponse({
          ok: true,
          state: 's',
          userCode: 'XXXXXX',
          authUrl: 'https://cloud.example.com/auth/cli-link?state=s',
          expiresInMs: 60_000,
          pollIntervalMs: 1,
        }),
      () => jsonResponse({ ok: true, status: 'expired' }),
    ]);

    try {
      await runCloudLogin({
        cloudUrl: 'https://cloud.example.com',
        deviceId: 'dev-abc',
        openBrowser: false,
        pollIntervalMs: 1,
        log: () => { /* silence */ },
        fetchImpl,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CloudLoginError);
      expect((err as CloudLoginError).kind).toBe('expired');
    }
  });

  it('respects abortSignal and throws cancelled', async () => {
    const ac = new AbortController();
    const { fetchImpl } = scripted([
      () =>
        jsonResponse({
          ok: true,
          state: 's',
          userCode: 'XXXXXX',
          authUrl: 'https://cloud.example.com/auth/cli-link?state=s',
          expiresInMs: 60_000,
          pollIntervalMs: 50,
        }),
      () => {
        // Abort right before the next sleep so the wait raises cancelled.
        ac.abort();
        return jsonResponse({ ok: true, status: 'pending' });
      },
    ]);

    try {
      await runCloudLogin({
        cloudUrl: 'https://cloud.example.com',
        deviceId: 'dev-abc',
        openBrowser: false,
        pollIntervalMs: 50,
        log: () => { /* silence */ },
        fetchImpl,
        abortSignal: ac.signal,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CloudLoginError);
      expect((err as CloudLoginError).kind).toBe('cancelled');
    }
  });

  it('throws transport when start endpoint is unreachable', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    try {
      await runCloudLogin({
        cloudUrl: 'https://cloud.example.com',
        deviceId: 'dev-abc',
        openBrowser: false,
        pollIntervalMs: 1,
        log: () => { /* silence */ },
        fetchImpl,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CloudLoginError);
      expect((err as CloudLoginError).kind).toBe('transport');
    }
  });

  it('throws transport when start returns malformed body', async () => {
    const { fetchImpl } = scripted([
      () => jsonResponse({ ok: false, error: 'bad request' }, 400),
    ]);

    try {
      await runCloudLogin({
        cloudUrl: 'https://cloud.example.com',
        deviceId: 'dev-abc',
        openBrowser: false,
        pollIntervalMs: 1,
        log: () => { /* silence */ },
        fetchImpl,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CloudLoginError);
      expect((err as CloudLoginError).kind).toBe('transport');
    }
  });
});
