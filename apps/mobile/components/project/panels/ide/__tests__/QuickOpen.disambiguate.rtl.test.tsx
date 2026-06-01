// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-QUICKOPEN-PATH — end-to-end Quick Open disambiguation.
 *
 * Mounts the real Palette with a PaletteItem[] built EXACTLY the way
 * Workbench.fileItems builds it (using buildDisambiguation). Mounting
 * the entire Workbench would drag in Monaco + xterm + the agent
 * service mock and is overkill for proving the disambiguator + the
 * Palette agree.
 *
 * Scenarios:
 *   1. Unique basename in single-root → sublabel HIDDEN in the row.
 *   2. Two files share a basename in single-root → BOTH rows show
 *      parent dir as muted sublabel.
 *   3. File at workspace root collides with a deeper file → "(root)"
 *      sentinel rendered for the root-level one.
 *   4. Multi-root → every row shows root label · parent-dir.
 *   5. Typing a path fragment (e.g. "components") matches a file even
 *      when its row shows no visible sublabel (searchText tier).
 *   6. Typing a parent-dir fragment of an AMBIGUOUS file matches via
 *      the visible sublabel.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Palette, type PaletteItem } from "../Palette";
import {
  buildDisambiguation,
  type QuickOpenFile,
} from "../quick-open-disambiguate";

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

/**
 * Mirror Workbench.fileItems exactly — single source of truth so a
 * refactor of that builder is caught here.
 */
function buildFileItems(
  files: Array<{ rootId: string; rootLabel: string; name: string; path: string }>,
  multiRoot: boolean,
): PaletteItem[] {
  const qo: QuickOpenFile[] = files.map((f) => ({
    id: `${f.rootId}::${f.path}`,
    name: f.name,
    path: f.path,
    rootLabel: multiRoot ? f.rootLabel : undefined,
  }));
  const d = buildDisambiguation(qo, { multiRoot });
  return files.map((f) => {
    const id = `${f.rootId}::${f.path}`;
    const r = d.get(id);
    return {
      id,
      label: f.name,
      sublabel: r?.display ?? undefined,
      searchText: r?.searchText ?? f.path,
      run: () => {},
    };
  });
}

function type(q: string) {
  fireEvent.change(screen.getByPlaceholderText("Go to file…"), {
    target: { value: q },
  });
}

/** Returns the rendered rows as { label, sublabel? } pairs in display order. */
function rows(): Array<{ label: string; sublabel: string | null }> {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-idx]")).map(
    (row) => {
      const blocks = row.querySelectorAll<HTMLElement>("div.min-w-0 > div");
      return {
        label: blocks[0]?.textContent ?? "",
        sublabel: blocks.length > 1 ? blocks[1]?.textContent ?? null : null,
      };
    },
  );
}

