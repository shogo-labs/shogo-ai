// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CLI cloud-login — pure poll-based device flow.
 *
 * Unlike the desktop sign-in (which receives the minted key via a
 * `shogo://auth-callback` deep link), the CLI cannot register protocol
 * handlers and does not run an inbound HTTP listener. Instead it asks
 * the cloud to mint a one-time pending-state, opens the bridge page in
 * the user's browser, then polls the cloud until the bridge page
 * approves the request — at which point the cloud returns the minted
 * device-tagged API key exactly once and discards the state.
 *
 * Sequence:
 *   1. CLI → POST /api/cli/login/start (with device metadata)
 *      cloud stores pending state, replies { state, userCode, authUrl,
 *      expiresInMs, pollIntervalMs }.
 *   2. CLI prints the URL + userCode and opens it in the browser.
 *   3. User signs in at <cloudUrl>/auth/cli-link?state=... and clicks
 *      "Approve". The bridge page POSTs /api/cli/login/approve which
 *      mints the key on the cloud and pins it to `state`.
 *   4. CLI polls GET /api/cli/login/poll?state=... at pollIntervalMs:
 *        pending  → keep polling
 *        approved → returns { key, email, workspace, deviceId } once,
 *                   then the state is deleted.
 *        denied   → user clicked "Cancel" on the bridge page.
 *        expired  → 5-minute TTL elapsed.
 *
 * Notes:
 *   - The userCode (last 6 hex of state, uppercased) is shown in both
 *     the CLI and the browser so the user can confirm the device they
 *     are approving matches the terminal they typed `shogo login` in.
 *   - No localhost listener — works behind firewalls / over SSH / from
 *     a remote tmux session.
 */
import { spawn } from 'node:child_process';
import { hostname, platform as osPlatform, arch } from 'node:os';
import pc from 'picocolors';

export interface CloudLoginResult {
  /** The minted shogo_sk_ key. */
  key: string;
  /** User email reported by cloud. */
  email: string | null;
  /** Workspace name the key was minted for. */
  workspace: string | null;
  /** Stable device id we sent up; cloud echoes it back. */
  deviceId: string;
}

export interface CloudLoginOptions {
  cloudUrl: string;
  /** Override the device label shown in the dashboard. Defaults to hostname. */
  deviceName?: string;
  /** Stable id for this machine. Caller should persist this so re-logins
   * dedupe to the same device row. */
  deviceId: string;
  /** App version label sent to cloud. */
  appVersion?: string;
  /** Optional pre-select for the bridge picker. */
  workspaceId?: string;
  /** Cap on total wait — defaults to whatever the cloud says (usually 5min). */
  timeoutMs?: number;
  /** If false, do not auto-open the browser. */
  openBrowser?: boolean;
  /** Custom logger — defaults to console.log. */
  log?: (line: string) => void;
  /** Override poll interval in ms. Defaults to whatever the cloud returns. */
  pollIntervalMs?: number;
  /** Test seam: replace the real fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam: an AbortSignal to stop polling early. */
  abortSignal?: AbortSignal;
}

export class CloudLoginError extends Error {
  constructor(
    message: string,
    public readonly kind: 'timeout' | 'denied' | 'cancelled' | 'expired' | 'transport',
  ) {
    super(message);
    this.name = 'CloudLoginError';
  }
}

interface StartResponse {
  ok: boolean;
  error?: string;
  state: string;
  userCode: string;
  authUrl: string;
  expiresInMs: number;
  pollIntervalMs: number;
}

interface PollResponse {
  ok: boolean;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  key?: string;
  email?: string | null;
  workspace?: string | null;
  deviceId?: string;
  error?: string;
}

