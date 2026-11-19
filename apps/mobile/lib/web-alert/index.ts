// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `Alert.alert` for web and the desktop renderer.
 *
 * react-native-web ships `Alert` as `class Alert { static alert() {} }`, so
 * every `Alert.alert(...)` in the app was a silent no-op outside iOS/Android:
 * errors never surfaced and confirmation callbacks never ran. `installWebAlert`
 * replaces that method with a queue rendered by `<WebAlertHost />`
 * (components/web-alert/WebAlertHost.tsx), which the root layout mounts once.
 */
import { Alert, Platform, type AlertButton, type AlertOptions } from "react-native";

export interface WebAlertRequest {
  id: number;
  title: string;
  message?: string;
  buttons: AlertButton[];
  options?: AlertOptions;
}

let queue: WebAlertRequest[] = [];
let nextId = 1;
let installed = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function enqueueWebAlert(
  title: string,
  message?: string,
  buttons?: AlertButton[],
  options?: AlertOptions,
): void {
  const request: WebAlertRequest = {
    id: nextId++,
    title: title ?? "",
    message: message || undefined,
    buttons: buttons && buttons.length > 0 ? buttons : [{ text: "OK" }],
    options,
  };
  queue = [...queue, request];
  emit();
}

export function getWebAlertQueue(): readonly WebAlertRequest[] {
  return queue;
}

export function subscribeWebAlerts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Removes the alert from the queue. Callers run the button callback afterwards. */
export function removeWebAlert(id: number): void {
  const before = queue.length;
  queue = queue.filter((request) => request.id !== id);
  if (queue.length !== before) emit();
}

/**
 * Whether Escape or a backdrop click may close the alert. An explicit
 * `options.cancelable` wins; otherwise alerts with a cancel button or a
 * single acknowledgement button can be dismissed.
 */
export function isWebAlertDismissible(request: WebAlertRequest): boolean {
  if (typeof request.options?.cancelable === "boolean") return request.options.cancelable;
  return request.buttons.length <= 1 || request.buttons.some((b) => b.style === "cancel");
}

/** Buttons in render order: the cancel button first, the rest as given. */
export function orderWebAlertButtons(buttons: readonly AlertButton[]): AlertButton[] {
  const cancel = buttons.filter((b) => b.style === "cancel");
  const rest = buttons.filter((b) => b.style !== "cancel");
  return [...cancel, ...rest];
}

/** The button Enter activates: the last non-cancel button, else the only button. */
export function defaultWebAlertButton(buttons: readonly AlertButton[]): AlertButton | undefined {
  const rest = buttons.filter((b) => b.style !== "cancel");
  return rest[rest.length - 1] ?? buttons[buttons.length - 1];
}

/** Returns true when `Alert.alert` is (now) routed to the web queue. */
export function installWebAlert(): boolean {
  if (Platform.OS !== "web") return false;
  if (installed) return true;
  (Alert as { alert: typeof Alert.alert }).alert = enqueueWebAlert;
  installed = true;
  return true;
}

export function resetWebAlertsForTests(): void {
  queue = [];
  nextId = 1;
  emit();
}
