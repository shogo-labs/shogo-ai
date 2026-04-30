/**
 * Pre-loads workspace files as Monaco models so the TS language service can
 * resolve cross-file imports, go-to-definition, and rename refactors across
 * the project — not just inside currently-open editor tabs.
 *
 * Models are keyed by URI `inmemory://${rootId}/${path}` to keep roots
 * isolated. Closing a root disposes its models. Loads requested before the
 * editor mounts are queued and replayed once setMonacoRef is called.
 *
 * Adapted from apps/ide-prototype/.../monaco/workspaceModels.ts. Mobile's
 * WorkspaceService matches the prototype's contract (listTree/readFile),
 * so the logic is unchanged — only paths and import sites differ.
 */
import type * as Monaco from "monaco-editor";
import type { WorkspaceService, WsNode } from "../workspace/types";

type MonacoT = typeof Monaco;

let monacoRef: MonacoT | null = null;
const modelsByRoot: Map<string, Set<string>> = new Map();

/** Loads requested before the editor mounted. Replayed once monacoRef is set. */
const pendingLoads: Map<string, { svc: WorkspaceService; tree: WsNode[] }> = new Map();

const MAX_MODELS_PER_ROOT = 1000;
const SUPPORTED_EXTS = /\.(tsx?|jsx?|d\.ts|json)$/;

export function setMonacoRef(m: MonacoT) {
  const wasNull = monacoRef === null;
  monacoRef = m;
  if (wasNull && pendingLoads.size > 0) {
    const entries = [...pendingLoads.entries()];
    pendingLoads.clear();
    for (const [rootId, { svc, tree }] of entries) {
      void loadWorkspaceModels(svc, rootId, tree).catch(() => {});
    }
  }
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

function flattenFiles(nodes: WsNode[]): string[] {
  const out: string[] = [];
  const stack: WsNode[] = [...nodes];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.kind === "file") {
      if (SUPPORTED_EXTS.test(n.path)) out.push(n.path);
    } else if (n.children) {
      for (const c of n.children) stack.push(c);
    }
  }
  return out;
}

/**
 * Walks the tree and ensures every TS/JS file has a Monaco model with up-to-
 * date content. Capped at MAX_MODELS_PER_ROOT to keep memory bounded on huge
 * projects — files beyond the cap will still get models on first open via
 * the editor's `path` prop (Monaco creates one automatically).
 */
export async function loadWorkspaceModels(
  svc: WorkspaceService,
  rootId: string,
  tree: WsNode[],
): Promise<void> {
  const m = monacoRef;
  if (!m) {
    pendingLoads.set(rootId, { svc, tree });
    return;
  }

  let paths = flattenFiles(tree);
  paths.sort();
  if (paths.length > MAX_MODELS_PER_ROOT) {
    console.warn(
      `[shogo] workspace '${rootId}' has ${paths.length} TS/JS files; loading first ${MAX_MODELS_PER_ROOT} for IntelliSense.`,
    );
    paths = paths.slice(0, MAX_MODELS_PER_ROOT);
  }

  const seen = new Set<string>();
  const BATCH = 16;
  for (let i = 0; i < paths.length; i += BATCH) {
    const slice = paths.slice(i, i + BATCH);
    await Promise.all(
      slice.map(async (p) => {
        try {
          const f = await svc.readFile(p);
          upsertModel(rootId, p, f.content, languageForPath(p));
          seen.add(uriFor(m, rootId, p).toString());
        } catch {
          // Ignore individual read failures (permission, deleted, etc.).
        }
      }),
    );
  }

  // Dispose any stale models for this root that no longer exist on disk.
  const tracked = modelsByRoot.get(rootId);
  if (tracked) {
    for (const uriStr of [...tracked]) {
      if (!seen.has(uriStr)) {
        const model = m.editor.getModel(m.Uri.parse(uriStr));
        if (model) model.dispose();
        tracked.delete(uriStr);
      }
    }
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

/** Dispose every model for a root (called on closeRoot). */
export function disposeWorkspaceModels(rootId: string): void {
  pendingLoads.delete(rootId);
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