export async function runCloudLogin(opts: CloudLoginOptions): Promise<CloudLoginResult> {
  const cloudUrl = opts.cloudUrl.replace(/\/$/, '');
  const deviceName = opts.deviceName ?? hostname();
  const devicePlatform = `${osPlatform()}-${arch()}`;
  const appVersion = opts.appVersion ?? readWorkerVersion();
  const log = opts.log ?? ((line: string) => console.log(line));
  const fetchImpl = opts.fetchImpl ?? fetch;

  // 1. Start
  const startRes = await fetchImpl(`${cloudUrl}/api/cli/login/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: opts.deviceId,
      deviceName,
      devicePlatform,
      deviceAppVersion: appVersion,
      workspaceId: opts.workspaceId,
      client: 'cli',
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch((err) => {
    throw new CloudLoginError(
      `Cannot reach Shogo Cloud at ${cloudUrl}: ${err?.message ?? err}`,
      'transport',
    );
  });
  if (!startRes.ok) {
    const text = await startRes.text().catch(() => '');
    throw new CloudLoginError(
      `Cloud rejected /api/cli/login/start (HTTP ${startRes.status}): ${text || 'no body'}`,
      'transport',
    );
  }
  const start = (await startRes.json().catch(() => ({} as any))) as StartResponse;
  if (!start?.ok || !start.state || !start.authUrl) {
    throw new CloudLoginError(
      `Cloud returned a malformed start response: ${start?.error ?? JSON.stringify(start)}`,
      'transport',
    );
  }

  const pollIntervalMs = clampPollInterval(opts.pollIntervalMs ?? start.pollIntervalMs);
  const timeoutMs = opts.timeoutMs ?? start.expiresInMs;
  const deadline = Date.now() + timeoutMs;

  // 2. Print + open browser
  log('');
  log(pc.bold('Sign in to Shogo Cloud'));
  log(pc.dim('  cloud:     ') + cloudUrl);
  log(pc.dim('  device:    ') + `${deviceName} (${devicePlatform})`);
  log(pc.dim('  user code: ') + pc.cyan(start.userCode));
  log('');
  log('  Open this URL in your browser to approve:');
  log('  ' + pc.cyan(start.authUrl));
  log('');

  if (opts.openBrowser !== false) {
    openInBrowser(start.authUrl).catch(() => { /* user can copy/paste */ });
  }

  log(pc.dim('Waiting for approval...'));

  // 3. Poll loop
  const onAbort = () => {
    throw new CloudLoginError('Interrupted.', 'cancelled');
  };
  const sigHandler = () => onAbort();
  process.once('SIGINT', sigHandler);
  process.once('SIGTERM', sigHandler);

  try {
    while (true) {
      if (opts.abortSignal?.aborted) {
        throw new CloudLoginError('Aborted by caller.', 'cancelled');
      }
      if (Date.now() >= deadline) {
        throw new CloudLoginError(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for approval.`,
          'timeout',
        );
      }

      const pollRes = await fetchImpl(
        `${cloudUrl}/api/cli/login/poll?state=${encodeURIComponent(start.state)}`,
        {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        },
      ).catch((err) => {
        // Soft network errors during polling shouldn't kill the flow —
        // user might have a flaky connection. Log and back off.
        log(pc.dim(`  (poll error: ${err?.message ?? err} — retrying)`));
        return null;
      });

      if (pollRes && pollRes.ok) {
        const data = (await pollRes.json().catch(() => ({} as any))) as PollResponse;
        if (data?.status === 'approved' && data.key) {
          return {
            key: data.key,
            email: data.email ?? null,
            workspace: data.workspace ?? null,
            deviceId: data.deviceId ?? opts.deviceId,
          };
        }
        if (data?.status === 'denied') {
          throw new CloudLoginError('Sign-in was denied in the browser.', 'denied');
        }
        if (data?.status === 'expired') {
          throw new CloudLoginError('Sign-in request expired before it was approved.', 'expired');
        }
        // status === 'pending' (or unknown) → keep polling
      }

      await sleep(pollIntervalMs, opts.abortSignal);
    }
  } finally {
    process.removeListener('SIGINT', sigHandler);
    process.removeListener('SIGTERM', sigHandler);
  }
}

function clampPollInterval(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 2000;
  return Math.min(Math.max(ms, 1000), 10_000);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CloudLoginError('Aborted by caller.', 'cancelled'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new CloudLoginError('Aborted by caller.', 'cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function readWorkerVersion(): string {
  try {
    const url = new URL('../../package.json', import.meta.url);
    const pkg = JSON.parse(require('node:fs').readFileSync(url, 'utf-8'));
    return pkg?.version ? `shogo-cli/${pkg.version}` : 'shogo-cli/unknown';
  } catch {
    return 'shogo-cli/unknown';
  }
}

function openInBrowser(url: string): Promise<void> {
  return new Promise((resolve) => {
    const cmd =
      process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'cmd'
      : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', () => resolve());
      child.unref();
      resolve();
    } catch {
      resolve();
    }
  });
}
