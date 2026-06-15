// @ts-nocheck
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = () => readFileSync("apps/mobile/components/project/panels/ide/Workbench.tsx", "utf8");

describe("Workbench save Git refresh", () => {
  test("requests Git status refresh immediately after saving a file", () => {
    const text = source();

    expect(text).toContain("const gitBridge = getDesktopGitBridge()");
    expect(text).toContain("void gitBridge?.refresh(root)");
  });

  test("refreshes again after conflict auto-stage settles", () => {
    const text = source();

    expect(text).toContain("maybeAutoStageIfConflictResolved(root, f.path, content).finally");
    expect(text).toContain("void gitBridge?.refresh(root)");
  });
});
