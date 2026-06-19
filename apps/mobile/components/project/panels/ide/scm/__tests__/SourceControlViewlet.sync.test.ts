// @ts-nocheck
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = () => readFileSync("apps/mobile/components/project/panels/ide/scm/SourceControlViewlet.tsx", "utf8");

describe("SourceControlViewlet sync changes UX", () => {
  test("renders a VS Code-style Sync Changes button from ahead/behind counts", () => {
    const text = source();

    expect(text).toContain("function SyncChangesButton");
    expect(text).toContain("Sync Changes {countLabel}");
    expect(text).toContain("snapshot.ahead > 0 || snapshot.behind > 0");
    expect(text).toContain("syncCountLabel(behind, ahead)");
  });

  test("confirms pull and push before syncing and supports don't-show-again", () => {
    const text = source();

    expect(text).toContain("function SyncConfirmationModal");
    expect(text).toContain("This action will pull and push commits from and to");
    expect(text).toContain("OK, Don&apos;t Show Again");
    expect(text).toContain("shogo.scm.syncConfirmationDismissed");
  });

  test("sync uses the existing remote sync action and refreshes status/history", () => {
    const text = source();

    expect(text).toContain("const res = await actions.syncRemote()");
    expect(text).toContain("await actions.refresh()");
    expect(text).toContain("await loadHistory()");
  });

  test("primary commit commits all visible changes and refreshes ahead count", () => {
    const text = source();

    expect(text).toContain("committableCount={totalUnstagedPlusStaged}");
    expect(text).toContain("const r = await actions.commitAll(message, opts)");
    expect(text).toContain("await actions.refresh()");
    expect(text).toContain("await loadHistory()");
  });

  test("auto-fetch keeps incoming and outgoing counts fresh without auto-pushing", () => {
    const text = source();

    expect(text).toContain("REMOTE_AUTO_FETCH_INTERVAL_MS");
    expect(text).toContain("const res = await actions.fetchRemote()");
    expect(text).not.toContain("setInterval(() => { void performSync(); }");
  });
});
