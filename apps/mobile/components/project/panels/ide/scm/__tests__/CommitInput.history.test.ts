// @ts-nocheck
/**
 * CommitInput — commit message history tests.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";

const HISTORY_KEY = "shogo.scm.commitHistory";
const MAX_HISTORY = 50;

function loadHistory(storage: Record<string, string>): string[] {
  try { return JSON.parse(storage[HISTORY_KEY] ?? "[]"); } catch { return []; }
}

function saveToHistory(storage: Record<string, string>, message: string) {
  const history = loadHistory(storage).filter((m) => m !== message);
  history.unshift(message);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  storage[HISTORY_KEY] = JSON.stringify(history);
}

describe("commit history — saveToHistory", () => {
  let store: Record<string, string>;
  beforeEach(() => { store = {}; });

  test("saves a new message", () => {
    saveToHistory(store, "fix: typo");
    expect(loadHistory(store)).toEqual(["fix: typo"]);
  });

  test("prepends (most recent first)", () => {
    saveToHistory(store, "first");
    saveToHistory(store, "second");
    expect(loadHistory(store)).toEqual(["second", "first"]);
  });

  test("deduplicates: existing message moves to top", () => {
    saveToHistory(store, "first");
    saveToHistory(store, "second");
    saveToHistory(store, "first");
    expect(loadHistory(store)).toEqual(["first", "second"]);
  });

  test("caps at MAX_HISTORY", () => {
    for (let i = 0; i < 55; i++) saveToHistory(store, `msg-${i}`);
    const h = loadHistory(store);
    expect(h.length).toBe(50);
    expect(h[0]).toBe("msg-54");
    expect(h[49]).toBe("msg-5");
  });

  test("unicode messages", () => {
    saveToHistory(store, "feat: 添加中文支持 🎉");
    expect(loadHistory(store)).toEqual(["feat: 添加中文支持 🎉"]);
  });

  test("special JSON chars", () => {
    saveToHistory(store, 'fix: "quotes" and \\backslash');
    expect(loadHistory(store)).toEqual(['fix: "quotes" and \\backslash']);
  });

  test("same message 100 times → only one copy", () => {
    for (let i = 0; i < 100; i++) saveToHistory(store, "same");
    expect(loadHistory(store)).toEqual(["same"]);
  });
});

describe("commit history — loadHistory", () => {
  test("empty store → empty array", () => expect(loadHistory({})).toEqual([]));
  test("corrupt JSON → empty array", () => expect(loadHistory({ [HISTORY_KEY]: "not-json" })).toEqual([]));
  test("valid JSON → parsed", () => expect(loadHistory({ [HISTORY_KEY]: '["a","b"]' })).toEqual(["a", "b"]));
  test("empty array → empty", () => expect(loadHistory({ [HISTORY_KEY]: "[]" })).toEqual([]));
});

describe("commit split menu contract", () => {
  test("matches the VS Code four-action menu", () => {
    const source = readFileSync("apps/mobile/components/project/panels/ide/scm/CommitInput.tsx", "utf8");
    const labels = [...source.matchAll(/<MenuItem label=\"([^\"]+)\"/g)].map((match) => match[1]);
    expect(labels).toEqual(["Commit", "Commit (Amend)", "Commit & Push", "Commit & Sync"]);
    expect(source).not.toContain('label="Commit All"');
    expect(source).not.toContain('label="Undo Last Commit"');
    expect(source).not.toContain('hint=');
  });

  test("enables primary commit from total committable changes, not staged changes only", () => {
    const source = readFileSync("apps/mobile/components/project/panels/ide/scm/CommitInput.tsx", "utf8");

    expect(source).toContain("committableCount = stagedCount");
    expect(source).toContain("hasMessage && committableCount > 0");
    expect(source).not.toContain("hasMessage && stagedCount > 0");
  });
});
