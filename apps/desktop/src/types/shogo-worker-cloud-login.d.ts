// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Type shim for `@shogo-ai/worker/cloud-login` consumed by the desktop's
 * Electron main process.
 *
 * Why a shim instead of pointing tsconfig `paths` at the worker's source
 * directly: apps/desktop/tsconfig.json sets `rootDir: src`, and TS would
 * otherwise pull the worker .ts file into the desktop's compilation unit
 * (which both violates rootDir and breaks because the worker uses ESM
 * features that the desktop's CJS module setting doesn't allow).
 *
 * This file MUST stay structurally compatible with the public surface
 * exported by `packages/shogo-worker/src/lib/cloud-login.ts`. There is
 * a Bun-built bundle of the worker source inlined into `dist/main.js`
 * by `scripts/bundle-main.mjs`, so the actual runtime implementation
 * still comes from the worker — this file is types-only.
 */
declare module '@shogo-ai/worker/cloud-login' {
  export interface CloudLoginResult {
    key: string;
    email: string | null;
    workspace: string | null;
    deviceId: string;
  }

  export interface CloudLoginOptions {
    cloudUrl: string;
    client?: 'cli' | 'desktop';
    deviceName?: string;
    devicePlatform?: string;
    deviceId: string;
    appVersion?: string;
    workspaceId?: string;
    timeoutMs?: number;
    openBrowser?: boolean | ((url: string) => void | Promise<void>);
    log?: (line: string) => void;
    pollIntervalMs?: number;
    installSignalHandlers?: boolean;
    fetchImpl?: typeof fetch;
    abortSignal?: AbortSignal;
  }

  export class CloudLoginError extends Error {
    constructor(
      message: string,
      kind: 'timeout' | 'denied' | 'cancelled' | 'expired' | 'transport',
    );
    readonly kind: 'timeout' | 'denied' | 'cancelled' | 'expired' | 'transport';
  }

  export function runCloudLogin(opts: CloudLoginOptions): Promise<CloudLoginResult>;
}
