// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Corporate-proxy support + allowlist host derivation for the Shogo Worker.
 *
 * Reads HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy from the
 * environment and returns a normalized proxy URL (or null if not set).
 *
 * The CLI does NOT install a global undici dispatcher on the CLI process
 * itself — the CLI only spawns the worker subprocess. Instead we forward
 * the env to the child; the child's Node runtime picks it up automatically
 * (undici >= 5.29 honours HTTPS_PROXY via getGlobalDispatcher).
 *
 * We also offer a reachability probe so `--debug` preflight can verify the
 * proxy before spinning anything up. The probe uses a real CONNECT request
 * to the target host on :443, which is exactly what the worker's TLS
 * traffic needs — a plain GET to the proxy root can pass even when the
 * proxy is misconfigured for CONNECT.
 */
import { request as httpRequest } from "node:http";

export interface ProxyConfig {
  /** Normalized proxy URL (scheme://host:port). */
  url: string;
  /** Which env var (or flag) it came from — for debug output. */
  source:
    | "flag"
    | "HTTPS_PROXY"
    | "https_proxy"
    | "HTTP_PROXY"
    | "http_proxy";
}

/**
 * Resolve the effective proxy from a --proxy override + env.
 * Precedence: flag > HTTPS_PROXY > https_proxy > HTTP_PROXY > http_proxy.
 */
export function resolveProxy(flag?: string, env: NodeJS.ProcessEnv = process.env): ProxyConfig | null {
  const trimmed = (s: string | undefined) => (s && s.trim().length > 0 ? s.trim() : undefined);
  const viaFlag = trimmed(flag);
  if (viaFlag) return { url: normalize(viaFlag), source: "flag" };

  const candidates: [ProxyConfig["source"], string | undefined][] = [
    ["HTTPS_PROXY", env.HTTPS_PROXY],
    ["https_proxy", env.https_proxy],
    ["HTTP_PROXY", env.HTTP_PROXY],
    ["http_proxy", env.http_proxy],
  ];
  for (const [source, value] of candidates) {
    const v = trimmed(value);
    if (v) return { url: normalize(v), source };
  }
  return null;
}

/** Normalize bare host:port into scheme-prefixed URL. */
function normalize(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  return `http://${raw}`;
}

/**
 * Inject the proxy into a child process env so the spawned worker uses it.
 * Sets both upper- and lower-case variants for maximum compatibility.
 */
export function applyProxyToEnv(env: NodeJS.ProcessEnv, proxy: ProxyConfig | null): NodeJS.ProcessEnv {
  if (!proxy) return env;
  return {
    ...env,
    HTTPS_PROXY: env.HTTPS_PROXY ?? proxy.url,
    https_proxy: env.https_proxy ?? proxy.url,
    HTTP_PROXY: env.HTTP_PROXY ?? proxy.url,
    http_proxy: env.http_proxy ?? proxy.url,
  };
}

/**
 * Probe the proxy by issuing an HTTP CONNECT to `targetHost:443`.
 * This mirrors what the worker's TLS traffic will actually do, so it catches
 * proxies that answer :80 but reject CONNECT tunneling.
 *
 * Accepts 200/407 as "proxy is answering":
 *  - 200 → tunnel established.
 *  - 407 → proxy requires authentication (still proves reachability; surfaces
 *          an actionable error on stdout).
 * Network errors fail the probe.
 */
export async function probeProxy(
  proxy: ProxyConfig,
  targetHost = "api.shogo.ai",
  timeoutMs = 5000,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: { ok: boolean; detail: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const u = new URL(proxy.url);
      const proxyHost = u.hostname;
      const proxyPort = u.port ? parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 80;

      const req = httpRequest({
        method: "CONNECT",
        host: proxyHost,
        port: proxyPort,
        path: `${targetHost}:443`,
        timeout: timeoutMs,
      });

      req.on("connect", (res) => {
        req.destroy();
        const status = res.statusCode ?? 0;
        if (status === 200) {
          settle({ ok: true, detail: `CONNECT ${targetHost}:443 → 200 (via ${proxyHost}:${proxyPort})` });
        } else if (status === 407) {
          settle({
            ok: false,
            detail: `407 Proxy Authentication Required — check credentials in ${proxy.source}`,
          });
        } else {
          settle({ ok: false, detail: `CONNECT → HTTP ${status}` });
        }
      });

      req.on("timeout", () => {
        req.destroy();
        settle({ ok: false, detail: `timeout after ${timeoutMs}ms` });
      });

      req.on("error", (err: NodeJS.ErrnoException) => {
        const code = err.code ? ` (${err.code})` : "";
        settle({ ok: false, detail: `${err.message}${code}` });
      });

      req.end();
    } catch (err: any) {
      settle({ ok: false, detail: err?.message ?? "unknown error" });
    }
  });
}

/**
 * Derive the full outbound allowlist (3 hosts) from a single cloudUrl.
 *
 * Shogo Worker talks to three hosts, as documented in
 * `docs/my-machines-networking.md`:
 *
 *   1. <cloud>                 — session control plane (FATAL if blocked)
 *   2. <cloud>-direct (or api-direct.<rootDomain>) — WS tunnel fallback
 *   3. artifacts.<rootDomain>  — artifact uploads (graceful if blocked)
 *
 * The rule for #2/#3 is: take the rootDomain of the cloud URL and prefix it.
 * This supports region-pinned deploys (EU, US) without hardcoding.
 */
export interface AllowlistHost {
  url: string;
  host: string;
  purpose: "control" | "tunnel-direct" | "artifacts";
  criticality: "fatal" | "graceful";
}

export function deriveAllowlist(cloudUrl: string): AllowlistHost[] {
  let u: URL;
  try {
    u = new URL(cloudUrl);
  } catch {
    return [];
  }

  const host = u.host; // e.g. "studio.shogo.ai"
  const scheme = u.protocol.replace(":", "") || "https";

  // rootDomain = last two dotted labels — "shogo.ai" from "studio.shogo.ai".
  // If the host is already 2 labels (e.g. "shogo.ai"), keep it as-is.
  const parts = u.hostname.split(".");
  const rootDomain = parts.length >= 2 ? parts.slice(-2).join(".") : u.hostname;

  return [
    {
      url: `${scheme}://${host}`,
      host,
      purpose: "control",
      criticality: "fatal",
    },
    {
      url: `${scheme}://api-direct.${rootDomain}`,
      host: `api-direct.${rootDomain}`,
      purpose: "tunnel-direct",
      criticality: "graceful",
    },
    {
      url: `${scheme}://artifacts.${rootDomain}`,
      host: `artifacts.${rootDomain}`,
      purpose: "artifacts",
      criticality: "graceful",
    },
  ];
}
