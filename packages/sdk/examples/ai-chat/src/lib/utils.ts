// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const fetcher = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Fetch error: ${response.statusText}`);
  }
  return response.json();
};

export async function fetchWithErrorHandlers(
  input: RequestInfo | URL,
  init?: RequestInit
) {
  try {
    const response = await fetch(input, init);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || response.statusText);
    }
    return response;
  } catch (error: unknown) {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      throw new Error("You appear to be offline.");
    }
    throw error;
  }
}

export function getLocalStorage(key: string) {
  if (typeof window !== "undefined") {
    return JSON.parse(localStorage.getItem(key) || "[]");
  }
  return [];
}

export function generateUUID(): string {
  return crypto.randomUUID();
}

export function getMostRecentUserMessage(messages: any[]) {
  const userMessages = messages.filter((message) => message.role === "user");
  return userMessages.at(-1);
}

export function getDocumentTimestampByIndex(
  documents: any[],
  index: number
) {
  if (!documents) return new Date();
  if (index > documents.length) return new Date();
  return documents[index].createdAt;
}

export function getTrailingMessageId({
  messages,
}: {
  messages: any[];
}): string | null {
  const trailingMessage = messages.at(-1);
  if (!trailingMessage) return null;
  return trailingMessage.id;
}

export function sanitizeText(text: string) {
  return text.replace("<has_function_call>", "");
}

export function convertToUIMessages(messages: any[]): any[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role as "user" | "assistant" | "system",
    parts: message.parts,
    metadata: {
      createdAt: message.createdAt,
    },
  }));
}

export function getTextFromMessage(message: any): string {
  return (message.parts || [])
    .filter((part: any) => part.type === "text")
    .map((part: any) => part.text)
    .join("");
}

export function formatDate(date: Date | string): string {
  const d = new Date(date);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) {
    return "Today";
  } else if (days === 1) {
    return "Yesterday";
  } else if (days < 7) {
    return `${days} days ago`;
  } else {
    return d.toLocaleDateString();
  }
}