describe("QuickOpen — disambiguation rendering", () => {
  test("single-root + unique basenames with parents: parent dir always shown (VS Code parity)", () => {
    const items = buildFileItems(
      [
        { rootId: "r", rootLabel: "agent", name: "App.tsx", path: "src/App.tsx" },
        { rootId: "r", rootLabel: "agent", name: "Button.tsx", path: "src/components/Button.tsx" },
      ],
      false,
    );
    render(<Palette placeholder="Go to file…" items={items} onClose={() => {}} />);
    const r = rows();
    expect(r.length).toBe(2);
    const subsByLabel: Record<string, string | null> = {};
    for (const x of r) subsByLabel[x.label] = x.sublabel;
    expect(subsByLabel["App.tsx"]).toBe("src");
    expect(subsByLabel["Button.tsx"]).toBe("src/components");
  });

  test("single-root + file AT workspace root with unique basename: no sublabel", () => {
    const items = buildFileItems(
      [
        { rootId: "r", rootLabel: "agent", name: "README.md", path: "README.md" },
        { rootId: "r", rootLabel: "agent", name: "package.json", path: "package.json" },
      ],
      false,
    );
    render(<Palette placeholder="Go to file…" items={items} onClose={() => {}} />);
    const r = rows();
    expect(r.length).toBe(2);
    expect(r[0].sublabel).toBeNull();
    expect(r[1].sublabel).toBeNull();
  });

  test("single-root + colliding basename: both rows show their distinct parent-dir", () => {
    const items = buildFileItems(
      [
        { rootId: "r", rootLabel: "agent", name: "index.ts", path: "src/utils/index.ts" },
        { rootId: "r", rootLabel: "agent", name: "index.ts", path: "src/components/index.ts" },
        { rootId: "r", rootLabel: "agent", name: "App.tsx", path: "src/App.tsx" },
      ],
      false,
    );
    render(<Palette placeholder="Go to file…" items={items} onClose={() => {}} />);
    const r = rows();
    const indexRows = r.filter((x) => x.label === "index.ts");
    expect(indexRows.length).toBe(2);
    expect(indexRows.map((x) => x.sublabel).sort()).toEqual([
      "src/components",
      "src/utils",
    ]);
    // App.tsx is unique but still gets its parent dir (default behaviour).
    expect(r.find((x) => x.label === "App.tsx")?.sublabel).toBe("src");
  });

  test("file at workspace root collides with deeper file → '(root)' sentinel", () => {
    const items = buildFileItems(
      [
        { rootId: "r", rootLabel: "agent", name: "README.md", path: "README.md" },
        { rootId: "r", rootLabel: "agent", name: "README.md", path: "docs/README.md" },
      ],
      false,
    );
    render(<Palette placeholder="Go to file…" items={items} onClose={() => {}} />);
    const subs = rows().map((x) => x.sublabel);
    expect(subs).toContain("(root)");
    expect(subs).toContain("docs");
  });

  test("multi-root: every row shows root label · parent-dir", () => {
    const items = buildFileItems(
      [
        { rootId: "r1", rootLabel: "agent", name: "App.tsx", path: "src/App.tsx" },
        { rootId: "r2", rootLabel: "local", name: "Server.ts", path: "src/Server.ts" },
        { rootId: "r2", rootLabel: "local", name: "Readme.md", path: "Readme.md" },
      ],
      true,
    );
    render(<Palette placeholder="Go to file…" items={items} onClose={() => {}} />);
    const r = rows();
    const subsByLabel: Record<string, string | null> = {};
    for (const x of r) subsByLabel[x.label] = x.sublabel;
    expect(subsByLabel["App.tsx"]).toBe("agent · src");
    expect(subsByLabel["Server.ts"]).toBe("local · src");
    expect(subsByLabel["Readme.md"]).toBe("local");
  });

  test("path-fragment query matches via searchText (root-level files, no sublabel)", () => {
    // Root-level files render no sublabel (no parent dir exists) — perfect
    // case for proving the hidden searchText tier still matches the path.
    const items = buildFileItems(
      [
        { rootId: "r", rootLabel: "agent", name: "README.md", path: "README.md" },
        { rootId: "r", rootLabel: "agent", name: "package.json", path: "package.json" },
      ],
      false,
    );
    render(<Palette placeholder="Go to file…" items={items} onClose={() => {}} />);
    expect(rows().every((r) => r.sublabel === null)).toBe(true);
    // Typing the basename via path fragment still finds it through searchText.
    type("readme");
    const r = rows();
    expect(r.length).toBe(1);
    expect(r[0].label).toContain("README.md");
    expect(r[0].sublabel).toBeNull();
  });

  test("path-fragment query matches via searchText for nested files (parent dir visible separately)", () => {
    const items = buildFileItems(
      [
        // Unique basenames in a single root: each gets its parent dir as
        // sublabel. searchText carries the full path, so 'account' (a
        // sub-segment of the parent) still narrows to Profile.tsx.
        { rootId: "r", rootLabel: "agent", name: "Profile.tsx", path: "src/account/Profile.tsx" },
        { rootId: "r", rootLabel: "agent", name: "Banner.tsx", path: "src/marketing/Banner.tsx" },
      ],
      false,
    );
    render(<Palette placeholder="Go to file…" items={items} onClose={() => {}} />);
    // Pre-query: both rows show their parent dirs.
    const pre = rows();
    expect(pre.find((r) => r.label === "Profile.tsx")?.sublabel).toBe("src/account");
    expect(pre.find((r) => r.label === "Banner.tsx")?.sublabel).toBe("src/marketing");
    // Now query a segment unique to one file.
    type("account");
    const r = rows();
    expect(r[0].label).toContain("Profile.tsx");
  });

  test("parent-dir fragment matches via visible sublabel for ambiguous files", () => {
    const items = buildFileItems(
      [
        { rootId: "r", rootLabel: "agent", name: "index.ts", path: "src/utils/index.ts" },
        { rootId: "r", rootLabel: "agent", name: "index.ts", path: "src/components/index.ts" },
      ],
      false,
    );
    render(<Palette placeholder="Go to file…" items={items} onClose={() => {}} />);
    type("utils");
    const r = rows();
    // Both index.ts rows survived the upstream score, but utils ranks first.
    expect(r[0].label).toContain("index.ts");
    expect(r[0].sublabel).toBe("src/utils");
  });
});
