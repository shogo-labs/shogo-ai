/**
 * Tests for workspaceModels.ts — the on-demand Monaco model registry.
 *
 * Covers the surviving surface after the bulk-preload removal (PR that
 * wired Monaco to the backend typescript-language-server). The pre-load
 * walker, in-flight dedup, and stale-cleanup phases are gone — replaced
 * by per-tab on-demand model creation, so the only behaviors left to
 * test are the upsert/remove primitives that `useLiveAgentEdits` and the
 * IDE file lifecycle handlers depend on.
 *
 * Uses a minimal Monaco mock — only the surface workspaceModels.ts touches.
 */
import { describe, expect, test, beforeEach } from "bun:test";

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

function makeService(opts: { counter?: { reads: number } } = {}) {
  const reads = opts.counter ?? { reads: 0 };
  return {
    reads,
    listTree: async () => [],
    readFile: async (path: string) => {
      reads.reads += 1;
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
describe("workspaceModels — upsertModelFromContent", () => {
  test("creates a model on first call and reuses it on subsequent calls", () => {
    mod.upsertModelFromContent("root1", "src/a.ts", "// version 1");
    expect(monacoMock.editor.getModels()).toHaveLength(1);
    expect(monacoMock.editor.getModels()[0]!.getValue()).toBe("// version 1");

    mod.upsertModelFromContent("root1", "src/a.ts", "// version 2");
    expect(monacoMock.editor.getModels()).toHaveLength(1);
    expect(monacoMock.editor.getModels()[0]!.getValue()).toBe("// version 2");
  });

  test("ignores files Monaco doesn't care about (binary, unknown ext)", () => {
    mod.upsertModelFromContent("root1", "logo.png", "garbage");
    mod.upsertModelFromContent("root1", "notes.md", "# title");
    expect(monacoMock.editor.getModels()).toHaveLength(0);
  });

  test("isolates rootIds — same path under different roots → distinct models", () => {
    mod.upsertModelFromContent("root1", "a.ts", "// in root1");
    mod.upsertModelFromContent("root2", "a.ts", "// in root2");
    expect(monacoMock.editor.getModels()).toHaveLength(2);
  });
});

describe("workspaceModels — upsertModelFromService", () => {
  test("reads the file once and creates a Monaco model from its content", async () => {
    const counter = { reads: 0 };
    const svc = makeService({ counter });
    await mod.upsertModelFromService(svc, "root1", "src/a.ts");
    expect(counter.reads).toBe(1);
    expect(monacoMock.editor.getModels()).toHaveLength(1);
    expect(monacoMock.editor.getModels()[0]!.getValue()).toBe("// src/a.ts");
  });

  test("swallows readFile errors so SSE handler can keep going", async () => {
    const svc = {
      readFile: async () => { throw new Error("boom") },
    } as any;
    await expect(mod.upsertModelFromService(svc, "root1", "src/a.ts")).resolves.toBeUndefined();
    expect(monacoMock.editor.getModels()).toHaveLength(0);
  });

  test("no-op for unsupported extensions — never reads the file", async () => {
    const counter = { reads: 0 };
    const svc = makeService({ counter });
    await mod.upsertModelFromService(svc, "root1", "image.png");
    expect(counter.reads).toBe(0);
    expect(monacoMock.editor.getModels()).toHaveLength(0);
  });
});

describe("workspaceModels — removeModel", () => {
  test("disposes the right model and leaves siblings intact", () => {
    mod.upsertModelFromContent("root1", "src/a.ts", "// a");
    mod.upsertModelFromContent("root1", "src/b.ts", "// b");
    mod.upsertModelFromContent("root1", "src/c.ts", "// c");
    expect(monacoMock.editor.getModels()).toHaveLength(3);

    mod.removeModel("root1", "src/b.ts");

    const remaining = monacoMock.editor.getModels().map((m: any) => m.uri.path);
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain("/src/a.ts");
    expect(remaining).toContain("/src/c.ts");
    expect(remaining).not.toContain("/src/b.ts");
  });

  test("removeModel for an unknown path is a no-op", () => {
    mod.upsertModelFromContent("root1", "a.ts", "// a");
    expect(() => mod.removeModel("root1", "does-not-exist.ts")).not.toThrow();
    expect(monacoMock.editor.getModels()).toHaveLength(1);
  });
});

describe("workspaceModels — removeModelsUnderPath", () => {
  test("sweeps every model under a directory prefix", () => {
    mod.upsertModelFromContent("root1", "src/components/A.ts", "// A");
    mod.upsertModelFromContent("root1", "src/components/B.ts", "// B");
    mod.upsertModelFromContent("root1", "src/utils/x.ts", "// x");
    mod.upsertModelFromContent("root1", "lib/y.ts", "// y");
    expect(monacoMock.editor.getModels()).toHaveLength(4);

    mod.removeModelsUnderPath("root1", "src/components");

    const remaining = monacoMock.editor.getModels().map((m: any) => m.uri.path).sort();
    expect(remaining).toEqual(["/lib/y.ts", "/src/utils/x.ts"]);
  });

  test("does not match siblings whose name starts with the prefix", () => {
    // src/components vs src/components-old — only the first should be swept.
    mod.upsertModelFromContent("root1", "src/components/A.ts", "// A");
    mod.upsertModelFromContent("root1", "src/components-old/B.ts", "// B");

    mod.removeModelsUnderPath("root1", "src/components");

    const remaining = monacoMock.editor.getModels().map((m: any) => m.uri.path);
    expect(remaining).toEqual(["/src/components-old/B.ts"]);
  });
});

describe("workspaceModels — disposeWorkspaceModels", () => {
  test("disposes every model for the rootId", () => {
    mod.upsertModelFromContent("root1", "a.ts", "// a");
    mod.upsertModelFromContent("root1", "b.ts", "// b");
    mod.upsertModelFromContent("root2", "c.ts", "// c");
    expect(monacoMock.editor.getModels()).toHaveLength(3);

    mod.disposeWorkspaceModels("root1");

    const remaining = monacoMock.editor.getModels().map((m: any) => m.uri.path);
    expect(remaining).toEqual(["/c.ts"]);
  });
});
