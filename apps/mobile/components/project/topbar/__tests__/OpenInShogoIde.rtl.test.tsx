// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { createReactNativeMock } from "../../../../test/react-native-mock";

mock.module("react-native", () =>
  createReactNativeMock({
    Pressable: ({ accessibilityLabel, accessibilityRole, accessibilityState, children, onPress, ...props }: any) =>
      createElement("button", { ...props, "aria-label": accessibilityLabel, onClick: onPress, role: accessibilityRole }, children),
  }),
);

const { OpenInShogoIdeButton } = await import("../OpenInShogoIdeButton");
const { WebAlertHost } = await import("../../../web-alert/WebAlertHost");
import { installWebAlert, resetWebAlertsForTests } from "../../../../lib/web-alert";
import {
  alertCodeWorkbenchError,
  codeWorkbenchButtonLabel,
  type CodeWorkbenchStatus,
} from "../../../../lib/code-workbench-status";

const status = (phase: CodeWorkbenchStatus["phase"], extra: Partial<CodeWorkbenchStatus> = {}): CodeWorkbenchStatus => ({
  projectId: "p1",
  phase,
  ...extra,
});

beforeEach(() => {
  installWebAlert();
  resetWebAlertsForTests();
});

afterEach(() => {
  act(() => resetWebAlertsForTests());
  cleanup();
});

describe("codeWorkbenchButtonLabel", () => {
  test.each([
    [null, true, "Open in Shogo IDE"],
    [null, false, "Open in IDE"],
    [status("downloading", { received: 42, total: 100 }), true, "Downloading Shogo IDE… 42%"],
    [status("downloading"), true, "Downloading Shogo IDE…"],
    [status("verifying"), true, "Installing Shogo IDE…"],
    [status("extracting"), true, "Installing Shogo IDE…"],
    [status("starting"), true, "Starting Shogo IDE…"],
    [status("ready"), true, "Open in Shogo IDE"],
    [status("error", { message: "x" }), false, "Open in IDE"],
  ])("%o (wide=%s) -> %s", (s, wide, label) => {
    expect(codeWorkbenchButtonLabel(s, wide)).toBe(label);
  });
});

describe("OpenInShogoIdeButton", () => {
  test("idle: shows the action and opens on press", () => {
    const onPress = mock(() => {});
    render(<OpenInShogoIdeButton onPress={onPress} status={null} wide />);
    const button = screen.getByRole("button", { name: "Open in Shogo IDE" });
    expect(button.textContent).toBe("Open in Shogo IDE");
    fireEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test("while downloading: shows progress and ignores presses", () => {
    const onPress = mock(() => {});
    render(<OpenInShogoIdeButton onPress={onPress} status={status("downloading", { received: 3, total: 4 })} wide />);
    const button = screen.getByRole("button", { name: "Open in Shogo IDE" }) as HTMLButtonElement;
    expect(button.textContent).toBe("Downloading Shogo IDE… 75%");
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  test("after an error the button is usable again", () => {
    const onPress = mock(() => {});
    render(<OpenInShogoIdeButton onPress={onPress} status={status("error", { message: "boom" })} wide />);
    fireEvent.click(screen.getByRole("button", { name: "Open in Shogo IDE" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("alertCodeWorkbenchError", () => {
  test("shows Close, Open log and Retry; Retry re-opens and Open log opens the log", () => {
    const retry = mock(() => {});
    const openLog = mock(() => {});
    render(<WebAlertHost />);
    act(() => alertCodeWorkbenchError("Downloading the Shogo IDE server failed: HTTP 503", { retry, openLog }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Could not open Shogo IDE");
    expect(dialog.textContent).toContain("HTTP 503");
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Close", "Open log", "Retry"]);
    fireEvent.click(screen.getByRole("button", { name: "Open log" }));
    expect(openLog).toHaveBeenCalledTimes(1);

    act(() => alertCodeWorkbenchError("again", { retry, openLog }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("without a log bridge there is no Open log button", () => {
    render(<WebAlertHost />);
    act(() => alertCodeWorkbenchError("nope", { retry: () => {} }));
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Close", "Retry"]);
  });
});
