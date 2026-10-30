// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ChatReferenceInput } from "./chat-references";

/**
 * Hands "Add to Chat" requests (file tree, editor ⌘L, terminal ⌘L, Shogo
 * Code) to the active chat composer. Requests made while no composer is
 * mounted — e.g. a narrow layout showing only the IDE — are queued and
 * applied when one subscribes.
 */

export type ChatInsertSource = "ide-tree" | "ide-editor" | "terminal" | "shogo-code";

export interface ChatInsertRequest {
  references?: ChatReferenceInput[];
  /** Plain text inserted verbatim (terminal output). */
  text?: string;
  source: ChatInsertSource;
  /** Called once the composer has inserted the request (not when it is only queued). */
  onApplied?: () => void;
}

export type ChatInsertHandler = (request: ChatInsertRequest) => void;
export type ChatInsertDelivery = "delivered" | "queued";

export const MAX_QUEUED_CHAT_INSERTS = 50;
/** Dispatched by packages/desktop-terminal's Add to Chat button (`detail: { text }`). */
export const TERMINAL_ADD_TO_CHAT_EVENT = "shogo:add-to-chat";

interface BusState {
  queue: ChatInsertRequest[];
  // The most recent subscriber is active; an older one takes over again when
  // the newer one unsubscribes (e.g. a chat tab closing).
  subscribers: ChatInsertHandler[];
  observers: Set<ChatInsertHandler>;
}

// Shared across module copies (Fast Refresh, duplicated bundles) so the
// once-per-window terminal listener always reaches the live subscribers.
const STATE_KEY = "__shogoChatInsertBus";
const globalState = globalThis as unknown as Record<string, BusState | undefined>;
const state: BusState = (globalState[STATE_KEY] ??= { queue: [], subscribers: [], observers: new Set() });

function deliverOrQueue(request: ChatInsertRequest, position: "back" | "front"): ChatInsertDelivery {
  const active = state.subscribers[state.subscribers.length - 1];
  if (active) {
    active(request);
    return "delivered";
  }
  if (position === "front") state.queue.unshift(request);
  else state.queue.push(request);
  if (state.queue.length > MAX_QUEUED_CHAT_INSERTS) {
    const dropped = state.queue.splice(0, state.queue.length - MAX_QUEUED_CHAT_INSERTS);
    console.warn(`[chat-insert-bus] dropped ${dropped.length} queued Add to Chat request(s); no chat composer is open`);
  }
  return "queued";
}

export function requestChatInsert(request: ChatInsertRequest): ChatInsertDelivery {
  ensureWindowAdapter();
  for (const observer of state.observers) observer(request);
  return deliverOrQueue(request, "back");
}

/**
 * Give back requests a composer accepted but did not apply (its panel went
 * inactive). They go to the next active composer, or to the front of the
 * queue, without notifying observers again.
 */
export function returnChatInserts(requests: ChatInsertRequest[]): void {
  for (const request of [...requests].reverse()) deliverOrQueue(request, "front");
}

/** Subscribe the active composer; queued requests are delivered synchronously, in order. */
export function subscribeChatInsert(handler: ChatInsertHandler): () => void {
  ensureWindowAdapter();
  state.subscribers.push(handler);
  while (state.queue.length > 0 && state.subscribers[state.subscribers.length - 1] === handler) handler(state.queue.shift()!);
  return () => {
    const i = state.subscribers.lastIndexOf(handler);
    if (i !== -1) state.subscribers.splice(i, 1);
  };
}

export function hasChatInsertSubscriber(): boolean {
  return state.subscribers.length > 0;
}

/**
 * Notified of every request before it is delivered or queued, without
 * consuming it — e.g. the project layout reveals a collapsed chat panel.
 */
export function onChatInsertRequested(observer: ChatInsertHandler): () => void {
  state.observers.add(observer);
  return () => {
    state.observers.delete(observer);
  };
}

const ADAPTER_FLAG = "__shogoChatInsertAdapterInstalled";

/** Routes the terminal's window event through the bus, once per window (idempotent across module copies). */
export function ensureWindowAdapter(): void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  const w = window as unknown as Record<string, unknown>;
  if (w[ADAPTER_FLAG]) return;
  w[ADAPTER_FLAG] = true;
  window.addEventListener(TERMINAL_ADD_TO_CHAT_EVENT, (event: Event) => {
    const text = (event as CustomEvent<{ text?: string }>).detail?.text?.trim();
    if (text) requestChatInsert({ text, source: "terminal" });
  });
}

ensureWindowAdapter();

/** Test-only: drop queued requests and subscribers. */
export function _resetChatInsertBusForTests(): void {
  state.queue.length = 0;
  state.subscribers.length = 0;
  state.observers.clear();
}
