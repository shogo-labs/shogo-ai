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
type Service = Pick<WorkspaceService, "readFile">;

let monacoRef: MonacoT | null = null;
const modelsByRoot: Map<string, Set<string>> = new Map();

/** Loads requested before the editor mounted. Replayed once monacoRef is set. */
const pendingLoads: Map<string, { svc: WorkspaceService; tree: WsNode[] }> = new Map();

/**
 * In-flight loads keyed by rootId. If a second loadWorkspaceModels arrives
 * for a rootId whose load is still walking, we return the existing promise
 * instead of starting a parallel walk. Prevents the race where two walks'
 * stale-model cleanup phases dispose each other's freshly-upserted models.
 */
const inFlightLoads: Map<string, Promise<void>> = new Map();

const MAX_MODELS_PER_ROOT = 1000;
const SUPPORTED_EXTS = /\.(tsx?|jsx?|d\.ts|json)$/;

/**
 * Initial-walk concurrency. Kept low enough that even a 1000-file project
 * stays well below the API server's 600 req/min global rate limit during
 * the cold-start preload (otherwise we'd flood agent-proxy and trip 429s).
 */
const BATCH = 6;

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
    // Latest tree wins — by design (tree may have changed during mount).
    pendingLoads.set(rootId, { svc, tree });
    return;
  }
  // Coalesce rapid re-loads for the same rootId so the stale-model cleanup
  // phases of two parallel walks can't race each other.
  const existing = inFlightLoads.get(rootId);
  if (existing) return existing;
  const run = doLoad(m, svc, rootId, tree);
  inFlightLoads.set(rootId, run);
  try {
    await run;
  } finally {
    inFlightLoads.delete(rootId);
  }
}

async function doLoad(
  m: MonacoT,
  svc: WorkspaceService,
  rootId: string,
  tree: WsNode[],
): Promise<void> {
  let paths = flattenFiles(tree);
  paths.sort();
  if (paths.length > MAX_MODELS_PER_ROOT) {
    console.warn(
      `[shogo] workspace '${rootId}' has ${paths.length} TS/JS files; loading first ${MAX_MODELS_PER_ROOT} for IntelliSense.`,
    );
    paths = paths.slice(0, MAX_MODELS_PER_ROOT);
  }

  // Skip files we've already loaded into Monaco — their content is kept in
  // sync incrementally via `upsertModelFromContent` from the SSE
  // `file.changed` handler. Re-reading every TS/JS file on every tree
  // refresh would burst hundreds of `readFile`s through agent-proxy and
  // trip the API server's global rate limit.
  const tracked = modelsByRoot.get(rootId);
  const newPaths = tracked
    ? paths.filter((p) => !tracked.has(uriFor(m, rootId, p).toString()))
    : paths;

  const seen = new Set<string>();
  for (const p of paths) {
    if (tracked?.has(uriFor(m, rootId, p).toString())) {
      seen.add(uriFor(m, rootId, p).toString());
    }
  }
  for (let i = 0; i < newPaths.length; i += BATCH) {
    const slice = newPaths.slice(i, i + BATCH);
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
  const trackedAfter = modelsByRoot.get(rootId);
  if (trackedAfter) {
    for (const uriStr of [...trackedAfter]) {
      if (!seen.has(uriStr)) {
        const model = m.editor.getModel(m.Uri.parse(uriStr));
        if (model) model.dispose();
        trackedAfter.delete(uriStr);
      }
    }
  }
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
  pendingLoads.delete(rootId);
  inFlightLoads.delete(rootId);
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
