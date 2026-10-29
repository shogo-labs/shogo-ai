// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ContextMenu } from "../ContextMenu";

afterEach(() => cleanup());

describe("ContextMenu hint", () => {
  test("a disabled item shows its hint as a tooltip and inline", () => {
    const onClick = mock(() => {});
    render(
      <ContextMenu
        x={0}
        y={0}
        onClose={() => {}}
        items={[{ label: "Add to Chat", disabled: true, hint: "Only project workspace files can be referenced", onClick }]}
      />,
    );
    const button = screen.getByText("Add to Chat").closest("button")!;
    expect(button.getAttribute("title")).toBe("Only project workspace files can be referenced");
    expect(screen.getByText("Only project workspace files can be referenced")).toBeTruthy();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("an enabled item keeps the hint as a tooltip only", () => {
    render(<ContextMenu x={0} y={0} onClose={() => {}} items={[{ label: "Open", hint: "Open the file", onClick: () => {} }]} />);
    expect(screen.getByText("Open").closest("button")!.getAttribute("title")).toBe("Open the file");
    expect(screen.queryByText("Open the file")).toBeNull();
  });
});
