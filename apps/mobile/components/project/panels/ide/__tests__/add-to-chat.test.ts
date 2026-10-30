// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, describe, expect, test } from "bun:test";
import {
  ADD_TO_CHAT_ACTION_ID,
  addToChatResultMessage,
  buildSelectionReferences,
  NO_FILE_ERROR,
  NON_AGENT_FILE_ERROR,
  registerAddToChatAction,
  resolveAddToChat,
  unsavedChangesMessage,
  type SelectionLike,
} from "../add-to-chat";
import { _resetChatInsertBusForTests, subscribeChatInsert, type ChatInsertRequest } from "../../../../../lib/chat-insert-bus";
import { MAX_SELECTION_CHARS } from "../../../../../lib/chat-references";

const LINES = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);

/** Fake Monaco model over LINES (1-based lines and columns). */
const model = (lines = LINES) => ({
  getValueInRange(r: SelectionLike) {
    if (r.startLineNumber === r.endLineNumber) return lines[r.startLineNumber - 1].slice(r.startColumn - 1, r.endColumn - 1);
    const out = [lines[r.startLineNumber - 1].slice(r.startColumn - 1)];
    for (let l = r.startLineNumber + 1; l < r.endLineNumber; l++) out.push(lines[l - 1]);
    out.push(lines[r.endLineNumber - 1].slice(0, r.endColumn - 1));
    return out.join("\n");
  },
});

const sel = (sl: number, sc: number, el: number, ec: number): SelectionLike => ({
  startLineNumber: sl,
  startColumn: sc,
  endLineNumber: el,
  endColumn: ec,
  isEmpty: () => sl === el && sc === ec,
});

const agentFile = { path: "src/big.ts", name: "big.ts", rootId: "agent", languageId: "typescript" };
const localFile = { path: "notes.md", name: "notes.md", rootId: "local:repo:1" };
const editor = (selections: SelectionLike[], m = model()) => ({ getModel: () => m, getSelections: () => selections });

afterEach(() => _resetChatInsertBusForTests());

describe("buildSelectionReferences", () => {
  test("a single selection becomes one 1-based inclusive range with its text", () => {
    expect(buildSelectionReferences(model(), [sel(120, 1, 140, 9)], agentFile)).toEqual([
      {
        type: "selection",
        path: "src/big.ts",
        name: "big.ts",
        startLine: 120,
        endLine: 140,
        text: model().getValueInRange(sel(120, 1, 140, 9)),
        languageId: "typescript",
        rootId: "agent",
      },
    ]);
  });

  test("multi-cursor: one reference per selection, sorted, identical ranges deduped", () => {
    const refs = buildSelectionReferences(
      model(),
      [sel(50, 1, 52, 4), sel(10, 1, 12, 3), sel(50, 2, 52, 6)],
      agentFile,
    );
    expect(refs.map((r) => (r.type === "selection" ? `${r.startLine}-${r.endLine}` : ""))).toEqual(["10-12", "50-52"]);
  });

  test("a selection ending at column 1 of the next line excludes that line", () => {
    const [ref] = buildSelectionReferences(model(), [sel(5, 1, 8, 1)], agentFile);
    expect(ref).toMatchObject({ startLine: 5, endLine: 7 });
  });

  test("empty and whitespace-only selections are skipped", () => {
    const blank = model(["   ", "\t", "code"]);
    expect(buildSelectionReferences(blank, [sel(1, 1, 1, 1), sel(1, 1, 2, 2)], agentFile)).toEqual([]);
  });

  test("over-long text is clamped and flagged", () => {
    const huge = model(["x".repeat(MAX_SELECTION_CHARS + 100)]);
    const [ref] = buildSelectionReferences(huge, [sel(1, 1, 1, MAX_SELECTION_CHARS + 101)], agentFile);
    expect(ref).toMatchObject({ truncated: true });
    expect(ref.type === "selection" && ref.text.length).toBe(MAX_SELECTION_CHARS);
  });
});

