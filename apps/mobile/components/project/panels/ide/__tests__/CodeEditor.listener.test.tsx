/**
 * CodeEditor — Monaco content-listener BUG-001 guarantees.
 *
 * The bug routed Monaco's onChange through React state via group.activeId,
 * which was racy. The fix:
 *   1. install our own `onDidChangeModelContent` listener (not the
 *      `<Editor onChange>` prop), and skip events with `ev.isFlush=true`
 *      (which is precisely the programmatic `model.setValue()` that
 *      `@monaco-editor/react` issues during a path/value swap);
 *   2. guard against `model.isDisposed()` for both content and cursor
 *      events so the tear-down race on tab close is safe;
 *   3. tag every emitted change with the fileId read live from a render-time
 *      ref mirror of `pathKey` — never a stale closure capture.
 *
 * This file unit-tests all three guarantees by mocking @monaco-editor/react
 * to a thin shell that drives our `handleMount` with a fake editor we
 * control directly. We don't load real Monaco — that would be slow and
 * couldn't deterministically drive the race.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import * as React from "react";

type ContentListener = (ev: { isFlush: boolean }) => void;
type CursorListener = (e: { position: { lineNumber: number; column: number } }) => void;

let lastMountedProps: any = null;
afterEach(cleanup);

// ─── Minimal @monaco-editor/react mock ────────────────────────────────────
mock.module("@monaco-editor/react", () => ({
  default: (props: any) => {
    // Capture props so a re-render scenario can re-invoke handleMount with the
    // newest closures (mirrors what React + monaco-editor/react would do).
    lastMountedProps = props;
    return null;
  },
  loader: {
    config: () => {},
    init: () => Promise.resolve({}),
  },
}));

// ─── Stub the side-effect modules CodeEditor pulls in at module-eval time ─
mock.module("../monaco/workspaceModels", () => ({ setMonacoRef: () => {} }));
mock.module("../monaco/extraLibs", () => ({ setupExtraLibs: () => {} }));
mock.module("../agentFixProvider", () => ({ setupAgentFix: () => {} }));
mock.module("../terminal/pty-factory", () => ({ isDesktopRuntime: () => false }));
mock.module("../monaco/themes", () => ({
  registerDesktopThemes: () => {},
  loadCustomThemes: () => {},
  BUILTIN_DESKTOP_THEMES: [],
}));

// ─── Fake editor + monaco namespace ────────────────────────────────────────
function makeFakeMonacoStack() {
  let contentListener: ContentListener | null = null;
  let cursorListener: CursorListener | null = null;
  let modelDisposed = false;
  let modelValue = "initial";

  const model = {
    getValue: () => modelValue,
    isDisposed: () => modelDisposed,
    uri: { toString: () => "inmemory://A" },
  };

  const ed = {
    getModel: () => model,
    onDidChangeModelContent: (cb: ContentListener) => {
      contentListener = cb;
      return { dispose: () => {} };
    },
    onDidChangeCursorPosition: (cb: CursorListener) => {
      cursorListener = cb;
      return { dispose: () => {} };
    },
  };

  const monaco = {
    editor: {
      defineTheme: () => {},
      setTheme: () => {},
    },
    languages: {
      typescript: {
        ScriptTarget: { ESNext: 99 },
        ModuleKind: { ESNext: 99 },
        ModuleResolutionKind: { NodeJs: 2 },
        JsxEmit: { React: 2 },
        typescriptDefaults: {
          setCompilerOptions: () => {},
          setDiagnosticsOptions: () => {},
        },
        javascriptDefaults: {
          setCompilerOptions: () => {},
          setDiagnosticsOptions: () => {},
        },
      },
    },
  };

  return {
    ed, monaco, model,
    fireContent: (ev: { isFlush: boolean }) => contentListener?.(ev),
    fireCursor: (line: number, column: number) => cursorListener?.({ position: { lineNumber: line, column } }),
    setModelValue: (v: string) => { modelValue = v; },
    disposeModel: () => { modelDisposed = true; },
  };
}

// Lazy import after mocks are in place. Renders through RTL so React hooks
// (useRef, useEffect) inside CodeEditor actually wire up.
async function mountEditor(props: any) {
  lastMountedProps = null;
  const { CodeEditor } = await import("../CodeEditor");
  const result = render(React.createElement(CodeEditor, props));
  return {
    props: lastMountedProps,
    rerender: (next: any) => {
      lastMountedProps = null;
      result.rerender(React.createElement(CodeEditor, next));
      return lastMountedProps;
    },
    unmount: () => result.unmount(),
  };
}

const baseProps = {
  value: "initial",
  language: "typescript",
  pathKey: "root::src/A.tsx",
  settings: {
    fontSize: 13, tabSize: 2, wordWrap: "off", minimap: false,
    lineNumbers: "on", renderWhitespace: "none", bracketPairs: true,
    autoSave: false, formatOnSave: false,
  },
  themeMode: "dark" as const,
};

describe("CodeEditor — BUG-001 content-listener guarantees", () => {
  let onChange = mock((_id: string, _v: string) => {});
  let onCursor = mock((_l: number, _c: number) => {});

  beforeEach(() => {
    onChange = mock((_id: string, _v: string) => {});
    onCursor = mock((_l: number, _c: number) => {});
  });

  test("does NOT call onChange when ev.isFlush=true (model-swap echo from @monaco-editor/react)", async () => {
    const stack = makeFakeMonacoStack();
    const props = (await mountEditor({ ...baseProps, onChange, onCursor })).props;
    props.onMount(stack.ed, stack.monaco);

    stack.setModelValue("B-CONTENT-from-tab-swap");
    stack.fireContent({ isFlush: true });

    expect(onChange).not.toHaveBeenCalled();
  });

  test("calls onChange(pathKey, model.getValue()) on a real user edit (isFlush=false)", async () => {
    const stack = makeFakeMonacoStack();
    const props = (await mountEditor({ ...baseProps, onChange, onCursor })).props;
    props.onMount(stack.ed, stack.monaco);

    stack.setModelValue("user typed this");
    stack.fireContent({ isFlush: false });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("root::src/A.tsx", "user typed this");
  });

  test("does NOT call onChange when the model is already disposed (close-tab race)", async () => {
    const stack = makeFakeMonacoStack();
    const props = (await mountEditor({ ...baseProps, onChange, onCursor })).props;
    props.onMount(stack.ed, stack.monaco);

    stack.disposeModel();
    stack.fireContent({ isFlush: false });

    expect(onChange).not.toHaveBeenCalled();
  });

  test("uses the LATEST pathKey when the user swaps tabs and immediately types", async () => {
    const stack = makeFakeMonacoStack();
    // Mount with A.
    const handle = await mountEditor({ ...baseProps, pathKey: "root::A", onChange, onCursor });
    handle.props.onMount(stack.ed, stack.monaco);

    // Re-render the SAME mounted instance with B (parent swapped tabs).
    // pathKeyRef updates in render — without that the listener would still
    // emit for "root::A".
    handle.rerender({ ...baseProps, pathKey: "root::B", onChange, onCursor });

    stack.setModelValue("typed-after-swap");
    stack.fireContent({ isFlush: false });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("root::B", "typed-after-swap");
  });

  test("uses the LATEST onChange callback (callback ref refresh)", async () => {
    const stack = makeFakeMonacoStack();
    const first = mock((_id: string, _v: string) => {});
    const second = mock((_id: string, _v: string) => {});

    const handle = await mountEditor({ ...baseProps, onChange: first, onCursor });
    handle.props.onMount(stack.ed, stack.monaco);

    // Re-render with a fresh onChange closure (Workbench creates a new one
    // each render via handleChangeFor(groupIdx)).
    handle.rerender({ ...baseProps, onChange: second, onCursor });

    stack.setModelValue("v");
    stack.fireContent({ isFlush: false });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("CodeEditor — cursor listener disposed-model guard", () => {
  let onChange = mock((_id: string, _v: string) => {});
  let onCursor = mock((_l: number, _c: number) => {});

  beforeEach(() => {
    onChange = mock((_id: string, _v: string) => {});
    onCursor = mock((_l: number, _c: number) => {});
  });

  test("does NOT call onCursor when model is disposed (close-tab tear-down)", async () => {
    const stack = makeFakeMonacoStack();
    const props = (await mountEditor({ ...baseProps, onChange, onCursor })).props;
    props.onMount(stack.ed, stack.monaco);

    stack.disposeModel();
    stack.fireCursor(7, 3);

    expect(onCursor).not.toHaveBeenCalled();
  });

  test("calls onCursor with line/column when the model is alive", async () => {
    const stack = makeFakeMonacoStack();
    const props = (await mountEditor({ ...baseProps, onChange, onCursor })).props;
    props.onMount(stack.ed, stack.monaco);

    stack.fireCursor(12, 4);

    expect(onCursor).toHaveBeenCalledTimes(1);
    expect(onCursor).toHaveBeenCalledWith(12, 4);
  });
});
