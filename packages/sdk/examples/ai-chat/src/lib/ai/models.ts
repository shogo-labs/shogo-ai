// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
// Models available through the Shogo AI Proxy
export const DEFAULT_CHAT_MODEL = "claude-haiku-4-5";

export type ChatModel = {
  id: string;
  name: string;
  provider: string;
  description: string;
};

export const chatModels: ChatModel[] = [
  // Anthropic
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    description: "Fast and affordable, great for everyday tasks",
  },
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    provider: "anthropic",
    description: "Best balance of speed, intelligence, and cost",
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    provider: "anthropic",
    description: "Most capable Anthropic model",
  },
  {
    id: "claude-sonnet-4-5-20250929",
    name: "Claude Sonnet 4.5 (Sept 2025)",
    provider: "anthropic",
    description: "Pinned Sonnet 4.5 version",
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5 (Oct 2025)",
    provider: "anthropic",
    description: "Pinned Haiku 4.5 version",
  },
];

// Group models by provider for UI
export const modelsByProvider = chatModels.reduce(
  (acc, model) => {
    if (!acc[model.provider]) {
      acc[model.provider] = [];
    }
    acc[model.provider].push(model);
    return acc;
  },
  {} as Record<string, ChatModel[]>
);
