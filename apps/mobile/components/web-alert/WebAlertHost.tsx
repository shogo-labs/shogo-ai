// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { AlertButton } from "react-native";
import {
  defaultWebAlertButton,
  getWebAlertQueue,
  isWebAlertDismissible,
  orderWebAlertButtons,
  removeWebAlert,
  subscribeWebAlerts,
  type WebAlertRequest,
} from "../../lib/web-alert";

/** Renders queued `Alert.alert` calls one at a time. Web only; mount once. */
export function WebAlertHost() {
  const queue = useSyncExternalStore(subscribeWebAlerts, getWebAlertQueue, getWebAlertQueue);
  const current = queue[0];
  if (!current) return null;
  return <WebAlertDialog key={current.id} request={current} />;
}

function WebAlertDialog({ request }: { request: WebAlertRequest }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const defaultButtonRef = useRef<HTMLButtonElement>(null);
  const buttons = orderWebAlertButtons(request.buttons);
  const defaultButton = defaultWebAlertButton(request.buttons);
  const dismissible = isWebAlertDismissible(request);
  const titleId = `web-alert-title-${request.id}`;
  const messageId = `web-alert-message-${request.id}`;

  const press = useCallback(
    (button: AlertButton) => {
      removeWebAlert(request.id);
      button.onPress?.();
    },
    [request.id],
  );

  const dismiss = useCallback(() => {
    if (!dismissible) return;
    const cancel = request.buttons.find((b) => b.style === "cancel");
    removeWebAlert(request.id);
    if (cancel) cancel.onPress?.();
    else request.options?.onDismiss?.();
  }, [dismissible, request]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    defaultButtonRef.current?.focus();
    return () => {
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return;
      }
      if (event.key === "Enter") {
        const target = event.target as HTMLElement | null;
        if (target?.tagName === "BUTTON" && dialogRef.current?.contains(target)) return;
        event.preventDefault();
        event.stopPropagation();
        if (defaultButton) press(defaultButton);
        return;
      }
      if (event.key === "Tab") {
        const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
        if (focusable.length === 0) return;
        const index = focusable.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.shiftKey
          ? focusable[(index - 1 + focusable.length) % focusable.length]
          : focusable[(index + 1) % focusable.length];
        event.preventDefault();
        next.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [defaultButton, dismiss, press]);

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
      <div data-testid="web-alert-backdrop" className="absolute inset-0 bg-black/50" onMouseDown={dismiss} />
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={request.message ? messageId : undefined}
        className="relative w-full max-w-[440px] rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-xl"
      >
        <h2 id={titleId} className="text-base font-semibold">
          {request.title}
        </h2>
        {request.message ? (
          <p id={messageId} className="mt-2 max-h-[50vh] select-text overflow-auto whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {request.message}
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {buttons.map((button, index) => (
            <button
              key={`${button.text ?? ""}-${index}`}
              ref={button === defaultButton ? defaultButtonRef : undefined}
              type="button"
              data-style={button.style ?? "default"}
              onClick={() => press(button)}
              className={
                button.style === "destructive"
                  ? "rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:opacity-90"
                  : button.style === "cancel"
                    ? "rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
                    : "rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
              }
            >
              {button.text ?? "OK"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
