// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// In-IDE confirm dialog with arbitrary buttons (e.g. Save / Don't Save /
// Cancel). Replaces `window.confirm`, which can't offer a Save choice and
// must not be called from inside a React state updater.

import React, { useEffect, useRef } from "react";

export interface ConfirmButton<T extends string> {
  label: string;
  value: T;
  /** "primary" is the default action (Enter); "danger" renders destructive. */
  variant?: "primary" | "danger" | "secondary";
}

export interface ConfirmDialogProps<T extends string> {
  title: string;
  message: React.ReactNode;
  buttons: ConfirmButton<T>[];
  /** Value reported when the user presses Escape or clicks the backdrop. */
  cancelValue: T;
  onResolve: (value: T) => void;
}

export function ConfirmDialog<T extends string>({
  title,
  message,
  buttons,
  cancelValue,
  onResolve,
}: ConfirmDialogProps<T>) {
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onResolve(cancelValue);
      }
    };
    // Capture so the Workbench's own capture-phase shortcuts don't fire
    // while the dialog is up.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cancelValue, onResolve]);

  const primaryIndex = Math.max(
    0,
    buttons.findIndex((b) => b.variant === "primary"),
  );

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onResolve(cancelValue);
      }}
      role="presentation"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="w-[420px] max-w-[90%] rounded-md border border-[color:var(--ide-border)] bg-[color:var(--ide-panel)] p-4 text-[color:var(--ide-text)] shadow-2xl"
      >
        <div className="text-[13px] font-semibold text-[color:var(--ide-text-strong)]">{title}</div>
        <div className="mt-2 text-[12px] leading-relaxed text-[color:var(--ide-muted)]">{message}</div>
        <div className="mt-4 flex justify-end gap-2">
          {buttons.map((b, i) => {
            const variant = b.variant ?? "secondary";
            const cls =
              variant === "primary"
                ? "bg-[color:var(--ide-primary)] text-white hover:opacity-90"
                : variant === "danger"
                  ? "bg-red-600 text-white hover:bg-red-500"
                  : "bg-[color:var(--ide-hover)] text-[color:var(--ide-text)] hover:bg-[color:var(--ide-active)]";
            return (
              <button
                key={b.value}
                ref={i === primaryIndex ? primaryRef : undefined}
                type="button"
                onClick={() => onResolve(b.value)}
                className={`rounded px-3 py-1 text-[12px] ${cls}`}
              >
                {b.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Human list of file names for dialog copy: `a.ts`, `a.ts and b.ts`, `a.ts, b.ts and 2 others`. */
export function describeFileNames(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} other${names.length - 2 === 1 ? "" : "s"}`;
}
