// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Alert } from "react-native";
import { installWebAlert, resetWebAlertsForTests } from "../../../lib/web-alert";
import { WebAlertHost } from "../WebAlertHost";

function alert(...args: Parameters<typeof Alert.alert>) {
  act(() => {
    Alert.alert(...args);
  });
}

function dialog() {
  return screen.queryByRole("alertdialog");
}

beforeEach(() => {
  expect(installWebAlert()).toBe(true);
  resetWebAlertsForTests();
});

afterEach(() => {
  act(() => resetWebAlertsForTests());
  cleanup();
});

describe("WebAlertHost", () => {
  test("renders nothing until Alert.alert is called", () => {
    render(<WebAlertHost />);
    expect(dialog()).toBeNull();
  });

  test("shows title, message and a default OK button", () => {
    render(<WebAlertHost />);
    alert("Could not open Shogo IDE", "Timed out\nsecond line");
    const node = dialog()!;
    expect(node).toBeTruthy();
    expect(node.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("Could not open Shogo IDE").id).toBe(node.getAttribute("aria-labelledby")!);
    expect(screen.getByText(/Timed out/).id).toBe(node.getAttribute("aria-describedby")!);
    const ok = screen.getByRole("button", { name: "OK" });
    expect(document.activeElement).toBe(ok);
    fireEvent.click(ok);
    expect(dialog()).toBeNull();
  });

  test("runs the pressed button's callback once and closes", () => {
    const onDelete = mock(() => {});
    const onCancel = mock(() => {});
    render(<WebAlertHost />);
    alert("Delete project?", "This cannot be undone.", [
      { text: "Delete", style: "destructive", onPress: onDelete },
      { text: "Cancel", style: "cancel", onPress: onCancel },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  test("puts the cancel button first and marks styles", () => {
    render(<WebAlertHost />);
    alert("Delete?", undefined, [
      { text: "Delete", style: "destructive" },
      { text: "Cancel", style: "cancel" },
    ]);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", "Delete"]);
    expect(buttons.map((b) => b.getAttribute("data-style"))).toEqual(["cancel", "destructive"]);
  });

  test("Escape and backdrop run the cancel button when one exists", () => {
    const onCancel = mock(() => {});
    render(<WebAlertHost />);
    alert("Leave?", undefined, [{ text: "Stay", style: "cancel", onPress: onCancel }, { text: "Leave" }]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();

    alert("Leave?", undefined, [{ text: "Stay", style: "cancel", onPress: onCancel }, { text: "Leave" }]);
    fireEvent.mouseDown(screen.getByTestId("web-alert-backdrop"));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(dialog()).toBeNull();
  });

  test("Escape calls onDismiss when there is no cancel button", () => {
    const onDismiss = mock(() => {});
    const onOk = mock(() => {});
    render(<WebAlertHost />);
    alert("Saved", undefined, [{ text: "OK", onPress: onOk }], { onDismiss });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onOk).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  test("cancelable: false ignores Escape and backdrop", () => {
    const onDismiss = mock(() => {});
    render(<WebAlertHost />);
    alert("Pick one", undefined, [{ text: "A" }, { text: "B" }], { cancelable: false, onDismiss });
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(screen.getByTestId("web-alert-backdrop"));
    expect(dialog()).toBeTruthy();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test("two non-cancel buttons without a cancel are not dismissible by default", () => {
    render(<WebAlertHost />);
    alert("Pick one", undefined, [{ text: "A" }, { text: "B" }]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog()).toBeTruthy();
  });

  test("Enter activates the last non-cancel button", () => {
    const onRetry = mock(() => {});
    const onLog = mock(() => {});
    render(<WebAlertHost />);
    alert("Failed", undefined, [
      { text: "Open log", onPress: onLog },
      { text: "Retry", onPress: onRetry },
      { text: "Close", style: "cancel" },
    ]);
    expect(document.activeElement?.textContent).toBe("Retry");
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onLog).not.toHaveBeenCalled();
  });

  test("Tab cycles focus within the dialog", () => {
    render(<WebAlertHost />);
    alert("Failed", undefined, [{ text: "Close", style: "cancel" }, { text: "Retry" }]);
    expect(document.activeElement?.textContent).toBe("Retry");
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement?.textContent).toBe("Close");
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement?.textContent).toBe("Retry");
  });

  test("queued alerts show one at a time in order", () => {
    render(<WebAlertHost />);
    alert("First");
    alert("Second");
    alert("Third");
    expect(screen.getByText("First")).toBeTruthy();
    expect(screen.queryByText("Second")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.getByText("Second")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.getByText("Third")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(dialog()).toBeNull();
  });

  test("a callback that raises another alert shows it next", () => {
    render(<WebAlertHost />);
    alert("Confirm", undefined, [
      { text: "Go", onPress: () => Alert.alert("Done") },
    ]);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Go" }));
    });
    expect(screen.getByText("Done")).toBeTruthy();
  });

  test("restores focus to the previously focused element", () => {
    render(
      <>
        <button type="button">Trigger</button>
        <WebAlertHost />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Trigger" });
    trigger.focus();
    alert("Hello");
    expect(document.activeElement).not.toBe(trigger);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(document.activeElement).toBe(trigger);
  });

  test("installWebAlert is idempotent", () => {
    const patched = Alert.alert;
    expect(installWebAlert()).toBe(true);
    expect(Alert.alert).toBe(patched);
  });
});
