// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Preflight checks for `shogo worker start --debug`.
 *
 * Verifies: runtime version, worker directory, proxy (when set), all three
 * allowlist hosts (control/tunnel/artifacts), and API-key validity. The
 * allowlist probes match what `docs/my-machines-networking.md` tells
 * security teams to open, so if preflight passes we know the firewall is
 * correctly configured.
 *
 * The `criticality` field on each host controls the overall pass/fail:
 *   - fatal    → must reach. Preflight fails.
 *   - graceful → should reach, but the worker will start anyway (we only
 *                warn, because tunnel-direct + artifacts are optional per
 *                the failure-modes table).
 */
import pc from 'picocolors';
import { existsSync } from 'node:fs';
import { deriveAllowlist, probeProxy, type ProxyConfig, type AllowlistHost } from './transport.ts';

export interface Check {
  name: string;
  /** 'fatal' ⇒ overall preflight fails; 'graceful' ⇒ prints a warning only. */
  criticality?: 'fatal' | 'graceful';
  run(): Promise<{ ok: boolean; detail?: string }>;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5000;

async function probeHealth(url: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: ctl.signal }).catch(() => null);
    clearTimeout(t);
    if (!r) return { ok: false, detail: 'no response (firewall? DNS?)' };
    return { ok: true, detail: `HTTP ${r.status}` };
  } catch (err: any) {
    return { ok: false, detail: err?.message ?? 'unknown error' };
  }
}

export const makeChecks = (opts: {
  cloudUrl: string;
  apiKey: string;
  workerDir: string;
  proxy?: ProxyConfig | null;
}): Check[] => {
  const checks: Check[] = [
    {
      name: 'Runtime (node >= 20)',
      criticality: 'fatal',
      async run() {
        const [major] = process.versions.node.split('.').map(Number);
        return (major ?? 0) >= 20
          ? { ok: true, detail: `node v${process.versions.node}` }
          : { ok: false, detail: `node v${process.versions.node} — need >=20` };
      },
    },
    {
      name: 'Worker directory exists',
      criticality: 'fatal',
      async run() {
        return existsSync(opts.workerDir)
          ? { ok: true, detail: opts.workerDir }
          : { ok: false, detail: `${opts.workerDir} does not exist` };
      },
    },
  ];

  if (opts.proxy) {
    checks.push({
      name: `Proxy reachable (${safeHost(opts.proxy.url)})`,
      criticality: 'fatal',
      async run() {
        return probeProxy(opts.proxy!);
      },
    });
  }

  const allowlist = deriveAllowlist(opts.cloudUrl);
  for (const entry of allowlist) {
    checks.push({
      name: `Reach ${entry.host}${entry.purpose !== 'control' ? pc.dim(` (${entry.purpose})`) : ''}`,
      criticality: entry.criticality,
      run: () => probeHealth(entry.url, DEFAULT_PROBE_TIMEOUT_MS),
    });
  }

  checks.push({
    name: 'API key valid',
    criticality: 'fatal',
    async run() {
      try {
        const r = await fetch(`${opts.cloudUrl}/api/instances/heartbeat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey },
          body: JSON.stringify({
            hostname: 'preflight',
            name: 'preflight',
            os: 'preflight',
            arch: 'preflight',
            metadata: { preflight: true },
          }),
        });
        if (r.status === 401 || r.status === 403) {
          return { ok: false, detail: `HTTP ${r.status} — key rejected` };
        }
        return r.ok
          ? { ok: true, detail: `HTTP ${r.status}` }
          : { ok: false, detail: `HTTP ${r.status}` };
      } catch (err: any) {
        return { ok: false, detail: err?.message ?? 'unknown error' };
      }
    },
  });

  return checks;
};

function safeHost(raw: string): string {
  try { return new URL(raw).host; } catch { return raw; }
}

export async function runPreflight(checks: Check[]): Promise<boolean> {
  console.log(pc.bold('\nShogo Worker — Preflight\n'));
  let fatalFailed = false;
  let gracefulFailed = 0;
  for (const c of checks) {
    process.stdout.write(`  ${pc.dim('...')} ${c.name}`);
    const result = await c.run();
    process.stdout.write('\r');
    if (result.ok) {
      console.log(
        `  ${pc.green('✓')} ${c.name}${result.detail ? pc.dim(` — ${result.detail}`) : ''}`,
      );
    } else if (c.criticality === 'graceful') {
      console.log(
        `  ${pc.yellow('◦')} ${c.name}${result.detail ? pc.dim(` — ${result.detail}`) : ''}${pc.yellow(' (optional — worker will still start)')}`,
      );
      gracefulFailed++;
    } else {
      console.log(
        `  ${pc.red('✗')} ${c.name}${result.detail ? pc.dim(` — ${result.detail}`) : ''}`,
      );
      fatalFailed = true;
    }
  }
  if (!fatalFailed && gracefulFailed === 0) {
    console.log(pc.green('\nAll checks passed.\n'));
  } else if (!fatalFailed) {
    console.log(pc.yellow(`\nStarting with ${gracefulFailed} optional host(s) blocked. See docs/my-machines-networking.md.\n`));
  } else {
    console.log(pc.red('\nPreflight failed — fix blocking issues before starting.\n'));
  }
  return !fatalFailed;
}
