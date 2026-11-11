// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Open in Shogo IDE" progress, as reported by the desktop main process
 * (`code-workbench:status`, apps/desktop/src/code-oss-server/status.ts).
 * A first open downloads the IDE server, so the button shows where it is.
 */
import { Alert } from "react-native";

export type CodeWorkbenchPhase = "downloading" | "verifying" | "extracting" | "starting" | "ready" | "error";

export interface CodeWorkbenchStatus {
  projectId: string;
  phase: CodeWorkbenchPhase;
  received?: number;
  total?: number;
  message?: string;
  logPath?: string;
}

export interface CodeWorkbenchBridge {
  open?: (opts: { projectId?: string; workspacePath?: string }) => Promise<
    { ok: true; pending?: boolean; alreadyPending?: boolean } | { ok: false; error?: string } | undefined
  >;
  onStatus?: (callback: (status: CodeWorkbenchStatus) => void) => () => void;
  openLog?: () => Promise<{ ok: boolean; error?: string }>;
}

export function getCodeWorkbenchBridge(): CodeWorkbenchBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { shogoDesktop?: { codeWorkbench?: CodeWorkbenchBridge } }).shogoDesktop?.codeWorkbench;
}

/** The failure dialog: Open log (when the bridge has it), Retry, Close. */
export function alertCodeWorkbenchError(
  message: string,
  actions: { retry: () => void; openLog?: () => void },
): void {
  Alert.alert("Could not open Shogo IDE", message, [
    ...(actions.openLog ? [{ text: "Open log", onPress: actions.openLog }] : []),
    { text: "Retry", onPress: actions.retry },
    { text: "Close", style: "cancel" as const },
  ]);
}

/** True while an open is in flight: the button is disabled. */
export function isCodeWorkbenchBusy(status: Pick<CodeWorkbenchStatus, "phase"> | null | undefined): boolean {
  return !!status && status.phase !== "ready" && status.phase !== "error";
}

export function codeWorkbenchButtonLabel(
  status: Pick<CodeWorkbenchStatus, "phase" | "received" | "total"> | null | undefined,
  wide: boolean,
): string {
  const idle = wide ? "Open in Shogo IDE" : "Open in IDE";
  if (!isCodeWorkbenchBusy(status)) return idle;
  switch (status!.phase) {
    case "downloading": {
      const { received, total } = status!;
      if (received !== undefined && total) {
        return `Downloading Shogo IDE… ${Math.min(100, Math.floor((received / total) * 100))}%`;
      }
      return "Downloading Shogo IDE…";
    }
    case "verifying":
    case "extracting":
      return "Installing Shogo IDE…";
    case "starting":
      return "Starting Shogo IDE…";
    default:
      return idle;
  }
}
