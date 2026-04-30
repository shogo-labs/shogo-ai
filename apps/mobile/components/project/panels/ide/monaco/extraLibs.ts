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

export function setupExtraLibs(monaco: MonacoNs): void {
  if (loaded) return;
  const ts = monaco.languages.typescript;
  for (const lib of EXTRA_LIBS) {
    if (typeof lib.content !== "string" || lib.content.length === 0) continue;
    ts.typescriptDefaults.addExtraLib(lib.content, lib.path);
    ts.javascriptDefaults.addExtraLib(lib.content, lib.path);
  }
  loaded = true;
}

export function __resetExtraLibsForTest(): void {
  loaded = false;
}