describe("resolveAddToChat", () => {
  test("with a selection -> selection references (any root)", () => {
    const r = resolveAddToChat(editor([sel(1, 1, 2, 3)]), localFile);
    expect("error" in r).toBe(false);
    expect(r).toMatchObject({ kind: "selection", references: [{ type: "selection", rootId: "local:repo:1" }] });
  });

  test("no selection in the agent workspace -> the file", () => {
    expect(resolveAddToChat(editor([sel(3, 2, 3, 2)]), agentFile)).toEqual({
      kind: "file",
      references: [{ type: "file", path: "src/big.ts", name: "big.ts" }],
    });
  });

  test("no selection outside the agent workspace -> error", () => {
    expect(resolveAddToChat(editor([]), localFile)).toEqual({ error: NON_AGENT_FILE_ERROR });
  });

  test("no file -> error", () => {
    expect(resolveAddToChat(editor([]), null)).toEqual({ error: NO_FILE_ERROR });
  });
});

describe("messages", () => {
  test("toast text", () => {
    expect(addToChatResultMessage({ kind: "file", references: [{ type: "file", path: "a.ts", name: "a.ts" }] })).toBe("Added a.ts to chat");
    const two = buildSelectionReferences(model(), [sel(1, 1, 2, 2), sel(5, 1, 6, 2)], agentFile);
    expect(addToChatResultMessage({ kind: "selection", references: two })).toBe("Added 2 selections to chat");
    expect(addToChatResultMessage({ kind: "selection", references: two.slice(0, 1) })).toBe("Added 1 selection to chat");
    expect(addToChatResultMessage({ error: "nope" })).toBe("nope");
    expect(unsavedChangesMessage(["a.ts"])).toBe(
      "a.ts has unsaved changes — the agent reads the saved file. Save (⌘S) to include them.",
    );
    expect(unsavedChangesMessage(["a.ts", "b.ts"])).toContain("a.ts, b.ts have unsaved changes");
  });
});

describe("registerAddToChatAction", () => {
  const monaco = { KeyMod: { CtrlCmd: 2048 }, KeyCode: { KeyL: 42 } };

  function fakeEditor(selections: SelectionLike[]) {
    const actions: any[] = [];
    return {
      actions,
      getModel: () => model(),
      getSelections: () => selections,
      addAction(descriptor: any) {
        actions.push(descriptor);
        return { dispose() {} };
      },
    };
  }

  test("registers ⌘L / Ctrl+L and a first-in-navigation context-menu entry", () => {
    const ed = fakeEditor([]);
    registerAddToChatAction(ed, monaco, { fileOf: () => agentFile });
    expect(ed.actions).toHaveLength(1);
    expect(ed.actions[0]).toMatchObject({
      id: ADD_TO_CHAT_ACTION_ID,
      label: "Add to Chat",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 0,
      keybindings: [2048 | 42],
    });
  });

  test("running it sends the references to the chat bus and reports the result", () => {
    const seen: ChatInsertRequest[] = [];
    subscribeChatInsert((r) => seen.push(r));
    const ed = fakeEditor([sel(120, 1, 140, 3)]);
    const results: unknown[] = [];
    registerAddToChatAction(ed, monaco, { fileOf: () => agentFile, onResult: (r) => results.push(r) });
    ed.actions[0].run(ed);
    expect(seen).toHaveLength(1);
    expect(seen[0].source).toBe("ide-editor");
    expect(seen[0].references?.[0]).toMatchObject({ type: "selection", startLine: 120, endLine: 140 });
    expect(results[0]).toMatchObject({ kind: "selection" });
  });

  test("an error sends nothing", () => {
    const seen: ChatInsertRequest[] = [];
    subscribeChatInsert((r) => seen.push(r));
    const ed = fakeEditor([]);
    const results: unknown[] = [];
    registerAddToChatAction(ed, monaco, { fileOf: () => localFile, onResult: (r) => results.push(r) });
    ed.actions[0].run(ed);
    expect(seen).toEqual([]);
    expect(results).toEqual([{ error: NON_AGENT_FILE_ERROR }]);
  });
});
