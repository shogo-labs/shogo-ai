/**
 * AnsiText — BUG-013 render layer.
 *
 * The parser is tested separately; this file pins the rendering rules:
 *   - one <span> per parsed AnsiSpan;
 *   - the wrapper element honours the `as` prop;
 *   - inline style binds through CSS custom properties so themes drive
 *     colors (color: var(--ide-ansi-red, …), not a hardcoded #cd3131
 *     escaping into the bundle);
 *   - bold, italic, underline, dim all flow through to inline style;
 *   - default fg uses inherit (NOT var(--ide-ansi-default)) so it cleanly
 *     drops out of the cascade and follows the panel's regular text color.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import * as React from "react";
import { AnsiText } from "../AnsiText";

const ESC = "\x1B";
afterEach(cleanup);

describe("AnsiText — rendering basics", () => {
  test("renders plain text as a single span", () => {
    const { container } = render(<AnsiText text="hello" />);
    const spans = container.querySelectorAll("span > span");
    expect(spans.length).toBe(1);
    expect(spans[0]!.textContent).toBe("hello");
  });

  test("default wrapper is <span>; honors `as` prop", () => {
    const { container } = render(<AnsiText text="x" />);
    expect(container.firstElementChild?.tagName).toBe("SPAN");

    cleanup();
    const { container: c2 } = render(<AnsiText as="div" text="x" />);
    expect(c2.firstElementChild?.tagName).toBe("DIV");
  });

  test("applies the className prop", () => {
    const { container } = render(<AnsiText className="run-line" text="x" />);
    expect(container.firstElementChild?.className).toBe("run-line");
  });

  test("renders [] for empty text → no inner spans", () => {
    const { container } = render(<AnsiText text="" />);
    expect(container.firstElementChild?.children.length).toBe(0);
  });
});

describe("AnsiText — style flow", () => {
  test("red fg renders as data-ansi-fg=\"red\" (CSS selector binds the var)", () => {
    const { container } = render(<AnsiText text={`${ESC}[31merror${ESC}[0m`} />);
    const span = container.querySelector("span > span")!;
    expect(span.getAttribute("data-ansi-fg")).toBe("red");
  });

  test("default fg sets NO data-ansi-fg attribute (inherit from theme)", () => {
    const { container } = render(<AnsiText text="plain" />);
    const span = container.querySelector("span > span")!;
    expect(span.getAttribute("data-ansi-fg")).toBeNull();
  });

  test("bold renders as font-weight: 700", () => {
    const { container } = render(<AnsiText text={`${ESC}[1mbold${ESC}[0m`} />);
    const span = container.querySelector("span > span")!;
    expect((span as HTMLElement).style.fontWeight).toBe("700");
  });

  test("italic renders as font-style: italic", () => {
    const { container } = render(<AnsiText text={`${ESC}[3mit${ESC}[0m`} />);
    expect((container.querySelector("span > span")! as HTMLElement).style.fontStyle).toBe("italic");
  });

  test("underline renders as text-decoration: underline", () => {
    const { container } = render(<AnsiText text={`${ESC}[4mu${ESC}[0m`} />);
    expect((container.querySelector("span > span")! as HTMLElement).style.textDecoration).toBe("underline");
  });

  test("dim renders as opacity: 0.6", () => {
    const { container } = render(<AnsiText text={`${ESC}[2md${ESC}[0m`} />);
    expect((container.querySelector("span > span")! as HTMLElement).style.opacity).toBe("0.6");
  });

  test("bg blue renders as data-ansi-bg=\"blue\"", () => {
    const { container } = render(<AnsiText text={`${ESC}[44mbg${ESC}[0m`} />);
    const span = container.querySelector("span > span")! as HTMLElement;
    expect(span.getAttribute("data-ansi-bg")).toBe("blue");
  });
});

describe("AnsiText — multi-span composition", () => {
  test("mixed default + red + default renders 3 spans in order", () => {
    const text = `pre ${ESC}[31mmid${ESC}[0m post`;
    const { container } = render(<AnsiText text={text} />);
    const spans = container.querySelectorAll("span > span");
    expect(spans.length).toBe(3);
    expect([...spans].map((s) => s.textContent)).toEqual(["pre ", "mid", " post"]);
    expect(spans[0]!.getAttribute("data-ansi-fg")).toBeNull();    // default
    expect(spans[1]!.getAttribute("data-ansi-fg")).toBe("red");
    expect(spans[2]!.getAttribute("data-ansi-fg")).toBeNull();    // back to default
  });

  test("real-world TS error sample renders correctly", () => {
    const line = `${ESC}[31m${ESC}[1merror${ESC}[22m TS2304: foo${ESC}[0m`;
    const { container } = render(<AnsiText text={line} />);
    const spans = [...container.querySelectorAll("span > span")] as HTMLElement[];
    expect(spans[0]!.textContent).toBe("error");
    expect(spans[0]!.getAttribute("style")).toContain("font-weight: 700");
    expect(spans[0]!.getAttribute("data-ansi-fg")).toBe("red");
    expect(spans[1]!.textContent).toBe(" TS2304: foo");
    expect(spans[1]!.getAttribute("style") ?? "").not.toContain("font-weight"); // 22 cleared bold
    expect(spans[1]!.getAttribute("data-ansi-fg")).toBe("red"); // color preserved
  });
});

describe("AnsiText — no innerHTML / no theme drift", () => {
  test("does NOT emit hardcoded color hex inline (theme-var binding via CSS)", () => {
    const { container } = render(<AnsiText text={`${ESC}[31mr${ESC}[0m`} />);
    // No raw hex in the per-span markup — colors live in the global
    // <style data-ansi-stylesheet> rule that uses CSS custom properties.
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{6}/);
    // The theme-binding stylesheet exists and uses CSS vars.
    const sheet = document.querySelector("style[data-ansi-stylesheet]");
    expect(sheet?.textContent).toMatch(/var\(--ide-ansi-red/);
  });

  test("data-ansi attribute is set on the wrapper for CSS hooks", () => {
    const { container } = render(<AnsiText text="x" />);
    expect(container.firstElementChild?.getAttribute("data-ansi")).toBe("true");
  });
});
