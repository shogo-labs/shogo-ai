// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "fs";
import { join } from "path";
import { ExplorerIncompleteNotice } from "../ExplorerIncompleteNotice";

describe("ExplorerIncompleteNotice", () => {
  test("says folders are still loading and Refresh re-lists", () => {
    const onRefresh = mock(() => {});
    render(<ExplorerIncompleteNotice onRefresh={onRefresh} />);
    expect(screen.getByRole("status").textContent).toContain("Some folders are still loading");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  // FilesPane is private to Workbench.tsx; pin the wiring it depends on.
  test("the explorer shows it only for a settled, still-truncated root", () => {
    const source = readFileSync(join(import.meta.dir, "..", "Workbench.tsx"), "utf8");
    expect(source).toContain("roots.some((r) => r.incomplete && !r.loading && !r.error)");
    expect(source).toContain("<ExplorerIncompleteNotice onRefresh={onRefresh} />");
    expect(source).toContain("onSettled: (stillTruncated) => setRoot(id, { incomplete: stillTruncated })");
  });
});
