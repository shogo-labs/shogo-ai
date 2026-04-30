/**
 * Sanity tests for the Monaco extraLibs registration.
 *
 * We don't load Monaco itself in these tests — instead we mock the minimum
 * surface (`addExtraLib` on `typescriptDefaults` / `javascriptDefaults`) and
 * assert that `setupExtraLibs` registers every entry in `EXTRA_LIBS`, that
 * it is idempotent, and that the bundled React types contain the symbols
 * users actually expect autocomplete for.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";
import { setupExtraLibs, __resetExtraLibsForTest } from "../monaco/extraLibs";
import { EXTRA_LIBS } from "../monaco/extraLibs.generated";

function makeMockMonaco() {
  const tsAdd = mock(() => {});
  const jsAdd = mock(() => {});
  return {
    monaco: {
      languages: {
        typescript: {
          typescriptDefaults: { addExtraLib: tsAdd },
          javascriptDefaults: { addExtraLib: jsAdd },
        },
      },
    } as unknown as Parameters<typeof setupExtraLibs>[0],
    tsAdd,
    jsAdd,
  };
}

describe("extraLibs", () => {
  beforeEach(() => {
    __resetExtraLibsForTest();
  });

  test("registers every entry on both typescript and javascript defaults", () => {
    const { monaco, tsAdd, jsAdd } = makeMockMonaco();
    setupExtraLibs(monaco);
    expect(tsAdd).toHaveBeenCalledTimes(EXTRA_LIBS.length);
    expect(jsAdd).toHaveBeenCalledTimes(EXTRA_LIBS.length);
    for (const lib of EXTRA_LIBS) {
      expect(tsAdd).toHaveBeenCalledWith(lib.content, lib.path);
      expect(jsAdd).toHaveBeenCalledWith(lib.content, lib.path);
    }
  });

  test("is idempotent across multiple calls", () => {
    const { monaco, tsAdd } = makeMockMonaco();
    setupExtraLibs(monaco);
    setupExtraLibs(monaco);
    setupExtraLibs(monaco);
    expect(tsAdd).toHaveBeenCalledTimes(EXTRA_LIBS.length);
  });

  test("__resetExtraLibsForTest re-arms the loader", () => {
    const a = makeMockMonaco();
    setupExtraLibs(a.monaco);
    __resetExtraLibsForTest();
    const b = makeMockMonaco();
    setupExtraLibs(b.monaco);
    expect(b.tsAdd).toHaveBeenCalledTimes(EXTRA_LIBS.length);
  });

  test("bundles the React core hooks under @types/react", () => {
    const react = EXTRA_LIBS.find((l) => l.path.endsWith("@types/react/index.d.ts"));
    expect(react).toBeDefined();
    expect(react!.content).toMatch(/function useState</);
    expect(react!.content).toMatch(/function useEffect\(/);
    expect(react!.content).toMatch(/function useMemo</);
    expect(react!.content).toMatch(/function useCallback</);
    expect(react!.content).toMatch(/function useRef</);
  });

  test("bundles @types/react/global.d.ts so the triple-slash reference at the top of index.d.ts resolves", () => {
    const global = EXTRA_LIBS.find((l) => l.path.endsWith("@types/react/global.d.ts"));
    expect(global).toBeDefined();
    expect(global!.content.length).toBeGreaterThan(1000);
    expect(global!.content).toMatch(/interface Event/);

    const react = EXTRA_LIBS.find((l) => l.path.endsWith("@types/react/index.d.ts"));
    expect(react!.content).toMatch(/\/\/\/ <reference path="global.d.ts" \/>/);
  });

  test("bundles react-dom/client (createRoot for React 18+)", () => {
    const client = EXTRA_LIBS.find((l) => l.path.endsWith("react-dom/client.d.ts"));
    expect(client).toBeDefined();
    expect(client!.content).toMatch(/createRoot/);
  });

  test("bundles csstype so React.CSSProperties resolves", () => {
    const css = EXTRA_LIBS.find((l) => l.path.endsWith("csstype/index.d.ts"));
    expect(css).toBeDefined();
    expect(css!.content.length).toBeGreaterThan(10000);
    expect(css!.content).toMatch(/PropertiesHyphen|interface Properties/);
  });

  test("every entry uses a /node_modules/ path so Monaco resolves it", () => {
    for (const lib of EXTRA_LIBS) {
      expect(lib.path).toMatch(/^file:\/\/\/node_modules\//);
      expect(lib.content.length).toBeGreaterThan(0);
    }
  });
});
