// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-QUICKOPEN-PATH — pin the disambiguator behaviour.
 *
 * Pure-function tests. No React, no DOM, no localStorage. The RTL
 * integration suite (Palette.quickopen.rtl.test.tsx) proves Workbench
 * wires this correctly; this file proves the rules themselves.
 */
import { describe, expect, test } from "bun:test";
import {
  buildDisambiguation,
  normalizePath,
  parentDirOf,
  ROOT_PLACEHOLDER,
  type QuickOpenFile,
} from "../quick-open-disambiguate";

function file(
  id: string,
  name: string,
  path: string,
  rootLabel?: string,
): QuickOpenFile {
  return { id, name, path, rootLabel };
}

// ─────────────────────────────────────────────────────────────────────
// normalizePath
// ─────────────────────────────────────────────────────────────────────

describe("normalizePath", () => {
  test("collapses backslashes to forward slashes", () => {
    expect(normalizePath("src\\components\\App.tsx")).toBe("src/components/App.tsx");
  });

  test("strips trailing slashes", () => {
    expect(normalizePath("src/components/")).toBe("src/components");
    expect(normalizePath("src/components///")).toBe("src/components");
  });

  test("collapses repeated slashes mid-path", () => {
    expect(normalizePath("src//components///App.tsx")).toBe("src/components/App.tsx");
  });

  test("preserves leading slash", () => {
    expect(normalizePath("/abs/path/file.ts")).toBe("/abs/path/file.ts");
  });

  test("empty input → empty string (no throw)", () => {
    expect(normalizePath("")).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────
// parentDirOf
// ─────────────────────────────────────────────────────────────────────

describe("parentDirOf", () => {
  test("typical nested file", () => {
    expect(parentDirOf("src/components/App.tsx")).toBe("src/components");
  });

  test("file at root → empty string", () => {
    expect(parentDirOf("App.tsx")).toBe("");
  });

  test("Windows-style separators normalized", () => {
    expect(parentDirOf("src\\components\\App.tsx")).toBe("src/components");
  });

  test("trailing slash on path doesn't break extraction", () => {
    expect(parentDirOf("src/components/App.tsx/")).toBe("src/components");
  });

  test("leading slash preserved in output", () => {
    expect(parentDirOf("/abs/path/file.ts")).toBe("/abs/path");
  });

  test("empty path → empty parent", () => {
    expect(parentDirOf("")).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────
// buildDisambiguation — single-root mode
// ─────────────────────────────────────────────────────────────────────

describe("buildDisambiguation — single-root", () => {
  test("empty input → empty Map", () => {
    const out = buildDisambiguation([]);
    expect(out.size).toBe(0);
  });

  test("unique basename with parent → display = parent dir (VS Code parity)", () => {
    const out = buildDisambiguation([
      file("a", "App.tsx", "src/App.tsx"),
      file("b", "Button.tsx", "src/components/Button.tsx"),
    ]);
    expect(out.get("a")?.display).toBe("src");
    expect(out.get("b")?.display).toBe("src/components");
  });

  test("unique basename AT workspace root → display null (filename is the path)", () => {
    const out = buildDisambiguation([
      file("a", "README.md", "README.md"),
      file("b", "package.json", "package.json"),
    ]);
    expect(out.get("a")?.display).toBeNull();
    expect(out.get("b")?.display).toBeNull();
  });

  test("colliding basename → both rows get parent-dir display", () => {
    const out = buildDisambiguation([
      file("a", "index.ts", "src/utils/index.ts"),
      file("b", "index.ts", "src/components/index.ts"),
    ]);
    expect(out.get("a")?.display).toBe("src/utils");
    expect(out.get("b")?.display).toBe("src/components");
  });

  test("three colliders → all three get their distinct parent dir", () => {
    const out = buildDisambiguation([
      file("a", "index.ts", "src/utils/index.ts"),
      file("b", "index.ts", "src/components/index.ts"),
      file("c", "index.ts", "test/index.ts"),
    ]);
    expect(out.get("a")?.display).toBe("src/utils");
    expect(out.get("b")?.display).toBe("src/components");
    expect(out.get("c")?.display).toBe("test");
  });

  test("collider at the workspace root → ROOT_PLACEHOLDER sentinel", () => {
    const out = buildDisambiguation([
      file("a", "README.md", "README.md"),
      file("b", "README.md", "docs/README.md"),
    ]);
    expect(out.get("a")?.display).toBe(ROOT_PLACEHOLDER);
    expect(out.get("b")?.display).toBe("docs");
  });

  test("Windows-style colliders normalize parents", () => {
    const out = buildDisambiguation([
      file("a", "App.tsx", "src\\foo\\App.tsx"),
      file("b", "App.tsx", "src\\bar\\App.tsx"),
    ]);
    expect(out.get("a")?.display).toBe("src/foo");
    expect(out.get("b")?.display).toBe("src/bar");
  });

  test("case-sensitive collision check: Foo.tsx vs foo.tsx are NOT collisions", () => {
    // Both still get their parent dir as sublabel (every row does), but
    // the ROOT_PLACEHOLDER fallback must NOT fire — they're considered
    // distinct basenames.
    const out = buildDisambiguation([
      file("a", "Foo.tsx", "Foo.tsx"),
      file("b", "foo.tsx", "foo.tsx"),
    ]);
    expect(out.get("a")?.display).toBeNull();
    expect(out.get("b")?.display).toBeNull();
  });

  test("unicode basenames pass through unchanged", () => {
    const out = buildDisambiguation([
      file("a", "café.tsx", "src/café.tsx"),
      file("b", "café.tsx", "lib/café.tsx"),
    ]);
    expect(out.get("a")?.display).toBe("src");
    expect(out.get("b")?.display).toBe("lib");
  });

  test("searchText is always populated with normalized full path", () => {
    const out = buildDisambiguation([
      file("a", "App.tsx", "src\\components\\App.tsx"),
    ]);
    expect(out.get("a")?.searchText).toBe("src/components/App.tsx");
  });

  test("searchText is full normalized path AND display is parent dir (both populated)", () => {
    const out = buildDisambiguation([
      file("a", "OnlyOne.tsx", "deep/path/OnlyOne.tsx"),
    ]);
    expect(out.get("a")?.display).toBe("deep/path");
    expect(out.get("a")?.searchText).toBe("deep/path/OnlyOne.tsx");
  });

  test("searchText for root-level file equals the basename (no parent prefix)", () => {
    const out = buildDisambiguation([file("a", "README.md", "README.md")]);
    expect(out.get("a")?.display).toBeNull();
    expect(out.get("a")?.searchText).toBe("README.md");
  });
});

// ─────────────────────────────────────────────────────────────────────
// buildDisambiguation — multi-root mode
// ─────────────────────────────────────────────────────────────────────

describe("buildDisambiguation — multi-root", () => {
  test("multi-root with unique basenames: every row still gets context", () => {
    const out = buildDisambiguation(
      [
        file("a", "App.tsx", "src/App.tsx", "agent"),
        file("b", "Server.ts", "src/Server.ts", "local"),
      ],
      { multiRoot: true },
    );
    expect(out.get("a")?.display).toBe("agent · src");
    expect(out.get("b")?.display).toBe("local · src");
  });

  test("multi-root + colliding basenames: rootLabel + parent dir for each", () => {
    const out = buildDisambiguation(
      [
        file("a", "index.ts", "src/index.ts", "agent"),
        file("b", "index.ts", "lib/index.ts", "local"),
      ],
      { multiRoot: true },
    );
    expect(out.get("a")?.display).toBe("agent · src");
    expect(out.get("b")?.display).toBe("local · lib");
  });

  test("multi-root with file at root of its own tree: rootLabel only", () => {
    const out = buildDisambiguation(
      [
        file("a", "README.md", "README.md", "agent"),
      ],
      { multiRoot: true },
    );
    expect(out.get("a")?.display).toBe("agent");
  });

  test("multi-root: searchText is rootLabel-prefixed", () => {
    const out = buildDisambiguation(
      [
        file("a", "App.tsx", "src/App.tsx", "agent"),
      ],
      { multiRoot: true },
    );
    expect(out.get("a")?.searchText).toBe("agent/src/App.tsx");
  });

  test("multi-root: missing rootLabel falls back gracefully (no ugly separator)", () => {
    // Shouldn't happen in practice — Workbench always populates rootLabel
    // when multiRoot is set — but the disambiguator must not crash AND
    // must not emit " · src" (leading separator with empty label).
    const out = buildDisambiguation(
      [{ id: "a", name: "App.tsx", path: "src/App.tsx" }],
      { multiRoot: true },
    );
    expect(out.get("a")?.searchText).toBe("src/App.tsx");
    // Falls through to parent-dir alone — useful context without the
    // dangling " · " separator.
    expect(out.get("a")?.display).toBe("src");
  });

  test("multi-root: missing rootLabel AND no parent (root-level file) → null display", () => {
    const out = buildDisambiguation(
      [{ id: "a", name: "App.tsx", path: "App.tsx" }],
      { multiRoot: true },
    );
    expect(out.get("a")?.display).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// buildDisambiguation — defensive / invariants
// ─────────────────────────────────────────────────────────────────────

describe("buildDisambiguation — defensive", () => {
  test("duplicate ids: last write wins (caller's responsibility to dedupe)", () => {
    const out = buildDisambiguation([
      file("a", "App.tsx", "src/App.tsx"),
      file("a", "App.tsx", "lib/App.tsx"),
    ]);
    // Map keyed by id → 1 entry only. But the basename count saw 2,
    // so the surviving entry IS treated as ambiguous (uses the LAST
    // entry's parent dir for display).
    expect(out.size).toBe(1);
    expect(out.get("a")?.display).toBe("lib");
  });

  test("preserves input order via Map insertion order", () => {
    const out = buildDisambiguation([
      file("z", "z.ts", "z.ts"),
      file("a", "a.ts", "a.ts"),
      file("m", "m.ts", "m.ts"),
    ]);
    expect(Array.from(out.keys())).toEqual(["z", "a", "m"]);
  });

  test("very large input doesn't degrade catastrophically", () => {
    const files: QuickOpenFile[] = [];
    for (let i = 0; i < 1000; i++) {
      files.push(file(`id${i}`, `name${i}.ts`, `dir${i % 50}/name${i}.ts`));
    }
    const t0 = Date.now();
    const out = buildDisambiguation(files);
    const elapsed = Date.now() - t0;
    expect(out.size).toBe(1000);
    expect(elapsed).toBeLessThan(200); // generous; typical run is < 5ms
  });

  test("all-files-at-root with colliding name → all get ROOT_PLACEHOLDER", () => {
    // Synthetic but pinned: if multiple files literally exist at the
    // root with the same name (different roots? impossible — same root?
    // FS would reject). Pinned so the algorithm never crashes here.
    const out = buildDisambiguation([
      file("a", "x.ts", "x.ts"),
      file("b", "x.ts", "x.ts"),
    ]);
    expect(out.get("a")?.display).toBe(ROOT_PLACEHOLDER);
    expect(out.get("b")?.display).toBe(ROOT_PLACEHOLDER);
  });
});
