/**
 * Registers `.d.ts` declaration files with Monaco's TypeScript service so
 * imports like `import { useState } from "react"` resolve to real types and
 * autocomplete works for symbols defined in `node_modules`.
 *
 * The actual `.d.ts` content lives in `extraLibs.generated.ts`, which is
 * produced by `apps/mobile/scripts/bundle-monaco-types.mjs`. The generated
 * file is committed so production builds need no network access.
 *
 * Idempotent: subsequent `setupExtraLibs(monaco)` calls are no-ops thanks
 * to the module-scoped `loaded` flag. Safe to call from every editor mount.
 */
import type { OnMount } from "@monaco-editor/react";
import { EXTRA_LIBS } from "./extraLibs.generated";

type MonacoNs = Parameters<OnMount>[1];

let loaded = false;

export function setupExtraLibs(monaco: MonacoNs, opts: { defer?: boolean } = {}): void {
  if (loaded) return;
  loaded = true;
  const ts = monaco.languages.typescript;
  const add = (lib: { path: string; content: string }) => {
    if (typeof lib.content !== "string" || lib.content.length === 0) return;
    ts.typescriptDefaults.addExtraLib(lib.content, lib.path);
    ts.javascriptDefaults.addExtraLib(lib.content, lib.path);
  };
  if (!opts.defer) {
    for (const lib of EXTRA_LIBS) add(lib);
    return;
  }
  // ~1 MB of .d.ts gets structured-cloned to the TS worker; doing it in one go
  // stalls the first keystrokes after the editor mounts. Register one lib per
  // idle slot instead so the first paint and first input stay responsive.
  const schedule: (cb: () => void) => void =
    typeof requestIdleCallback === "function"
      ? (cb) => requestIdleCallback(() => cb(), { timeout: 1500 })
      : (cb) => setTimeout(cb, 16);
  let i = 0;
  const step = () => {
    if (i >= EXTRA_LIBS.length) return;
    add(EXTRA_LIBS[i++]);
    schedule(step);
  };
  schedule(step);
}

export function __resetExtraLibsForTest(): void {
  loaded = false;
}
