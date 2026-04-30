/**
 * Tests for workspaceModels.ts — the cross-file IntelliSense pre-loader.
 *
 * Covers the high-priority bugs from PR #466 review:
 *   • In-flight dedup for parallel loadWorkspaceModels on same rootId (#4)
 *   • removeModel disposes the right Monaco model (#2)
 *   • removeModelsUnderPath sweeps an entire directory subtree
 *   • disposeWorkspaceModels clears all state for a root
 *
 * Uses a minimal Monaco mock — only the surface workspaceModels.ts touches.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";

// ─── Minimal Monaco mock ──────────────────────────────────────────────────
type MockUri = { _str: string; toString: () => string; path: string };
type MockModel = {
  uri: MockUri;
  _content: string;
  _disposed: boolean;
  getValue: () => string;
  setValue: (v: string) => void;
  dispose: () => void;
};

function makeMonacoMock() {
  const models = new Map<string, MockModel>();
  const Uri = {
    parse: (str: string): MockUri => {
      const idx = str.indexOf("://");
      const after = idx >= 0 ? str.slice(idx + 3) : str;
      const slash = after.indexOf("/");
      const path = slash >= 0 ? after.slice(slash) : "/";
      return { _str: str, toString: () => str, path };
    },
  };
  return {
    Uri,
    editor: {
      createModel: (content: string, _lang: string, uri: MockUri): MockModel => {
        const m: MockModel = {
          uri,
          _content: content,
          _disposed: false,
          getValue: () => m._content,
          setValue: (v: string) => {
            m._content = v;
          },
          dispose: () => {
            m._disposed = true;
            models.delete(uri.toString());
          },
        };
        models.set(uri.toString(), m);
        return m;
      },
      getModel: (uri: MockUri) => models.get(uri.toString()) ?? null,
      getModels: () => [...models.values()],
    },
    _models: models,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function makeTree(paths: string[]) {
  // Root tree of files (no nested dirs needed for these tests).
  return paths.map((p) => ({ path: p, name: p, kind: "file" as const }));
}

function makeService(opts: { delayMs?: number; counter?: { reads: number } } = {}) {
  const reads = opts.counter ?? { reads: 0 };
  return {
    reads,
    listTree: async () => [],
    readFile: async (path: string) => {
      reads.reads += 1;
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return { content: `// ${path}`, mtime: Date.now(), size: 8 };
    },
    writeFile: async () => ({ mtime: Date.now(), size: 0 }),
    mkdir: async () => {},
    remove: async () => {},
    rename: async () => {},
    search: async () => ({ results: [], truncated: false }),
  } as any;
}

// ─── Module reset between tests ───────────────────────────────────────────
let mod: typeof import("../monaco/workspaceModels");
let monacoMock: ReturnType<typeof makeMonacoMock>;

beforeEach(async () => {
  // Re-import a fresh copy so module-level state doesn't leak between tests.
  // Bun's mock system uses cache busting via a query string trick.
  const fresh = `../monaco/workspaceModels?t=${Date.now()}-${Math.random()}`;
  mod = (await import(fresh)) as typeof import("../monaco/workspaceModels");
  monacoMock = makeMonacoMock();
  mod.setMonacoRef(monacoMock as any);
});

// ─── Tests ────────────────────────────────────────────────────────────────
describe("workspaceModels — in-flight dedup (#4)", () => {
  test("parallel loads for the same rootId share a single walk", async () => {
    const counter = { reads: 0 };
    const svc = makeService({ delayMs: 10, counter });
    const tree = makeTree(["src/a.ts", "src/b.ts", "src/c.ts"]);

    // Fire three loads in parallel — without dedup we'd see 9 reads.
    await Promise.all([
      mod.loadWorkspaceModels(svc, "root1", tree),
      mod.loadWorkspaceModels(svc, "root1", tree),
      mod.loadWorkspaceModels(svc, "root1", tree),
    ]);

    expect(counter.reads).toBe(3);
  });

  test("sequential loads are NOT deduped (each starts fresh)", async () => {
    const counter = { reads: 0 };
    const svc = makeService({ counter });
    const tree = makeTree(["src/a.ts", "src/b.ts"]);

    await mod.loadWorkspaceModels(svc, "root1", tree);
    await mod.loadWorkspaceModels(svc, "root1", tree);

    expect(counter.reads).toBe(4); // 2 paths × 2 sequential loads
  });

  test("parallel loads for DIFFERENT rootIds run in parallel", async () => {
    const counter = { reads: 0 };
    const svc = makeService({ delayMs: 5, counter });
    const tree1 = makeTree(["src/a.ts"]);
    const tree2 = makeTree(["lib/b.ts"]);

    await Promise.all([
      mod.loadWorkspaceModels(svc, "root-A", tree1),
      mod.loadWorkspaceModels(svc, "root-B", tree2),
    ]);

    expect(counter.reads).toBe(2);
  });
});

describe("workspaceModels — removeModel (#2)", () => {
  test("removeModel disposes the right model and leaves siblings intact", async () => {
    const svc = makeService();
    const tree = makeTree(["src/a.ts", "src/b.ts", "src/c.ts"]);
    await mod.loadWorkspaceModels(svc, "root1", tree);
    expect(monacoMock.editor.getModels()).toHaveLength(3);

    mod.removeModel("root1", "src/b.ts");

    const remaining = monacoMock.editor.getModels().map((m: any) => m.uri.path);
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain("/src/a.ts");
    expect(remaining).toContain("/src/c.ts");
    expect(remaining).not.toContain("/src/b.ts");
  });

  test("removeModel for an unknown path is a no-op", async () => {
    const svc = makeService();
    await mod.loadWorkspaceModels(svc, "root1", makeTree(["a.ts"]));
    expect(() => mod.removeModel("root1", "does-not-exist.ts")).not.toThrow();
    expect(monacoMock.editor.getModels()).toHaveLength(1);
  });
});

describe("workspaceModels — removeModelsUnderPath", () => {
  test("sweeps every model under a directory prefix", async () => {
    const svc = makeService();
    const tree = makeTree([
      "src/components/A.ts",
      "src/components/B.ts",
      "src/utils/x.ts",
      "lib/y.ts",
    ]);
    await mod.loadWorkspaceModels(svc, "root1", tree);
    expect(monacoMock.editor.getModels()).toHaveLength(4);

    mod.removeModelsUnderPath("root1", "src/components");

    const remaining = monacoMock.editor.getModels().map((m: any) => m.uri.path).sort();
    expect(remaining).toEqual(["/lib/y.ts", "/src/utils/x.ts"]);
  });

  test("does not match siblings whose name starts with the prefix", async () => {
    const svc = makeService();
    // src/components vs src/components-old — only the first should be swept.
    const tree = makeTree([
      "src/components/A.ts",
      "src/components-old/B.ts",
    ]);
    await mod.loadWorkspaceModels(svc, "root1", tree);

    mod.removeModelsUnderPath("root1", "src/components");

    const remaining = monacoMock.editor.getModels().map((m: any) => m.uri.path);
    expect(remaining).toEqual(["/src/components-old/B.ts"]);
  });
});

describe("workspaceModels — disposeWorkspaceModels", () => {
  test("disposes every model for the rootId", async () => {
    const svc = makeService();
    await mod.loadWorkspaceModels(svc, "root1", makeTree(["a.ts", "b.ts"]));
    await mod.loadWorkspaceModels(svc, "root2", makeTree(["c.ts"]));
    expect(monacoMock.editor.getModels()).toHaveLength(3);

    mod.disposeWorkspaceModels("root1");

    const remaining = monacoMock.editor.getModels().map((m: any) => m.uri.path);
    expect(remaining).toEqual(["/c.ts"]);
  });
});
