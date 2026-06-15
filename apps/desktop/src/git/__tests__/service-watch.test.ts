import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parsePorcelainV2 } from "../porcelain";
import { buildStatusMaps } from "../service";

const source = () => readFileSync("apps/desktop/src/git/service.ts", "utf8");

describe("GitWorkspace file watching", () => {
  test("watches workspace files and requests debounced status refreshes", () => {
    const text = source();

    expect(text).toContain("import chokidar");
    expect(text).toContain("private watcher: FSWatcher | null = null");
    expect(text).toContain("this.startWatcher()");
    expect(text).toContain("chokidar.watch(this.root");
    expect(text).toContain("this.watcher.on('all', () => this.requestRefresh())");
  });

  test("ignores .git internals and closes watcher when suspended", () => {
    const text = source();

    expect(text).toContain("normalized.endsWith('/.git') || normalized.includes('/.git/')");
    expect(text).toContain("void this.watcher.close()");
    expect(text).toContain("this.watcher = null");
  });

  test("exposes an immediate refresh for post-commit status updates", () => {
    const service = source();
    const ipc = readFileSync("apps/desktop/src/git/ipc.ts", "utf8");

    expect(service).toContain("refreshNow(): Promise<void>");
    expect(ipc).toContain("await getOrCreateGitWorkspace(g.root).refreshNow()");
  });

  test("subscribe returns a fresh snapshot so renderer cannot miss the first status event", () => {
    const ipc = readFileSync("apps/desktop/src/git/ipc.ts", "utf8");
    const preload = readFileSync("apps/desktop/src/preload.ts", "utf8");

    expect(ipc).toContain("await ws.refreshNow()");
    expect(ipc).toContain("snapshot: ws.current()");
    expect(preload).toContain("if (r.snapshot) onSnapshot(r.snapshot)");
  });

  test("keeps unstaged manual edits out of stagedStatus", () => {
    const parsed = parsePorcelainV2("1 .M N... 100644 100644 100644 0 0 vite.config.ts\0");
    const maps = buildStatusMaps(parsed.files);

    expect(maps.fileStatus).toEqual({ "vite.config.ts": "M" });
    expect(maps.stagedStatus).toEqual({});
    expect(maps.conflictPaths).toEqual([]);
  });

  test("puts true index-column changes in stagedStatus", () => {
    const parsed = parsePorcelainV2("1 M. N... 100644 100644 100644 0 0 src/App.tsx\0");
    const maps = buildStatusMaps(parsed.files);

    expect(maps.fileStatus).toEqual({ "src/App.tsx": "M" });
    expect(maps.stagedStatus).toEqual({ "src/App.tsx": "M" });
  });
});
