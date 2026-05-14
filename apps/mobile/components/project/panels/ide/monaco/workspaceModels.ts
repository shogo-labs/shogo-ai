// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-root Monaco model registry — used by the IDE's file lifecycle handlers
 * (live agent edits, in-place file delete/rename) to keep the editor in sync
 * with disk without re-reading the whole project.
 *
 * History note: this module used to also pre-load every TS/JS file in the
 * workspace as Monaco models so the in-browser TypeScript Web Worker could
 * resolve cross-file imports. That preload was the root cause of the
 * "agent-fetch downloads everything on IDE open" bug. Cross-file IntelliSense
 * is now served by the backend typescript-language-server via
 * `monaco/lspProviders.ts`, which reads files off disk natively, so the
 * preload is gone and only the on-demand model upserts remain — no walker,
 * no batched readFile burst, no MAX_MODELS_PER_ROOT cap.
 */
import type * as Monaco from "monaco-editor";
import type { WorkspaceService } from "../workspace/types";

type MonacoT = typeof Monaco;
type Service = Pick<WorkspaceService, "readFile">;

let monacoRef: MonacoT | null = null;
const modelsByRoot: Map<string, Set<string>> = new Map();

const SUPPORTED_EXTS = /\.(tsx?|jsx?|d\.ts|json)$/;

export function setMonacoRef(m: MonacoT) {
  monacoRef = m;
}

export function getMonacoRef(): MonacoT | null {
  return monacoRef;
}

function uriFor(m: MonacoT, rootId: string, path: string): Monaco.Uri {
  const norm = "/" + path.replace(/^\/+/, "");
  return m.Uri.parse(`inmemory://${encodeURIComponent(rootId)}${norm}`);
}

function languageForPath(path: string): string {
  if (path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".ts")) return "typescript";
  if (path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".js")) return "javascript";
  if (path.endsWith(".json")) return "json";
  return "plaintext";
}

/**
 * Refresh a single Monaco model with already-fetched content. No-op for
 * files Monaco doesn't care about (non-TS/JS/JSON). The hot path for live
 * agent edits — the SSE handler in `useLiveAgentEdits` already reads the
 * file once for the open-editor buffer, so we plumb that same content
 * through here instead of re-fetching.
 */
export function upsertModelFromContent(
  rootId: string,
  path: string,
  content: string,
): void {
  if (!SUPPORTED_EXTS.test(path)) return;
  upsertModel(rootId, path, content);
}

/**
 * Refresh a single Monaco model by reading the file from the workspace
 * service. Used when content isn't already in hand. Caller decides whether
 * to await; failures are swallowed so transient read errors don't bubble
 * into the SSE handler.
 */
export async function upsertModelFromService(
  svc: Service,
  rootId: string,
  path: string,
): Promise<void> {
  if (!SUPPORTED_EXTS.test(path)) return;
  try {
    const f = await svc.readFile(path);
    upsertModel(rootId, path, f.content);
  } catch {
    // Best-effort — next file.changed event or tree refresh will retry.
  }
}

/** Create or refresh a single model. */
export function upsertModel(
  rootId: string,
  path: string,
  content: string,
  language?: string,
): void {
  const m = monacoRef;
  if (!m) return;
  if (!SUPPORTED_EXTS.test(path)) return;

  const uri = uriFor(m, rootId, path);
  const existing = m.editor.getModel(uri);
  if (existing) {
    if (existing.getValue() !== content) existing.setValue(content);
    return;
  }
  m.editor.createModel(content, language ?? languageForPath(path), uri);
  let set = modelsByRoot.get(rootId);
  if (!set) {
    set = new Set();
    modelsByRoot.set(rootId, set);
  }
  set.add(uri.toString());
}

/** Remove a single model (file deleted). */
export function removeModel(rootId: string, path: string): void {
  const m = monacoRef;
  if (!m) return;
  const uri = uriFor(m, rootId, path);
  const model = m.editor.getModel(uri);
  if (model) model.dispose();
  modelsByRoot.get(rootId)?.delete(uri.toString());
}

/**
 * Disposes every model under a path prefix in a root. Used when a directory
 * is renamed/moved/deleted — every nested file's model needs to go too.
 */
export function removeModelsUnderPath(rootId: string, prefix: string): void {
  const m = monacoRef;
  if (!m) return;
  const set = modelsByRoot.get(rootId);
  if (!set) return;
  const norm = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
  const head = `inmemory://${encodeURIComponent(rootId)}/${norm}/`;
  const exact = `inmemory://${encodeURIComponent(rootId)}/${norm}`;
  for (const uriStr of [...set]) {
    if (uriStr === exact || uriStr.startsWith(head)) {
      const model = m.editor.getModel(m.Uri.parse(uriStr));
      if (model) model.dispose();
      set.delete(uriStr);
    }
  }
}

/** Dispose every model for a root (called on closeRoot). */
export function disposeWorkspaceModels(rootId: string): void {
  const m = monacoRef;
  if (!m) return;
  const set = modelsByRoot.get(rootId);
  if (!set) return;
  for (const uriStr of set) {
    const model = m.editor.getModel(m.Uri.parse(uriStr));
    if (model) model.dispose();
  }
  modelsByRoot.delete(rootId);
}
