/**
 * Bundles common library type declarations as Monaco extraLibs so imports
 * like `import { useState } from "react"` resolve against real types instead
 * of being suppressed. Only loaded once per Monaco instance.
 *
 * We use Vite's `?raw` import suffix to inline the .d.ts files at build time
 * — no runtime fetch needed.
 */
import type { OnMount } from "@monaco-editor/react";

import reactDts from "../../../../node_modules/@types/react/index.d.ts?raw";
import reactJsxDts from "../../../../node_modules/@types/react/jsx-runtime.d.ts?raw";
import reactDomDts from "../../../../node_modules/@types/react-dom/index.d.ts?raw";
import reactDomClientDts from "../../../../node_modules/@types/react-dom/client.d.ts?raw";

type MonacoNs = Parameters<OnMount>[1];

const LIBS: { name: string; content: string; path: string }[] = [
  { name: "react", content: reactDts, path: "file:///node_modules/@types/react/index.d.ts" },
  { name: "react/jsx-runtime", content: reactJsxDts, path: "file:///node_modules/@types/react/jsx-runtime.d.ts" },
  { name: "react-dom", content: reactDomDts, path: "file:///node_modules/@types/react-dom/index.d.ts" },
  { name: "react-dom/client", content: reactDomClientDts, path: "file:///node_modules/@types/react-dom/client.d.ts" },
];

let loaded = false;

export function loadExtraLibs(monaco: MonacoNs): void {
  if (loaded) return;
  const ts = monaco.languages.typescript;
  for (const lib of LIBS) {
    if (typeof lib.content !== "string" || lib.content.length === 0) continue;
    ts.typescriptDefaults.addExtraLib(lib.content, lib.path);
    ts.javascriptDefaults.addExtraLib(lib.content, lib.path);
  }
  loaded = true;
}
